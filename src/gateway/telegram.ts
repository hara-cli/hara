// Telegram adapter for `hara gateway` — long-poll getUpdates + sendMessage over the Bot API (built-in
// fetch, zero new dep). Token from HARA_TELEGRAM_TOKEN. The generic `ChatAdapter` shape is what WeChat(iLink)
// / Feishu plug into next.
import { InboundMediaBudget, savePrivateResponse } from "./media.js";
import type { OutboundFilePayload } from "./outbound-files.js";
import { gatewayRuntimeScope } from "./runtime-state.js";

const API = "https://api.telegram.org";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface InboundMsg {
  chatId: number | string; // Telegram numeric chat id; WeChat wxid string
  userId: number | string;
  userName: string;
  text: string;
  /** Stable platform delivery id, when available. Used only for bounded cross-restart deduplication. */
  messageId?: string;
  /** Platform create time in milliseconds. Old replayed events are ignored on a fresh gateway start. */
  createdAtMs?: number;
  /** Adapter proved this event is in a private durable local queue; startup age filtering must not discard it. */
  durablyQueued?: boolean;
  /** local paths to inbound images the agent should SEE (attached inline / described downstream) */
  images?: string[];
  /** Adapter-owned local downloads. The gateway removes these after this message finishes handling. */
  transientFiles?: string[];
  /** Chat kind, when the adapter can tell — lets gateway flows target groups vs DMs. Omitted = adapter didn't say. */
  chatType?: "p2p" | "group";
  /** People @-mentioned in this message, when the platform surfaces them. `isSelf` = the gateway bot itself was
   *  mentioned — the permission-friendly signal a `mention:"self"` flow triggers on. */
  mentions?: { id?: string; name?: string; isSelf?: boolean }[];
}
export type InboundAckCleanup = () => Promise<void>;
export interface ChatAdapter {
  name: string;
  start(
    /** A returned cleanup runs only after the adapter has durably acknowledged/removed this platform event. */
    // `any` keeps legacy adapters source-compatible while Telegram/Feishu consume the optional cleanup.
    // Other adapters currently expose no stable messageId, so the gateway never creates a marker for them.
    onMessage: (m: InboundMsg) => Promise<any>,
    signal: AbortSignal,
    /** Fail-closed authorization preflight. Media is never fetched when omitted or false. */
    shouldDownload?: (m: InboundMsg) => boolean,
  ): Promise<void>;
  /** `idempotencyKey` is an opaque stable effect id. Adapters whose platform supports idempotent create
   * requests may use it; adapters without that capability retain at-least-once behavior. */
  send(chatId: number | string, text: string, signal?: AbortSignal, idempotencyKey?: string): Promise<void>;
  /** Optional: upload already-verified bytes. `snapshotPath` is cleanup-only and must never be reopened here. */
  sendFile?(chatId: number | string, file: OutboundFilePayload, signal?: AbortSignal, idempotencyKey?: string): Promise<void>;
  /** Optional: send a message and return its platform message id — so transient UX messages ("⟳ working…")
   *  can be recalled later. Platforms without it just leave such messages in place. */
  sendTracked?(chatId: number | string, text: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Optional: delete/recall one of the BOT's own messages (e.g. Feishu allows it; WeChat iLink does not). */
  recall?(chatId: number | string, messageId: string, signal?: AbortSignal): Promise<void>;
}

const processOutboundTails = new Map<string, Promise<void>>();

/** Keeps each logical outbound message/file atomic within one credential-scoped chat while unrelated chats
 * stay concurrent. The map is process-global rather than adapter-local because cron/flow delivery constructs
 * short-lived adapters; those instances must not interleave chunks with the long-lived gateway adapter. */
export class PerChatOutboundLane {
  private readonly scope: string;

  constructor(platform = "gateway", connectionIdentity = "default") {
    // `gatewayRuntimeScope` hashes the credential identity. Raw tokens/app ids never enter map keys, logs, or
    // persisted state, while two adapters for the same bot still share one lane.
    this.scope = gatewayRuntimeScope(platform, connectionIdentity);
  }

