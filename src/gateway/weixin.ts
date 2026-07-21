// WeChat (personal) adapter for `hara gateway`, via Tencent's official iLink bot API
// (ilinkai.weixin.qq.com). Text-DM happy path: QR login → long-poll getupdates → sendmessage.
// Ported from the documented iLink wire protocol. Built-in fetch; QR rendering uses the optional
// `qrcode-terminal` dep (graceful fallback to printing the URL). No encryption is needed on the text path
// (iLink only uses crypto for media upload/download, which v1 doesn't do).
import { homedir } from "node:os";
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";
import type { OutboundFilePayload } from "./outbound-files.js";
import {
  INBOUND_MEDIA_MAX_BYTES,
  INBOUND_MEDIA_TIMEOUT_MS,
  InboundMediaBudget,
  cleanupTransientMedia,
  readResponseBytesLimited,
  savePrivateMediaBytes,
} from "./media.js";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
  type PrivateStateFileBinding,
} from "../security/private-state.js";

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0); // 131584

const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const EP = {
  getUpdates: "ilink/bot/getupdates",
  sendMessage: "ilink/bot/sendmessage",
  getBotQr: "ilink/bot/get_bot_qrcode",
  getQrStatus: "ilink/bot/get_qrcode_status",
  getUploadUrl: "ilink/bot/getuploadurl",
};

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;
const SESSION_EXPIRED = -14;
const RATE_LIMIT = -2;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4; // item.type for a file attachment (audio is sent as a file — iLink voice bubbles unreliable)
const MEDIA_IMAGE = 1; // media_type for getuploadurl when sending an image (inline)
const MEDIA_FILE = 3; // media_type for getuploadurl when sending a file/audio
const WEIXIN_CDN_ALLOWLIST = new Set([
  "novac2c.cdn.weixin.qq.com",
  "ilinkai.weixin.qq.com",
  "wx.qlogo.cn",
  "thirdwx.qlogo.cn",
  "res.wx.qq.com",
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);

export interface WeixinCreds {
  account_id: string;
  token: string;
  base_url: string;
  user_id: string;
}

export type WeixinCredentialInspection =
  | { state: "ready"; credentials: WeixinCreds }
  | { state: "missing" | "unreadable" };

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (v == null ? "" : String(v));

function stableWeixinMessageId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function weixinCreatedAtMs(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

// ── pure protocol helpers (unit-tested) ──────────────────────────────────────

/** X-WECHAT-UIN: base64 of the decimal string of a random uint32 (regenerated per request). */
export function randomWechatUin(): string {
  const v = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(v), "utf-8").toString("base64");
}

function ilinkHeaders(token: string | undefined, body: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Every POST body is compact JSON with base_info merged in. */
export function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
}

/** The `sendmessage` body for a text DM (context_token omitted when falsy). */
export function buildSendBody(to: string, text: string, contextToken: string | undefined, clientId: string): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: to,
    client_id: clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text } }],
  };
  if (contextToken) msg.context_token = contextToken;
  return { msg };
}

/** iLink wants the AES key as base64 of the key's HEX-string ASCII bytes — NOT base64 of the raw key bytes.
 *  (Getting this wrong = the receiver can't decrypt → unplayable/grey media.) */
export function apiAesKey(keyHex: string): string {
  return Buffer.from(keyHex, "ascii").toString("base64");
}

/** The sendmessage item for a file attachment (audio/zip/pdf/doc/… — anything not shown inline). */
export function audioFileItem(encryptQueryParam: string, aesKeyForApi: string, rawsize: number, filename: string): Record<string, unknown> {
  return {
    type: ITEM_FILE,
    file_item: {
      media: { encrypt_query_param: encryptQueryParam, aes_key: aesKeyForApi, encrypt_type: 1 },
      file_name: filename,
      len: String(rawsize), // plaintext size, as a STRING (a file_item quirk — image uses ciphertext size as int)
    },
  };
}

