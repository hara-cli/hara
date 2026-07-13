// Feishu/Lark adapter for `hara gateway` — uses the official @larksuiteoapi/node-sdk: a WSClient long-connection
// for inbound events (no public webhook endpoint needed — fits hara's local daemon) and the REST Client for
// outbound. Creds from HARA_FEISHU_APP_ID / HARA_FEISHU_APP_SECRET (+ HARA_FEISHU_DOMAIN=lark for larksuite.com).
// Same ChatAdapter shape as the others, so all cross-platform gateway logic (send_file, system context,
// stuck-guard, image attach/describe) works unchanged. v1 = p2p (DM) only; group support is a fast-follow.
// Namespace import + default fallback: node resolves this SDK as CJS (default = module object), but
// bun's bundler resolves its ESM build (named exports only, NO default) — `import lark from` made
// every binaries release fail. This form works under both resolutions.
import * as larkNs from "@larksuiteoapi/node-sdk";
const lark = ((larkNs as { default?: unknown }).default ?? larkNs) as typeof import("@larksuiteoapi/node-sdk");
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";
import { InboundMediaBudget, cleanupTransientMedia, savePrivateMedia } from "./media.js";

/** Normalize a Feishu message's parsed content by type → text + any media keys (pure; download done by caller). */
export function parseFeishuContent(
  messageType: string,
  content: any,
): { text: string; imageKey?: string; fileKey?: string; fileName?: string } {
  if (messageType === "text") return { text: String(content?.text ?? "") };
  if (messageType === "post") return { text: flattenPost(content) };
  if (messageType === "image") return { text: "", imageKey: content?.image_key };
  if (messageType === "file") return { text: "", fileKey: content?.file_key, fileName: content?.file_name };
  if (messageType === "audio") return { text: "", fileKey: content?.file_key, fileName: "audio" };
  return { text: "" };
}

/** Flatten a Feishu rich-text "post" message into plain text (best-effort over its [[{tag,text}]] runs). */
export function flattenPost(content: any): string {
  const blocks = content?.content ?? content?.zh_cn?.content ?? content?.en_us?.content ?? [];
  const out: string[] = [];
  for (const line of Array.isArray(blocks) ? blocks : []) {
    for (const seg of Array.isArray(line) ? line : []) {
      if (seg?.tag === "text" && seg.text) out.push(String(seg.text));
      else if (seg?.tag === "a" && seg.text) out.push(String(seg.text));
    }
  }
  return out.join(" ").trim();
}

async function downloadFeishuResource(
  client: any,
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  options: { maxBytes: number; signal: AbortSignal },
): Promise<string | null> {
  try {
    const resp: any = await client.im.messageResource.get(
      { path: { message_id: messageId, file_key: fileKey }, params: { type } },
      { signal: options.signal },
    );
    if (typeof resp?.getReadableStream !== "function") return null;
    return await savePrivateMedia(resp.getReadableStream(), {
      platform: "feishu",
      filenameHint: type === "image" ? "image.jpg" : "file.bin",
      contentType: resp?.headers?.["content-type"],
      ...options,
    });
  } catch {
    return null;
  }
}

/** Build an InboundMsg from a Feishu im.message.receive_v1 event (downloads media). Handles BOTH p2p (DM) and
 *  group messages — group @-mentions are surfaced (with `isSelf`) so gateway flows can target them. null = skip. */
async function toInbound(
  client: any,
  data: any,
  botOpenId: string | undefined,
  signal: AbortSignal,
  shouldDownload?: (m: InboundMsg) => boolean,
): Promise<InboundMsg | null> {
  const msg = data?.message;
  if (!msg?.chat_id) return null;
  const chatType: "p2p" | "group" | undefined =
    msg.chat_type === "p2p" ? "p2p" : msg.chat_type === "group" ? "group" : undefined;
  const sender = data?.sender?.sender_id;
  const userId = String(sender?.open_id || sender?.user_id || msg.chat_id);
  const rawMentions: any[] = Array.isArray(msg.mentions) ? msg.mentions : [];
  const mentions = rawMentions.length
    ? rawMentions.map((x) => ({
        id: x?.id?.open_id || x?.id?.user_id || (typeof x?.id === "string" ? x.id : undefined),
        name: x?.name,
        isSelf: !!botOpenId && x?.id?.open_id === botOpenId,
      }))
    : undefined;
  let content: any = {};
  try {
    content = JSON.parse(msg.content ?? "{}");
  } catch {
    /* malformed content → empty */
  }
  const parsed = parseFeishuContent(String(msg.message_type), content);
  let text = parsed.text;
  const images: string[] = [];
  const transientFiles: string[] = [];
  const mediaMarker = parsed.imageKey ? "[图片]" : parsed.fileKey ? "[附件]" : "";
  const base: InboundMsg = {
    chatId: String(msg.chat_id),
    userId,
    userName: userId,
    text: text || mediaMarker,
    chatType,
    mentions,
  };
  let handedOff = false;
  try {
    if (shouldDownload?.(base) === true && (parsed.imageKey || parsed.fileKey)) {
      const budget = new InboundMediaBudget("feishu", signal);
      if (parsed.imageKey) {
        const p = await budget.download((options) => downloadFeishuResource(client, msg.message_id, parsed.imageKey!, "image", options));
        if (p) {
          images.push(p);
          transientFiles.push(p);
          text = "[图片]";
        }
      } else if (parsed.fileKey) {
        const p = await budget.download((options) => downloadFeishuResource(client, msg.message_id, parsed.fileKey!, "file", options));
        const label = parsed.fileName === "audio" ? "语音" : `文件 ${parsed.fileName ?? ""}`.trim();
        if (p) {
          transientFiles.push(p);
          text = `[${label}: ${p}]`;
        }
      }
    }
    // Make @-placeholders readable: Feishu puts "@_user_1" tokens in text + a mentions[] carrying their names.
    for (const x of rawMentions) if (x?.key && x?.name) text = text.split(String(x.key)).join(`@${x.name}`);
    text = text.trim();
    if (!text && !images.length && !(mentions && mentions.length)) return null;
    const inbound: InboundMsg = {
      ...base,
      text: text || mediaMarker || "[消息]",
      images: images.length ? images : undefined,
      transientFiles: transientFiles.length ? transientFiles : undefined,
    };
    handedOff = true;
    return inbound;
  } finally {
    if (!handedOff && transientFiles.length) await cleanupTransientMedia("feishu", transientFiles);
  }
}

