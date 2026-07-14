// Feishu/Lark adapter for `hara gateway` — uses the official @larksuiteoapi/node-sdk: a WSClient long-connection
// for inbound events (no public webhook endpoint needed — fits hara's local daemon) and the REST Client for
// outbound. Creds from HARA_FEISHU_APP_ID / HARA_FEISHU_APP_SECRET (+ HARA_FEISHU_DOMAIN=lark for larksuite.com).
// Same ChatAdapter shape as the others, so all cross-platform gateway logic (send_file, system context,
// stuck-guard, image attach/describe) works unchanged. v1 = p2p (DM) only; group support is a fast-follow.
// Namespace import + default fallback: node resolves this SDK as CJS (default = module object), but
// bun's bundler resolves its ESM build (named exports only, NO default) — `import lark from` made
// every binaries release fail. This form works under both resolutions.
import { createHash } from "node:crypto";
import * as larkNs from "@larksuiteoapi/node-sdk";
const lark = ((larkNs as { default?: unknown }).default ?? larkNs) as typeof import("@larksuiteoapi/node-sdk");
import {
  chunkText,
  outboundTransferTimeoutMs,
  PerChatOutboundLane,
  withOutboundDeadline,
  type ChatAdapter,
  type InboundAckCleanup,
  type InboundMsg,
} from "./telegram.js";
import { InboundMediaBudget, cleanupTransientMedia, savePrivateResponse } from "./media.js";
import { GatewayEventSpool, gatewayRuntimeScope } from "./runtime-state.js";

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