/** The sendmessage item for an inline image (shows in the chat, not as a file). mid_size = CIPHERTEXT size (int). */
export function imageInlineItem(encryptQueryParam: string, aesKeyForApi: string, ciphertextSize: number): Record<string, unknown> {
  return {
    type: ITEM_IMAGE,
    image_item: {
      media: { encrypt_query_param: encryptQueryParam, aes_key: aesKeyForApi, encrypt_type: 1 },
      mid_size: ciphertextSize,
    },
  };
}

/** First text item's text (iLink puts text under item_list[].text_item.text; voice falls back to type 3). */
export function extractText(itemList: unknown): string {
  if (!Array.isArray(itemList)) return "";
  for (const item of itemList) {
    if (item?.type === ITEM_TEXT) return str(item?.text_item?.text);
    if (item?.type === 3) return str(item?.voice_item?.text);
  }
  return "";
}

/** DM vs group: a room id (or a non-self to_user with msg_type 1) means group; else DM keyed by from_user_id. */
export function guessChatType(msg: any, accountId: string): { kind: "dm" | "group"; id: string } {
  const roomId = str(msg?.room_id ?? msg?.chat_room_id).trim();
  const toUserId = str(msg?.to_user_id).trim();
  const isGroup = !!roomId || (!!toUserId && !!accountId && toUserId !== accountId && msg?.msg_type === 1);
  if (isGroup) return { kind: "group", id: roomId || toUserId || str(msg?.from_user_id) };
  return { kind: "dm", id: str(msg?.from_user_id) };
}

/** Parse one inbound iLink message → InboundMsg + its context_token. null = skip (own echo / group / non-text). */
export function parseWeixinMessage(msg: any, accountId: string): { inbound: InboundMsg; contextToken: string } | null {
  const from = str(msg?.from_user_id).trim();
  if (!from || from === accountId) return null; // missing sender, or our own echo
  if (guessChatType(msg, accountId).kind !== "dm") return null; // v1 = text DM only
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  const text = extractText(items);
  if (!text) return null;
  // A voice message arrives as iLink's server-side transcription (voice_item.text). Prefix an explicit note —
  // NOT a bare "[voice message]" label, which hara misreads as raw audio it must process (and then disclaims).
  // This tells it the text is already transcribed so it just answers.
  const isVoice = !items.some((i: any) => i?.type === ITEM_TEXT) && items.some((i: any) => i?.type === 3);
  const tagged = isVoice ? `(The user sent this as a voice message; it is already transcribed to text below — just reply to it normally, you don't have or need the audio.)\n\n${text}` : text;
  const messageId = stableWeixinMessageId(msg?.message_id);
  const createdAtMs = weixinCreatedAtMs(msg?.create_time_ms);
  return {
    inbound: {
      chatId: from,
      userId: from,
      userName: from,
      text: tagged,
      ...(messageId ? { messageId } : {}),
      ...(createdAtMs === undefined ? {} : { createdAtMs }),
    },
    contextToken: str(msg?.context_token).trim(),
  };
}

/** iLink signals expiry via -14, or -2 + errmsg "unknown error" (a stale-session masquerading as rate-limit). */
export function isSessionExpired(ret: number, errcode: number, errmsg: string): boolean {
  if (ret === SESSION_EXPIRED || errcode === SESSION_EXPIRED) return true;
  if (ret !== RATE_LIMIT && errcode !== RATE_LIMIT) return false;
  return (errmsg || "").toLowerCase() === "unknown error";
}

// ── HTTP + state ──────────────────────────────────────────────────────────────

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(() => res(), ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return external && typeof anyFn === "function" ? anyFn([timeout, external]) : timeout;
}

