import { createHash } from "node:crypto";
import type { ExternalSessionInfo, ExternalSessionReadResult } from "../external-sessions/types.js";
import { redactSensitiveText, redactSensitiveValue } from "../security/secrets.js";
import type { Tool } from "../tools/registry.js";

/** A durable user-selected address, NOT an execution grant. Every message requires a fresh approval. */
export interface ConversationCodingLink {
  sessionId: string;
  sourceId: "codex" | "claude" | "runtime";
  workspaceId: string;
  title: string;
  revision: string;
  linkedAt: string;
}

export function isConversationCodingLink(value: unknown): value is ConversationCodingLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.sourceId === "string" && ["codex", "claude", "runtime"].includes(v.sourceId)
    && typeof v.sessionId === "string" && new RegExp(`^ext_${v.sourceId}_[a-f0-9]{24}$`, "u").test(v.sessionId)
    && typeof v.workspaceId === "string" && v.workspaceId.length > 0 && v.workspaceId.length <= 160
    && typeof v.title === "string" && v.title.length > 0 && v.title.length <= 120
    && typeof v.revision === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v.revision)
    && typeof v.linkedAt === "string" && v.linkedAt.length <= 40 && Number.isFinite(Date.parse(v.linkedAt));
}

export function codingLinkTargetAvailable(result: ExternalSessionReadResult): boolean {
  return result.conversationLinkAvailable === true && !result.readOnly && (result.controlMode === "live" || result.controlMode === "managed")
    && ["codex", "claude", "runtime"].includes(result.session.sourceId)
    && (result.session.sourceId !== "runtime" || result.session.agentKind === "codex" || result.session.agentKind === "claude")
    && !["stored", "unknown", "error"].includes(result.session.state);
}

/** Stable for a replay of this exact model call, distinct across parent turns and relink revisions. */
export function codingLinkCommandId(parentSessionId: string, turnId: string, revision: string, toolCallId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["hara-coding-link-v1", parentSessionId, turnId, revision, toolCallId])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createConnectedCodingSessionTool(options: {
  link: ConversationCodingLink;
  parentSessionId: string;
  turnId: string;
  targetLabel: string;
  assertCurrent: () => void;
  read: () => Promise<ExternalSessionReadResult>;
  send: (text: string, commandId: string, signal?: AbortSignal) => Promise<unknown>;
}): Tool {
  const { link } = options;
  return {
    name: "connected_coding_session",
    description: "Use ONLY the existing coding session explicitly connected by the user to this conversation. "
      + "status inspects its identity; read returns a bounded recent transcript; message sends a follow-up to that exact session "
      + "after a fresh human confirmation, even in full-auto. Never select another active window, resume/fork a history, "
      + "or claim delivery/completion without the returned receipt. Other Agents do not inherit this link. "
      + `Connected address: ${link.sessionId} (${link.sourceId}).`,
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["status", "read", "message"] },
      text: { type: "string", maxLength: 8_000, description: "The exact follow-up to send. Required for message." },
    }, required: ["action"] },
    kind: "read",
    classify: (input) => input?.action === "message"
      ? { effect: "exec", concurrencySafe: false, approvalKind: "exec", requiresExplicitApproval: true,
        approvalTarget: `${options.targetLabel} · ${link.sourceId} · ${link.sessionId}` }
      : { effect: "read", concurrencySafe: false },
    run: async (input, ctx) => {
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)
          || Object.keys(input).some((key) => !["action", "text"].includes(key))
          || !["status", "read", "message"].includes(input.action)) throw new Error("coding_link_invalid_input");
        if (ctx.signal?.aborted) throw new Error("coding_link_cancelled");
        options.assertCurrent();
        const result = await options.read();
        options.assertCurrent();
        if (ctx.signal?.aborted) throw new Error("coding_link_cancelled");
        if (result.session.id !== link.sessionId || result.session.sourceId !== link.sourceId
          || result.session.workspaceId !== link.workspaceId) throw new Error("coding_link_target_changed");
        if (input.action === "status") return JSON.stringify(redactSensitiveValue({ session: result.session, available: codingLinkTargetAvailable(result), approval: "each_message" }).value);
        if (result.conversationLinkAvailable !== true) throw new Error("coding_link_target_not_shareable");
        if (input.action === "read") {
          let remaining = 12_000;
          const messages = result.messages.slice(-12).reverse().map((message) => {
            const text = remaining > 0 ? redactSensitiveText(message.text).text.slice(-Math.min(2_000, remaining)) : "";
            remaining -= text.length;
            return { role: message.role, text };
          }).filter((message) => message.text).reverse();
          return JSON.stringify(redactSensitiveValue({ session: result.session, messages, bounded: true }).value);
        }
        if (!codingLinkTargetAvailable(result)) throw new Error("coding_link_not_controllable_use_advanced_recovery");
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 8_000
          || typeof ctx.toolCallId !== "string" || !ctx.toolCallId) throw new Error("coding_link_invalid_message");
        const commandId = codingLinkCommandId(options.parentSessionId, options.turnId, link.revision, ctx.toolCallId);
        options.assertCurrent();
        const receipt = await options.send(input.text, commandId, ctx.signal);
        return JSON.stringify(redactSensitiveValue(receipt).value);
      } catch (error) {
        // Adapter diagnostics can echo credentials or upstream request bodies. Keep them out of a
        // second conversation; the selected native session retains its own ordinary failure state.
        const code = error instanceof Error && /^coding_link_[a-z_]+$/u.test(error.message)
          ? error.message : "coding_link_operation_failed";
        return JSON.stringify({ status: "not_completed", reasonCode: code,
          instruction: "Do not retry an uncertain send automatically. Inspect the selected session or ask the user to reconnect it." });
      }
    },
  };
}

export interface ConversationCodingLinkView {
  link: ConversationCodingLink | null;
  target?: ExternalSessionInfo;
  available?: boolean;
}