/** Keep adapter acknowledgement coupled to the gateway callback; errors are logged once and rethrown. */
export async function dispatchFeishuInbound(
  onMessage: (message: InboundMsg) => Promise<InboundAckCleanup | void>,
  message: InboundMsg,
): Promise<InboundAckCleanup | void> {
  try {
    return await onMessage(message);
  } catch (error) {
    console.error(`hara feishu: message handling failed — ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

type FeishuResourceDownloader = (
  messageId: string,
  fileKey: string,
  type: "image" | "file",
  options: { maxBytes: number; signal: AbortSignal },
) => Promise<string | null>;

/** Build an InboundMsg from a Feishu im.message.receive_v1 event (downloads media). Handles BOTH p2p (DM) and
 *  group messages — group @-mentions are surfaced (with `isSelf`) so gateway flows can target them. null = skip. */
async function toInbound(
  downloadResource: FeishuResourceDownloader,
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
  const createdAtMs = feishuTimestampMs(msg.create_time);
  const base: InboundMsg = {
    chatId: String(msg.chat_id),
    userId,
    userName: userId,
    text: text || mediaMarker,
    ...(typeof msg.message_id === "string" && msg.message_id ? { messageId: msg.message_id } : {}),
    ...(createdAtMs === undefined ? {} : { createdAtMs }),
    durablyQueued: true,
    chatType,
    mentions,
  };
  let handedOff = false;
  try {
    if (shouldDownload?.(base) === true && (parsed.imageKey || parsed.fileKey)) {
      const budget = new InboundMediaBudget("feishu", signal);
      if (parsed.imageKey) {
        const p = await budget.download((options) => downloadResource(msg.message_id, parsed.imageKey!, "image", options));
        if (p) {
          images.push(p);
          transientFiles.push(p);
          text = "[图片]";
        }
      } else if (parsed.fileKey) {
        const p = await budget.download((options) => downloadResource(msg.message_id, parsed.fileKey!, "file", options));
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

/** Feishu transports timestamps as decimal strings (normally milliseconds; tolerate seconds fixtures). */
export function feishuTimestampMs(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed);
}

function feishuEventSpoolId(data: any): string {
  const platformId = data?.message?.message_id ?? data?.header?.event_id ?? data?.event_id;
  if (typeof platformId === "string" && platformId.trim()) return platformId.trim();
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new Error("Feishu event has no stable serializable id");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function waitForFeishuWork(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function feishuAdapter(appId: string, appSecret: string): ChatAdapter {
  const domain = process.env.HARA_FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
  const restBase = process.env.HARA_FEISHU_DOMAIN === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  // appId is the connection identity used by the gateway instance lease too. The lane hashes it before use,
  // so one-shot cron adapters and the daemon share ordering without retaining either credential.
  const outbound = new PerChatOutboundLane("feishu", appId);
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
  // Generated SDK methods discard unknown request options before they reach axios, so passing `signal` there
  // is not cooperative cancellation. REST and media use native fetch instead; the SDK remains responsible for
  // the inbound WebSocket event transport. Token material stays in memory and is never included in errors.
  let tenantToken: string | undefined;
  let tenantTokenExpiresAt = 0;
  const getTenantToken = async (signal: AbortSignal): Promise<string> => {
    if (tenantToken && Date.now() < tenantTokenExpiresAt - 60_000) return tenantToken;
    let response: Response;
    try {
      response = await fetch(`${restBase}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal,
      });
    } catch {
      if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
      throw new Error("Feishu auth transport failed");
    }
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok || body?.code !== 0 || typeof body?.tenant_access_token !== "string") {
      throw new Error(`Feishu auth failed: HTTP ${response.status}${body?.code !== undefined ? ` · code=${body.code}` : ""}`);
    }
    const nextToken = body.tenant_access_token as string;
    tenantToken = nextToken;
    const expiresInSeconds = Number(body.expire);
    tenantTokenExpiresAt = Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds * 1_000 : 60 * 60_000);
    return nextToken;
  };
  const outboundRequest = async (path: string, init: RequestInit, signal: AbortSignal): Promise<any> => {
    const token = await getTenantToken(signal);
    let response: Response;
    try {
      response = await fetch(`${restBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal,
      });
    } catch {
      if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
      throw new Error("Feishu transport failed");
    }
    let body: any;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (!response.ok || (typeof body?.code === "number" && body.code !== 0)) {
      throw new Error(`Feishu request failed: HTTP ${response.status}${body?.code !== undefined ? ` · code=${body.code}` : ""}`);
    }
    return body;
  };
  const downloadResource: FeishuResourceDownloader = async (messageId, fileKey, type, options) => {
    try {
      const token = await getTenantToken(options.signal);
      const response = await fetch(
        `${restBase}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: options.signal },
      );
      return await savePrivateResponse(response, {
        platform: "feishu",
        filenameHint: type === "image" ? "image.jpg" : "file.bin",
        ...options,
      });
    } catch {
      // Inbound media is optional. Native fetch + savePrivateResponse both honor the budget signal, so a
      // timeout releases the active media slot instead of leaving an unbounded SDK request behind.
      return null;
    }
  };
  // The bot's own open_id — resolved once, lazily — so a group message that @-mentions the bot can be flagged
  // isSelf (what a flow's `mention:"self"` triggers on). The SDK request surface drops AbortSignal, so identity
  // lookup deliberately shares the native, credential-safe REST path and has its own hard deadline. Ordinary
  // lookup failures degrade gracefully; gateway shutdown cancellation still propagates and stops the event.
  let botOpenId: string | undefined;
  let botOpenIdAttemptAt = Number.NEGATIVE_INFINITY;
  const ensureBotOpenId = async (signal: AbortSignal): Promise<string | undefined> => {
    if (botOpenId) return botOpenId;
    if (Date.now() - botOpenIdAttemptAt < 60_000) return undefined;
    botOpenIdAttemptAt = Date.now();
    try {
      const r: any = await withOutboundDeadline("Feishu bot identity", signal, 15_000, (transferSignal) =>
        outboundRequest("/open-apis/bot/v3/info", { method: "GET" }, transferSignal),
      );
      botOpenId = r?.bot?.open_id ?? r?.data?.bot?.open_id ?? undefined;
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Feishu gateway cancelled");
      }
      botOpenId = undefined;
    }
    return botOpenId;
  };
  const sendMsg = async (
    chatId: string | number,
    msgType: string,
    content: object,
    signal: AbortSignal,
    idempotencyKey?: string,
  ): Promise<unknown> => {
    const uuid = idempotencyKey
      ? createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)
      : undefined;
    return outboundRequest(
      `/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: String(chatId),
          msg_type: msgType,
          content: JSON.stringify(content),
          ...(uuid ? { uuid } : {}),
        }),
      },
      signal,
    );
  };
  return {
    name: "feishu",
    async send(chatId, text, signal, idempotencyKey) {
      await withOutboundDeadline("Feishu send", signal, outboundTransferTimeoutMs("text"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          if (transferSignal.aborted) {
            throw transferSignal.reason instanceof Error ? transferSignal.reason : new Error("Feishu send cancelled");
          }
          for (const [index, part] of chunkText(text || "(empty)", 4000).entries()) {
            const partKey = idempotencyKey ? `${idempotencyKey}:${index}` : undefined;
            await sendMsg(chatId, "text", { text: part }, transferSignal, partKey);
          }
        });
      });
    },
    // Track + recall: lets the gateway clean up transient UX messages ("⟳ working…") once the real reply
    // lands — Feishu permits deleting the bot's own messages (DELETE im/v1/messages/:id).
    async sendTracked(chatId, text, signal) {
      return withOutboundDeadline("Feishu send", signal, outboundTransferTimeoutMs("text"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          if (transferSignal.aborted) {
            throw transferSignal.reason instanceof Error ? transferSignal.reason : new Error("Feishu send cancelled");
          }
          const r: any = await sendMsg(chatId, "text", { text }, transferSignal);
          return r?.data?.message_id ?? r?.message_id ?? undefined;
        });
      });
    },
    async recall(chatId, messageId, signal) {
      await withOutboundDeadline("Feishu recall", signal, outboundTransferTimeoutMs("text"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          if (transferSignal.aborted) {
            throw transferSignal.reason instanceof Error ? transferSignal.reason : new Error("Feishu recall cancelled");
          }
          try {
            await outboundRequest(
              `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
              { method: "DELETE" },
              transferSignal,
            );
          } catch {
            /* best-effort cleanup — an unrecallable message just stays */
          }
        });
      });
    },
    async sendFile(chatId, file, signal, idempotencyKey) {
      await withOutboundDeadline("Feishu upload", signal, outboundTransferTimeoutMs("file"), async (transferSignal) => {
        return outbound.run(chatId, async () => {
          if (transferSignal.aborted) {
            throw transferSignal.reason instanceof Error ? transferSignal.reason : new Error("Feishu upload cancelled");
          }
          const name = file.safeName;
          const isImg = /\.(png|jpe?g|gif|webp)$/i.test(name);
          if (isImg) {
            const form = new FormData();
            form.append("image_type", "message");
            form.append("image", new Blob([new Uint8Array(file.bytes)]), name);
            const up: any = await outboundRequest(
              "/open-apis/im/v1/images",
              { method: "POST", body: form },
              transferSignal,
            );
            const key = up?.data?.image_key ?? up?.image_key;
            if (!key) throw new Error("Feishu image upload returned no image_key");
            await sendMsg(chatId, "image", { image_key: key }, transferSignal, idempotencyKey);
          } else {
            const form = new FormData();
            form.append("file_type", "stream");
            form.append("file_name", name);
            form.append("file", new Blob([new Uint8Array(file.bytes)]), name);
            const up: any = await outboundRequest(
              "/open-apis/im/v1/files",
              { method: "POST", body: form },
              transferSignal,
            );
            const key = up?.data?.file_key ?? up?.file_key;
            if (!key) throw new Error("Feishu file upload returned no file_key");
            await sendMsg(chatId, "file", { file_key: key }, transferSignal, idempotencyKey);
          }
        });
      });
    },
    async start(onMessage, signal, shouldDownload) {
      const spool = await GatewayEventSpool.open(gatewayRuntimeScope("feishu-inbound", appId));
      const locallyCompleted = new Set<string>();
      const cleanupFailures = new Map<string, number>();
      const retryStateFailures = new Map<string, number>();
      const postAckCleanups = new Map<string, InboundAckCleanup>();
      const runWorker = async (): Promise<void> => {
        while (!signal.aborted) {
          const item = await spool.nextReady();
          if (!item) {
            await waitForFeishuWork(250, signal);
            continue;
          }
          try {
            if (!locallyCompleted.has(item.id)) {
              const m = await toInbound(downloadResource, item.payload, await ensureBotOpenId(signal), signal, shouldDownload);
              if (signal.aborted) {
                await spool.release(item.id);
                return;
              }
              if (m) {
                const cleanup = await dispatchFeishuInbound(onMessage, m);
                if (cleanup) postAckCleanups.set(item.id, cleanup);
              }
              if (signal.aborted) {
                await spool.release(item.id);
                return;
              }
              locallyCompleted.add(item.id);
            }
            await spool.complete(item.id);
            locallyCompleted.delete(item.id);
            cleanupFailures.delete(item.id);
            retryStateFailures.delete(item.id);
            const postAckCleanup = postAckCleanups.get(item.id);
            postAckCleanups.delete(item.id);
            if (postAckCleanup) {
              try {
                await postAckCleanup();
              } catch {
                // The platform event is already absent from the spool. Retaining a small terminal marker is
                // fail-safe (it can only block a future accidental rerun), so report once and continue.
                console.error("hara feishu: ALERT acknowledged-event cleanup failed; private marker retained for manual recovery");
              }
            }
          } catch {
            if (signal.aborted) {
              await spool.release(item.id);
              return;
            }
            if (locallyCompleted.has(item.id)) {
              // Agent/delivery already completed; only the spool deletion failed. Retrying the agent would
              // repeat coding/tool effects, so retain the local completion marker and retry disk cleanup only.
              const failures = (cleanupFailures.get(item.id) ?? 0) + 1;
              cleanupFailures.set(item.id, failures);
              if (failures === 1) {
                console.error("hara feishu: completed inbound event could not be removed from the durable spool; cleanup will retry with backoff");
              }
              if (failures >= 5) {
                console.error("hara feishu: ALERT durable spool cleanup suspended after 5 failures; the completed item is retained for startup recovery");
                return; // keep the in-memory lease: no busy loop and no agent replay in this process
              }
              await waitForFeishuWork(Math.min(30_000, 2_000 * (2 ** (failures - 1))), signal);
              await spool.release(item.id);
              continue;
            }
            try {
              const retry = await spool.retry(item.id);
              retryStateFailures.delete(item.id);
              const digest = createHash("sha256").update(item.id).digest("hex").slice(0, 12);
              if (retry.exhausted) {
                console.error(`hara feishu: ALERT inbound event ${digest} exhausted ${retry.attempts} spool attempts — dead-lettered`);
              } else {
                console.error(`hara feishu: inbound event ${digest} failed; retry ${retry.attempts} in ${Math.ceil(retry.retryAfterMs / 1_000)}s`);
              }
            } catch {
              // A broken disk must not create an unbounded hot loop of retry-state writes and alarms. Keep the
              // durable event plus this process-local lease for startup/manual recovery after five attempts.
              const failures = (retryStateFailures.get(item.id) ?? 0) + 1;
              retryStateFailures.set(item.id, failures);
              if (failures === 1) {
                console.error("hara feishu: durable spool retry state could not be saved; persistence will retry with backoff");
              }
              if (failures >= 5) {
                console.error("hara feishu: ALERT durable spool retry-state persistence suspended after 5 failures; event retained for startup recovery");
                return;
              }
              await waitForFeishuWork(Math.min(30_000, 2_000 * (2 ** (failures - 1))), signal);
              await spool.release(item.id);
            }
          }
        }
      };
      const workers = Array.from({ length: 4 }, () => runWorker().catch((error) => {
        console.error(`hara feishu: ALERT inbound spool worker stopped unexpectedly — ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }));
      const workersSettled = Promise.allSettled(workers);
      const persistenceWrites = new Set<Promise<unknown>>();
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          // Feishu requires a long-connection callback within three seconds. Durably enqueue first, then ACK;
          // workers run the potentially minutes-long agent task independently and survive process restarts.
          if (signal.aborted) throw new Error("Feishu gateway cancelled");
          const write = spool.enqueue(feishuEventSpoolId(data), data);
          persistenceWrites.add(write);
          void write.then(
            () => persistenceWrites.delete(write),
            () => persistenceWrites.delete(write),
          );
          try {
            await withOutboundDeadline("Feishu event persistence", signal, 2_500, async () => write);
          } catch (error) {
            if (!signal.aborted) {
              console.error(`hara feishu: ALERT event could not be durably queued before ACK — ${error instanceof Error ? error.message : String(error)}`);
            }
            throw error;
          }
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
      // Do not release the gateway instance lease while an old worker or an ACK-persistence write can still
      // mutate the spool. A replacement process must never race this process's final CAS write or run the same
      // durable item concurrently.
      while (persistenceWrites.size) await Promise.allSettled([...persistenceWrites]);
      await workersSettled;
    },
  };
}
