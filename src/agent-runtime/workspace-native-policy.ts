// The shared public-layer contract. Kept small so runtime adapters never create parallel evidence authority.
import { join } from "node:path";
import { attachWorkspaceNativePolicy, finishWorkspaceNativePolicy, workspaceRuntimeStorage, type WorkspaceRunPermit } from "../workspace/execution.js";
import { workspaceStateHome } from "../workspace/resource-context.js";
import { createRuntimeExecutionPolicy, workspaceRunPermissionTier, type RegisteredPolicyRuntime, type RuntimeExecutionPolicy } from "./execution-policy.js";

const writers = new Map<string, Set<RuntimeExecutionPolicy>>();
const attached = new WeakSet<RuntimeExecutionPolicy>();
export function beginWorkspaceNativePolicy(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy): void {
  if (attached.has(policy)) return;
  policy.beginAttempt(permit.binding.runId);
  const peers = writers.get(policy.workRoot) ?? new Set();
  if (peers.size) throw new Error("Concurrent native writers require the final shared evidence invalidation contract");
  peers.add(policy); writers.set(policy.workRoot, peers); attached.add(policy);
  attachWorkspaceNativePolicy(permit, policy);
}
export function newPiWorkspaceNativePolicy(permit: WorkspaceRunPermit, accountHome: string, runtimeHome: string): RuntimeExecutionPolicy {
  // The immutable d1ad885 policy refuses Pi until hara:4 delivers its Pi extension. No other id is substituted.
  const policy = createRuntimeExecutionPolicy({ runtimeId: "pi" as RegisteredPolicyRuntime, tier: workspaceRunPermissionTier(permit),
    accountHome, runtimeHome, workRoot: permit.binding.project.root,
    protectedStateRoots: [workspaceRuntimeStorage(permit).run(() => workspaceStateHome())], lifetime: "attempt", loginSource: "isolated" });
  try { beginWorkspaceNativePolicy(permit, policy); return policy; } catch (error) { void policy.close(); throw error; }
}
export async function endWorkspaceNativePolicy(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy): Promise<void> {
  if (!attached.has(policy)) return;
  const shared = policy as RuntimeExecutionPolicy & { drainAttempt?: () => Promise<unknown> };
  if (typeof shared.drainAttempt !== "function") throw new Error("The shared native drain contract is unavailable");
  await shared.drainAttempt();
  finishWorkspaceNativePolicy(permit, policy);
  attached.delete(policy); const peers = writers.get(policy.workRoot); peers?.delete(policy); if (!peers?.size) writers.delete(policy.workRoot);
}
