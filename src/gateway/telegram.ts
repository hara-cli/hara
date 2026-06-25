// Telegram adapter for `hara gateway` — long-poll getUpdates + sendMessage over the Bot API (built-in
// fetch, zero new dep). Token from HARA_TELEGRAM_TOKEN. The generic `ChatAdapter` shape is what WeChat(iLink)
// / Feishu plug into next.
const API = "https://api.telegram.org";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface InboundMsg {
  chatId: number | string; // Telegram numeric chat id; WeChat wxid string
  userId: number | string;
  userName: string;
  text: string;
  /** local paths to inbound images the agent should SEE (attached inline / described downstream) */
  images?: string[];
}
export interface ChatAdapter {
  name: string;
  start(onMessage: (m: InboundMsg) => Promise<void>, signal: AbortSignal): Promise<void>;
  send(chatId: number | string, text: string): Promise<void>;
  /** Optional: send a local file (voice/image/document). Adapters without it just don't send files. */
  sendFile?(chatId: number | string, filePath: string): Promise<void>;
}

/** Extract an InboundMsg from a Telegram getUpdates result item (pure). null if it isn't a text message. */
export function parseTelegramUpdate(u: any): InboundMsg | null {
  const m = u?.message;
  if (!m || typeof m.text !== "string" || !m.chat?.id) return null;
  return { chatId: m.chat.id, userId: m.from?.id ?? 0, userName: m.from?.username || m.from?.first_name || String(m.from?.id ?? ""), text: m.text };
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
  return {
    name: "telegram",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)")) {
        await fetch(`${base}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: part }),
        }).catch(() => {});
      }
    },
    async start(onMessage, signal) {
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
            if (msg) await onMessage(msg).catch(() => {});
          }
        } catch {
          if (signal.aborted) break;
          await sleep(2000); // network blip → back off + retry
        }
      }
    },
  };
}