async function apiPost(baseUrl: string, endpoint: string, payload: Record<string, unknown>, token: string | undefined, timeoutMs: number, external?: AbortSignal): Promise<any> {
  const body = envelope(payload);
  const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
  const res = await fetch(url, { method: "POST", body, headers: ilinkHeaders(token, body), signal: combineSignals(timeoutMs, external) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`iLink POST ${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`);
  return JSON.parse(raw);
}

async function apiGet(baseUrl: string, endpoint: string, timeoutMs: number): Promise<any> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
  const headers = { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`iLink GET ${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`);
  return JSON.parse(raw);
}

function weixinStateFile(filename: string): PrivateStateFileBinding {
  return bindPrivateHaraStateFile(homedir(), ["weixin"], filename);
}

function accountStateFilename(accountId: string, suffix: string): string {
  const normalized = String(accountId ?? "").trim();
  const key = /^[A-Za-z0-9_-]{1,128}$/.test(normalized)
    ? normalized
    : `account-${createHash("sha256").update(normalized).digest("hex")}`;
  return `${key}${suffix}`;
}

/** Return peer identifiers without exposing token values or bypassing the private-state reader. */
export function weixinKnownPeers(accountId: string): string[] {
  try {
    const binding = weixinStateFile(accountStateFilename(accountId, ".context-tokens.json"));
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, 8 * 1024 * 1024);
    if (!snapshot) return [];
    const parsed = JSON.parse(snapshot.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed)
      .slice(-1000)
      .filter(([peer, token]) => Boolean(peer) && typeof token === "string" && Boolean(token))
      .map(([peer]) => peer);
  } catch {
    return [];
  }
}

function validWeixinCredentials(value: unknown): value is WeixinCreds {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credentials = value as Partial<WeixinCreds>;
  return [credentials.account_id, credentials.token, credentials.base_url, credentials.user_id]
    .every((part) => typeof part === "string" && part.trim().length > 0);
}

/** Read-only credential probe. The public status mapper exposes only `state`; credentials stay inside the
 * gateway module and are used solely to derive the already-redacted runtime scope or start the adapter. */
export function inspectWeixinCredentials(): WeixinCredentialInspection {
  try {
    const binding = weixinStateFile("creds.json");
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, 1024 * 1024);
    if (!snapshot) return { state: "missing" };
    const credentials: unknown = JSON.parse(snapshot.text);
    return validWeixinCredentials(credentials)
      ? { state: "ready", credentials }
      : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

export function loadWeixinCreds(): WeixinCreds | null {
  const inspected = inspectWeixinCredentials();
  return inspected.state === "ready" ? inspected.credentials : null;
}
function saveWeixinCreds(c: WeixinCreds): void {
  writePrivateStateFileSync(weixinStateFile("creds.json"), JSON.stringify(c, null, 2) + "\n");
}

// get_updates_buf cursor — persisted so a restart resumes the message stream where it left off.
function loadCursor(accountId: string): string {
  try {
    const binding = weixinStateFile(accountStateFilename(accountId, ".cursor"));
    return readPrivateStateFileSnapshotSync(binding.path, 4 * 1024 * 1024)?.text ?? "";
  } catch {
    return "";
  }
}
function saveCursor(accountId: string, buf: string): void {
  try {
    const binding = weixinStateFile(accountStateFilename(accountId, ".cursor"));
    writePrivateStateFileSync(binding, buf);
  } catch {
    /* best-effort */
  }
}

// Per-peer context_token: every reply must echo the latest token iLink sent for that peer.
class TokenStore {
  private readonly cache = new Map<string, string>();
  constructor(private accountId: string) {
    try {
      const binding = this.binding();
      const snapshot = readPrivateStateFileSnapshotSync(binding.path, 8 * 1024 * 1024);
      const parsed = snapshot ? JSON.parse(snapshot.text) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [peer, token] of Object.entries(parsed).slice(-1000)) {
          if (peer && typeof token === "string" && token) this.cache.set(peer, token);
        }
      }
    } catch {
      this.cache.clear();
    }
  }
  private binding(): PrivateStateFileBinding {
    return weixinStateFile(accountStateFilename(this.accountId, ".context-tokens.json"));
  }
  private peerKey(peer: string): string {
    return String(peer ?? "").trim().slice(0, 256);
  }
  private persist(): void {
    try {
      writePrivateStateFileSync(this.binding(), JSON.stringify(Object.fromEntries(this.cache)) + "\n");
    } catch {
      /* best-effort */
    }
  }
  get(peer: string): string | undefined {
    const key = this.peerKey(peer);
    const token = this.cache.get(key);
    if (token) {
      this.cache.delete(key);
      this.cache.set(key, token);
    }
    return token;
  }
  set(peer: string, token: string): void {
    const key = this.peerKey(peer);
    const boundedToken = String(token ?? "").slice(0, 4096);
    if (key && boundedToken) {
      this.cache.delete(key);
      this.cache.set(key, boundedToken);
      while (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
      this.persist();
    }
  }
  del(peer: string): void {
    this.cache.delete(this.peerKey(peer));
    this.persist();
  }
}

