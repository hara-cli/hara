// WeCom (企业微信 / Enterprise WeChat) adapter for `hara gateway`.
//
// Hara connects out to WeCom's AI Bot WebSocket gateway, so no public webhook is required. The transport
// deliberately stays small, but follows the same lifecycle as WeCom's official Node SDK: subscribe and wait
// for the auth ACK, monitor heartbeat ACKs, reconnect with bounded backoff, correlate every request, and stop
// reconnecting when `disconnected_event` says another connection has replaced this one.
import { basename, extname } from "node:path";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import {
  chunkText,
  outboundTransferTimeoutMs,
  PerChatOutboundLane,
  withOutboundDeadline,
  type ChatAdapter,
  type InboundMsg,
} from "./telegram.js";
import {
  InboundMediaBudget,
  cleanupTransientMedia,
  decodeBase64Media,
  readResponseBytesLimited,
  savePrivateMediaBytes,
} from "./media.js";
import type { OutboundFilePayload } from "./outbound-files.js";

const DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com";
const WSImpl: any = (globalThis as any).WebSocket;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

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
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_AUTH_FAILURES = 5;
const MAX_MISSED_HEARTBEATS = 2;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 512 * 1024;
const MAX_UPLOAD_CHUNK_RETRIES = 2;
const ABSOLUTE_MAX_BYTES = 20 * 1024 * 1024;

export interface WecomTransportOptions {
  /** Per-frame request/auth ACK timeout. Intended mainly for deterministic local protocol tests. */
  requestTimeoutMs?: number;
  /** Heartbeat interval. Two missed ACKs force a reconnect. */
  heartbeatMs?: number;
  /** Initial reconnect delay; retries use exponential backoff. */
  reconnectBaseMs?: number;
  /** Hard reconnect-delay ceiling. */
  reconnectMaxMs?: number;
  /** Repeated credential failures eventually stop the daemon instead of looping forever. */
  maxAuthFailures?: number;
}

interface ResolvedWecomTransportOptions {
  requestTimeoutMs: number;
  heartbeatMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maxAuthFailures: number;
}

type WecomRequest = (cmd: string, body: unknown, signal?: AbortSignal) => Promise<any>;
type LiveConnection = { send: WecomRequest | null };
type ConnectReason = "closed" | "auth-failed" | "superseded" | "aborted";
interface ConnectOutcome {
  reason: ConnectReason;
  authenticated: boolean;
  detail?: string;
}

interface PendingRequest {
  command: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function resolveTransportOptions(options: WecomTransportOptions = {}): ResolvedWecomTransportOptions {
  const reconnectBaseMs = boundedInteger(options.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS, 10, 60_000);
  return {
    requestTimeoutMs: boundedInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 50, 60_000),
    heartbeatMs: boundedInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, 50, 300_000),
    reconnectBaseMs,
    reconnectMaxMs: Math.max(
      reconnectBaseMs,
      boundedInteger(options.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS, 10, 300_000),
    ),
    maxAuthFailures: boundedInteger(options.maxAuthFailures, DEFAULT_MAX_AUTH_FAILURES, 1, 20),
  };
}

function signalError(signal: AbortSignal | undefined, fallback: string): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw signalError(signal, `${label} cancelled`);
}

function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signalError(signal, "WeCom operation cancelled"));
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signalError(signal, "WeCom operation cancelled"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function reconnectDelay(attempt: number, options: ResolvedWecomTransportOptions): number {
  return Math.min(options.reconnectMaxMs, options.reconnectBaseMs * (2 ** Math.max(0, attempt - 1)));
}

function protocolText(value: unknown, secret: string): string {
  let text = String(value ?? "unknown error").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 240);
  if (secret) text = text.split(secret).join("[redacted]");
  return text || "unknown error";
}

const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** A downloadable inbound media item extracted from a WeCom callback body. */
export interface WecomMediaRef {
  kind: "image" | "file" | "video";
  url?: string;
  base64?: string;
  aesKeyB64?: string;
  fileName?: string;
}

function imageExtFromBytes(data: Buffer): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ".png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return ".gif";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return ".jpg";
}

