// WeCom (企业微信 / Enterprise WeChat) adapter for `hara gateway` — connects to WeCom's AI Bot WebSocket gateway
// (wss://openws.work.weixin.qq.com) over Node's native global WebSocket (zero new dep on Node ≥ 22) so the LOCAL
// daemon dials OUT: NO public webhook / callback endpoint is required, exactly like Discord/DingTalk/Feishu's
// long-connection mode. Creds from HARA_WECOM_BOT_ID / HARA_WECOM_SECRET (the AI Bot's id + secret from the WeCom
// admin console). Same ChatAdapter shape as Telegram/Discord, so all the cross-platform gateway plumbing (system
// context, stuck-guard, allowlist, send_file, voice) works unchanged.
//
// Protocol (ported from the Hermes Python adapter): authenticate with an `aibot_subscribe` frame → receive
// `aibot_msg_callback` events → reply with `aibot_send_msg` → upload media via the 3-step `aibot_upload_media_*`
// chunked protocol → AES-256-CBC decrypt inbound media that carries an `aeskey`. Every request frame carries a
// `headers.req_id` and the server echoes it back so request/response are correlated. v1 limitations are documented
// at the bottom of this file (the public spec is thin — fields are best-effort and tolerant of shape drift).
import { basename, extname } from "node:path";
import { randomUUID, createDecipheriv, createHash } from "node:crypto";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";
import { InboundMediaBudget, decodeBase64Media, readResponseBytesLimited, savePrivateMediaBytes } from "./media.js";
import type { OutboundFilePayload } from "./outbound-files.js";

const DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
const WSImpl: any = (globalThis as any).WebSocket;

// app-level command verbs on the AI Bot gateway (mirror the Hermes constants)
const CMD_SUBSCRIBE = "aibot_subscribe";
const CMD_CALLBACK = "aibot_msg_callback";
const CMD_LEGACY_CALLBACK = "aibot_callback";
const CMD_EVENT_CALLBACK = "aibot_event_callback";
const CMD_SEND = "aibot_send_msg";
const CMD_PING = "ping";
const CMD_UPLOAD_INIT = "aibot_upload_media_init";
const CMD_UPLOAD_CHUNK = "aibot_upload_media_chunk";
const CMD_UPLOAD_FINISH = "aibot_upload_media_finish";

const CALLBACK_CMDS = new Set([CMD_CALLBACK, CMD_LEGACY_CALLBACK]);
const MAX_MESSAGE_LENGTH = 4000;
const HEARTBEAT_MS = 30000;
const REQUEST_TIMEOUT_MS = 15000;
const UPLOAD_CHUNK_SIZE = 512 * 1024; // 512 KB chunks (WeCom upload protocol)
const ABSOLUTE_MAX_BYTES = 20 * 1024 * 1024; // WeCom hard cap on any upload

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** A downloadable inbound media item pulled out of a WeCom callback body (pure). `aesKeyB64` present → the bytes at
 *  `url` are AES-256-CBC encrypted and must be decrypted; `base64` present → the bytes are inline. */
export interface WecomMediaRef {
  kind: "image" | "file";
  url?: string;
  base64?: string;
  aesKeyB64?: string;
  fileName?: string;
}

/** Detect an image extension from magic bytes (pure) — used when WeCom doesn't give us a filename. */
function imageExtFromBytes(data: Buffer): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ".png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return ".gif";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return ".jpg";
}

/** AES-256-CBC decrypt WeCom-encrypted media (pure). The 32-byte key is the base64-decoded `aeskey`; the IV is the
 *  first 16 bytes of that key; padding is PKCS#7 (validated leniently, like the Hermes reference). */
export function decryptWecomMedia(ciphertext: Buffer, aesKeyB64: string): Buffer {
  const key = Buffer.from(aesKeyB64, "base64");
  if (key.length !== 32) throw new Error(`unexpected WeCom aes_key length: ${key.length} (expected 32)`);
  const d = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  d.setAutoPadding(false); // strip PKCS#7 ourselves so a non-conformant tail doesn't throw
  const padded = Buffer.concat([d.update(ciphertext), d.final()]);
  if (!padded.length) return padded;
  const pad = padded[padded.length - 1];
  if (pad >= 1 && pad <= 32 && padded.length >= pad) {
    let ok = true;
    for (let i = padded.length - pad; i < padded.length; i++) if (padded[i] !== pad) ok = false;
    if (ok) return padded.subarray(0, padded.length - pad);
  }
  return padded;
}

