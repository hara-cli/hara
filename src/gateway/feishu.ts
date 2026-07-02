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
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

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

async function downloadFeishuResource(client: any, messageId: string, fileKey: string, type: "image" | "file"): Promise<string | null> {
  try {
    const resp: any = await client.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
    const dir = join(homedir(), ".hara", "feishu", "media");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `fs_${Date.now()}_${fileKey.slice(-8)}.${type === "image" ? "jpg" : "bin"}`);
    if (typeof resp?.writeFile === "function") await resp.writeFile(path);
    else if (typeof resp?.getReadableStream === "function") await pipeline(resp.getReadableStream(), createWriteStream(path));
    else return null;
    return path;
  } catch {
    return null;
  }
}

/** Build an InboundMsg from a Feishu im.message.receive_v1 event (downloads media). null = skip (not a DM / empty). */
async function toInbound(client: any, data: any): Promise<InboundMsg | null> {
  const msg = data?.message;
  if (!msg?.chat_id || msg.chat_type !== "p2p") return null; // v1: direct messages only
  const sender = data?.sender?.sender_id;
  const userId = String(sender?.open_id || sender?.user_id || msg.chat_id);
  let content: any = {};
  try {
    content = JSON.parse(msg.content ?? "{}");
  } catch {
    /* malformed content → empty */
  }
  const parsed = parseFeishuContent(String(msg.message_type), content);
  let text = parsed.text;
  const images: string[] = [];
  if (parsed.imageKey) {
    const p = await downloadFeishuResource(client, msg.message_id, parsed.imageKey, "image");
    if (p) {
      images.push(p);
      text = "[图片]";
    }
  } else if (parsed.fileKey) {
    const p = await downloadFeishuResource(client, msg.message_id, parsed.fileKey, "file");
    const label = parsed.fileName === "audio" ? "语音" : `文件 ${parsed.fileName ?? ""}`.trim();
    if (p) text = `[${label}: ${p}]`;
  }
  text = text.trim();
  if (!text && !images.length) return null;
  return { chatId: String(msg.chat_id), userId, userName: userId, text: text || "[图片]", images: images.length ? images : undefined };
}

export function feishuAdapter(appId: string, appSecret: string): ChatAdapter {
  const domain = process.env.HARA_FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain });
  const wsClient = new lark.WSClient({ appId, appSecret, domain });
  const sendMsg = (chatId: string | number, msgType: string, content: object): Promise<unknown> =>
    client.im.message
      .create({ params: { receive_id_type: "chat_id" }, data: { receive_id: String(chatId), msg_type: msgType, content: JSON.stringify(content) } })
      .catch(() => undefined);
  return {
    name: "feishu",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)", 4000)) await sendMsg(chatId, "text", { text: part });
    },
    async sendFile(chatId, filePath) {
      const name = basename(filePath);
      const isImg = /\.(png|jpe?g|gif|webp)$/i.test(name);
      try {
        if (isImg) {
          const up: any = await client.im.image.create({ data: { image_type: "message", image: createReadStream(filePath) } });
          const key = up?.image_key ?? up?.data?.image_key;
          if (key) await sendMsg(chatId, "image", { image_key: key });
        } else {
          const up: any = await client.im.file.create({ data: { file_type: "stream", file_name: name, file: createReadStream(filePath) } });
          const key = up?.file_key ?? up?.data?.file_key;
          if (key) await sendMsg(chatId, "file", { file_key: key });
        }
      } catch {
        /* upload/send failed — surfaced upstream as "no file delivered" */
      }
    },
    async start(onMessage, signal) {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          const m = await toInbound(client, data);
          if (m) await onMessage(m).catch(() => {});
        },
      });
      wsClient.start({ eventDispatcher }); // runs its own background long-connection (auto-reconnect)
      // keep the adapter alive until the gateway aborts (the WSClient manages the socket itself)
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}
