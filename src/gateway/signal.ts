// Signal adapter for `hara gateway` — talks to a LOCAL signal-cli daemon running in HTTP/JSON-RPC mode
// (built-in fetch, zero new dep; no WebSocket, no cloud API). The user installs signal-cli, registers/links the
// bot's phone number, and runs `signal-cli -a <number> daemon --http localhost:8080`. Inbound is drained via the
// JSON-RPC `receive` method on a long-poll loop (the robust zero-dep path — no SSE line-buffering quirks);
// outbound + attachment fetch go through JSON-RPC `send`/`getAttachment`. Creds from HARA_SIGNAL_RPC_URL
// (e.g. http://localhost:8080) + HARA_SIGNAL_NUMBER (the bot's registered phone, E.164). Same ChatAdapter shape
// as the others, so all cross-platform gateway plumbing (send_file, system context, stuck-guard, image
// attach/describe) works unchanged. Mirrors the Matrix long-poll model + the Discord download-media/sendFile
// patterns, and the hermes signal.py protocol/redaction behavior.
//
// EXTERNAL DEPENDENCY: signal-cli is NOT bundled — it's a separate program the user installs and runs (it is the
// only way to speak Signal's protocol; there is no official cloud API). The adapter just speaks HTTP/JSON-RPC to
// the daemon the user has running. See setup notes at the bottom of this file.
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";
import {
  INBOUND_MEDIA_MAX_BYTES,
  InboundMediaBudget,
  decodeBase64Media,
  readResponseBytesLimited,
  savePrivateMediaBytes,
} from "./media.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// Base64 expands by 4/3; leave a small fixed budget for the JSON-RPC envelope without permitting an unlimited body.
const ATTACHMENT_RPC_MAX_BYTES = Math.ceil(INBOUND_MEDIA_MAX_BYTES / 3) * 4 + 64 * 1024;

// E.164 phone numbers (+15551234567) anywhere in a string → +155****4567 (mirrors hermes' _redact_phone).
const PHONE_RE = /\+[1-9]\d{6,14}/g;
/** Redact phone numbers for logging. Keeps a 4/4 head+tail window; never logs the full E.164. (pure) */
export function redactPhone(s: string): string {
  if (!s) return "<none>";
  return s.replace(PHONE_RE, (p) => (p.length <= 8 ? "****" : `${p.slice(0, 4)}****${p.slice(-4)}`));
}

const isImageExt = (ext: string): boolean => /^\.(png|jpe?g|gif|webp)$/i.test(ext);

/** Guess a file extension from an attachment's contentType / filename (signal-cli gives us both as hints). (pure) */
export function attachmentExt(contentType?: string, filename?: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) {
    if (ct.includes("png")) return ".png";
    if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
    if (ct.includes("gif")) return ".gif";
    if (ct.includes("webp")) return ".webp";
  }
  const fromName = (filename ?? "").toLowerCase().match(/\.(png|jpe?g|gif|webp|mp4|mp3|ogg|m4a|pdf|txt)$/);
  if (fromName) return fromName[0];
  if (ct.startsWith("audio/")) return ".ogg";
  if (ct.startsWith("video/")) return ".mp4";
  return ".bin";
}

/** Sniff a file extension from magic bytes — fallback when signal-cli's base64 attachment lacks a contentType. (pure) */
export function extFromBytes(data: Uint8Array): string {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return ".png";
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return ".jpg";
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return ".gif";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return ".webp";
  return ".bin";
}

export interface SignalImageRef {
  /** signal-cli attachment id — fetched via JSON-RPC getAttachment in start() */
  id: string;
  contentType?: string;
  filename?: string;
}

/** Parse one signal-cli envelope → InboundMsg + the image attachments to fetch (pure; the fetch/download happens in
 *  start()). Mirrors hermes' _handle_envelope: unwraps the {envelope:{...}} shape, handles plain dataMessage + edits,
 *  filters our own outbound + stories. Filtering of OUR OWN number is done here via `selfNumber`. Returns the msg +
 *  the image attachment refs (only images — other media is ignored, like Telegram/Matrix). null = skip. */