/** Pull the plain text out of a WeCom callback body (pure). Handles `text`, `voice` (transcription), and `mixed`
 *  (text + image runs) message types — joining all text runs with newlines. */
function extractWecomText(body: any): string {
  const parts: string[] = [];
  const msgtype = String(body?.msgtype ?? "").toLowerCase();
  if (msgtype === "mixed") {
    const items = Array.isArray(body?.mixed?.msg_item) ? body.mixed.msg_item : [];
    for (const it of items) {
      if (String(it?.msgtype ?? "").toLowerCase() === "text") {
        const c = String(it?.text?.content ?? "").trim();
        if (c) parts.push(c);
      }
    }
  } else {
    const c = String(body?.text?.content ?? "").trim();
    if (c) parts.push(c);
    if (msgtype === "voice") {
      const v = String(body?.voice?.content ?? "").trim(); // voice transcription, when present
      if (v) parts.push(v);
    }
  }
  return parts.join("\n").trim();
}

/** Collect downloadable media refs from a WeCom callback body (pure). Covers top-level `image`/`file` and the image
 *  runs inside a `mixed` message. */
function extractWecomMedia(body: any): WecomMediaRef[] {
  const refs: WecomMediaRef[] = [];
  const pushMedia = (kind: "image" | "file", m: any): void => {
    if (!m || typeof m !== "object") return;
    refs.push({
      kind,
      url: typeof m.url === "string" ? m.url : undefined,
      base64: typeof m.base64 === "string" ? m.base64 : undefined,
      aesKeyB64: typeof m.aeskey === "string" ? m.aeskey : undefined,
      fileName: typeof m.filename === "string" ? m.filename : typeof m.name === "string" ? m.name : undefined,
    });
  };
  const msgtype = String(body?.msgtype ?? "").toLowerCase();
  if (msgtype === "mixed") {
    const items = Array.isArray(body?.mixed?.msg_item) ? body.mixed.msg_item : [];
    for (const it of items) if (String(it?.msgtype ?? "").toLowerCase() === "image") pushMedia("image", it.image);
  } else {
    if (body?.image) pushMedia("image", body.image);
    if (msgtype === "file" && body?.file) pushMedia("file", body.file);
  }
  return refs;
}

/** Parse a WeCom `aibot_msg_callback` payload → InboundMsg + its downloadable media refs (pure; the actual download
 *  happens in start()). `selfBotId` filters out the bot's own echoes. null = ignore (own message / empty / no chat
 *  id). chatId is the WeCom chatid (group) else the sender's userid (DM); userId/userName are the sender's userid.
 *  Mirrors parseDiscordMessage. */
export function parseWecomMessage(
  payload: any,
  selfBotId: string,
): { msg: InboundMsg; media: WecomMediaRef[] } | null {
  const body = payload?.body;
  if (!body || typeof body !== "object") return null;

  const sender = typeof body.from === "object" && body.from ? body.from : {};
  const senderId = String(sender.userid ?? "").trim();
  // ignore our own messages (the bot speaking) so we never loop on our replies
  if (selfBotId && senderId && senderId === selfBotId) return null;
  if (selfBotId && String(body.bot_id ?? body.botid ?? "").trim() === selfBotId && !senderId) return null;

  const chatId = String(body.chatid ?? senderId).trim();
  if (!chatId) return null;

  const text = extractWecomText(body);
  const media = extractWecomMedia(body);
  if (!text && !media.length) return null; // unsupported type or empty

  // WeCom AI Bot callbacks use chattype="single" or "group". Only the explicit single value proves a DM;
  // missing/unknown types fail closed as group even when chatid happens to be absent.
  const chatType = String(body.chattype ?? "").trim().toLowerCase() === "single" ? "p2p" : "group";

  return {
    msg: {
      chatId,
      userId: senderId || chatId,
      userName: String(sender.name ?? sender.userid ?? senderId ?? chatId),
      text: text || "[图片]",
      chatType,
    },
    media,
  };
}

/** Download (and AES-decrypt if needed) a WeCom inbound media ref → a local path under ~/.hara/wecom/media. null on
 *  failure. Inline base64 and remote (optionally encrypted) urls are both handled. */
