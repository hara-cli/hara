// Slack adapter for `hara gateway` — uses Socket Mode so the local daemon connects OUT over Node's native
// global WebSocket (zero new dep on Node ≥ 22): apps.connections.open (app-level token, xapp-) hands back a
// wss:// URL → we connect, ACK every envelope, and turn message events into InboundMsg. Outbound is the Web
// API (bot token, xoxb-). Same ChatAdapter shape as Discord/Telegram, so all cross-platform gateway plumbing
// (send_file, in-chat system context, stuck-guard, image attach/describe) works unchanged. Two tokens are
// required because Socket Mode (xapp-) and the Web API (xoxb-) are separate auth scopes.
import { InboundMediaBudget, savePrivateResponse } from "./media.js";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

const WEB = "https://slack.com/api";
const WSImpl: any = (globalThis as any).WebSocket;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

const isImage = (name: string, mime?: string): boolean => (mime?.startsWith("image/") ?? false) || /\.(png|jpe?g|gif|webp)$/i.test(name);

/** Call a Slack Web API method with a token (form-encoded, the most widely-accepted shape). Returns the parsed
 *  JSON; callers check `.ok`. Never throws — a failed call resolves to `{ ok: false }`. */
async function slackApi(method: string, token: string, body: Record<string, unknown>): Promise<any> {
  try {
    const r = await fetch(`${WEB}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

/** Slack file url_private is gated — it needs the BOT token as a Bearer header (a plain GET returns the login
 *  page HTML, not the bytes). Download into ~/.hara/slack/media so the agent can SEE it. */
async function downloadSlackFile(
  url: string,
  name: string,
  botToken: string,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` }, signal: options.signal });
    if (!r.ok) return null;
    return await savePrivateResponse(r, { platform: "slack", filenameHint: name, ...options });
  } catch {
    return null;
  }
}

/** Parse a Slack Events API `event` (the inner `payload.event`) → InboundMsg + its image file refs (pure;
 *  download happens in start()). null = ignore (not a user message / our own / an edit/delete subtype / empty).
 *  Mirrors discord.ts's parseDiscordMessage so it's unit-testable without the network. */
export function slackChatType(event: any): "p2p" | "group" {
  const channel = String(event?.channel ?? "").trim();
  // Slack reserves D-prefixed ids for direct-message channels. It is stronger than a contradictory event field.
  if (channel.startsWith("D")) return "p2p";
  return String(event?.channel_type ?? "").trim().toLowerCase() === "im" ? "p2p" : "group";
}

export function parseSlackEvent(event: any, selfId: string): { msg: InboundMsg; imageUrls: { url: string; name: string }[] } | null {
  if (event?.type !== "message") return null;
  if (event.bot_id || (selfId && event.user === selfId)) return null; // ignore bots + our own messages
  // message_changed / message_deleted / channel_join … carry no fresh user text we want to act on
  if (event.subtype && event.subtype !== "file_share") return null;
  if (!event.channel || !event.user) return null;
  const files = Array.isArray(event.files) ? event.files : [];
  const imageUrls = files
    .filter((f: any) => isImage(String(f?.name ?? ""), f?.mimetype))
    .map((f: any) => ({ url: String(f?.url_private_download || f?.url_private || ""), name: String(f?.name ?? "image") }))
    .filter((f: { url: string }) => f.url);
  const text = String(event.text ?? "");
  if (!text && !imageUrls.length) return null;
  return {
    msg: {
      chatId: String(event.channel),
      userId: String(event.user),
      userName: String(event.user), // Slack events carry only the id; users.info would resolve a name (skipped for zero extra calls)
      text: text || "[图片]",
      chatType: slackChatType(event),
    },
    imageUrls,
  };
}