/** AES-256-CBC + WeCom's PKCS#7 (block size 32) media decryption. Invalid padding fails closed. */
export function decryptWecomMedia(ciphertext: Buffer, aesKeyB64: string): Buffer {
  if (!ciphertext.length) throw new Error("WeCom encrypted media is empty");
  if (ciphertext.length % 16 !== 0) throw new Error("invalid WeCom encrypted media length");
  const key = Buffer.from(String(aesKeyB64 ?? ""), "base64");
  if (key.length !== 32) throw new Error(`unexpected WeCom aes_key length: ${key.length} (expected 32)`);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const pad = padded[padded.length - 1];
  if (pad < 1 || pad > 32 || pad > padded.length) throw new Error("invalid WeCom media padding");
  for (let i = padded.length - pad; i < padded.length; i++) {
    if (padded[i] !== pad) throw new Error("invalid WeCom media padding");
  }
  return padded.subarray(0, padded.length - pad);
}

function extractWecomText(body: any): string {
  const parts: string[] = [];
  const msgtype = String(body?.msgtype ?? "").toLowerCase();
  if (msgtype === "mixed") {
    const items = Array.isArray(body?.mixed?.msg_item) ? body.mixed.msg_item : [];
    for (const item of items) {
      if (String(item?.msgtype ?? "").toLowerCase() !== "text") continue;
      const content = String(item?.text?.content ?? "").trim();
      if (content) parts.push(content);
    }
  } else {
    const content = String(body?.text?.content ?? "").trim();
    if (content) parts.push(content);
    if (msgtype === "voice") {
      const transcript = String(body?.voice?.content ?? "").trim();
      if (transcript) parts.push(transcript);
    }
  }
  return parts.join("\n").trim();
}

function extractWecomMedia(body: any): WecomMediaRef[] {
  const refs: WecomMediaRef[] = [];
  const pushMedia = (kind: WecomMediaRef["kind"], media: any): void => {
    if (!media || typeof media !== "object") return;
    const ref: WecomMediaRef = {
      kind,
      url: typeof media.url === "string" ? media.url : undefined,
      base64: typeof media.base64 === "string" ? media.base64 : undefined,
      aesKeyB64: typeof media.aeskey === "string" ? media.aeskey : undefined,
      fileName: typeof media.filename === "string"
        ? media.filename
        : typeof media.name === "string"
          ? media.name
          : undefined,
    };
    // Do not admit metadata-only placeholders into the download budget.
    if (ref.url || ref.base64) refs.push(ref);
  };
  const msgtype = String(body?.msgtype ?? "").toLowerCase();
  if (msgtype === "mixed") {
    const items = Array.isArray(body?.mixed?.msg_item) ? body.mixed.msg_item : [];
    for (const item of items) {
      if (String(item?.msgtype ?? "").toLowerCase() === "image") pushMedia("image", item.image);
    }
  } else {
    if (msgtype === "image") pushMedia("image", body?.image);
    if (msgtype === "file") pushMedia("file", body?.file);
    if (msgtype === "video") pushMedia("video", body?.video);
  }
  return refs;
}

/** WeCom transports `create_time` as seconds today; tolerate millisecond fixtures and future protocol drift. */
export function wecomTimestampMs(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed);
}

function stableWecomId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** Parse a WeCom callback into the gateway's platform-neutral inbound message. */
export function parseWecomMessage(
  payload: any,
  selfBotId: string,
): { msg: InboundMsg; media: WecomMediaRef[] } | null {
  const body = payload?.body;
  if (!body || typeof body !== "object") return null;

  const sender = typeof body.from === "object" && body.from ? body.from : {};
  const senderId = String(sender.userid ?? "").trim();
  if (selfBotId && senderId && senderId === selfBotId) return null;
  if (selfBotId && String(body.aibotid ?? body.bot_id ?? body.botid ?? "").trim() === selfBotId && !senderId) return null;

  const chatId = String(body.chatid ?? senderId).trim();
  if (!chatId) return null;
  const text = extractWecomText(body);
  const media = extractWecomMedia(body);
  if (!text && !media.length) return null;

  const messageId = stableWecomId(body.msgid) ?? stableWecomId(payload?.headers?.req_id);
  const createdAtMs = wecomTimestampMs(body.create_time);
  const marker = media.some((ref) => ref.kind === "image")
    ? "[图片]"
    : media.some((ref) => ref.kind === "video")
      ? "[视频]"
      : "[附件]";

  return {
    msg: {
      chatId,
      userId: senderId || chatId,
      userName: String(sender.name ?? sender.userid ?? senderId ?? chatId),
      text: text || marker,
      ...(messageId ? { messageId } : {}),
      ...(createdAtMs === undefined ? {} : { createdAtMs }),
      chatType: String(body.chattype ?? "").trim().toLowerCase() === "single" ? "p2p" : "group",
    },
    media,
  };
}