async function renderQr(data: string): Promise<void> {
  try {
    const spec: string = "qrcode-terminal"; // optional dep; variable specifier so tsc doesn't require it at build time
    const mod = (await import(spec)) as any;
    const qr = mod.default ?? mod;
    console.error("\nScan this QR with WeChat (Me → … or Discover → Scan):\n");
    await new Promise<void>((res) => qr.generate(data, { small: true }, (s: string) => { console.error(s); res(); }));
  } catch {
    console.error(`\nScan this as a QR with WeChat — install 'qrcode-terminal' to render it inline, or paste this URL into any QR generator:\n${data}\n`);
  }
}

/** Interactive QR login → saves {account_id, token, base_url, user_id} to ~/.hara/weixin/creds.json. */
export async function weixinLogin(timeoutSeconds = 480): Promise<WeixinCreds | null> {
  let qr = await apiGet(ILINK_BASE_URL, `${EP.getBotQr}?bot_type=3`, QR_TIMEOUT_MS);
  let qrcodeValue = str(qr.qrcode);
  await renderQr(str(qr.qrcode_img_content) || qrcodeValue);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let baseUrl = ILINK_BASE_URL;
  let refreshes = 0;
  let lastStatus = "";
  while (Date.now() < deadline) {
    let st: any;
    try {
      st = await apiGet(baseUrl, `${EP.getQrStatus}?qrcode=${encodeURIComponent(qrcodeValue)}`, QR_TIMEOUT_MS);
    } catch {
      await sleep(1000);
      continue;
    }
    const status = str(st.status) || "wait";
    if (status !== lastStatus && status === "scaned") console.error("weixin login: scanned — confirm on your phone…");
    lastStatus = status;
    if (status === "confirmed") {
      const creds: WeixinCreds = {
        account_id: str(st.ilink_bot_id),
        token: str(st.bot_token),
        base_url: str(st.baseurl) || ILINK_BASE_URL,
        user_id: str(st.ilink_user_id),
      };
      if (!creds.account_id || !creds.token) {
        console.error("weixin login: confirmed but missing account_id/token");
        return null;
      }
      saveWeixinCreds(creds);
      console.error(`weixin login: ✓ logged in as ${creds.account_id} (base ${creds.base_url})`);
      return creds;
    }
    if (status === "scaned_but_redirect") {
      const host = str(st.redirect_host);
      if (host) baseUrl = `https://${host}`; // subsequent calls use the redirected host
    } else if (status === "expired") {
      if (++refreshes > 3) {
        console.error("weixin login: QR expired too many times — aborting");
        return null;
      }
      qr = await apiGet(ILINK_BASE_URL, `${EP.getBotQr}?bot_type=3`, QR_TIMEOUT_MS);
      qrcodeValue = str(qr.qrcode);
      baseUrl = ILINK_BASE_URL;
      await renderQr(str(qr.qrcode_img_content) || qrcodeValue);
    }
    await sleep(1000);
  }
  console.error("weixin login: timed out");
  return null;
}

