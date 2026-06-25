// Discord adapter for `hara gateway` — connects to the Discord gateway over Node's native global WebSocket
// (zero new dep on Node ≥ 22) for inbound, and the REST API for outbound. Token from HARA_DISCORD_TOKEN; allow
// users via HARA_GATEWAY_ALLOWED (Discord user-id snowflakes). Same ChatAdapter shape as Telegram/WeChat, so all
// the cross-platform gateway plumbing (send_file, in-chat system context, stuck-guard, image attach/describe)
// works unchanged. NOTE: receiving message text needs the privileged "Message Content Intent" enabled for the
// bot in the Discord developer portal.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

const REST = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15, privileged)
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const WSImpl: any = (globalThis as any).WebSocket;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

const isImage = (name: string, mime?: string): boolean => (mime?.startsWith("image/") ?? false) || /\.(png|jpe?g|gif|webp)$/i.test(name);

async function downloadDiscordAttachment(url: string, filename: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const dir = join(homedir(), ".hara", "discord", "media");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `dc_${Date.now()}_${basename(filename) || "file.bin"}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
    return path;
  } catch {
    return null;
  }
}

/** Parse a Discord MESSAGE_CREATE payload → InboundMsg + its image attachment URLs (pure; download happens in
 *  start()). null = ignore (own message / another bot / empty). */
export function parseDiscordMessage(d: any, selfId: string): { msg: InboundMsg; imageUrls: { url: string; name: string }[] } | null {
  if (!d?.channel_id || !d?.author?.id) return null;
  if (d.author.id === selfId || d.author.bot) return null; // ignore our own messages + other bots
  const atts = Array.isArray(d.attachments) ? d.attachments : [];
  const imageUrls = atts
    .filter((a: any) => isImage(String(a?.filename ?? ""), a?.content_type))
    .map((a: any) => ({ url: String(a.url), name: String(a.filename ?? "image") }));
  const text = String(d.content ?? "");
  if (!text && !imageUrls.length) return null;
  return {
    msg: {
      chatId: String(d.channel_id),
      userId: String(d.author.id),
      userName: d.author.global_name || d.author.username || String(d.author.id),
      text: text || "[图片]",
    },
    imageUrls,
  };
}

export function discordAdapter(token: string): ChatAdapter {
  const auth = { Authorization: `Bot ${token}` };
  return {
    name: "discord",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)", 2000)) {
        await fetch(`${REST}/channels/${chatId}/messages`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ content: part }),
        }).catch(() => {});
      }
    },
    async sendFile(chatId, filePath) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({}));
      form.append("files[0]", new Blob([readFileSync(filePath)]), basename(filePath));
      await fetch(`${REST}/channels/${chatId}/messages`, { method: "POST", headers: auth, body: form }).catch(() => {});
    },
    async start(onMessage, signal) {
      if (!WSImpl) {
        console.error("hara gateway: Discord needs Node ≥ 22 (global WebSocket). Upgrade Node.");
        return;
      }
      while (!signal.aborted) {
        await connectOnce(token, onMessage, signal);
        if (!signal.aborted) await sleep(3000, signal); // reconnect backoff
      }
    },
  };
}

/** One gateway connection: HELLO→heartbeat, IDENTIFY, then dispatch MESSAGE_CREATE. Resolves on close/abort;
 *  the caller reconnects. v1 keeps it simple — fresh IDENTIFY each time, no RESUME. */
function connectOnce(token: string, onMessage: (m: InboundMsg) => Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WSImpl(GATEWAY);
    let hb: ReturnType<typeof setInterval> | null = null;
    let seq: number | null = null;
    let selfId = "";
    const stop = (): void => {
      if (hb) clearInterval(hb);
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
      if (hb) clearInterval(hb);
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
      if (typeof p.s === "number") seq = p.s;
      if (p.op === 10) {
        const interval = p.d?.heartbeat_interval ?? 41250;
        hb = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 1, d: seq }));
          } catch {
            /* socket gone */
          }
        }, interval);
        ws.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS, properties: { os: "linux", browser: "hara", device: "hara" } } }));
      } else if (p.op === 0) {
        if (p.t === "READY") selfId = p.d?.user?.id ?? "";
        else if (p.t === "MESSAGE_CREATE") {
          const parsed = parseDiscordMessage(p.d, selfId);
          if (parsed) {
            for (const im of parsed.imageUrls) {
              const path = await downloadDiscordAttachment(im.url, im.name);
              if (path) (parsed.msg.images ??= []).push(path);
            }
            await onMessage(parsed.msg).catch(() => {});
          }
        }
      } else if (p.op === 7 || p.op === 9) {
        stop(); // server asked to reconnect / invalid session → drop and let the caller reconnect
      }
    });
  });
}
