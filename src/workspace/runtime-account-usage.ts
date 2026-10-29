import type { AgentRuntimeId } from "../agent-runtime/bindings.js";
import { readAgentRuntimeUsage, type RuntimeAccountWindow, type RuntimeUsageView } from "../agent-runtime/usage.js";

export interface WorkspaceUsageAccount {
  workspaceId: string;
  agentId: string;
  runtimeId: AgentRuntimeId;
  connectionId: string | null;
}
export interface WorkspaceUsageAttention {
  state: "ok" | "limit_reached" | "parse_unavailable";
  view: RuntimeUsageView;
}
export type WorkspaceUsageCollector = (account: WorkspaceUsageAccount) => Promise<RuntimeAccountWindow | null>;

/** Bounded, non-persistent telemetry. The collector owns native account semantics and credentials. */
export class WorkspaceRuntimeUsageCache {
  private readonly rows = new Map<string, RuntimeAccountWindow | null>();
  private readonly pending = new Set<string>();
  constructor(private readonly collector?: WorkspaceUsageCollector) {}

  private key(account: WorkspaceUsageAccount): string {
    return JSON.stringify([account.workspaceId, account.runtimeId, account.connectionId]);
  }
  read(account: WorkspaceUsageAccount, nowMs = Date.now()): WorkspaceUsageAttention {
    const window = this.rows.get(this.key(account));
    const view = readAgentRuntimeUsage(
      { spaceId: account.workspaceId, agentRef: account.agentId, runtimeId: account.runtimeId },
      account.connectionId ? { spaceId: account.workspaceId, agentRef: account.agentId,
        runtimeId: account.runtimeId, connectionId: account.connectionId } : undefined,
      window ? [window] : [], nowMs);
    return { state: !view.fresh ? "parse_unavailable" : view.availability === "exhausted" ? "limit_reached"
      : view.availability === "available" ? "ok" : "parse_unavailable", view };
  }
  /** Best effort and single-flight: no await on the dispatch path and no zero-balance fallback. */
  async refresh(account: WorkspaceUsageAccount): Promise<void> {
    if (!this.collector || !account.connectionId) return;
    const key = this.key(account);
    if (this.pending.has(key)) return;
    this.pending.add(key);
    try {
      const row = await this.collector(account);
      this.rows.set(key, row && row.runtimeId === account.runtimeId
        && row.connectionId === account.connectionId ? row : null);
    } catch { this.rows.set(key, null); }
    finally { this.pending.delete(key); }
  }
  /** Only a bounded cache of current accounts; no history or cross-colleague balance ledger. */
  prune(workspaceId: string, active: readonly WorkspaceUsageAccount[]): void {
    const keep = new Set(active.map(account => this.key(account)));
    for (const key of this.rows.keys()) if (JSON.parse(key)[0] === workspaceId && !keep.has(key)) this.rows.delete(key);
  }
}

export function planColleagueUsageDispatch(target: WorkspaceUsageAttention, otherColleagues: readonly {
  agentId: string; usage: WorkspaceUsageAttention;
}[], nowMs = Date.now()): { action: "dispatch" | "exhausted"; availability: RuntimeUsageView["availability"];
  fresh: boolean; alternatives: string[]; resetAt: string | null } {
  if (target.state !== "limit_reached") return { action: "dispatch", availability: target.view.availability,
    fresh: target.view.fresh, alternatives: [], resetAt: null };
  const resetMs = target.view.resetAt ? Date.parse(target.view.resetAt) : NaN;
  return { action: "exhausted", availability: "exhausted", fresh: true,
    alternatives: otherColleagues.filter(row => row.usage.state === "ok").map(row => row.agentId),
    resetAt: Number.isFinite(resetMs) && resetMs > nowMs ? target.view.resetAt : null };
}
