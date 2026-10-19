// Explicit owner-reviewed references to RETAINED project Agents, not a colleague/persona importer.
// Never opens a project, its role definition/memory/scripts/database, a vault or a running gateway.
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { canonical, deepFreeze, exact, plain, text } from "./local-state.js";
import type { LegacyTaskPlan } from "./legacy-plan.js";
import { isWorkspaceId } from "./registry.js";
import { isWorkspaceResourceBinding, sameWorkspaceResourceBinding, type WorkspaceResourceBinding } from "./resource-context.js";

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const alias = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
  && !/^(?:global|claude|codex|plugin):/.test(value);
const cwd = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && isAbsolute(value) && resolve(value) === value && value !== "/" && !/[\u0000-\u001f\u007f]/.test(value);
export interface RetainedProjectAgentApproval {
  agentRef: string; cwd: string; sourceFingerprint: string; approvalHash: string; workspaceId: string; resourceBinding: WorkspaceResourceBinding;
  taskIds: readonly string[]; flowNames: readonly string[];
}
export interface RetainedProjectAgentPlan {
  schemaVersion: 1; kind: "retained-project-agent"; agentRef: string; cwd: string; sourceFingerprint: string; approvalHash: string;
  workspaceId: string; resourceBinding: WorkspaceResourceBinding;
  schedulingOwner: "main-hara"; runtimeAuthority: "existing-owner-runtime"; newColleague: false;
  tasks: { id: string; sourceHash: string }[];
  flows: { name: string; sourceHash: string; dispatchEvidence: "static-result" | "prompt-hint-only"; enabled: boolean }[];
}
function sourceRows(value: unknown, key: string, cap: number): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : plain(value) ? value[key] : null;
  if (!Array.isArray(rows) || rows.length > cap || rows.some(row => !plain(row))) throw new Error("Invalid retained project route source");
  return rows as Record<string, unknown>[];
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256 && new Set(value).size === value.length && value.every(item => text(item, 128));
}
/** Approval is supplied by trusted Host composition, never inferred from task text or an old message.
 * Its hash is provenance, NOT authentication or an execution/tool permission. Do not ambient-import
 * every external Claude/Codex role merely because one qualified project identity was approved. */
export function planRetainedProjectAgent(approval: RetainedProjectAgentApproval, input: { jobs: unknown; flows: unknown; taskPlan: readonly LegacyTaskPlan[] }): RetainedProjectAgentPlan {
  if (!plain(approval) || !exact(approval, ["agentRef", "cwd", "sourceFingerprint", "approvalHash", "workspaceId", "resourceBinding", "taskIds", "flowNames"])
    || !alias(approval.agentRef) || !cwd(approval.cwd) || !digest(approval.sourceFingerprint) || !digest(approval.approvalHash)
    || !isWorkspaceId(approval.workspaceId) || !isWorkspaceResourceBinding(approval.resourceBinding)
    || !ids(approval.taskIds) || !ids(approval.flowNames) || !approval.taskIds.length && !approval.flowNames.length) throw new Error("Explicit retained project Agent review required");
  const jobs = sourceRows(input.jobs, "jobs", 4096), flows = sourceRows(input.flows, "flows", 256);
  const tasks = approval.taskIds.map(id => {
    const matches = jobs.filter(row => row.id === id), reviewed = input.taskPlan.filter(row => row.id === id);
    if (matches.length !== 1 || reviewed.length !== 1 || reviewed[0]!.definitionValidation !== "pass" || reviewed[0]!.definitionHash !== hash(matches[0])
      || matches[0]!.cwd !== approval.cwd) throw new Error("Retained project task source/cwd changed; no identity substituted");
    return { id, sourceHash: hash(matches[0]) };
  });
  const flowRows = approval.flowNames.map(name => {
    const matches = flows.filter(row => row.name === name);
    if (matches.length !== 1 || matches[0]!.enabled !== undefined && typeof matches[0]!.enabled !== "boolean") throw new Error("Retained project flow source is ambiguous");
    const flow = matches[0]!, fixed = plain(flow.staticResult) && plain(flow.staticResult.dispatch) && flow.staticResult.dispatch.agent === approval.agentRef;
    // A prompt's mention preserves an expected routing hint only. It is never a structured send,
    // automatic dispatch grant or permission to change the independently retained gateway rule.
    const hint = typeof flow.do === "string" && flow.do.includes(approval.agentRef) && /dispatch/.test(flow.do);
    if (!fixed && !hint) throw new Error("Expected retained flow target is not demonstrated in this source; do not rewrite it");
    return { name, sourceHash: hash(flow), dispatchEvidence: fixed ? "static-result" as const : "prompt-hint-only" as const, enabled: flow.enabled !== false };
  });
  return deepFreeze({ schemaVersion: 1 as const, kind: "retained-project-agent" as const, agentRef: approval.agentRef, cwd: approval.cwd,
    sourceFingerprint: approval.sourceFingerprint, approvalHash: approval.approvalHash, workspaceId: approval.workspaceId, resourceBinding: { ...approval.resourceBinding }, schedulingOwner: "main-hara" as const,
    runtimeAuthority: "existing-owner-runtime" as const, newColleague: false as const, tasks, flows: flowRows });
}
function checked(value: RetainedProjectAgentPlan): void {
  if (!plain(value) || !exact(value, ["schemaVersion", "kind", "agentRef", "cwd", "sourceFingerprint", "approvalHash", "workspaceId", "resourceBinding", "schedulingOwner", "runtimeAuthority", "newColleague", "tasks", "flows"])
    || value.schemaVersion !== 1 || value.kind !== "retained-project-agent" || !alias(value.agentRef) || !cwd(value.cwd)
    || !isWorkspaceId(value.workspaceId) || !isWorkspaceResourceBinding(value.resourceBinding)
    || !digest(value.sourceFingerprint) || !digest(value.approvalHash) || value.schedulingOwner !== "main-hara" || value.runtimeAuthority !== "existing-owner-runtime"
    || value.newColleague !== false || !Array.isArray(value.tasks) || value.tasks.length > 256 || !Array.isArray(value.flows) || value.flows.length > 256
    || !value.tasks.length && !value.flows.length
    || value.tasks.some(row => !plain(row) || !exact(row, ["id", "sourceHash"]) || !text(row.id, 128) || !digest(row.sourceHash))
    || value.flows.some(row => !plain(row) || !exact(row, ["name", "sourceHash", "dispatchEvidence", "enabled"]) || !text(row.name, 128) || !digest(row.sourceHash)
      || !["static-result", "prompt-hint-only"].includes(row.dispatchEvidence) || typeof row.enabled !== "boolean")
    || new Set(value.tasks.map(row => row.id)).size !== value.tasks.length || new Set(value.flows.map(row => row.name)).size !== value.flows.length) throw new Error("Invalid retained project Agent route; no fallback role selected");
}
/** Metadata attached to the original schedule, while its command/cwd/flags stay byte-for-byte intact.
 * Native main Hara remains scheduler owner; the qualified target is NOT a newly allocated ag_* ID. */