export function feishuAdapter(appId: string, appSecret: string): ChatAdapter {
  const domain = process.env.HARA_FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain });
  // Self-healing long connection. The SDK's pong watchdog (wsConfig.pingTimeout) is OFF by default, which lets a
  // silently-dropped socket stay "ready" forever while events just stop — the exact failure that made this
  // gateway go deaf. Turning it on means: no inbound frame within pingTimeout seconds of a ping → presumed dead
  // → reconnect. handshakeTimeoutMs stops a stuck DNS/proxy handshake from hanging. Lifecycle logs give
  // visibility so a reconnect is observable instead of a mystery silence.
  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    domain,
    autoReconnect: true,
    wsConfig: { pingTimeout: 10 },
    handshakeTimeoutMs: 15_000,
    onReconnecting: () => console.error("hara feishu: ⟳ ws reconnecting…"),
    onReconnected: () => console.error("hara feishu: ✓ ws reconnected"),
    onError: (err: Error) => console.error(`hara feishu: ws error — ${err?.message ?? err}`),
  });
  // The bot's own open_id — resolved once, lazily — so a group message that @-mentions the bot can be flagged
  // isSelf (what a flow's `mention:"self"` triggers on). Failure degrades gracefully: isSelf just stays false.
  let botOpenId: string | undefined;
  let botOpenIdAttemptAt = Number.NEGATIVE_INFINITY;
  const ensureBotOpenId = async (): Promise<string | undefined> => {
    if (botOpenId) return botOpenId;
    if (Date.now() - botOpenIdAttemptAt < 60_000) return undefined;
    botOpenIdAttemptAt = Date.now();
    try {
      const r: any = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      botOpenId = r?.bot?.open_id ?? r?.data?.bot?.open_id ?? undefined;
    } catch {
      botOpenId = undefined;
    }
    return botOpenId;
  };
  const sendMsg = async (chatId: string | number, msgType: string, content: object): Promise<unknown> => {
    const response: any = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: String(chatId), msg_type: msgType, content: JSON.stringify(content) },
    });
    if (typeof response?.code === "number" && response.code !== 0) {
      throw new Error(`Feishu send failed: code=${response.code}${response.msg ? ` · ${response.msg}` : ""}`);
    }
    return response;
  };
  return {
    name: "feishu",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)", 4000)) await sendMsg(chatId, "text", { text: part });
    },
    // Track + recall: lets the gateway clean up transient UX messages ("⟳ working…") once the real reply
    // lands — Feishu permits deleting the bot's own messages (DELETE im/v1/messages/:id).
    async sendTracked(chatId, text) {
      const r: any = await sendMsg(chatId, "text", { text });
      return r?.data?.message_id ?? r?.message_id ?? undefined;
    },
    async recall(_chatId, messageId) {
      try {
        await client.im.message.delete({ path: { message_id: messageId } });
      } catch {
        /* best-effort cleanup — an unrecallable message just stays */
      }
    },
    async sendFile(chatId, file) {
      const name = file.safeName;
      const isImg = /\.(png|jpe?g|gif|webp)$/i.test(name);
      if (isImg) {
        const up: any = await client.im.image.create({ data: { image_type: "message", image: file.bytes } });
        const key = up?.image_key ?? up?.data?.image_key;
        if (!key) throw new Error("Feishu image upload returned no image_key");
        await sendMsg(chatId, "image", { image_key: key });
      } else {
        const up: any = await client.im.file.create({ data: { file_type: "stream", file_name: name, file: file.bytes } });
        const key = up?.file_key ?? up?.data?.file_key;
        if (!key) throw new Error("Feishu file upload returned no file_key");
        await sendMsg(chatId, "file", { file_key: key });
      }
    },
    async start(onMessage, signal, shouldDownload) {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          const m = await toInbound(client, data, await ensureBotOpenId(), signal, shouldDownload);
          if (m) await onMessage(m).catch((error) => console.error(`hara feishu: message handling failed — ${error instanceof Error ? error.message : String(error)}`));
        },
      });
      wsClient.start({ eventDispatcher }); // runs its own background long-connection (auto-reconnect + watchdog)
      // Keep the adapter alive until the gateway aborts, then CLOSE the WSClient so its socket + timers release
      // the event loop and the process actually exits on SIGTERM (previously the live connection pinned the
      // loop, so only kill -9 worked — and a hard kill leaves a dirty disconnect that Feishu can throttle).
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      try {
        wsClient.close();
      } catch {
        /* best-effort clean shutdown */
      }
    },
  };
}