async function downloadWecomMedia(
  ref: WecomMediaRef,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<string | null> {
  try {
    let data: Buffer | null = null;
    if (ref.base64) {
      data = decodeBase64Media(ref.base64, options.maxBytes);
    } else if (ref.url) {
      const response = await fetch(ref.url, { signal: options.signal });
      if (!response.ok) return null;
      data = await readResponseBytesLimited(response, options.maxBytes, options.signal);
    }
    if (!data?.length) return null;
    if (ref.aesKeyB64) data = decryptWecomMedia(data, ref.aesKeyB64);
    if (!data.length || data.length > options.maxBytes) return null;

    let name = ref.fileName ? basename(ref.fileName) : "";
    if (ref.kind === "image" && (!name || !extname(name))) name = `image${imageExtFromBytes(data)}`;
    if (!name) name = ref.kind === "video" ? "video.mp4" : "file.bin";
    return await savePrivateMediaBytes(data, {
      platform: "wecom",
      filenameHint: name,
      ...options,
    });
  } catch {
    return null;
  }
}

export function wecomAdapter(
  botId: string,
  secret: string,
  wsUrl: string = DEFAULT_WS_URL,
  transportOptions: WecomTransportOptions = {},
): ChatAdapter {
  if (!botId.trim() || !secret) throw new Error("WeCom bot id and secret are required");
  const options = resolveTransportOptions(transportOptions);
  const conn: LiveConnection = { send: null };
  const outbound = new PerChatOutboundLane("wecom", botId);

  async function uploadMedia(
    request: WecomRequest,
    file: OutboundFilePayload,
    mediaType: "image" | "file",
    signal: AbortSignal,
  ): Promise<string> {
    const data = file.bytes;
    if (!data.length) throw new Error("cannot upload an empty file to WeCom");
    if (data.length > ABSOLUTE_MAX_BYTES) throw new Error(`file exceeds WeCom 20MB limit: ${data.length} bytes`);
    const totalChunks = Math.ceil(data.length / UPLOAD_CHUNK_SIZE);
    const init = await request(CMD_UPLOAD_INIT, {
      type: mediaType,
      filename: basename(file.safeName) || "file.bin",
      total_size: data.length,
      total_chunks: totalChunks,
      md5: createHash("md5").update(data).digest("hex"),
    }, signal);
    const uploadId = String(init?.body?.upload_id ?? "").trim();
    if (!uploadId) throw new Error("WeCom media upload init returned no upload_id");

    for (let index = 0; index < totalChunks; index++) {
      const start = index * UPLOAD_CHUNK_SIZE;
      const chunk = data.subarray(start, Math.min(start + UPLOAD_CHUNK_SIZE, data.length));
      let uploaded = false;
      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_UPLOAD_CHUNK_RETRIES; attempt++) {
        throwIfAborted(signal, "WeCom upload");
        try {
          await request(CMD_UPLOAD_CHUNK, {
            upload_id: uploadId,
            chunk_index: index,
            base64_data: chunk.toString("base64"),
          }, signal);
          uploaded = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < MAX_UPLOAD_CHUNK_RETRIES) await waitForDelay(250 * (attempt + 1), signal);
        }
      }
      if (!uploaded) {
        const reason = lastError instanceof Error ? lastError.message : "unknown transport error";
        throw new Error(`WeCom media chunk ${index} failed after ${MAX_UPLOAD_CHUNK_RETRIES + 1} attempts: ${reason}`);
      }
    }

    const finish = await request(CMD_UPLOAD_FINISH, { upload_id: uploadId }, signal);
    const mediaId = String(finish?.body?.media_id ?? "").trim();
    if (!mediaId) throw new Error("WeCom media upload finish returned no media_id");
    return mediaId;
  }

  return {
    name: "wecom",
    async send(chatId, text, signal) {
      await withOutboundDeadline("WeCom send", signal, outboundTransferTimeoutMs("text"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          const request = conn.send;
          if (!request) throw new Error("WeCom socket is not authenticated");
          for (const part of chunkText(text || "(empty)", MAX_MESSAGE_LENGTH)) {
            await request(CMD_SEND, {
              chatid: String(chatId),
              msgtype: "markdown",
              markdown: { content: part },
            }, transferSignal);
          }
        });
      });
    },
    async sendFile(chatId, file, signal) {
      await withOutboundDeadline("WeCom upload", signal, outboundTransferTimeoutMs("file"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          const request = conn.send;
          if (!request) throw new Error("WeCom socket is not authenticated");
          const mediaType: "image" | "file" = isImageName(file.safeName) ? "image" : "file";
          const mediaId = await uploadMedia(request, file, mediaType, transferSignal);
          await request(CMD_SEND, {
            chatid: String(chatId),
            msgtype: mediaType,
            [mediaType]: { media_id: mediaId },
          }, transferSignal);
        });
      });
    },
    async start(onMessage, signal, shouldDownload) {
      if (!WSImpl) throw new Error("WeCom gateway requires Node 22.12 or newer; upgrade Node and restart Hara");
      let authFailures = 0;
      let reconnectAttempts = 0;
      while (!signal.aborted) {
        const outcome = await connectOnce(botId, secret, wsUrl, conn, onMessage, signal, shouldDownload, options);
        if (signal.aborted || outcome.reason === "aborted") return;
        if (outcome.reason === "superseded") {
          throw new Error("WeCom connection was replaced by another active bot connection; stopped to avoid a reconnect loop");
        }

        let attempt: number;
        if (outcome.reason === "auth-failed") {
          authFailures++;
          reconnectAttempts = 0;
          if (authFailures >= options.maxAuthFailures) {
            throw new Error(`WeCom authentication failed ${authFailures} time(s); check HARA_WECOM_BOT_ID and HARA_WECOM_SECRET`);
          }
          attempt = authFailures;
          console.error(
            `hara wecom: authentication failed (attempt ${authFailures}/${options.maxAuthFailures}); reconnecting.`,
          );
        } else {
          authFailures = 0;
          reconnectAttempts = outcome.authenticated ? 1 : reconnectAttempts + 1;
          attempt = reconnectAttempts;
          console.error(`hara wecom: ${outcome.detail ?? "connection closed"}; reconnecting.`);
        }
        await waitForDelay(reconnectDelay(attempt, options), signal).catch(() => undefined);
      }
    },
  };
}

