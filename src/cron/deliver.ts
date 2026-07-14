// Cron result delivery — push a finished job's output to a chat channel (openclaw/hermes parity),
// WITHOUT needing the gateway process: adapters are constructed one-shot from the same env vars the
// gateway uses, send once, and are dropped. Spec format: "<target>:<id>" —
//   telegram:<chatId>   (HARA_TELEGRAM_TOKEN)
//   feishu:<chatId>     (HARA_FEISHU_APP_ID + HARA_FEISHU_APP_SECRET)
//   webhook:<url>       (plain POST {name,status,text} JSON — for anything else)
//   weixin:<peerId>     (sends over stored ~/.hara/weixin creds — explicit peer required; guessing the
//                        "owner" from a multi-DM context-token cache can deliver private results to the wrong person)
// Adapters are imported LAZILY so the (heavy) SDKs never load unless a job actually delivers.
import { outboundTransferTimeoutMs, withOutboundDeadline } from "../gateway/telegram.js";

export interface DeliverTarget {
  platform: "telegram" | "feishu" | "webhook" | "weixin";
  to: string;
}

/** Parse a `--deliver` spec; error string on anything unsupported (listing what IS supported). */
export function parseDeliver(spec: string): DeliverTarget | { error: string } {
  const i = spec.indexOf(":");
  if (i <= 0) return { error: "bad deliver spec — use telegram:<chatId>, feishu:<chatId>, weixin:<peerId>, or webhook:<url>" };
  const platform = spec.slice(0, i).toLowerCase();
  const to = spec.slice(i + 1).trim();
  if (!to) return { error: "deliver spec is missing a target after ':'" };
  if (platform === "weixin" && to.toLowerCase() === "owner") {
    return { error: "weixin:owner is ambiguous when several people have messaged the bot — use an explicit weixin:<peerId>" };
  }
  if (platform === "telegram" || platform === "feishu" || platform === "webhook" || platform === "weixin") return { platform, to };
  return { error: "unsupported deliver platform — supported: telegram, feishu, weixin, webhook" };
}

function safeDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const boundedLifecycle = /^(?:Gateway delivery|Webhook delivery|Telegram (?:send|upload)|Feishu (?:send|upload|recall)) (?:cancelled|timed out after \d+ms)$/u.exec(message);
  if (boundedLifecycle) return boundedLifecycle[0];
  const telegramStatus = /^(Telegram [A-Za-z]+ failed: HTTP \d+)/u.exec(message);
  if (telegramStatus) return telegramStatus[1];
  const controlledTransport = /^(?:Telegram [A-Za-z]+ transport failed|Feishu (?:auth transport failed|transport failed|auth failed: HTTP \d+(?: · code=\d+)?|request failed: HTTP \d+(?: · code=\d+)?))$/u.exec(message);
  if (controlledTransport) return controlledTransport[0];
  // Opaque adapters and native fetch errors may contain the full target URL (including query credentials).
  return "transport request failed";
}

/** Flatten markdown for plain-text chat surfaces (Feishu/WeChat/Telegram text messages render syntax
 *  literally): drop code fences/inline backticks/bold/headers, turn [text](url) into "text (url)". */
export function plainChat(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/** Send `text` to the target. Returns null on success, or an error string (never throws — cron
 * delivery is best-effort and must not kill the tick). `signal` ties one-shot adapters to their caller;
 * the outer hard deadline also bounds adapters/SDKs that fail to cooperate with cancellation. */
export async function deliverResult(
  spec: string,
  text: string,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<string | null> {
  const t = parseDeliver(spec);
  if ("error" in t) return t.error;
  if (t.platform !== "webhook") text = plainChat(text); // chat surfaces are plain text; webhooks get raw payload
  try {
    return await withOutboundDeadline(
      "Gateway delivery",
      signal,
      outboundTransferTimeoutMs("text"),
      async (deliverySignal) => {
        if (t.platform === "webhook") {
          return withOutboundDeadline("Webhook delivery", deliverySignal, 15_000, async (webhookSignal) => {
            const r = await fetch(t.to, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
              },
              body: JSON.stringify({ source: "hara-cron", text }),
              signal: webhookSignal,
            });
            return r.ok ? null : `webhook ${r.status}`;
          });
        }
        if (t.platform === "telegram") {
          const token = process.env.HARA_TELEGRAM_TOKEN;
          if (!token) return "HARA_TELEGRAM_TOKEN not set";
          const { telegramAdapter } = await import("../gateway/telegram.js");
          await telegramAdapter(token).send(t.to, text, deliverySignal, idempotencyKey);
          return null;
        }
        if (t.platform === "weixin") {
          const { loadWeixinCreds, weixinAdapter } = await import("../gateway/weixin.js");
          const creds = loadWeixinCreds();
          if (!creds) return "hara weixin not logged in (~/.hara/weixin/creds.json missing)";
          await weixinAdapter(creds).send(t.to, text, deliverySignal);
          return null;
        }
        // feishu
        const appId = process.env.HARA_FEISHU_APP_ID;
        const appSecret = process.env.HARA_FEISHU_APP_SECRET;
        if (!appId || !appSecret) return "HARA_FEISHU_APP_ID / HARA_FEISHU_APP_SECRET not set";
        const { feishuAdapter } = await import("../gateway/feishu.js");
        await feishuAdapter(appId, appSecret).send(t.to, text, deliverySignal, idempotencyKey);
        return null;
      },
    );
  } catch (e) {
    return `delivery failed: ${safeDeliveryError(e)}`;
  }
}