async function sendChunk(creds: WeixinCreds, tokenStore: TokenStore, peer: string, text: string): Promise<void> {
  const clientId = `hara-weixin-${randomUUID().replace(/-/g, "")}`; // reused across the -14 retry for dedup
  const post = (ctx: string | undefined): Promise<any> =>
    apiPost(creds.base_url, EP.sendMessage, buildSendBody(peer, text, ctx, clientId), creds.token, API_TIMEOUT_MS).catch((e) => ({ ret: 1, errmsg: String(e?.message ?? e) }));
  let resp = await post(tokenStore.get(peer));
  // HARA_WX_DEBUG=1 → dump the raw send response (protocol exploration: does iLink return a message id we
  // could use for a future recall/revoke?). Off by default; stderr only.
  if (process.env.HARA_WX_DEBUG === "1") console.error("weixin send resp:", JSON.stringify(resp).slice(0, 500));
  let [ret, errcode, errmsg] = [num(resp.ret), num(resp.errcode), str(resp.errmsg ?? resp.msg)];
  if (isSessionExpired(ret, errcode, errmsg)) {
    tokenStore.del(peer); // stale → drop it and retry once tokenless (iLink accepts that, degraded)
    resp = await post(undefined);
    [ret, errcode, errmsg] = [num(resp.ret), num(resp.errcode), str(resp.errmsg ?? resp.msg)];
  }
  // Rate-limit (ret=-2, empty errmsg): iLink throttles cold/rapid proactive pushes. Back off and retry a few
  // times instead of silently dropping the message — the reused clientId dedups so a retry can't double-send.
  for (let attempt = 0; ret === RATE_LIMIT && errcode === 0 && attempt < 3; attempt++) {
    await sleep(1500 * (attempt + 1));
    resp = await post(tokenStore.get(peer));
    [ret, errcode, errmsg] = [num(resp.ret), num(resp.errcode), str(resp.errmsg ?? resp.msg)];
  }
  if (ret !== 0 || errcode !== 0) throw new Error(`weixin send failed: ret=${ret} errcode=${errcode} errmsg=${errmsg || "unknown error"}`);
}

function aes128EcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null); // PKCS7 auto-padding (Node default) matches iLink
  return Buffer.concat([c.update(plaintext), c.final()]);
}

// ── inbound media (receive a file/image/voice the user sent) ──────────────────

/** Parse an inbound `media.aes_key`: base64 → 16 raw bytes, OR base64 → 32-char ascii hex → hex-decode. */
export function parseAesKey(aesKeyB64: string): Buffer {
  const decoded = Buffer.from(aesKeyB64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new Error(`unexpected aes_key format (${decoded.length} bytes)`);
}

function aes128EcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null);
  d.setAutoPadding(false); // iLink's strip is conditional (tolerates non-PKCS7) — replicate it ourselves
  const padded = Buffer.concat([d.update(ciphertext), d.final()]);
  if (!padded.length) return padded;
  const pad = padded[padded.length - 1];
  if (pad >= 1 && pad <= 16 && padded.length >= pad) {
    let ok = true;
    for (let i = padded.length - pad; i < padded.length; i++) if (padded[i] !== pad) ok = false;
    if (ok) return padded.subarray(0, padded.length - pad);
  }
  return padded;
}

export interface InboundMediaRef {
  kind: "image" | "file" | "voice";
  encryptQueryParam?: string;
  fullUrl?: string;
  aesKeyB64?: string;
  fileName?: string;
}

