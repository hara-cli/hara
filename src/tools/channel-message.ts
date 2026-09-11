import { createHash, randomUUID } from "node:crypto";
import { deliverResult, parseDeliver, plainChat } from "../cron/deliver.js";
import { listChannelBridges, resolveChannelBridgeTarget } from "../gateway/channel-bridges.js";
import { inspectFeishuGatewayCredentials } from "../gateway/credentials.js";
import { sendThroughConnectedGateway } from "../gateway/outbound-broker.js";
import { liveGatewayRuntimeScopes } from "../gateway/runtime-state.js";
import { registerTool } from "./registry.js";

function safeSourcePlatform(value: string | undefined): string | undefined {
  const platform = value?.trim().toLowerCase();
  return platform && /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(platform) ? platform : undefined;
}

function deliveryText(text: string, targetPlatform: string): string {
  const clean = plainChat(text).trim();
  const source = safeSourcePlatform(process.env.HARA_GATEWAY);
  if (!source || source === targetPlatform) return clean;
  const sourceName = source === "weixin" ? "微信" : source === "feishu" ? "飞书" : source;
  return `[来自 Hara ${sourceName}]\n${clean}`;
}

registerTool({
  name: "channel_message",
  description:
    "Send plain text to a Feishu or WeChat destination already connected to Hara on this device. Use action=send " +
    "only when both the recipient and message body are known. If either is missing, do not call the tool: ask only " +
    "the direct question(s) for the missing value(s), with no preface, explanation, example, or promise to send. " +
    "When both are missing, default to only the localized equivalent of 'Who should I send it to? What should I " +
    "send?'; when one is missing, ask only that one. Follow any user-requested response length or exact format. Use " +
    "action=list only when the user asks which destinations are available or their supplied recipient remains " +
    "ambiguous. Keep tool names, parameter names, internal ids, and bridge mechanics out of ordinary user-facing " +
    "clarifications. Never invent a destination. A queued result is not proof of delivery.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "send"], description: "List safe destinations or send one message." },
      target: { type: "string", description: "bridge:<name>, feishu:<chatId>, or weixin:<peerId>. Required for send." },
      text: { type: "string", description: "Plain-text message. Required for send." },
    },
    required: ["action"],
  },
  kind: "exec",
  visibility: "eager",
  classify(input) {
    return input?.action === "list"
      ? { effect: "read", concurrencySafe: true }
      : { effect: "exec", concurrencySafe: false, approvalKind: "exec" };
  },
  async run(input, ctx) {
    const action = String(input?.action ?? "").trim().toLowerCase();
    const home = ctx.stateHome;
    if (action === "list") {
      const [feishu, weixin] = await Promise.all([
        liveGatewayRuntimeScopes("feishu", { ...(home ? { home } : {}) }),
        liveGatewayRuntimeScopes("weixin", { ...(home ? { home } : {}) }),
      ]);
      const bridges = listChannelBridges(home, undefined);
      const destinations = bridges
        .filter((bridge) => bridge.enabled)
        .map((bridge) => `bridge:${bridge.name} (Feishu group; ${bridge.subscribers} WeChat subscriber(s))`);
      return [
        `Connected gateways: Feishu ${feishu.length === 1 ? "ready" : feishu.length ? `${feishu.length} accounts (selection required)` : "offline"}; WeChat ${weixin.length ? "ready" : "offline"}.`,
        destinations.length ? `Saved bridge aliases:\n${destinations.join("\n")}` : "No bridge aliases. In the target Feishu group, the gateway owner can send /bridge on <name>.",
        "Exact Feishu chat ids remain usable as feishu:<chatId>; never guess one.",
      ].join("\n");
    }
    if (action !== "send") return "Error: action must be list or send.";
    const rawTarget = String(input?.target ?? "").trim();
    const rawText = String(input?.text ?? "").trim();
    if (!rawTarget) return "Error: target is required for action=send. Use action=list if the destination is unknown.";
    if (!rawText) return "Error: text is required for action=send.";

    let target = rawTarget;
    let destinationLabel = rawTarget;
    if (rawTarget.toLowerCase().startsWith("bridge:")) {
      const name = rawTarget.slice(rawTarget.indexOf(":") + 1).trim();
      if (!name) return "Error: bridge target is missing its name.";
      const resolved = resolveChannelBridgeTarget(name, home);
      if (!resolved) return `Error: no enabled bridge named '${name}'. Use action=list or enable it in the Feishu group with /bridge on ${name}.`;
      target = resolved;
      destinationLabel = `bridge:${name}`;
    }
    const parsed = parseDeliver(target);
    if ("error" in parsed) return `Error: ${parsed.error}`;
    if (parsed.platform !== "feishu" && parsed.platform !== "weixin") {
      return "Error: channel_message supports only Feishu and WeChat destinations.";
    }
    const text = deliveryText(rawText, parsed.platform);
    const operationId = createHash("sha256")
      .update("hara-channel-message-v1\0")
      .update(ctx.toolCallId ?? ctx.taskId ?? ctx.sessionId ?? randomUUID())
      .update("\0")
      .update(target)
      .update("\0")
      .update(text)
      .digest("hex");

    const feishuCredentials = parsed.platform === "feishu"
      ? inspectFeishuGatewayCredentials(home ? { home } : {})
      : undefined;
    if (parsed.platform === "feishu" && feishuCredentials?.state !== "ready") {
      const result = await sendThroughConnectedGateway(
        "feishu",
        parsed.to,
        text,
        operationId,
        ctx.signal,
        { ...(home ? { home } : {}) },
      );
      if (result.status === "sent") return `Sent to ${destinationLabel} through the connected Feishu gateway.`;
      if (result.status === "queued") {
        return `Queued for ${destinationLabel}, but no delivery receipt arrived before the wait deadline. Do not claim it was delivered; ask the user to verify before retrying.`;
      }
      return `Error: ${result.error}. The message was not confirmed as delivered.`;
    }

    const error = await deliverResult(target, text, ctx.signal, operationId, home ? { home } : {});
    return error
      ? `Error: ${error}. The message was not confirmed as delivered.`
      : `Sent to ${destinationLabel} through Hara's connected ${parsed.platform === "feishu" ? "Feishu" : "WeChat"} capability.`;
  },
});
