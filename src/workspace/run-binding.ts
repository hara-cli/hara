import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
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
  project: { root: string; dev: string | number; ino: string | number };
  sessionId: string;
  runId: string;
  lineage: { rootRunId: string | null; parentRunId: string | null; depth: number };
  createdAt: string;
  host: { hostId: string; hostEpoch: number; grantId: string; grantRevision: number; actorId: string; policyRevision: number };
  budget: { maxRounds: number; maxToolCalls: number; maxTokens: number; timeoutMs: number };
}
/** Transport input includes the fixed prompt/tool schema on EVERY round. Allow twelve ordinary
 * rounds: 12 x 8k input + 12 x 2k output = 120k, with 8k headroom. This is a sizing example,
 * not a token-price estimate or a guarantee that every task reaches twelve rounds. Retain raw usage.
 * The possible token ceiling is 4x the former 32k; actual spend depends on measured use and rates.
 * Only new ordinary tasks use this default. Existing bindings and acceptance slices stay frozen. */
export const DEFAULT_WORKSPACE_RUN_BUDGET: Readonly<WorkspaceRunBinding["budget"]> = Object.freeze({
  maxRounds: 12, maxToolCalls: 32, maxTokens: 128_000, timeoutMs: 120_000,
});
export function workspaceAgentBindingHash(binding: WorkspaceAgentTaskBinding): string {
  return createHash("sha256").update("hara-workspace-run-agent-v1\0").update(canonical(binding)).digest("hex");
}
const safeId = (value: unknown) => text(value, 220) && !/[\\/]/.test(value);
// Native file IDs can use all 64 bits (notably on NTFS). Keep old exact JSON numbers readable,
// but never round an unsafe number back into authority. New bindings use decimal strings.
function fileId(value: unknown): value is string | number {
  return typeof value === "number" ? Number.isSafeInteger(value) && value >= 0
    : typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}
export function workspaceFileIdMatches(frozen: unknown, native: bigint): boolean {
  return fileId(frozen) && BigInt(frozen) === native;
}
export function captureWorkspaceProjectIdentity(root: string): WorkspaceRunBinding["project"] {
  const info = lstatSync(root, { bigint: true });
  if (!isAbsolute(root) || !info.isDirectory() || info.isSymbolicLink() || realpathSync.native(root) !== root) {
    throw new Error("Workspace project grant identity changed");
  }
  return { root, dev: String(info.dev), ino: String(info.ino) };
}
function parse(value: unknown): WorkspaceRunBinding {
  const fail = (): never => { throw new Error("invalid or unsupported Workspace RunBinding; execution refused"); };
  if (!plain(value) || !exact(value, ["schemaVersion", "scope", "agent", "agentBindingHash", "connection", "runtimeContract", "project", "sessionId", "runId", "lineage", "createdAt", "host", "budget"])
    || value.schemaVersion !== 1 || !isWorkspaceAgentTaskBinding(value.agent) || value.agent.runtimeId !== "pi"
    || value.agentBindingHash !== workspaceAgentBindingHash(value.agent) || !isScopedRunConnection(value.connection)
    || value.runtimeContract !== "hara-governed-pi-v1" || !safeId(value.sessionId) || !safeId(value.runId)
    || !plain(value.lineage) || !exact(value.lineage, ["rootRunId", "parentRunId", "depth"])
    || !(value.lineage.depth === 0 ? value.lineage.rootRunId === null && value.lineage.parentRunId === null
      : value.lineage.depth === 1 && safeId(value.lineage.rootRunId) && safeId(value.lineage.parentRunId)
        && value.lineage.rootRunId !== value.runId && value.lineage.parentRunId !== value.runId)
    || !plain(value.project) || !exact(value.project, ["root", "dev", "ino"]) || !text(value.project.root, 4096) || !isAbsolute(value.project.root)
    || ![value.project.dev, value.project.ino].every(fileId)
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
