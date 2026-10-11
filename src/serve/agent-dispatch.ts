/** Host-owned, per-turn bounds for persistent colleagues. This is never reconstructed from a model
 * prompt or persisted provenance: resuming history must not revive an old delegation grant. */
export interface AgentDispatchContext {
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly chain: readonly string[];
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly budget: { remaining: number; active: Set<string> };
  /** Captured from the human-started root turn, never from a colleague's prompt or saved audit. */
  readonly interactionNegotiated: boolean;
  readonly nativeInputNegotiated: boolean;
  /** Host-created live follow-up scope. Never restored from history or accepted from a tool argument. */
  readonly followup?: true;
}

export const MAX_AGENT_CONTACT_DEPTH = 3;
export const MAX_AGENT_CONTACT_DISPATCHES = 8;

export function beginAgentDispatch(input: {
  sessionId: string; turnId: string; agentRef: string; signal: AbortSignal; isCurrent: () => boolean;
  interactionNegotiated?: boolean; nativeInputNegotiated?: boolean;
}): AgentDispatchContext {
  return {
    rootSessionId: input.sessionId, rootTurnId: input.turnId, chain: [input.agentRef],
    signal: input.signal, isCurrent: input.isCurrent,
    interactionNegotiated: input.interactionNegotiated === true,
    nativeInputNegotiated: input.nativeInputNegotiated === true,
    budget: { remaining: MAX_AGENT_CONTACT_DISPATCHES, active: new Set() },
  };
}

/** Claim before any provider build or new transcript. Failed/uncertain attempts still consume a slot.
 * The shared budget spans siblings; releasing a writer never replenishes it. */
export function claimAgentDispatch(parent: AgentDispatchContext, recipient: string): {
  context: AgentDispatchContext; release: () => void;
} {
  if (parent.signal.aborted || !parent.isCurrent()) throw new Error("agent_dispatch_parent_inactive");
  if (parent.chain.includes(recipient)) throw new Error("agent_dispatch_cycle");
  if (parent.chain.length > MAX_AGENT_CONTACT_DEPTH) throw new Error("agent_dispatch_depth_limit");
  if (parent.budget.active.has(recipient)) throw new Error("agent_dispatch_recipient_busy");
  if (parent.budget.remaining <= 0) throw new Error("agent_dispatch_budget_exhausted");
  parent.budget.remaining -= 1;
  parent.budget.active.add(recipient);
  return {
    context: { ...parent, chain: [...parent.chain, recipient] },
    release: () => { parent.budget.active.delete(recipient); },
  };
}