export function slackAdapter(appToken: string, botToken: string): ChatAdapter {
  return {
    name: "slack",
    async send(chatId, text) {
      // Slack hard-caps a message at 40k chars; 3500 keeps us clear of mrkdwn expansion + block limits.
      for (const part of chunkText(text || "(empty)", 3500)) {
        await slackApi("chat.postMessage", botToken, { channel: chatId, text: part });
      }
    },
    async sendFile(chatId, file) {
      // 3-step external-upload flow (getUploadURLExternal → PUT bytes → completeUploadExternal): the current,
      // non-deprecated path that works with just files:write (the old files.upload can 404/missing_scope).
      try {
        const bytes = file.bytes;
        const name = file.safeName;
        const url = await slackApi("files.getUploadURLExternal", botToken, { filename: name, length: bytes.length });
        if (!url?.ok || !url.upload_url || !url.file_id) return;
        const up = await fetch(url.upload_url, { method: "POST", body: new Blob([new Uint8Array(bytes)]) }); // presigned URL: no auth header
        if (!up.ok) return;
        await slackApi("files.completeUploadExternal", botToken, { files: [{ id: url.file_id, title: name }], channel_id: String(chatId) });
      } catch {
        /* upload/send failed — surfaced upstream as "no file delivered" */
      }
    },
    async start(onMessage, signal, shouldDownload) {
      if (!WSImpl) {
        console.error("hara gateway: Slack needs Node ≥ 22 (global WebSocket). Upgrade Node.");
        return;
      }
      // Resolve our own bot user id once so parseSlackEvent can drop our own messages (echo-loop guard).
      const auth = await slackApi("auth.test", botToken, {});
      const selfId = String(auth?.user_id ?? "");
      while (!signal.aborted) {
        const wss = await openSocketUrl(appToken);
        if (wss) await connectOnce(wss, botToken, selfId, onMessage, signal, shouldDownload);
        if (!signal.aborted) await sleep(3000, signal); // reconnect backoff (and re-open: each URL is single-use)
      }
    },
  };
}

/** Ask Slack for a fresh single-use Socket Mode wss:// URL (app-level token). null on failure → caller backs off. */
async function openSocketUrl(appToken: string): Promise<string | null> {
  const j = await slackApi("apps.connections.open", appToken, {});
  return j?.ok && typeof j.url === "string" ? j.url : null;
}

/** One Socket Mode connection: receive envelopes, ACK each by echoing its envelope_id, and dispatch message
 *  events. Resolves on close/disconnect/abort; the caller re-opens a new URL and reconnects. v1 keeps it simple —
 *  no buffered-payload backpressure (the daemon spawns one hara per message anyway). */
function connectOnce(
  url: string,
  botToken: string,
  selfId: string,
  onMessage: (m: InboundMsg) => Promise<void>,
  signal: AbortSignal,
  shouldDownload?: (m: InboundMsg) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WSImpl(url);
    const stop = (): void => {
      signal.removeEventListener("abort", stop);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
    ws.addEventListener("close", () => {
      signal.removeEventListener("abort", stop);
      resolve();
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("message", async (ev: any) => {
      let p: any;
      try {
        p = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // ACK first — Slack redelivers (and eventually disconnects the socket) for any envelope we don't ack in ~3s.
      if (p.envelope_id) {
        try {
          ws.send(JSON.stringify({ envelope_id: p.envelope_id }));
        } catch {
          /* socket gone */
        }
      }
      if (p.type === "disconnect") {
        stop(); // server is rotating us off (refresh / too_many_connections) → drop and let the caller reconnect
        return;
      }
      if (p.type === "events_api") {
        const parsed = parseSlackEvent(p.payload?.event, selfId);
        if (parsed) {
          if (shouldDownload?.(parsed.msg) === true) {
            const budget = new InboundMediaBudget("slack", signal);
            for (const im of parsed.imageUrls) {
              const path = await budget.download((options) => downloadSlackFile(im.url, im.name, botToken, options));
              if (path) {
                (parsed.msg.images ??= []).push(path);
                (parsed.msg.transientFiles ??= []).push(path);
              }
            }
          }
          await onMessage(parsed.msg).catch(() => {});
        }
      }
      // type "hello" (connection established) and slash_commands/interactive envelopes: acked above, nothing else to do.
    });
  });
}