type Target = { workspaceId: string; resourceBinding: WorkspaceResourceBinding };
function targetMatches(plan: RetainedProjectAgentPlan, target: Target | undefined): boolean {
  return !!target && plan.workspaceId === target.workspaceId && sameWorkspaceResourceBinding(plan.resourceBinding, target.resourceBinding);
}
export function retainedProjectTaskRoutes(plans: readonly RetainedProjectAgentPlan[], jobs: unknown, sourceFingerprint: string, target?: Target) {
  if (!Array.isArray(plans) || plans.length > 256 || !digest(sourceFingerprint)) throw new Error("Invalid retained project route collection");
  const rows = sourceRows(jobs, "jobs", 4096), refs = new Set<string>(), routes = new Map<string, { agentRef: string; cwd: string; approvalHash: string;
    runtimeAuthority: "existing-owner-runtime"; schedulingOwner: "main-hara"; newColleague: false }>();
  for (const plan of plans) {
    checked(plan);
    if (plan.sourceFingerprint !== sourceFingerprint || !targetMatches(plan, target) || refs.has(plan.agentRef)) throw new Error("Retained project route source/identity/Workspace conflict"); refs.add(plan.agentRef);
    for (const task of plan.tasks) {
      const matches = rows.filter(row => row.id === task.id);
      if (routes.has(task.id) || matches.length !== 1 || hash(matches[0]) !== task.sourceHash || matches[0]!.cwd !== plan.cwd) throw new Error("Retained project task route conflicts or source changed");
      routes.set(task.id, Object.freeze({ agentRef: plan.agentRef, cwd: plan.cwd, approvalHash: plan.approvalHash,
        runtimeAuthority: "existing-owner-runtime", schedulingOwner: "main-hara", newColleague: false }));
    }
  }
  return routes;
}
/** Pure exact-alias lookup for /agent and dispatch compatibility. The Host must still supply the
 * original owner/runtime handle and approval boundary; this never loads a definition or invokes it. */
export function retainedProjectAgentRoute(plans: readonly RetainedProjectAgentPlan[], agentRef: string, sourceFingerprint: string, target: Target) {
  if (!Array.isArray(plans) || plans.length > 256 || !alias(agentRef) || !digest(sourceFingerprint)) throw new Error("Exact retained project Agent reference required");
  for (const plan of plans) { checked(plan); if (plan.sourceFingerprint !== sourceFingerprint || !targetMatches(plan, target)) throw new Error("Retained project Agent route source/Workspace changed"); }
  const matches = plans.filter(row => row.agentRef === agentRef && row.sourceFingerprint === sourceFingerprint);
  if (matches.length !== 1) throw new Error("Retained project Agent route unavailable or ambiguous; no global/persona fallback");
  const row = matches[0]!;
  return Object.freeze({ agentRef: row.agentRef, cwd: row.cwd, schedulingOwner: row.schedulingOwner, runtimeAuthority: row.runtimeAuthority,
    newColleague: false as const, approvalHash: row.approvalHash });
}