/** Downloadable media items in an inbound message (pure). Skips voice that already carries a transcription. */
export function inboundMediaRefs(itemList: unknown): InboundMediaRef[] {
  const items = Array.isArray(itemList) ? itemList : [];
  const out: InboundMediaRef[] = [];
  for (const it of items) {
    if (it?.type === ITEM_IMAGE) {
      const media = it.image_item?.media ?? {};
      // image key hack: prefer image_item.aeskey (hex) re-encoded as base64(ascii(hex)); else media.aes_key
      const hex = str(it.image_item?.aeskey);
      const aesKeyB64 = (hex && Buffer.from(hex, "ascii").toString("base64")) || str(media.aes_key) || undefined;
      out.push({ kind: "image", encryptQueryParam: str(media.encrypt_query_param) || undefined, fullUrl: str(media.full_url) || undefined, aesKeyB64 });
    } else if (it?.type === ITEM_FILE) {
      const media = it.file_item?.media ?? {};
      out.push({ kind: "file", encryptQueryParam: str(media.encrypt_query_param) || undefined, fullUrl: str(media.full_url) || undefined, aesKeyB64: str(media.aes_key) || undefined, fileName: str(it.file_item?.file_name) || "document.bin" });
    } else if (it?.type === ITEM_VOICE && !str(it.voice_item?.text)) {
      const media = it.voice_item?.media ?? {};
      out.push({ kind: "voice", encryptQueryParam: str(media.encrypt_query_param) || undefined, fullUrl: str(media.full_url) || undefined, aesKeyB64: str(media.aes_key) || undefined });
    }
  }
  return out;
}

const cdnDownloadUrl = (param: string): string => `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(param)}`;