export function parseSignalMessage(
  raw: any,
  selfNumber: string,
): { msg: InboundMsg; images: SignalImageRef[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw.envelope ?? raw; // signal-cli wraps payloads as { envelope: {...} }

  // Stories / typing / receipts / sync echoes carry no inbound dataMessage → skip. Also skip our own outbound
  // (syncMessage is the echo of what WE sent from another linked device — never treat it as user input).
  if (env.syncMessage) return null;
  if (env.storyMessage) return null;
  if (env.typingMessage || env.receiptMessage) return null;

  const sender = env.sourceNumber || env.sourceUuid || env.source;
  if (!sender) return null;
  if (selfNumber && (env.sourceNumber === selfNumber || env.source === selfNumber)) return null; // our own message

  // editMessage carries its updated dataMessage nested inside (mirrors hermes).
  const data = env.dataMessage ?? env.editMessage?.dataMessage;
  if (!data || typeof data !== "object") return null;

  const group = data.groupInfo;
  // signal-cli omits (or nulls) groupInfo for a direct envelope. A present non-null but malformed group object
  // remains group-classified even without an id, which is the conservative behavior during protocol drift.
  const isGroup = group != null;
  const groupId = typeof group?.groupId === "string" && group.groupId.trim() ? group.groupId.trim() : undefined;
  const chatId = groupId ? `group:${groupId}` : String(sender);

  const atts = Array.isArray(data.attachments) ? data.attachments : [];
  const images: SignalImageRef[] = atts
    .filter((a: any) => a?.id && (String(a.contentType ?? "").startsWith("image/") || isImageExt(attachmentExt(a?.contentType, a?.filename))))
    .map((a: any) => ({ id: String(a.id), contentType: a?.contentType, filename: a?.filename }));

  const text = typeof data.message === "string" ? data.message : "";
  if (!text && images.length === 0) return null; // no text + no image (reaction/sticker/other media) → skip

  return {
    msg: {
      chatId,
      userId: String(sender),
      userName: env.sourceName || String(sender),
      text: text || "[图片]",
      chatType: isGroup ? "group" : "p2p",
    },
    images,
  };
}

export function signalAdapter(rpcUrl: string, selfNumber: string): ChatAdapter {
  const base = rpcUrl.replace(/\/+$/, ""); // trim trailing slashes
  let rpcSeq = 0;

  /** One JSON-RPC 2.0 call to the signal-cli daemon. Returns `result` (any) or null on error. */
  async function rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    responseLimit?: number,
  ): Promise<any> {
    const id = `${method}_${++rpcSeq}`;
    try {
      const res = await fetch(`${base}/api/v1/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
        signal,
      });
      if (!res.ok) return null;
      const j = (responseLimit
        ? JSON.parse((await readResponseBytesLimited(res, responseLimit, signal)).toString("utf8"))
        : await res.json()) as { result?: any; error?: any };
      if (j.error) {
        console.error(`hara gateway[signal]: RPC ${method} error:`, redactPhone(JSON.stringify(j.error)));
        return null;
      }
      return j.result ?? null;
    } catch (e) {
      if (signal?.aborted) return null;
      return null;
    }
  }

  /** Recipient/group routing shared by send + sendFile (mirrors hermes). */
  const target = (chatId: number | string): Record<string, unknown> => {
    const id = String(chatId);
    return id.startsWith("group:") ? { groupId: id.slice(6) } : { recipient: [id] };
  };

  /** Fetch a signal-cli attachment by id (base64 over JSON-RPC) → a local path under ~/.hara/signal/media. */
  async function downloadAttachment(
    ref: SignalImageRef,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<string | null> {
    try {
      const encodedLimit = Math.ceil(options.maxBytes / 3) * 4 + 64 * 1024;
      const result = await rpc("getAttachment", { account: selfNumber, id: ref.id }, options.signal, Math.min(encodedLimit, ATTACHMENT_RPC_MAX_BYTES));
      // signal-cli returns either a raw base64 string or { data: "base64..." }
      const b64 = typeof result === "string" ? result : result && typeof result === "object" ? result.data : null;
      if (!b64 || typeof b64 !== "string") return null;
      const bytes = decodeBase64Media(b64, options.maxBytes);
      let ext = attachmentExt(ref.contentType, ref.filename);
      if (ext === ".bin") ext = extFromBytes(bytes); // last-resort magic-byte sniff
      return await savePrivateMediaBytes(bytes, { platform: "signal", filenameHint: `attachment${ext}`, ...options });
    } catch {
      return null;
    }
  }

  return {
    name: "signal",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)", 4000)) {
        await rpc("send", { account: selfNumber, message: part, ...target(chatId) });
      }
    },
    async sendFile(chatId, filePath) {
      // Signal has no separate photo/document endpoints — everything is an `attachments` path on `send`.
      // signal-cli reads the file off the local disk by path, so we just hand it the path (no upload step).
      await rpc("send", { account: selfNumber, message: "", attachments: [filePath], ...target(chatId) }).catch(() => {});
    },
    async start(onMessage, signal, shouldDownload) {
      console.error(
        `hara gateway[signal]: polling signal-cli daemon at ${base} as ${redactPhone(selfNumber)} (ensure \`signal-cli -a <number> daemon --http\` is running).`,
      );
      while (!signal.aborted) {
        try {
          // JSON-RPC `receive` drains all envelopes queued since the last call. timeout is the long-poll seconds
          // the daemon will hold the request open waiting for new messages (server-side block → low-latency, low-spin).
          const result = await rpc("receive", { account: selfNumber, timeout: 30 }, signal);
          const envelopes: any[] = Array.isArray(result) ? result : result ? [result] : [];
          for (const raw of envelopes) {
            const parsed = parseSignalMessage(raw, selfNumber);
            if (!parsed) continue;
            if (shouldDownload?.(parsed.msg) === true) {
              const budget = new InboundMediaBudget("signal", signal);
              for (const ref of parsed.images) {
                const path = await budget.download((options) => downloadAttachment(ref, options));
                if (path) {
                  (parsed.msg.images ??= []).push(path);
                  (parsed.msg.transientFiles ??= []).push(path);
                }
              }
            }
            await onMessage(parsed.msg).catch(() => {});
          }
          if (envelopes.length === 0) await sleep(500); // daemon returned immediately (no long-poll support) → gentle spin
        } catch {
          if (signal.aborted) break;
          await sleep(2000); // daemon down / network blip → back off + retry (reconnect on drop)
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// signal-cli setup (the user does this once, OUTSIDE hara):
//
//   1. Install signal-cli           brew install signal-cli   (or download a release; needs a JRE)
//   2. Register OR link the number  (a) register a NEW number:
//                                       signal-cli -a +1555… register        # solve the captcha it prompts for
//                                       signal-cli -a +1555… verify 123456    # the SMS code
//                                   (b) OR link to an EXISTING phone as a secondary device:
//                                       signal-cli link -n "hara"             # scan the QR from Signal app → Linked devices
//   3. Run the HTTP/JSON-RPC daemon signal-cli -a +1555… daemon --http localhost:8080
//   4. Point hara at it             HARA_SIGNAL_RPC_URL=http://localhost:8080  HARA_SIGNAL_NUMBER=+1555…
//                                   hara gateway --platform signal
// ─────────────────────────────────────────────────────────────────────────────
