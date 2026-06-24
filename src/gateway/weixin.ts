// WeChat (personal) adapter for `hara gateway`, via Tencent's official iLink bot API
// (ilinkai.weixin.qq.com). Text-DM happy path: QR login → long-poll getupdates → sendmessage.
// Ported from the documented iLink wire protocol. Built-in fetch; QR rendering uses the optional
// `qrcode-terminal` dep (graceful fallback to printing the URL). No encryption is needed on the text path
// (iLink only uses crypto for media upload/download, which v1 doesn't do).
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0); // 131584

const EP = {
  getUpdates: "ilink/bot/getupdates",
  sendMessage: "ilink/bot/sendmessage",
  getBotQr: "ilink/bot/get_bot_qrcode",
  getQrStatus: "ilink/bot/get_qrcode_status",
};

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const QR_TIMEOUT_MS = 35_000;
const SESSION_EXPIRED = -14;
const RATE_LIMIT = -2;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;

export interface WeixinCreds {
  account_id: string;
  token: string;
  base_url: string;
  user_id: string;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (v == null ? "" : String(v));

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
  const text = extractText(msg?.item_list);
  if (!text) return null;
  return { inbound: { chatId: from, userId: from, userName: from, text }, contextToken: str(msg?.context_token).trim() };
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

const weixinDir = (): string => join(homedir(), ".hara", "weixin");
const credsFile = (): string => join(weixinDir(), "creds.json");

export function loadWeixinCreds(): WeixinCreds | null {
  try {
    return existsSync(credsFile()) ? (JSON.parse(readFileSync(credsFile(), "utf8")) as WeixinCreds) : null;
  } catch {
    return null;
  }
}
function saveWeixinCreds(c: WeixinCreds): void {
  mkdirSync(weixinDir(), { recursive: true });
  writeFileSync(credsFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

// get_updates_buf cursor — persisted so a restart resumes the message stream where it left off.
function loadCursor(accountId: string): string {
  try {
    const f = join(weixinDir(), `${accountId}.cursor`);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  } catch {
    return "";
  }
}
function saveCursor(accountId: string, buf: string): void {
  try {
    mkdirSync(weixinDir(), { recursive: true });
    writeFileSync(join(weixinDir(), `${accountId}.cursor`), buf);
  } catch {
    /* best-effort */
  }
}

// Per-peer context_token: every reply must echo the latest token iLink sent for that peer.
class TokenStore {
  private cache: Record<string, string> = {};
  constructor(private accountId: string) {
    try {
      if (existsSync(this.file())) this.cache = JSON.parse(readFileSync(this.file(), "utf8"));
    } catch {
      this.cache = {};
    }
  }
  private file(): string {
    return join(weixinDir(), `${this.accountId}.context-tokens.json`);
  }
  private persist(): void {
    try {
      mkdirSync(weixinDir(), { recursive: true });
      writeFileSync(this.file(), JSON.stringify(this.cache));
    } catch {
      /* best-effort */
    }
  }
  get(peer: string): string | undefined {
    return this.cache[peer] || undefined;
  }
  set(peer: string, token: string): void {
    if (token) {
      this.cache[peer] = token;
      this.persist();
    }
  }
  del(peer: string): void {
    delete this.cache[peer];
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
  let [ret, errcode, errmsg] = [num(resp.ret), num(resp.errcode), str(resp.errmsg ?? resp.msg)];
  if (isSessionExpired(ret, errcode, errmsg)) {
    tokenStore.del(peer); // stale → drop it and retry once tokenless (iLink accepts that, degraded)
    resp = await post(undefined);
    [ret, errcode, errmsg] = [num(resp.ret), num(resp.errcode), str(resp.errmsg ?? resp.msg)];
  }
  if (ret !== 0 || errcode !== 0) console.error(`weixin send: ret=${ret} errcode=${errcode} errmsg=${errmsg}`);
}

export function weixinAdapter(creds: WeixinCreds): ChatAdapter {
  const tokenStore = new TokenStore(creds.account_id);
  return {
    name: "weixin",
    async send(chatId, text) {
      const peer = String(chatId);
      for (const part of chunkText(text || "(empty)")) await sendChunk(creds, tokenStore, peer, part);
    },
    async start(onMessage, signal) {
      let buf = loadCursor(creds.account_id);
      let pollMs = LONG_POLL_TIMEOUT_MS;
      while (!signal.aborted) {
        let resp: any;
        try {
          // client timeout is a touch longer than the server long-poll so an empty batch returns before we abort
          resp = await apiPost(creds.base_url, EP.getUpdates, { get_updates_buf: buf }, creds.token, pollMs + 5_000, signal);
        } catch {
          if (signal.aborted) break;
          await sleep(2000, signal); // timeout (normal) or network blip → re-poll
          continue;
        }
        const ret = num(resp.ret);
        const errcode = num(resp.errcode);
        if (isSessionExpired(ret, errcode, str(resp.errmsg))) {
          console.error("weixin: session expired — re-login with `hara gateway --platform weixin --login`. backing off 600s.");
          await sleep(600_000, signal);
          continue;
        }
        if (ret !== 0 || errcode !== 0) {
          await sleep(2000, signal);
          continue;
        }
        buf = str(resp.get_updates_buf) || buf;
        saveCursor(creds.account_id, buf);
        for (const msg of Array.isArray(resp.msgs) ? resp.msgs : []) {
          const parsed = parseWeixinMessage(msg, creds.account_id);
          if (!parsed) continue;
          tokenStore.set(String(parsed.inbound.userId), parsed.contextToken);
          await onMessage(parsed.inbound).catch(() => {});
        }
        const lp = num(resp.longpolling_timeout_ms);
        pollMs = lp > 0 ? lp : LONG_POLL_TIMEOUT_MS;
      }
    },
  };
}
