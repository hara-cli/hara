// DingTalk (钉钉) adapter for `hara gateway` — connects to DingTalk's Stream Mode over Node's native global
// WebSocket (zero new dep on Node ≥ 22) so the LOCAL daemon dials OUT (no public webhook endpoint needed, like
// Feishu's long-connection). Creds from HARA_DINGTALK_CLIENT_ID / HARA_DINGTALK_CLIENT_SECRET (the app's
// AppKey/AppSecret on open.dingtalk.com). Replies go to the per-message `sessionWebhook` the inbound payload
// carries. Same ChatAdapter shape as Telegram/Discord/Feishu, so all the cross-platform gateway plumbing
// (system context, stuck-guard, allowlist) works unchanged. v1 limitations: file send is not supported (DingTalk
// bot replies via sessionWebhook only do text/markdown cards) and inbound images are noted but not downloaded.
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

// Open a Stream connection here → response gives the WS endpoint + a ticket; then we dial endpoint?ticket=…
const OPEN_CONNECTION = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const BOT_TOPIC = "/v1.0/im/bot/messages/get"; // the CALLBACK topic that carries a bot chat message
const WSImpl: any = (globalThis as any).WebSocket;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

/** Parse a DingTalk bot message payload (the JSON.parse'd `data` field of a CALLBACK frame) → InboundMsg plus the
 *  per-message sessionWebhook used to reply (pure). Accepts text (and picture, marked "[图片]"); null otherwise.
 *  conversationId routes group/DM; senderStaffId is preferred for the allowlist (the org staff id), else senderId. */
export function parseDingtalkMessage(msg: any): { msg: InboundMsg; sessionWebhook: string | null } | null {
  if (!msg) return null;
  const chatId = String(msg.conversationId || msg.senderId || "");
  if (!chatId) return null;
  const userId = String(msg.senderStaffId || msg.senderId || "");
  const userName = String(msg.senderNick || userId);
  const sessionWebhook = typeof msg.sessionWebhook === "string" ? msg.sessionWebhook : null;
  const type = String(msg.msgtype || "");
  let text = "";
  if (type === "text") text = String(msg.text?.content ?? "").trim();
  else if (type === "picture") text = "[图片]"; // v1: inbound image not downloaded (downloadCode in content)
  else if (type === "richText") text = flattenRichText(msg.content?.richText).trim();
  if (!text) return null; // unsupported type (audio/file/etc.) or empty
  return { msg: { chatId, userId, userName, text }, sessionWebhook };
}

/** Flatten a DingTalk richText message (an array of {text}/{type} runs) into plain text (pure). */
function flattenRichText(runs: any): string {
  if (!Array.isArray(runs)) return "";
  return runs.map((r: any) => (r && typeof r.text === "string" ? r.text : "")).join(" ").trim();
}

export function dingtalkAdapter(clientId: string, clientSecret: string): ChatAdapter {
  // chatId → the latest sessionWebhook seen for it (expires ~ a few hours; refreshed on each inbound message).
  const webhooks = new Map<string, string>();
  return {
    name: "dingtalk",
    async send(chatId, text) {
      const url = webhooks.get(String(chatId));
      if (!url) return; // no inbound seen yet → no webhook to reply through (replies must follow a message)
      for (const part of chunkText(text || "(empty)")) {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: part } }),
        }).catch(() => {});
      }
    },
    // sendFile intentionally omitted: DingTalk bot replies (sessionWebhook) can't upload arbitrary files in v1.
    // The gateway surfaces "(this platform can't send files yet)" when the agent queues a file.
    async start(onMessage, signal) {
      if (!WSImpl) {
        console.error("hara gateway: DingTalk needs Node ≥ 22 (global WebSocket). Upgrade Node.");
        return;
      }
      while (!signal.aborted) {
        await connectOnce(clientId, clientSecret, webhooks, onMessage, signal);
        if (!signal.aborted) await sleep(3000, signal); // reconnect backoff
      }
    },
  };
}

/** One Stream connection: register → open the WS to the returned endpoint?ticket=…, then ACK every frame and
 *  dispatch bot messages. Resolves on close/abort; the caller reconnects (fresh registration each time). */
async function connectOnce(
  clientId: string,
  clientSecret: string,
  webhooks: Map<string, string>,
  onMessage: (m: InboundMsg) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let endpoint: string;
  let ticket: string;
  try {
    const res = await fetch(OPEN_CONNECTION, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [
          { type: "EVENT", topic: "*" },
          { type: "CALLBACK", topic: BOT_TOPIC },
        ],
        ua: "hara-cli/stream",
        localIp: "127.0.0.1",
      }),
      signal,
    });
    if (!res.ok) {
      console.error(`hara gateway: DingTalk connection register failed (HTTP ${res.status}) — check HARA_DINGTALK_CLIENT_ID/SECRET and that Stream mode is enabled.`);
      return;
    }
    const j = (await res.json()) as { endpoint?: string; ticket?: string };
    if (!j.endpoint || !j.ticket) {
      console.error("hara gateway: DingTalk register returned no endpoint/ticket.");
      return;
    }
    endpoint = j.endpoint;
    ticket = j.ticket;
  } catch {
    if (!signal.aborted) console.error("hara gateway: DingTalk connection register error (network).");
    return;
  }

  return new Promise((resolve) => {
    const ws = new WSImpl(`${endpoint}?ticket=${encodeURIComponent(ticket)}`);
    let hb: ReturnType<typeof setInterval> | null = null;
    const cleanup = (): void => {
      if (hb) clearInterval(hb);
      signal.removeEventListener("abort", stop);
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
      // Application-level keepalive: a SYSTEM/ping frame keeps the connection registered between messages.
      hb = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "SYSTEM", headers: { topic: "ping" }, data: "{}" }));
        } catch {
          /* socket gone — close handler resolves */
        }
      }, 30000);
    });
    ws.addEventListener("close", () => {
      cleanup();
      resolve();
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("message", async (ev: any) => {
      let frame: any;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const headers = frame?.headers ?? {};
      const topic = String(headers.topic ?? "");
      // ACK every frame with its messageId per the Stream ack protocol; reply data is a JSON-string `response`.
      const ack = (response: unknown): void => {
        if (!headers.messageId) return;
        try {
          ws.send(
            JSON.stringify({
              code: 200,
              headers: { messageId: headers.messageId, contentType: "application/json" },
              message: "OK",
              data: JSON.stringify({ response: response ?? {} }),
            }),
          );
        } catch {
          /* socket gone */
        }
      };
      if (frame?.type === "SYSTEM") {
        if (topic === "disconnect") {
          stop(); // server asked us to drop → close and let the caller re-register
          return;
        }
        ack({}); // ping / connected / other system frames → just acknowledge
        return;
      }
      if (topic === BOT_TOPIC) {
        let payload: any;
        try {
          payload = JSON.parse(String(frame.data ?? "{}")); // CALLBACK data is a JSON string
        } catch {
          ack({});
          return;
        }
        ack({}); // ack first (DingTalk expects a prompt ack; the actual reply goes via sessionWebhook)
        const parsed = parseDingtalkMessage(payload);
        if (parsed) {
          if (parsed.sessionWebhook) webhooks.set(String(parsed.msg.chatId), parsed.sessionWebhook);
          await onMessage(parsed.msg).catch(() => {});
        }
        return;
      }
      ack({}); // any other EVENT frame → acknowledge so DingTalk doesn't retry
    });
  });
}
