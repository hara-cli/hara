import { isAbsolute, join } from "node:path";
import { lstatSync } from "node:fs";
import { assertWorkspaceRunAdmission } from "../workspace/execution.js";
import type { ExpandedRuntimeProtection } from "./expanded-protection.js";

/** Uses interface v1. The implementation is integrated separately; a missing policy or evidence
 * hook fails closed. No source path, writable root or permission tier comes from renderer input. */
export const sharedExpandedRuntimeProtection: ExpandedRuntimeProtection = async input => {
  const permit = input.options.workspaceRun;
  if (!permit || !input.env.HOME || !isAbsolute(input.env.HOME)) throw new Error("runtime_permission_denied");
  const assertCurrent = () => assertWorkspaceRunAdmission(permit, input.options, input.runtimeId);
  assertCurrent();
  const modulePath = "./execution-policy.js";
  let layer: any;
  try { layer = await import(modulePath); } catch { throw new Error("runtime_permission_denied"); }
  if (typeof layer.createRuntimeExecutionPolicy !== "function" || typeof layer.workspaceRunPermissionTier !== "function")
    throw new Error("runtime_permission_denied");
  const tier = layer.workspaceRunPermissionTier(permit);
  if (tier !== "full-protected" && tier !== "controlled") throw new Error("runtime_permission_denied");
  const policy = layer.createRuntimeExecutionPolicy({ runtimeId: input.runtimeId, tier, workRoot: input.options.ctx.cwd,
    accountHome: input.env.HOME, runtimeHome: join(input.env.HOME, "." + input.runtimeId),
    protectedStateRoots: input.options.ctx.stateHome ? [input.options.ctx.stateHome] : [], loginSource: "host", lifetime: "attempt" });
  try {
    if (typeof policy.tempRoot !== "string" || !isAbsolute(policy.tempRoot)) throw new Error("runtime_permission_denied");
    const stat = lstatSync(policy.tempRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("runtime_permission_denied");
    return {
      fullProtected: tier === "full-protected", temporaryDirectory: policy.tempRoot, assertCurrent,
      wrap(command, args, env) {
        assertCurrent();
        const launch = policy.wrap({ command, args, env });
        if (launch.command !== "/usr/bin/sandbox-exec" || launch.args?.[0] !== "-p" || launch.args[2] !== command
          || launch.args.length !== args.length + 3 || !args.every((arg, index) => launch.args[index + 3] === arg))
          throw new Error("runtime_permission_denied");
        return launch;
      },
      observeNativeTool(event) {
        assertCurrent();
        policy.observeNativeEvent({ type: "tool", status: event.state, operation: event.name,
          ...(event.risk === "external-publish" ? { command: "git push" } : {}),
          ...(event.deletionTarget ? { type: "file", operation: "delete", path: event.deletionTarget } : {}) });
      },
      async collectEvidence() {
        assertCurrent();
        const evidence = policy.collectWorkspaceEvidence();
        const executionPath = "../workspace/execution.js";
        const host = await import(executionPath);
        // The common layer owns the run/scope/evidence binder. Never inject a CLI assertion as proof.
        if (evidence) {
          if (typeof host.recordWorkspaceNativeEvidence !== "function") throw new Error("runtime_permission_denied");
          host.recordWorkspaceNativeEvidence(permit, evidence);
        }
        if (policy.risks?.length) {
          if (typeof host.recordWorkspaceRuntimeRisks !== "function") throw new Error("runtime_permission_denied");
          host.recordWorkspaceRuntimeRisks(permit, policy.risks);
        }
      },
      close: () => policy.close(),
    };
  } catch (error) { await policy.close(); throw error; }
};
