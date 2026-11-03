import { isAbsolute } from "node:path";
import { lstatSync } from "node:fs";
import { assertWorkspaceRunAdmission } from "../workspace/execution.js";
import type { WorkspaceRunPermit } from "../workspace/execution.js";
import { workspaceRunPermissionTier, type RuntimeExecutionPolicy } from "./execution-policy.js";
import { assertExpandedRuntimeIsolation } from "./expanded-isolation.js";
import type { ExpandedRuntimeProtection, PreflightExpandedRuntimeProtection } from "./expanded-protection.js";

/** Interface v2. The native Host bridge owns attempt binding, writer exclusion, evidence and risk
 * publication. A missing bridge still fails BEFORE spawn; inherited personal extensions are explicitly allowed by Jeff option A. */
const protect: ExpandedRuntimeProtection = async input => {
  assertExpandedRuntimeIsolation(input.runtimeId);
  const permit = input.options.workspaceRun;
  if (!permit || !input.env.HOME || !isAbsolute(input.env.HOME)) throw new Error("runtime_permission_denied");
  const assertCurrent = () => assertWorkspaceRunAdmission(permit, input.options, input.runtimeId);
  assertCurrent();
  const modulePath = "./workspace-native-policy.js", executionPath = "../workspace/execution.js";
  const bridge: Record<string, unknown> = await import(modulePath).catch(() => { throw new Error("runtime_permission_denied"); });
  const host: Record<string, unknown> = await import(executionPath);
  if (typeof bridge.newWorkspaceNativePolicy !== "function" || typeof bridge.endWorkspaceNativePolicy !== "function"
    || typeof host.publishWorkspaceNativeRisks !== "function") throw new Error("runtime_permission_denied");
  const create = bridge.newWorkspaceNativePolicy as (permit: WorkspaceRunPermit, id: string,
    resolved: { command: string; env: NodeJS.ProcessEnv; loginSource: "host" }) => RuntimeExecutionPolicy;
  const finish = bridge.endWorkspaceNativePolicy as (permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy) => void;
  const publish = host.publishWorkspaceNativeRisks as (permit: WorkspaceRunPermit) => void;
  // The shared helper calls beginAttempt(permit.binding.runId) and attaches this very policy.
  const policy = create(permit, input.runtimeId, { command: input.command, env: input.env, loginSource: "host" });
  try {
    if (typeof policy.tempRoot !== "string" || !isAbsolute(policy.tempRoot)) throw new Error("runtime_permission_denied");
    const stat = lstatSync(policy.tempRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("runtime_permission_denied");
    let finished = false;
    const finishOnce = () => { if (!finished) { finished = true; finish(permit, policy); } };
    return {
      fullProtected: workspaceRunPermissionTier(permit) === "full-protected",
      temporaryDirectory: policy.tempRoot, assertCurrent,
      wrap(command, args, env) {
        assertCurrent();
        const launch = policy.wrap({ command, args, env });
        if (launch.command !== "/usr/bin/sandbox-exec" || launch.args[0] !== "-p" || launch.args[2] !== command
          || launch.args.length !== args.length + 3 || !args.every((arg, index) => launch.args[index + 3] === arg))
          throw new Error("runtime_permission_denied");
        return launch;
      },
      observeNativeTool(event) {
        assertCurrent();
        policy.observeNativeEvent({ type: "tool", status: event.state, operation: event.name,
          ...(event.risk === "external-publish" ? { command: "git push" } : {}),
          ...(event.deletionTarget ? { type: "file", operation: "delete", path: event.deletionTarget } : {}) });
        publish(permit);
      },
      collectEvidence() { assertCurrent(); finishOnce(); },
      async close() { try { finishOnce(); } finally { await policy.close(); } },
    };
  } catch (error) { try { finish(permit, policy); } finally { await policy.close(); } throw error; }
};
export const sharedExpandedRuntimeProtection: PreflightExpandedRuntimeProtection = Object.assign(protect, {
  assertLaunchSupported: assertExpandedRuntimeIsolation,
});