function connectOnce(
  botId: string,
  secret: string,
  wsUrl: string,
  conn: LiveConnection,
  onMessage: (message: InboundMsg) => Promise<unknown>,
  signal: AbortSignal,
  shouldDownload: ((message: InboundMsg) => boolean) | undefined,
  options: ResolvedWecomTransportOptions,
): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    const ws = new WSImpl(wsUrl);
    const pending = new Map<string, PendingRequest>();
    const heartbeatIds = new Set<string>();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    let authReqId = "";
    let missedHeartbeats = 0;
    let authenticated = false;
    let settled = false;

    const closeSocket = (): void => {
      try {
        if (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN) ws.close();
      } catch {
        /* already closed */
      }
    };

    const detachPending = (entry: PendingRequest): void => {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    };

    const cleanup = (reason: Error): void => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (authTimer) clearTimeout(authTimer);
      heartbeatTimer = null;
      authTimer = null;
      heartbeatIds.clear();
      signal.removeEventListener("abort", stop);
      for (const entry of pending.values()) {
        detachPending(entry);
        entry.reject(reason);
      }
      pending.clear();
      if (conn.send === request) conn.send = null;
    };

    const finish = (reason: ConnectReason, detail?: string): void => {
      if (settled) return;
      settled = true;
      cleanup(new Error(detail ?? "WeCom connection closed"));
      if (reason !== "closed") closeSocket();
      resolve({ reason, authenticated, ...(detail ? { detail } : {}) });
    };

    const stop = (): void => {
      finish("aborted", "WeCom gateway stopped");
      closeSocket();
    };

    const sendRaw = (frame: unknown): void => {
      if (settled || ws.readyState !== WS_OPEN) throw new Error("WeCom socket is not open");
      ws.send(JSON.stringify(frame));
    };

    const request: WecomRequest = (command, body, requestSignal) => {
      if (settled || !authenticated || ws.readyState !== WS_OPEN) {
        return Promise.reject(new Error("WeCom socket is not authenticated"));
      }
      if (requestSignal?.aborted) return Promise.reject(signalError(requestSignal, `WeCom ${command} cancelled`));
      const reqId = `${command}-${randomUUID()}`;
      return new Promise((resolveRequest, rejectRequest) => {
        const onAbort = (): void => {
          const entry = pending.get(reqId);
          if (!entry) return;
          pending.delete(reqId);
          detachPending(entry);
          rejectRequest(signalError(requestSignal, `WeCom ${command} cancelled`));
        };
        const timer = setTimeout(() => {
          const entry = pending.get(reqId);
          if (!entry) return;
          pending.delete(reqId);
          detachPending(entry);
          rejectRequest(new Error(`WeCom ${command} timed out after ${options.requestTimeoutMs}ms`));
        }, options.requestTimeoutMs);
        const entry: PendingRequest = {
          command,
          resolve: resolveRequest,
          reject: rejectRequest,
          timer,
          signal: requestSignal,
          onAbort,
        };
        pending.set(reqId, entry);
        requestSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          sendRaw({ cmd: command, headers: { req_id: reqId }, body });
        } catch (error) {
          pending.delete(reqId);
          detachPending(entry);
          rejectRequest(error instanceof Error ? error : new Error("WeCom request send failed"));
        }
      });
    };

    const settleRequest = (reqId: string, frame: any): boolean => {
      const entry = pending.get(reqId);
      if (!entry) return false;
      pending.delete(reqId);
      detachPending(entry);
      const code = Number(frame?.errcode);
      if (code !== 0) {
        entry.reject(new Error(
          `WeCom ${entry.command} failed (code ${Number.isFinite(code) ? code : "invalid"}): ${protocolText(frame?.errmsg, secret)}`,
        ));
      } else {
        entry.resolve(frame);
      }
      return true;
    };

    const handleCallback = async (frame: any): Promise<void> => {
      if (signal.aborted || !authenticated) return;
      const parsed = parseWecomMessage(frame, botId);
      if (!parsed) return;
      const transientFiles: string[] = [];
      let handedOff = false;
      try {
        let text = parsed.msg.text;
        const images: string[] = [];
        if (shouldDownload?.(parsed.msg) === true && parsed.media.length) {
          const budget = new InboundMediaBudget("wecom", signal);
          for (const ref of parsed.media) {
            const path = await budget.download((downloadOptions) => downloadWecomMedia(ref, downloadOptions));
            if (!path) continue;
            transientFiles.push(path);
            if (ref.kind === "image") {
              images.push(path);
              if (text !== "[图片]" && !text.includes("[图片]")) text += `${text ? "\n" : ""}[图片]`;
            } else {
              const filename = ref.fileName ? basename(ref.fileName) : "";
              const label = ref.kind === "video"
                ? `视频${filename ? ` ${filename}` : ""}`
                : `文件${filename ? ` ${filename}` : ""}`;
              const marker = `[${label}: ${path}]`;
              text = text === "[附件]" || text === "[视频]" ? marker : `${text}${text ? "\n" : ""}${marker}`;
            }
          }
        }
        if (signal.aborted) return;
        const inbound: InboundMsg = {
          ...parsed.msg,
          text: text.trim() || parsed.msg.text,
          images: images.length ? images : undefined,
          transientFiles: transientFiles.length ? transientFiles : undefined,
        };
        handedOff = true;
        await onMessage(inbound);
      } finally {
        if (!handedOff && transientFiles.length) await cleanupTransientMedia("wecom", transientFiles);
      }
    };

    const handleMessage = async (event: any): Promise<void> => {
      const data = event?.data;
      if (typeof data === "string" && Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) {
        finish("closed", "received an oversized WeCom frame");
        closeSocket();
        return;
      }
      if (data instanceof ArrayBuffer && data.byteLength > MAX_FRAME_BYTES) {
        finish("closed", "received an oversized WeCom frame");
        closeSocket();
        return;
      }
      if (typeof data?.size === "number" && data.size > MAX_FRAME_BYTES) {
        finish("closed", "received an oversized WeCom frame");
        closeSocket();
        return;
      }

      let raw: string;
      if (typeof data === "string") raw = data;
      else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString("utf8");
      else if (typeof data?.arrayBuffer === "function") raw = Buffer.from(await data.arrayBuffer()).toString("utf8");
      else raw = String(data ?? "");
      let frame: any;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      const cmd = String(frame?.cmd ?? "");
      const reqId = String(frame?.headers?.req_id ?? "");

      if (reqId && reqId === authReqId) {
        if (authenticated) return; // a duplicate auth ACK must not install a second heartbeat timer
        if (authTimer) clearTimeout(authTimer);
        authTimer = null;
        if (Number(frame?.errcode) !== 0) {
          finish(
            "auth-failed",
            `WeCom authentication failed (code ${Number.isFinite(Number(frame?.errcode)) ? Number(frame.errcode) : "invalid"}): ${protocolText(frame?.errmsg, secret)}`,
          );
          return;
        }
        authenticated = true;
        missedHeartbeats = 0;
        conn.send = request;
        console.error("hara wecom: authenticated.");
        heartbeatTimer = setInterval(() => {
          if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
            finish("closed", `heartbeat ACK timed out after ${missedHeartbeats} missed ping(s)`);
            closeSocket();
            return;
          }
          const heartbeatId = `${CMD_PING}-${randomUUID()}`;
          missedHeartbeats++;
          heartbeatIds.add(heartbeatId);
          try {
            sendRaw({ cmd: CMD_PING, headers: { req_id: heartbeatId }, body: {} });
          } catch {
            finish("closed", "heartbeat send failed");
            closeSocket();
          }
        }, options.heartbeatMs);
        return;
      }

      if (reqId && heartbeatIds.has(reqId)) {
        heartbeatIds.delete(reqId);
        if (Number(frame?.errcode) === 0) {
          missedHeartbeats = 0;
          heartbeatIds.clear();
        }
        return;
      }

      if (reqId && !CALLBACK_CMDS.has(cmd) && cmd !== CMD_EVENT_CALLBACK && settleRequest(reqId, frame)) return;
      if (!authenticated) return;
      if (cmd === CMD_EVENT_CALLBACK) {
        if (String(frame?.body?.event?.eventtype ?? "") === "disconnected_event") {
          finish("superseded", "another active WeCom connection replaced this one");
        }
        return;
      }
      if (cmd === CMD_PING) return;
      if (!CALLBACK_CMDS.has(cmd)) return;
      await handleCallback(frame);
    };

    signal.addEventListener("abort", stop, { once: true });
    ws.addEventListener("open", () => {
      authReqId = `${CMD_SUBSCRIBE}-${randomUUID()}`;
      authTimer = setTimeout(() => {
        finish("auth-failed", `WeCom authentication ACK timed out after ${options.requestTimeoutMs}ms`);
        closeSocket();
      }, options.requestTimeoutMs);
      try {
        sendRaw({
          cmd: CMD_SUBSCRIBE,
          headers: { req_id: authReqId },
          body: { bot_id: botId, secret },
        });
      } catch {
        finish("closed", "could not send the WeCom authentication frame");
        closeSocket();
      }
    });
    ws.addEventListener("message", (event: any) => {
      void handleMessage(event).catch((error) => {
        console.error(`hara wecom: callback handling failed — ${protocolText(error instanceof Error ? error.message : error, secret)}`);
      });
    });
    ws.addEventListener("close", () => finish("closed", "connection closed"));
    ws.addEventListener("error", () => {
      finish("closed", "WebSocket transport error");
      closeSocket();
    });
  });
}