  run<T>(chatId: number | string, task: () => Promise<T>): Promise<T> {
    const key = `${this.scope}\0${String(chatId)}`;
    const previous = processOutboundTails.get(key) ?? Promise.resolve();
    const operation = previous.then(task, task);
    // A failure is returned to its caller but cannot poison later sends in the same chat.
    const tail = operation.then(() => undefined, () => undefined);
    processOutboundTails.set(key, tail);
    void tail.then(() => {
      if (processOutboundTails.get(key) === tail) processOutboundTails.delete(key);
    });
    return operation;
  }
}

const DEFAULT_TEXT_TRANSFER_TIMEOUT_MS = 30_000;
const DEFAULT_FILE_TRANSFER_TIMEOUT_MS = 120_000;
const MAX_OUTBOUND_TRANSFER_TIMEOUT_MS = 120_000;
const MIN_OUTBOUND_TRANSFER_TIMEOUT_MS = 50;

/** Operator/test override remains bounded: outbound transport can never disable or exceed the hard ceiling. */
export function outboundTransferTimeoutMs(
  kind: "text" | "file",
  value: number | string | undefined = process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS,
): number {
  const fallback = kind === "file" ? DEFAULT_FILE_TRANSFER_TIMEOUT_MS : DEFAULT_TEXT_TRANSFER_TIMEOUT_MS;
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(MIN_OUTBOUND_TRANSFER_TIMEOUT_MS, Math.min(MAX_OUTBOUND_TRANSFER_TIMEOUT_MS, Math.trunc(parsed)))
    : fallback;
}

/** Cooperative cancellation plus a hard caller deadline. The hard race is intentional: some transports
 * ignore AbortSignal, but shutdown must still settle promptly. Adapters place this deadline outside their
 * process-global lane so an ambiguous late transfer remains quarantined until it really settles. */
export async function withOutboundDeadline<T>(
  label: string,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  transfer: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) throw new Error(`${label} cancelled`);
  const controller = new AbortController();
  let rejectStopped!: (reason: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  let stoppedOnce = false;
  const stop = (reason: Error): void => {
    if (stoppedOnce) return;
    stoppedOnce = true;
    controller.abort(reason);
    rejectStopped(reason);
  };
  const onParentAbort = (): void => stop(new Error(`${label} cancelled`));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => stop(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    // Starting through a microtask turns synchronous SDK throws into the same bounded promise path.
    const running = Promise.resolve().then(() => transfer(controller.signal));
    return await Promise.race([running, stopped]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/** Extract an InboundMsg from a Telegram getUpdates result item (pure). Accepts text and photo messages
 *  (photo → caption or a "[图片]" marker; the image itself is downloaded in start()). null otherwise. */
export function parseTelegramUpdate(u: any): InboundMsg | null {
  const m = u?.message;
  if (!m || !m.chat?.id) return null;
  const text = typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "";
  const hasPhoto = Array.isArray(m.photo) && m.photo.length > 0;
  if (!text && !hasPhoto) return null; // not text or a photo (sticker/location/etc.)
  return {
    chatId: m.chat.id,
    userId: m.from?.id ?? 0,
    userName: m.from?.username || m.from?.first_name || String(m.from?.id ?? ""),
    text: text || "[图片]",
    ...(Number.isSafeInteger(u?.update_id) ? { messageId: String(u.update_id) } : {}),
    ...(Number.isFinite(Number(m.date)) && Number(m.date) > 0 ? { createdAtMs: Math.trunc(Number(m.date) * 1_000) } : {}),
    ...(m.chat?.type === "private" ? { chatType: "p2p" as const } : ["group", "supergroup"].includes(m.chat?.type) ? { chatType: "group" as const } : {}),
  };
}

/** The largest photo's file_id (Telegram sends `photo` as an ascending size array) (pure). null if none. */
export function photoFileId(u: any): string | null {
  const photo = u?.message?.photo;
  return Array.isArray(photo) && photo.length ? (photo[photo.length - 1]?.file_id ?? null) : null;
}

/** Download a Telegram file by file_id → a local path under ~/.hara/telegram/media (getFile then the file CDN). */
async function downloadTelegramFile(
  base: string,
  token: string,
  fileId: string,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<string | null> {
  try {
    const r = await fetch(`${base}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: options.signal });
    const j = (await r.json()) as { result?: { file_path?: string } };
    const fp = j?.result?.file_path;
    if (!fp) return null;
    const dl = await fetch(`${API}/file/bot${token}/${fp}`, { signal: options.signal });
    if (!dl.ok) return null;
    return await savePrivateResponse(dl, { platform: "telegram", filenameHint: fp, ...options });
  } catch {
    return null;
  }
}

let messageSegmenter: Intl.Segmenter | null | undefined;
function messageGraphemes(text: string): string[] {
  // Keep user-perceived characters (ZWJ emoji, flags, combining marks, CRLF) together. The fallback still
  // protects surrogate pairs on runtimes without full ICU, although supported Hara runtimes provide it.
  if (messageSegmenter === undefined) {
    messageSegmenter = typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  }
  return messageSegmenter
    ? Array.from(messageSegmenter.segment(text), (entry) => entry.segment)
    : Array.from(text);
}

function splitOversizedGrapheme(grapheme: string, max: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const point of grapheme) {
    if (point.length > max) {
      if (piece) {
        pieces.push(piece);
        piece = "";
      }
      // Only possible when max=1 and the code point is an astral character. The platform's UTF-16 bound is
      // non-negotiable, so this is the sole case where even a code point must be split into code units.
      for (let at = 0; at < point.length; at += max) pieces.push(point.slice(at, at + max));
      continue;
    }
    if (piece.length + point.length > max) {
      pieces.push(piece);
      piece = point;
    } else {
      piece += point;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Split text into chunks whose JavaScript UTF-16 length is ≤ max (pure). */
export function chunkText(text: string, max = 4000): string[] {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("chunk size must be a positive integer");
  if (text.length <= max) return [text];
  const units = messageGraphemes(text).flatMap((grapheme) => {
    // A maliciously huge combining sequence cannot bypass the service limit. Splitting such a single cluster
    // is the only case where both the hard platform bound and grapheme integrity cannot be satisfied.
    return grapheme.length <= max ? [grapheme] : splitOversizedGrapheme(grapheme, max);
  });
  const widths = units.map((unit) => unit.length);
  const out: string[] = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let width = 0;
    while (end < units.length && width + widths[end] <= max) width += widths[end++];
    if (end < units.length) {
      const softFloor = Math.max(1, Math.floor(max / 2));
      let breakAt = -1;
      // Paragraph/line boundaries preserve the shape of long agent replies. Whitespace is the fallback;
      // CJK prose without either still gets a safe hard grapheme boundary.
      let candidateWidth = width;
      for (let i = end - 1; i >= start; i--) {
        if (candidateWidth < softFloor) break;
        if (units[i].includes("\n")) {
          breakAt = i + 1;
          break;
        }
        candidateWidth -= widths[i];
      }
      if (breakAt < 0) {
        candidateWidth = width;
        for (let i = end - 1; i >= start; i--) {
          if (candidateWidth < softFloor) break;
          if (/^\s+$/u.test(units[i])) {
            breakAt = i + 1;
            break;
          }
          candidateWidth -= widths[i];
        }
      }
      if (breakAt > start) end = breakAt;
    }
    out.push(units.slice(start, end).join(""));
    start = end;
  }
  return out;
}

export function telegramAdapter(token: string): ChatAdapter {
  const base = `${API}/bot${token}`;
  const outbound = new PerChatOutboundLane("telegram", token);
  const request = async (method: string, init: RequestInit, signal: AbortSignal): Promise<any> => {
    let response: Response;
    try {
      response = await fetch(`${base}/${method}`, { ...init, signal });
    } catch {
      if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
      // Never let a fetch implementation echo the bot-token URL/body through gateway logs or owner replies.
      throw new Error(`Telegram ${method} transport failed`);
    }
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok || body?.ok === false) {
      throw new Error(`Telegram ${method} failed: HTTP ${response.status}${body?.description ? ` · ${body.description}` : ""}`);
    }
    return body;
  };
  return {
    name: "telegram",
    async send(chatId, text, signal) {
      await withOutboundDeadline("Telegram send", signal, outboundTransferTimeoutMs("text"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          if (transferSignal.aborted) {
            throw transferSignal.reason instanceof Error ? transferSignal.reason : new Error("Telegram send cancelled");
          }
          for (const part of chunkText(text || "(empty)")) {
            await request("sendMessage", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: part }),
            }, transferSignal);
          }
        });
      });
    },
    async sendFile(chatId, file, signal) {
      await withOutboundDeadline("Telegram upload", signal, outboundTransferTimeoutMs("file"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          if (transferSignal.aborted) {
            throw transferSignal.reason instanceof Error ? transferSignal.reason : new Error("Telegram upload cancelled");
          }
          // images → sendPhoto (inline preview); everything else → sendDocument (keeps the filename)
          const name = file.safeName;
          const isImg = /\.(png|jpe?g|gif|webp)$/i.test(name);
          const form = new FormData();
          form.append("chat_id", String(chatId));
          form.append(isImg ? "photo" : "document", new Blob([new Uint8Array(file.bytes)]), name);
          await request(isImg ? "sendPhoto" : "sendDocument", { method: "POST", body: form }, transferSignal);
        });
      });
    },
    async start(onMessage, signal, shouldDownload) {
      let offset = 0;
      let consecutiveFailures = 0;
      let outageAlerted = false;
      const postAck = new Array<{ cleanup: InboundAckCleanup; failures: number }>();
      while (!signal.aborted) {
        try {
          // Telegram's `timeout=30` is only a server-side long-poll hint. A half-open proxy/socket can ignore
          // it indefinitely, so the client adds a hard margin and aborts the actual fetch after 40 seconds.
          const acknowledgedCount = postAck.length;
          const j = await withOutboundDeadline("Telegram poll", signal, 40_000, async (pollSignal) => {
            let response: Response;
            try {
              response = await fetch(`${base}/getUpdates?timeout=30&offset=${offset}`, { signal: pollSignal });
            } catch {
              if (pollSignal.aborted && pollSignal.reason instanceof Error) throw pollSignal.reason;
              // Fetch/proxy errors can include the complete request URL; never let the bot token reach logs.
              throw new Error("Telegram getUpdates transport failed");
            }
            if (!response.ok) throw new Error(`Telegram getUpdates failed: HTTP ${response.status}`);
            try {
              // Keep body consumption inside the hard deadline too. Receiving headers is not completion: a
              // half-open peer can otherwise leave response.json() pending forever after the timer is cleared.
              return await response.json() as { result?: any[] };
            } catch {
              if (pollSignal.aborted && pollSignal.reason instanceof Error) throw pollSignal.reason;
              throw new Error("Telegram getUpdates returned an invalid response");
            }
          });
          // This successful request carried the offset advanced by the previous iteration, so Telegram has
          // now durably forgotten those updates. Only then may their private execution markers be removed.
          const acknowledged = postAck.splice(0, acknowledgedCount);
          for (const entry of acknowledged) {
            try {
              await entry.cleanup();
            } catch {
              entry.failures++;
              if (entry.failures === 1) {
                console.error("hara telegram: acknowledged-event cleanup failed; private marker will retry");
              }
              if (entry.failures >= 5) {
                console.error("hara telegram: ALERT acknowledged-event cleanup suspended after 5 failures; private marker retained for manual recovery");
              } else {
                postAck.push(entry);
              }
            }
          }
          for (const u of j.result ?? []) {
            const updateId = Number(u?.update_id);
            if (!Number.isSafeInteger(updateId) || updateId < 0 || !Number.isSafeInteger(updateId + 1)) {
              throw new Error("Telegram getUpdates returned an invalid update_id");
            }
            const nextOffset = updateId + 1;
            const msg = parseTelegramUpdate(u);
            if (!msg) {
              offset = Math.max(offset, nextOffset);
              continue;
            }
            const fid = photoFileId(u); // a photo message → download it so the agent can SEE it
            if (fid && shouldDownload?.(msg) === true) {
              const budget = new InboundMediaBudget("telegram", signal);
              const path = await budget.download((options) => downloadTelegramFile(base, token, fid, options));
              if (path) {
                msg.images = [path];
                msg.transientFiles = [path];
              }
            }
            // Acknowledge only after the whole gateway callback succeeds. On failure the offset stays put,
            // so Telegram redelivers this update and later batch entries cannot overtake it.
            const cleanup = await onMessage(msg);
            offset = Math.max(offset, nextOffset);
            if (cleanup) postAck.push({ cleanup, failures: 0 });
            if (signal.aborted) break;
          }
          if (outageAlerted) console.error("hara telegram: ✓ polling recovered");
          consecutiveFailures = 0;
          outageAlerted = false;
        } catch (error) {
          if (signal.aborted) break;
          consecutiveFailures++;
          if (consecutiveFailures === 1) {
            console.error(`hara telegram: update handling failed — ${error instanceof Error ? error.message : String(error)}`);
          } else if (consecutiveFailures === 3 || consecutiveFailures % 10 === 0) {
            outageAlerted = true;
            console.error(`hara telegram: ALERT polling/handling has failed ${consecutiveFailures} consecutive times`);
          }
          await sleep(2000); // network blip → back off + retry
        }
      }
    },
  };
}