async function downloadWecomMedia(
  ref: WecomMediaRef,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<string | null> {
  try {
    let data: Buffer | null = null;
    if (ref.base64) {
      data = decodeBase64Media(ref.base64, options.maxBytes);
    } else if (ref.url) {
      const r = await fetch(ref.url, { signal: options.signal });
      if (!r.ok) return null;
      data = await readResponseBytesLimited(r, options.maxBytes, options.signal);
    }
    if (!data || !data.length) return null;
    if (ref.aesKeyB64) data = decryptWecomMedia(data, ref.aesKeyB64);
    if (!data.length || data.length > options.maxBytes) return null;
    let name = ref.fileName ? basename(ref.fileName) : "";
    if (!name || (ref.kind === "image" && !extname(name))) name = `image${imageExtFromBytes(data)}`;
    return await savePrivateMediaBytes(data, {
      platform: "wecom",
      filenameHint: name || "file.bin",
      ...options,
    });
  } catch {
    return null;
  }
}

export function wecomAdapter(botId: string, secret: string, wsUrl: string = DEFAULT_WS_URL): ChatAdapter {
  // per-connection request/response correlation lives inside connectOnce; send/sendFile use the live socket handle
  // it publishes through `conn`.
  const conn: { send: ((cmd: string, body: any) => Promise<any>) | null } = { send: null };

  // Upload already-verified bytes to WeCom via the 3-step chunked protocol → its media_id.
  async function uploadMedia(file: OutboundFilePayload, mediaType: "image" | "file"): Promise<string> {
    if (!conn.send) throw new Error("WeCom socket not connected");
    const data = file.bytes;
    if (data.length > ABSOLUTE_MAX_BYTES) throw new Error(`file exceeds WeCom 20MB limit: ${data.length} bytes`);
    const totalChunks = Math.max(1, Math.ceil(data.length / UPLOAD_CHUNK_SIZE));
    const init = await conn.send(CMD_UPLOAD_INIT, {
      type: mediaType,
      filename: file.safeName,
      total_size: data.length,
      total_chunks: totalChunks,
      md5: createHash("md5").update(data).digest("hex"),
    });
    const uploadId = String(init?.body?.upload_id ?? "").trim();
    if (!uploadId) throw new Error(`media upload init returned no upload_id (${JSON.stringify(init?.errmsg ?? init)})`);
    for (let i = 0, start = 0; start < data.length || i === 0; i++, start += UPLOAD_CHUNK_SIZE) {
      const chunk = data.subarray(start, start + UPLOAD_CHUNK_SIZE);
      await conn.send(CMD_UPLOAD_CHUNK, { upload_id: uploadId, chunk_index: i, base64_data: chunk.toString("base64") });
      if (start + UPLOAD_CHUNK_SIZE >= data.length) break;
    }
    const fin = await conn.send(CMD_UPLOAD_FINISH, { upload_id: uploadId });
    const mediaId = String(fin?.body?.media_id ?? "").trim();
    if (!mediaId) throw new Error(`media upload finish returned no media_id (${JSON.stringify(fin?.errmsg ?? fin)})`);
    return mediaId;
  }

  return {
    name: "wecom",
    async send(chatId, text) {
      if (!conn.send) return; // no live socket yet → nothing to reply through
      for (const part of chunkText(text || "(empty)", MAX_MESSAGE_LENGTH)) {
        await conn
          .send(CMD_SEND, { chatid: String(chatId), msgtype: "markdown", markdown: { content: part } })
          .catch(() => {});
      }
    },
    async sendFile(chatId, file) {
      if (!conn.send) return;
      const mediaType: "image" | "file" = isImageName(file.safeName) ? "image" : "file";
      try {
        const mediaId = await uploadMedia(file, mediaType);
        await conn.send(CMD_SEND, { chatid: String(chatId), msgtype: mediaType, [mediaType]: { media_id: mediaId } });
      } catch {
        /* upload/send failed — caller surfaces a generic failure; nothing else to do */
      }
    },
    async start(onMessage, signal, shouldDownload) {
      if (!WSImpl) {
        console.error("hara gateway: WeCom needs Node ≥ 22 (global WebSocket). Upgrade Node.");
        return;
      }
      while (!signal.aborted) {
        await connectOnce(botId, secret, wsUrl, conn, onMessage, signal, shouldDownload);
        if (!signal.aborted) await sleep(3000, signal); // reconnect backoff
      }
    },
  };
}

/** One gateway connection: open WS → `aibot_subscribe` auth → correlate request/response by req_id, dispatch
 *  `aibot_msg_callback` events, heartbeat with `ping`. Resolves on close/abort; the caller reconnects (fresh
 *  subscribe each time — v1 keeps it simple, no resume). */
function connectOnce(
  botId: string,
  secret: string,
  wsUrl: string,
  conn: { send: ((cmd: string, body: any) => Promise<any>) | null },
  onMessage: (m: InboundMsg) => Promise<void>,
  signal: AbortSignal,
  shouldDownload?: (m: InboundMsg) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WSImpl(wsUrl);
    let hb: ReturnType<typeof setInterval> | null = null;
    const pending = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();
    const seen = new Set<string>(); // msgid dedup within this connection (network hiccups can re-deliver)

    const sendRaw = (frame: any): void => {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* socket gone — close handler resolves */
      }
    };
    // Send a request and await the frame whose headers.req_id matches; times out so callers never hang.
    const request = (cmd: string, body: any): Promise<any> =>
      new Promise((res) => {
        const reqId = `${cmd}-${randomUUID()}`;
        const timer = setTimeout(() => {
          pending.delete(reqId);
          res({ errcode: -1, errmsg: "timeout" });
        }, REQUEST_TIMEOUT_MS);
        pending.set(reqId, { resolve: res, timer });
        sendRaw({ cmd, headers: { req_id: reqId }, body });
      });

    const cleanup = (): void => {
      if (hb) clearInterval(hb);
      signal.removeEventListener("abort", stop);
      for (const { resolve: r, timer } of pending.values()) {
        clearTimeout(timer);
        r({ errcode: -1, errmsg: "connection closed" });
      }
      pending.clear();
      if (conn.send === request) conn.send = null;
    };
    const stop = (): void => {
      cleanup();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });

    ws.addEventListener("open", () => {
      // Authenticate, then publish this socket's request() so send/sendFile can use it; heartbeat keeps it alive.
      sendRaw({ cmd: CMD_SUBSCRIBE, headers: { req_id: `subscribe-${randomUUID()}` }, body: { bot_id: botId, secret } });
      conn.send = request;
      hb = setInterval(() => sendRaw({ cmd: CMD_PING, headers: { req_id: `ping-${randomUUID()}` }, body: {} }), HEARTBEAT_MS);
    });
    ws.addEventListener("close", () => {
      cleanup();
      resolve();
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("message", async (ev: any) => {
      // Native WebSocket may hand us a string, an ArrayBuffer, or a Blob — normalize to text first.
      let raw: string;
      const d = ev?.data;
      if (typeof d === "string") raw = d;
      else if (d instanceof ArrayBuffer) raw = Buffer.from(d).toString("utf8");
      else if (typeof d?.arrayBuffer === "function") raw = Buffer.from(await d.arrayBuffer()).toString("utf8");
      else raw = String(d ?? "");

      let p: any;
      try {
        p = JSON.parse(raw);
      } catch {
        return;
      }
      const cmd = String(p?.cmd ?? "");
      const reqId = String(p?.headers?.req_id ?? "");

      // A correlated response to one of our requests (and not itself a callback) → resolve the waiter.
      if (reqId && pending.has(reqId) && !CALLBACK_CMDS.has(cmd)) {
        const waiter = pending.get(reqId)!;
        clearTimeout(waiter.timer);
        pending.delete(reqId);
        waiter.resolve(p);
        return;
      }
      if (cmd === CMD_PING || cmd === CMD_EVENT_CALLBACK) return; // server ping / event ack → ignore
      if (!CALLBACK_CMDS.has(cmd)) return; // pre-auth / unknown frame → ignore

      const msgId = String(p?.body?.msgid ?? reqId ?? "");
      if (msgId) {
        if (seen.has(msgId)) return; // duplicate delivery → drop
        seen.add(msgId);
        if (seen.size > 1000) seen.clear();
      }
      const parsed = parseWecomMessage(p, botId);
      if (parsed) {
        if (shouldDownload?.(parsed.msg) === true) {
          const budget = new InboundMediaBudget("wecom", signal);
          for (const ref of parsed.media) {
            const path = await budget.download((options) => downloadWecomMedia(ref, options));
            if (path) {
              (parsed.msg.images ??= []).push(path);
              (parsed.msg.transientFiles ??= []).push(path);
            }
          }
        }
        await onMessage(parsed.msg).catch(() => {});
      }
    });
  });
}
