import { createHash } from "node:crypto";
import { isWorkspaceAgentTaskBinding, type WorkspaceAgentTaskBinding } from "./agent-binding.js";
import { isScopedRunConnection, type ScopedRunConnection } from "./scoped-connections.js";
import { parseWorkspaceResourceScope, workspaceResourceScopeKey, type WorkspaceResourceScope } from "./resource-context.js";
import { canonical, deepFreeze, exact, plain, positive, text, UUID } from "./local-state.js";

export interface WorkspaceRunBinding {
  schemaVersion: 1;
  scope: WorkspaceResourceScope;
  agent: Readonly<WorkspaceAgentTaskBinding>;
  agentBindingHash: string;
  connection: Readonly<ScopedRunConnection>;
  runtimeContract: "hara-governed-pi-v1";
  sessionId: string;
  runId: string;
  createdAt: string;
  host: { hostId: string; hostEpoch: number; grantId: string; grantRevision: number; actorId: string; policyRevision: number };
  budget: { maxRounds: number; maxToolCalls: number; maxTokens: number; timeoutMs: number };
}
export function workspaceAgentBindingHash(binding: WorkspaceAgentTaskBinding): string {
  return createHash("sha256").update("hara-workspace-run-agent-v1\0").update(canonical(binding)).digest("hex");
}
const safeId = (value: unknown) => text(value, 220) && !/[\\/]/.test(value);
function parse(value: unknown): WorkspaceRunBinding {
  const fail = (): never => { throw new Error("invalid or unsupported Workspace RunBinding; execution refused"); };
  if (!plain(value) || !exact(value, ["schemaVersion", "scope", "agent", "agentBindingHash", "connection", "runtimeContract", "sessionId", "runId", "createdAt", "host", "budget"])
    || value.schemaVersion !== 1 || !isWorkspaceAgentTaskBinding(value.agent) || value.agent.runtimeId !== "pi"
    || value.agentBindingHash !== workspaceAgentBindingHash(value.agent) || !isScopedRunConnection(value.connection)
    || value.runtimeContract !== "hara-governed-pi-v1" || !safeId(value.sessionId) || !safeId(value.runId)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !plain(value.host) || !exact(value.host, ["hostId", "hostEpoch", "grantId", "grantRevision", "actorId", "policyRevision"])
    || !text(value.host.hostId) || !text(value.host.grantId) || !text(value.host.actorId)
    || !positive(value.host.hostEpoch) || !positive(value.host.grantRevision) || !positive(value.host.policyRevision)
    || !plain(value.budget) || !exact(value.budget, ["maxRounds", "maxToolCalls", "maxTokens", "timeoutMs"])
    || ![value.budget.maxRounds, value.budget.maxToolCalls, value.budget.maxTokens, value.budget.timeoutMs].every(positive)
    || Number(value.budget.maxRounds) > 64 || Number(value.budget.maxToolCalls) > 256
    || Number(value.budget.maxTokens) > 200_000 || Number(value.budget.timeoutMs) > 10 * 60_000) return fail();
  const scope = parseWorkspaceResourceScope(value.scope);
  if (scope.authority.kind !== "local" || scope.workspaceId !== value.agent.workspaceId
    || workspaceResourceScopeKey(scope) !== value.agent.resourceBinding.scopeKey
    || !UUID.test(value.agent.resourceBinding.generation)) return fail();
  return structuredClone({ ...value, scope }) as unknown as WorkspaceRunBinding;
}
export function isWorkspaceRunBinding(value: unknown): value is WorkspaceRunBinding {
  try { parse(value); return true; } catch { return false; }
}
export function freezeWorkspaceRunBinding(value: WorkspaceRunBinding): Readonly<WorkspaceRunBinding> { return deepFreeze(parse(value)); }
export function workspaceRunBindingsEqual(a: WorkspaceRunBinding, b: WorkspaceRunBinding): boolean {
  return isWorkspaceRunBinding(a) && isWorkspaceRunBinding(b) && canonical(a) === canonical(b);
}
export function workspaceRunMatchesTask(binding: unknown, task: { id?: unknown; workspaceAgentBinding?: unknown; runtimeBinding?: unknown }): binding is WorkspaceRunBinding {
  return isWorkspaceRunBinding(binding) && task.runtimeBinding === undefined
    && isWorkspaceAgentTaskBinding(task.workspaceAgentBinding) && binding.agent.taskId === task.id
    && canonical(binding.agent) === canonical(task.workspaceAgentBinding);
}
