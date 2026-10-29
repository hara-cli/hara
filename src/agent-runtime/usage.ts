import type { AgentRuntimeBinding, AgentRuntimeId } from "./bindings.js";

export type RuntimeUsageScope = "hara-pi" | "external-runtime" | "legacy-hara";
export type RuntimeAvailability = "available" | "exhausted" | "unknown";

/** Account selection belongs to the bound runtime, never to a provider-wide or scheduler-wide pool. */
export interface RuntimeAccountBinding {
  spaceId: string;
  agentRef: string;
  runtimeId: AgentRuntimeId;
  connectionId: string;
}

/** A runtime/provider adapter supplies this decision in its own native account window. */
export interface RuntimeAccountWindow {
  runtimeId: AgentRuntimeId;
  connectionId: string;
  scope: RuntimeUsageScope;
  authority: string;
  availability: RuntimeAvailability;
  fetchedAt: string;
  validUntil: string;
  resetAt?: string;
}

export interface RuntimeUsageView {
  runtimeId: AgentRuntimeId;
  connectionId: string | null;
  scope: RuntimeUsageScope;
  authority: string | null;
  availability: RuntimeAvailability;
  fresh: boolean;
  fetchedAt: string | null;
  resetAt: string | null;
}

export function runtimeUsageScope(runtimeId: AgentRuntimeId): RuntimeUsageScope {
  if (runtimeId === "pi") return "hara-pi";
  return runtimeId === "hara" ? "legacy-hara" : "external-runtime";
}

/** Read-only projection. Missing, mismatched, ambiguous or stale authority is unknown. */
export function readAgentRuntimeUsage(
  role: Pick<AgentRuntimeBinding, "spaceId" | "agentRef" | "runtimeId">,
  account: RuntimeAccountBinding | undefined,
  windows: readonly RuntimeAccountWindow[],
  nowMs = Date.now(),
): RuntimeUsageView {
  const { runtimeId } = role;
  const scope = runtimeUsageScope(runtimeId);
  const connectionId = account?.spaceId === role.spaceId && account.agentRef === role.agentRef
    && account.runtimeId === runtimeId && typeof account.connectionId === "string"
    && account.connectionId.trim() ? account.connectionId : null;
  const unknown: RuntimeUsageView = { runtimeId, connectionId, scope, authority: null,
    availability: "unknown", fresh: false, fetchedAt: null, resetAt: null };
  if (!connectionId || !Number.isFinite(nowMs)) return unknown;
  const matches = windows.filter((window) => window.runtimeId === runtimeId
    && window.connectionId === connectionId && window.scope === scope);
  if (matches.length !== 1) return unknown;
  const window = matches[0]!;
  const fetchedAt = Date.parse(window.fetchedAt);
  const validUntil = Date.parse(window.validUntil);
  if (typeof window.authority !== "string" || !window.authority.trim()
    || !["available", "exhausted", "unknown"].includes(window.availability)
    || !Number.isFinite(fetchedAt) || !Number.isFinite(validUntil)
    || fetchedAt > nowMs || validUntil < nowMs || validUntil < fetchedAt) return unknown;
  return { runtimeId, connectionId, scope, authority: window.authority,
    availability: window.availability, fresh: true, fetchedAt: window.fetchedAt,
    resetAt: window.resetAt ?? null };
}
