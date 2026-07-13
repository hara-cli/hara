// Telegram adapter for `hara gateway` — long-poll getUpdates + sendMessage over the Bot API (built-in
// fetch, zero new dep). Token from HARA_TELEGRAM_TOKEN. The generic `ChatAdapter` shape is what WeChat(iLink)
// / Feishu plug into next.
import { InboundMediaBudget, savePrivateResponse } from "./media.js";
import type { OutboundFilePayload } from "./outbound-files.js";

const API = "https://api.telegram.org";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface InboundMsg {
  chatId: number | string; // Telegram numeric chat id; WeChat wxid string
  userId: number | string;
  userName: string;
  text: string;
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
export interface ChatAdapter {
  name: string;
  start(
    onMessage: (m: InboundMsg) => Promise<void>,
    signal: AbortSignal,
    /** Fail-closed authorization preflight. Media is never fetched when omitted or false. */
    shouldDownload?: (m: InboundMsg) => boolean,
  ): Promise<void>;
  send(chatId: number | string, text: string): Promise<void>;
  /** Optional: upload already-verified bytes. `snapshotPath` is cleanup-only and must never be reopened here. */
  sendFile?(chatId: number | string, file: OutboundFilePayload): Promise<void>;
  /** Optional: send a message and return its platform message id — so transient UX messages ("⟳ working…")
   *  can be recalled later. Platforms without it just leave such messages in place. */
  sendTracked?(chatId: number | string, text: string): Promise<string | undefined>;
  /** Optional: delete/recall one of the BOT's own messages (e.g. Feishu allows it; WeChat iLink does not). */
  recall?(chatId: number | string, messageId: string): Promise<void>;
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

/** Split text into chunks ≤ max (Telegram caps a message at 4096 chars) (pure). */
export function chunkText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

export function telegramAdapter(token: string): ChatAdapter {
  const base = `${API}/bot${token}`;
  const request = async (method: string, init: RequestInit): Promise<any> => {
    const response = await fetch(`${base}/${method}`, init);
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
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)")) {
        await request("sendMessage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: part }),
        });
      }
    },
    async sendFile(chatId, file) {
      // images → sendPhoto (inline preview); everything else → sendDocument (keeps the filename)
      const name = file.safeName;
      const isImg = /\.(png|jpe?g|gif|webp)$/i.test(name);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append(isImg ? "photo" : "document", new Blob([new Uint8Array(file.bytes)]), name);
      await request(isImg ? "sendPhoto" : "sendDocument", { method: "POST", body: form });
    },
    async start(onMessage, signal, shouldDownload) {
      let offset = 0;
      while (!signal.aborted) {
        try {
          const res = await fetch(`${base}/getUpdates?timeout=30&offset=${offset}`, { signal });
          if (!res.ok) {
            await sleep(2000);
            continue;
          }
          const j = (await res.json()) as { result?: any[] };
          for (const u of j.result ?? []) {
            offset = Math.max(offset, (u.update_id ?? 0) + 1);
            const msg = parseTelegramUpdate(u);
            if (!msg) continue;
            const fid = photoFileId(u); // a photo message → download it so the agent can SEE it
            if (fid && shouldDownload?.(msg) === true) {
              const budget = new InboundMediaBudget("telegram", signal);
              const path = await budget.download((options) => downloadTelegramFile(base, token, fid, options));
              if (path) {
                msg.images = [path];
                msg.transientFiles = [path];
              }
            }
            await onMessage(msg).catch(() => {});
          }
        } catch {
          if (signal.aborted) break;
          await sleep(2000); // network blip → back off + retry
        }
      }
    },
  };
}
