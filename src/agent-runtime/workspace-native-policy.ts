// All paths come from Host admission and the registered installer, never model or renderer arguments.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { attachWorkspaceNativePolicy, finishWorkspaceNativePolicy, publishWorkspaceNativeRisks, workspaceRuntimeStorage, type WorkspaceRunPermit } from "../workspace/execution.js";
import { workspaceStateHome } from "../workspace/resource-context.js";
import { createRuntimeExecutionPolicy, runtimeExecutionPolicyKey, workspaceRunPermissionTier,
  type RegisteredPolicyRuntime, type RuntimeExecutionPolicy, type RuntimeExecutionPolicyInput } from "./execution-policy.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";

type Resolved = ReturnType<WorkspaceRuntimeInstaller["resolveBound"]> & { proxyUrl?: string | null };
export function workspaceRuntimePolicyInput(permit: WorkspaceRunPermit, runtimeId: RegisteredPolicyRuntime, resolved: Resolved,
  lifetime: "attempt" | "resident" = "attempt", installer?: WorkspaceRuntimeInstaller): RuntimeExecutionPolicyInput {
  if (runtimeId !== permit.binding.agent.runtimeId) throw new Error("Native policy runtime differs from the admitted binding");
  const home = resolved.env.HOME;
  if (!home) throw new Error("Native runtime login HOME is unavailable; no fallback was selected");
  if (installer && (runtimeId === "codex" || runtimeId === "claude" || runtimeId === "opencode" || runtimeId === "gemini" || runtimeId === "kimi")) return {
    runtimeId, tier: workspaceRunPermissionTier(permit), workRoot: permit.binding.project.root,
    ...installer.executionPolicyDirectories(runtimeId, resolved), lifetime, loginSource: resolved.loginSource,
  };
  const env = resolved.env;
  const runtimeHome = runtimeId === "codex" ? env.CODEX_HOME : runtimeId === "claude" ? env.CLAUDE_CONFIG_DIR
    : runtimeId === "opencode" && env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, "opencode") : undefined;
  return { runtimeId, tier: workspaceRunPermissionTier(permit), accountHome: home, workRoot: permit.binding.project.root,
    runtimeHome, protectedStateRoots: [workspaceRuntimeStorage(permit).run(() => workspaceStateHome())], lifetime, loginSource: resolved.loginSource };
}
export function workspaceRuntimeProcessKey(input: RuntimeExecutionPolicyInput, resolved: Resolved): string {
  return createHash("sha256").update(JSON.stringify([runtimeExecutionPolicyKey(input), resolved.proxyUrl ?? null])).digest("hex");
}
// Two native attempts sharing the directory cannot claim each other's changes as completion proof.
const writers = new Map<string, Set<RuntimeExecutionPolicy>>();
const attached = new WeakSet<RuntimeExecutionPolicy>();
export function beginWorkspaceNativePolicy(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy): void {
  if (attached.has(policy)) return;
  policy.beginAttempt(permit.binding.runId);
  attachWorkspaceNativePolicy(permit, policy);
  const peers = writers.get(policy.workRoot) ?? new Set();
  if (peers.size) { policy.invalidateEvidence(); for (const peer of peers) peer.invalidateEvidence(); }
  peers.add(policy); writers.set(policy.workRoot, peers); attached.add(policy);
}
export function newWorkspaceNativePolicy(permit: WorkspaceRunPermit, runtimeId: RegisteredPolicyRuntime, resolved: Resolved, installer?: WorkspaceRuntimeInstaller): RuntimeExecutionPolicy {
  const policy = createRuntimeExecutionPolicy(workspaceRuntimePolicyInput(permit, runtimeId, resolved, "attempt", installer));
  try { beginWorkspaceNativePolicy(permit, policy); return policy; } catch (error) { void policy.close(); throw error; }
}
export async function endWorkspaceNativePolicy(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy, input: { keepResidentRoot?: boolean } = {}): Promise<void> {
  if (!attached.has(policy)) return;
  await policy.drainAttempt({ keepResidentRoot: input.keepResidentRoot === true });
  finishWorkspaceNativePolicy(permit, policy);
  attached.delete(policy); const peers = writers.get(policy.workRoot); peers?.delete(policy); if (!peers?.size) writers.delete(policy.workRoot);
}
/** Bounded documented native item events. No arbitrary text is accepted as a write receipt. */
export function observeWorkspaceNativeItem(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy, item: Record<string, unknown>, status: "started" | "completed"): void {
  if (["commandExecution", "command_execution"].includes(String(item.type))) {
    policy.observeNativeEvent({ type: "command", status, ...(typeof item.command === "string" ? { command: item.command.slice(0, 8192) } : {}) });
  } else if (["fileChange", "file_change"].includes(String(item.type)) && Array.isArray(item.changes)) {
    for (const change of item.changes.slice(0, 256)) if (change && typeof change.path === "string") {
      const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
      policy.observeNativeEvent({ type: "file", status, path: change.path, operation: String(kind ?? "change") });
    }
  }
  publishWorkspaceNativeRisks(permit);
}
