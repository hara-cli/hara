// Trusted adapter to the shared Host execution-policy contract. No unprotected fallback.
import type { RunOpts } from "../agent/loop.js";
import type { WorkspaceRunPermit } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { JsonCliRuntimeId } from "./json-cli-protocol.js";
import { createRuntimeExecutionPolicy, workspaceRunPermissionTier,
  type RuntimeExecutionPolicy, type RuntimePermissionTier } from "./execution-policy.js";

export type JsonCliExecutionPolicy = RuntimeExecutionPolicy;
export interface JsonCliPolicyHandle { tier: RuntimePermissionTier; policy: JsonCliExecutionPolicy }
/** Trusted Host composition only. This is never a renderer, model, environment or RPC option. */
export type JsonCliPolicyFactory = (input: {
  runtimeId: JsonCliRuntimeId; permit: WorkspaceRunPermit; options: RunOpts; installer: WorkspaceRuntimeInstaller;
  resolved: { command: string; env: NodeJS.ProcessEnv; loginSource: "host" | "isolated" };
}) => Promise<JsonCliPolicyHandle>;

export const createJsonCliExecutionPolicy: JsonCliPolicyFactory = async input => {
  // Jeff 2026-11-03 option A: classic Kimi inherits host extensions. This removes only
  // the extension-isolation gate; the frozen permit and shared Seatbelt boundary stay mandatory.
  const tier = workspaceRunPermissionTier(input.permit);
  const roots = input.installer.executionPolicyDirectories(input.runtimeId, input.resolved);
  const policy = createRuntimeExecutionPolicy({ runtimeId: input.runtimeId, managedProjectPermit: input.permit, tier,
    workRoot: input.permit.binding.project.root, ...roots, lifetime: "attempt", loginSource: input.resolved.loginSource });
  return { tier, policy };
};
