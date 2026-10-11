import type { AgentFollowupGrant, AgentFollowupStore } from "../gateway/agent-followup.js";
import type { Tool } from "../tools/registry.js";

/** The model may nominate only an opaque, gateway-observed candidate. It cannot supply sender, account,
 * parent chat, workspace, native session or grant authority. Grant always crosses a fresh human card. */
export function createAgentFollowupTool(options: {
  store: AgentFollowupStore; parentSessionId: string; agentRef: string;
  assertCurrent: () => void;
  isActive?: (id: string) => boolean;
  grant: (candidateId: string, minutes: number, maxMessages: number) => AgentFollowupGrant;
  stop: (id: string) => void;
}): Tool {
  return {
    name: "agent_followup",
    description: "Let this named Hara Agent own a bounded Feishu reply-thread follow-up, only after a fresh human confirmation. "
      + "First list recent authorized @bot source candidates. Select the user's exact thread; ask the human if unclear. "
      + "Use agent_contact to ask a designated colleague to own it, rather than always routing through main Hara. "
      + "grant permits up to 8 same-sender thread messages for at most 24 hours, never all group messages. "
      + "No listener is started. The existing Feishu connector and this approving Hara client must stay online. "
      + "Restarts/disconnect/policy changes pause execution. File changes, commands and coding-session sends still need individual confirmation. "
      + "Results reply to their original thread; stop revokes this conversation's grant. Never call grant again to route around a denial or uncertain receipt.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "status", "grant", "stop"] },
      candidateId: { type: "string", description: "Exact opaque candidate from list; grant only." },
      minutes: { type: "integer", minimum: 1, maximum: 1440 },
      maxMessages: { type: "integer", minimum: 1, maximum: 8 },
      grantId: { type: "string", description: "Exact owned grant to revoke; stop only." },
    }, required: ["action"] },
    kind: "read",
    classify: (input) => {
      if (input?.action !== "grant") return { effect: input?.action === "stop" ? "state" : "read", concurrencySafe: false };
      const source = options.store.candidates().find((c) => c.id === input.candidateId);
      return { effect: "exec", concurrencySafe: false, approvalKind: "exec", requiresExplicitApproval: true,
        approvalTarget: `${options.agentRef}: ${input.minutes ?? "?"} minutes, ${input.maxMessages ?? "?"} messages. Feishu thread ${source ? `${source.chatId}, sender ${source.senderName}, source ${source.messageId}, root ${source.rootMessageId}` : "expired or unavailable source"}. Reads in the Agent workspace; individual approval for writes, commands and external sends.` };
    },
    run: async (input, ctx) => {
      options.assertCurrent();
      if (ctx.signal?.aborted) throw new Error("follow-up request cancelled");
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((k) => !["action", "candidateId", "minutes", "maxMessages", "grantId"].includes(k))) throw new Error("invalid follow-up input");
      if (input.action === "list") return JSON.stringify({ candidates: options.store.candidates(),
        instruction: "Choose only the explicitly requested thread. Multiple candidates require a human choice, not a recency guess." });
      if (input.action === "status") return JSON.stringify({ grants: options.store.list(options.parentSessionId).map((g) => ({
        id: g.id, agentRef: g.agentRef, status: g.status === "active" && (!options.isActive?.(g.id) || g.expiresAt <= Date.now())
          ? "requires_confirmation" : g.status,
        expiresAt: g.expiresAt, accepted: g.accepted, maxMessages: g.maxMessages,
      })), receipts: options.store.receipts(options.parentSessionId) });
      if (input.action === "stop" && typeof input.grantId === "string") {
        options.stop(input.grantId); return JSON.stringify({ id: input.grantId, status: "revoked" });
      }
      if (input.action === "grant" && typeof input.candidateId === "string" && Number.isSafeInteger(input.minutes) && Number.isSafeInteger(input.maxMessages)) {
        const g = options.grant(input.candidateId, input.minutes, input.maxMessages);
        return JSON.stringify({ id: g.id, status: g.status, ownerAgentRef: g.agentRef, expiresAt: g.expiresAt,
          maxMessages: g.maxMessages, recovery: "No replay after restart; explicitly revoke the old grant and confirm a fresh source to continue." });
      }
      throw new Error("invalid follow-up action or bounded grant arguments");
    },
  };
}
