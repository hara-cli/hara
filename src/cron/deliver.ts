// Cron result delivery — push a finished job's output to a chat channel (openclaw/hermes parity),
// WITHOUT needing the gateway process: adapters are constructed one-shot from the same env vars the
// gateway uses, send once, and are dropped. Spec format: "<target>:<id>" —
//   telegram:<chatId>   (HARA_TELEGRAM_TOKEN)
//   feishu:<chatId>     (HARA_FEISHU_APP_ID + HARA_FEISHU_APP_SECRET)
//   webhook:<url>       (plain POST {name,status,text} JSON — for anything else)
//   weixin:<peerId>     (sends over stored ~/.hara/weixin creds — explicit peer required; guessing the
//                        "owner" from a multi-DM context-token cache can deliver private results to the wrong person)
// Adapters are imported LAZILY so the (heavy) SDKs never load unless a job actually delivers.

export interface DeliverTarget {
  platform: "telegram" | "feishu" | "webhook" | "weixin";
  to: string;
}

/** Parse a `--deliver` spec; error string on anything unsupported (listing what IS supported). */
export function parseDeliver(spec: string): DeliverTarget | { error: string } {
  const i = spec.indexOf(":");
  if (i <= 0) return { error: `bad deliver spec "${spec}" — use telegram:<chatId>, feishu:<chatId>, weixin:<peerId>, or webhook:<url>` };
  const platform = spec.slice(0, i).toLowerCase();
  const to = spec.slice(i + 1).trim();
  if (!to) return { error: `deliver spec "${spec}" is missing a target after ":"` };
  if (platform === "weixin" && to.toLowerCase() === "owner") {
    return { error: "weixin:owner is ambiguous when several people have messaged the bot — use an explicit weixin:<peerId>" };
  }
  if (platform === "telegram" || platform === "feishu" || platform === "webhook" || platform === "weixin") return { platform, to };
  return { error: `unsupported deliver platform "${platform}" — supported: telegram, feishu, weixin, webhook` };
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
 *  delivery is best-effort and must not kill the tick). */
export async function deliverResult(spec: string, text: string): Promise<string | null> {
  const t = parseDeliver(spec);
  if ("error" in t) return t.error;
  if (t.platform !== "webhook") text = plainChat(text); // chat surfaces are plain text; webhooks get raw payload
  try {
    if (t.platform === "webhook") {
      const r = await fetch(t.to, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "hara-cron", text }),
        signal: AbortSignal.timeout(15_000),
      });
      return r.ok ? null : `webhook ${r.status}`;
    }
    if (t.platform === "telegram") {
      const token = process.env.HARA_TELEGRAM_TOKEN;
      if (!token) return "HARA_TELEGRAM_TOKEN not set";
      const { telegramAdapter } = await import("../gateway/telegram.js");
      await telegramAdapter(token).send(t.to, text);
      return null;
    }
    if (t.platform === "weixin") {
      const { loadWeixinCreds, weixinAdapter } = await import("../gateway/weixin.js");
      const creds = loadWeixinCreds();
      if (!creds) return "hara weixin not logged in (~/.hara/weixin/creds.json missing)";
      await weixinAdapter(creds).send(t.to, text);
      return null;
    }
    // feishu
    const appId = process.env.HARA_FEISHU_APP_ID;
    const appSecret = process.env.HARA_FEISHU_APP_SECRET;
    if (!appId || !appSecret) return "HARA_FEISHU_APP_ID / HARA_FEISHU_APP_SECRET not set";
    const { feishuAdapter } = await import("../gateway/feishu.js");
    await feishuAdapter(appId, appSecret).send(t.to, text);
    return null;
  } catch (e) {
    return `delivery failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
