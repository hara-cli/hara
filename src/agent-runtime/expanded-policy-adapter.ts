import { isAbsolute, join } from "node:path";
import { lstatSync } from "node:fs";
import { assertWorkspaceRunAdmission, publishWorkspaceNativeRisks } from "../workspace/execution.js";
import { workspaceRunPermissionTier } from "./execution-policy.js";
import { newWorkspaceNativePolicy, endWorkspaceNativePolicy } from "./workspace-native-policy.js";
import { assertExpandedRuntimeIsolation } from "./expanded-isolation.js";
import type { ExpandedRuntimeId } from "./expanded-models.js";
import type { ExpandedRuntimeProtection, PreflightExpandedRuntimeProtection } from "./expanded-protection.js";

/** Fixed native login-file declarations, relative to installer-proved host accountHome.
 * These are path declarations only: Hara never opens the user's credentials or Keychain items. */
export const EXPANDED_RUNTIME_LOGIN_FILES: Readonly<Record<ExpandedRuntimeId, readonly string[]>> = {
  copilot: [".copilot/config.json", ".config/gh/hosts.yml"],
  cursor: [".cursor/cli-config.json"],
  grok: [".grok/user-settings.json", ".grok/auth.json"],
};

/** Public v4: preserve the complete ownership/drain launch and await Host end before cleanup.
 * Personal extensions inherit by Jeff option A; this does not relax Seatbelt or permit admission. */
const protect: ExpandedRuntimeProtection = async input => {
  assertExpandedRuntimeIsolation(input.runtimeId);
  const permit = input.options.workspaceRun;
  if (!permit || input.resolved.loginSource !== "host") throw new Error("runtime_permission_denied");
  const assertCurrent = () => assertWorkspaceRunAdmission(permit, input.options, input.runtimeId);
  assertCurrent();
  const directories = input.installer.executionPolicyDirectories(input.runtimeId, input.resolved);
  const policy = newWorkspaceNativePolicy(permit, input.runtimeId, input.resolved, input.installer);
  let ending: Promise<void> | undefined;
  const finishOnce = () => ending ??= endWorkspaceNativePolicy(permit, policy);
  try {
    if (!isAbsolute(policy.tempRoot)) throw new Error("runtime_permission_denied");
    const stat = lstatSync(policy.tempRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("runtime_permission_denied");
    const ownLogin = EXPANDED_RUNTIME_LOGIN_FILES[input.runtimeId].map(file => join(directories.accountHome, file));
    if (policy.readableCredentialFiles.length !== ownLogin.length || policy.readableCredentialFiles.some(file => !ownLogin.includes(file)))
      throw new Error("runtime_permission_denied");
    return {
      fullProtected: workspaceRunPermissionTier(permit) === "full-protected", temporaryDirectory: policy.tempRoot, assertCurrent,
      wrap(command, args, env) {
        assertCurrent();
        const launch = policy.wrap({ command, args, env });
        if (typeof launch.onProcess !== "function" || typeof launch.drainProcess !== "function") throw new Error("runtime_permission_denied");
        return launch;
      },
      observeNativeTool(event) {
        assertCurrent();
        policy.observeNativeEvent({ type: "tool", status: event.state, operation: event.name,
          ...(event.risk === "external-publish" ? { command: "git push" } : {}),
          ...(event.deletionTarget ? { type: "file", operation: "delete", path: event.deletionTarget } : {}) });
        publishWorkspaceNativeRisks(permit);
      },
      async collectEvidence() { assertCurrent(); await finishOnce(); },
      async close() { try { await finishOnce(); } finally { await policy.close(); } },
    };
  } catch (error) { try { await finishOnce(); } finally { await policy.close(); } throw error; }
};
export const sharedExpandedRuntimeProtection: PreflightExpandedRuntimeProtection = Object.assign(protect, {
  assertLaunchSupported: assertExpandedRuntimeIsolation,
});