function assertCdnHost(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`unparseable media URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`disallowed scheme ${u.protocol}`);
  if (!WEIXIN_CDN_ALLOWLIST.has(u.hostname)) throw new Error(`host ${u.hostname} not in WeChat CDN allowlist (SSRF guard)`);
}

/** Download (+ AES-decrypt if keyed) an inbound media item to a local file. Returns its path + mime, or null. */
export async function downloadInboundMedia(
  ref: InboundMediaRef,
  options: { maxBytes: number; signal: AbortSignal } = {
    maxBytes: INBOUND_MEDIA_MAX_BYTES,
    signal: AbortSignal.timeout(INBOUND_MEDIA_TIMEOUT_MS),
  },
): Promise<{ path: string; mime: string } | null> {
  try {
    let url: string;
    if (ref.encryptQueryParam) url = cdnDownloadUrl(ref.encryptQueryParam);
    else if (ref.fullUrl) {
      assertCdnHost(ref.fullUrl);
      url = ref.fullUrl;
    } else return null;
    const res = await fetch(url, { signal: options.signal });
    if (!res.ok) throw new Error(`media download HTTP ${res.status}`);
    let buf = await readResponseBytesLimited(res, options.maxBytes, options.signal);
    if (ref.aesKeyB64) buf = aes128EcbDecrypt(buf, parseAesKey(ref.aesKeyB64));
    if (!buf.length) return null;
    const filenameHint = ref.kind === "image" ? "image.jpg" : ref.kind === "voice" ? "audio.silk" : ref.fileName || "document.bin";
    const path = await savePrivateMediaBytes(buf, {
      platform: "weixin",
      filenameHint,
      ...options,
    });
    return { path, mime: ref.kind === "image" ? "image/jpeg" : ref.kind === "voice" ? "audio/silk" : "application/octet-stream" };
  } catch (e) {
    console.error(`weixin inbound media (${ref.kind}): ${(e as Error)?.message ?? e}`);
    return null;
  }
}

async function cdnUpload(uploadUrl: string, ciphertext: Buffer): Promise<string> {
  const res = await fetch(uploadUrl, { method: "POST", body: new Uint8Array(ciphertext), headers: { "Content-Type": "application/octet-stream" }, signal: AbortSignal.timeout(120_000) });
  await res.arrayBuffer().catch(() => undefined); // drain body
  if (!res.ok) throw new Error(`CDN upload HTTP ${res.status}`);
  const ep = res.headers.get("x-encrypted-param");
  if (!ep) throw new Error("CDN upload missing x-encrypted-param header");
  return ep;
}

/** Send already-verified bytes to a peer. Images go inline (image_item); everything else (audio/zip/pdf/doc/…) goes as a
 *  file attachment (file_item) carrying the filename. Ported byte-exact from iLink's media protocol:
 *  getuploadurl → AES-128-ECB encrypt → CDN POST → sendmessage(item). */
export async function sendMediaFile(creds: WeixinCreds, tokenStore: TokenStore, peer: string, file: OutboundFilePayload): Promise<boolean> {
  try {
    const plaintext = file.bytes;
    const rawsize = plaintext.length;
    const isImage = IMAGE_EXTS.has((file.safeName.split(".").pop() || "").toLowerCase());
    const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
    const filekey = randomBytes(16).toString("hex");
    const key = randomBytes(16);
    const keyHex = key.toString("hex");
    const filesize = Math.ceil((rawsize + 1) / 16) * 16; // AES-padded size == ciphertext length
    const up = await apiPost(creds.base_url, EP.getUploadUrl, { filekey, media_type: isImage ? MEDIA_IMAGE : MEDIA_FILE, to_user_id: peer, rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: keyHex }, creds.token, API_TIMEOUT_MS);
    const ciphertext = aes128EcbEncrypt(plaintext, key);
    const fullUrl = str(up.upload_full_url);
    const param = str(up.upload_param);
    const uploadUrl = fullUrl || (param ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}` : "");
    if (!uploadUrl) throw new Error("getuploadurl returned neither upload_full_url nor upload_param");
    const encryptedParam = await cdnUpload(uploadUrl, ciphertext);
    const item = isImage
      ? imageInlineItem(encryptedParam, apiAesKey(keyHex), ciphertext.length)
      : audioFileItem(encryptedParam, apiAesKey(keyHex), rawsize, file.safeName);
    const clientId = `hara-weixin-${randomUUID().replace(/-/g, "")}`; // reused across the -14 retry for dedup
    const send = (ctx: string | undefined): Promise<any> => {
      const msg: Record<string, unknown> = { from_user_id: "", to_user_id: peer, client_id: clientId, message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH, item_list: [item] };
      if (ctx) msg.context_token = ctx;
      return apiPost(creds.base_url, EP.sendMessage, { msg }, creds.token, API_TIMEOUT_MS);
    };
    let res = await send(tokenStore.get(peer));
    let [ret, errcode, errmsg] = [num(res.ret), num(res.errcode), str(res.errmsg ?? res.msg)];
    if (isSessionExpired(ret, errcode, errmsg)) {
      tokenStore.del(peer);
      res = await send(undefined); // tokenless retry (degraded fallback iLink accepts)
      [ret, errcode, errmsg] = [num(res.ret), num(res.errcode), str(res.errmsg ?? res.msg)];
    }
    if (ret !== 0 || errcode !== 0) {
      console.error(`weixin sendMedia: ret=${ret} errcode=${errcode} errmsg=${errmsg}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`weixin sendMedia: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

export function weixinAdapter(creds: WeixinCreds): ChatAdapter {
  const tokenStore = new TokenStore(creds.account_id);
  // Reuse parseWeixinMessage for text/voice-transcription, then download any image/file/voice media and append
  // a `[kind: localpath]` reference so hara can read the file. Handles media-only messages (no text) too.
  const buildInbound = async (
    msg: any,
    signal: AbortSignal,
    shouldDownload?: (m: InboundMsg) => boolean,
  ): Promise<InboundMsg | null> => {
    const parsed = parseWeixinMessage(msg, creds.account_id);
    const from = str(msg?.from_user_id).trim();
    if (!from || from === creds.account_id) return null;
    const chat = guessChatType(msg, creds.account_id);
    const refs = inboundMediaRefs(msg?.item_list);
    let text = parsed?.inbound.text ?? extractText(msg?.item_list);
    const base: InboundMsg = {
      chatId: chat.id,
      userId: from,
      userName: from,
      text: text || (refs.some((ref) => ref.kind === "image") ? "[图片]" : refs.length ? "[附件]" : ""),
      chatType: chat.kind === "dm" ? "p2p" : "group",
    };
    if (!base.text) return null;
    const downloadAllowed = base.chatType === "p2p" && shouldDownload?.(base) === true;
    // Persist context only for an authenticated DM, before any download. Rejected senders cannot grow state.
    if (downloadAllowed) tokenStore.set(from, parsed?.contextToken || str(msg?.context_token).trim());
    const images: string[] = [];
    const transientFiles: string[] = [];
    let handedOff = false;
    try {
      if (downloadAllowed) {
        const budget = new InboundMediaBudget("weixin", signal);
        for (const ref of refs) {
          let downloaded: { path: string; mime: string } | null = null;
          const path = await budget.download(async (options) => {
            downloaded = await downloadInboundMedia(ref, options);
            return downloaded?.path ?? null;
          });
          if (!path || !downloaded) continue;
          transientFiles.push(path);
          if (ref.kind === "image") {
            // images go through as real attachments (seen/described downstream); leave only a light marker in text
            images.push(path);
            if (text !== "[图片]") text += `${text ? "\n" : ""}[图片]`;
          } else {
            const label = ref.kind === "voice" ? "语音" : `文件 ${ref.fileName ?? ""}`.trim();
            text = text === "[附件]" ? `[${label}: ${path}]` : `${text}${text ? "\n" : ""}[${label}: ${path}]`;
          }
        }
      }
      const inbound: InboundMsg = {
        ...base,
        text: text.trim() || base.text,
        images: images.length ? images : undefined,
        transientFiles: transientFiles.length ? transientFiles : undefined,
      };
      handedOff = true;
      return inbound;
    } finally {
      if (!handedOff && transientFiles.length) await cleanupTransientMedia("weixin", transientFiles);
    }
  };
  return {
    name: "weixin",
    async send(chatId, text) {
      const peer = String(chatId);
      for (const part of chunkText(text || "(empty)")) await sendChunk(creds, tokenStore, peer, part);
    },
    async sendFile(chatId, file) {
      if (!(await sendMediaFile(creds, tokenStore, String(chatId), file))) throw new Error(`weixin file delivery failed: ${file.safeName}`);
    },
    async start(onMessage, signal, shouldDownload, runtime) {
      let buf = loadCursor(creds.account_id);
      let pollMs = LONG_POLL_TIMEOUT_MS;
      while (!signal.aborted) {
        let resp: any;
        try {
          // client timeout is a touch longer than the server long-poll so an empty batch returns before we abort
          resp = await apiPost(creds.base_url, EP.getUpdates, { get_updates_buf: buf }, creds.token, pollMs + 5_000, signal);
        } catch {
          if (signal.aborted) break;
          runtime?.error("network");
          await sleep(2000, signal); // timeout (normal) or network blip → re-poll
          continue;
        }
        const ret = num(resp.ret);
        const errcode = num(resp.errcode);
        if (isSessionExpired(ret, errcode, str(resp.errmsg))) {
          runtime?.error("session-expired");
          console.error("weixin: session expired — re-login with `hara gateway --platform weixin --login`. backing off 600s.");
          await sleep(600_000, signal);
          continue;
        }
        if (ret !== 0 || errcode !== 0) {
          runtime?.error("platform-error");
          await sleep(2000, signal);
          continue;
        }
        runtime?.poll();
        buf = str(resp.get_updates_buf) || buf;
        saveCursor(creds.account_id, buf);
        for (const msg of Array.isArray(resp.msgs) ? resp.msgs : []) {
          const inbound = await buildInbound(msg, signal, shouldDownload);
          if (inbound) await onMessage(inbound).catch(() => {});
        }
        const lp = num(resp.longpolling_timeout_ms);
        pollMs = lp > 0 ? lp : LONG_POLL_TIMEOUT_MS;
      }
    },
  };
}
