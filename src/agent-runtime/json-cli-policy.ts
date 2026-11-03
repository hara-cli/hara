// Trusted adapter to the shared Host execution-policy contract. No unprotected fallback.
import type { RunOpts } from "../agent/loop.js";
import type { WorkspaceRunPermit } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { JsonCliRuntimeId } from "./json-cli-protocol.js";
import { createRuntimeExecutionPolicy, workspaceRunPermissionTier,
  type RuntimeExecutionPolicy, type RuntimePermissionTier } from "./execution-policy.js";

export type JsonCliExecutionPolicy = Pick<RuntimeExecutionPolicy,
  "beginAttempt" | "wrap" | "observeNativeEvent" | "collectWorkspaceEvidence" | "close">;
export interface JsonCliPolicyHandle { tier: RuntimePermissionTier; policy: JsonCliExecutionPolicy }
/** Trusted Host composition only. This is never a renderer, model, environment or RPC option. */
export type JsonCliPolicyFactory = (input: {
  runtimeId: JsonCliRuntimeId; permit: WorkspaceRunPermit; options: RunOpts; installer: WorkspaceRuntimeInstaller;
  resolved: { command: string; env: NodeJS.ProcessEnv; loginSource: "host" | "isolated" };
}) => Promise<JsonCliPolicyHandle>;

export const createJsonCliExecutionPolicy: JsonCliPolicyFactory = async input => {
  // Classic Kimi has no documented way to disable global hooks/plugins while retaining the
  // original login configuration. A custom config would replace that login. Do not read/copy it,
  // silently inherit extensions, or invent unsupported flags. Keep production closed.
  if (input.runtimeId === "kimi") throw new Error("runtime_isolation_unavailable");
  const tier = workspaceRunPermissionTier(input.permit);
  const roots = input.installer.executionPolicyRoots(input.runtimeId, input.resolved);
  const policy = createRuntimeExecutionPolicy({ runtimeId: input.runtimeId, tier,
    workRoot: input.permit.binding.project.root, ...roots, lifetime: "attempt", loginSource: input.resolved.loginSource });
  return { tier, policy };
};
