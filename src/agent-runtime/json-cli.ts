import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExternalCommandCapture } from "../external-sessions/process.js";
import { runGovernedAgent, type RunOpts } from "../agent/loop.js";
import { assertWorkspaceRunAdmission, attachWorkspaceRuntimeModel, publishWorkspaceNativeRisks, workspaceRunRuntimeStages } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import { createRegisteredCliMcpTurn, WORKSPACE_MCP_TOKEN_ENV } from "./registered-cli-mcp.js";
import { beginWorkspaceNativePolicy, endWorkspaceNativePolicy } from "./workspace-native-policy.js";
import { createJsonCliExecutionPolicy, type JsonCliPolicyFactory, type JsonCliPolicyHandle } from "./json-cli-policy.js";
import { createJsonCliNativeObserver, jsonCliArgs, jsonCliHelpCompatible, normalizeJsonCliOutput, writeJsonCliMcp, type JsonCliRuntimeId } from "./json-cli-protocol.js";
import { runtimeFailureTracker } from "./failure-tracker.js";
import { classifyRuntimeFailure, runtimeFailureMessage } from "./failure-diagnostics.js";
import { runtimeProxyFailure } from "../security/runtime-proxy.js";
import { createRuntimeStageProcessObserver } from "./stage-observer.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";

/** policyFactory is a trusted Host/test composition seam, never a renderer/model setting. */
export function jsonCliDriver(id: JsonCliRuntimeId, installer: WorkspaceRuntimeInstaller, models?: WorkspaceRuntimeModels,
  policyFactory: JsonCliPolicyFactory = createJsonCliExecutionPolicy): GovernedAgentRuntimeDriver {
  return { id, async run(history, options: RunOpts, binding) {
    const permit = options.workspaceRun;
    if (!permit || permit.binding.agent.runtimeId !== id || permit.binding.agent.taskId !== binding.taskId) return { status: "error", error: "Runtime requires its exact Workspace run permit" };
    const assertCurrent = () => assertWorkspaceRunAdmission(permit, options, id); assertCurrent();
    const selection = models ? await models.launchSelection(id).catch(() => models.selection(id)) : null;
    if (selection?.effort) return { status: "error", error: runtimeFailureMessage({ ...installer.failureContext(id), kind: "version_incompatible", elapsedMs: 0 }) };
    let policy: JsonCliPolicyHandle | undefined, directory: string | undefined, success: (() => void) | undefined;
    const native = createRegisteredCliMcpTurn({ signal: options.signal!, assertCurrent,
      parseOutput: output => normalizeJsonCliOutput(id, output).turn,
      async launch(endpoint, prompt, activity) {
        assertCurrent(); const started = Date.now();
        let observer: ReturnType<typeof createRuntimeStageProcessObserver> | undefined;
        let tracker: ReturnType<typeof runtimeFailureTracker> | undefined;
        let env: NodeJS.ProcessEnv | undefined;
        try {
          const resolved = await installer.prepareBound(id, native.signal); assertCurrent();
          tracker = runtimeFailureTracker(installer, id, permit.binding.agent.agentId,
            JSON.stringify([resolved.command, resolved.loginSource, resolved.proxyUrl, permit.binding.agent.configRevision, selection]), resolved);
          const held = tracker.blocked(); if (held) return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: held };
          directory = realpathSync.native(mkdtempSync(join(tmpdir(), `hara-${id}-attempt-`)));
          // --help uses a fresh probe HOME, never the account's login/configuration files.
          const probeEnv = { ...resolved.env, HOME: directory, USERPROFILE: directory, GEMINI_CLI_HOME: directory,
            KIMI_SHARE_DIR: join(directory, ".kimi"), KIMI_CODE_HOME: join(directory, ".kimi-code") };
          const help = await runExternalCommandCapture({ command: resolved.command, env: probeEnv }, ["--help"],
            { cwd: directory, signal: native.signal, timeoutMs: 10_000, maxOutputBytes: 256 * 1024, failureKind: "runtime" });
          if (!help.ok || !jsonCliHelpCompatible(id, help.stdout)) return { ok: false, stdout: "", code: help.code, timedOut: help.timedOut,
            runtimeFailure: tracker.failed(help.timedOut ? "timeout" : "version_incompatible", Date.now() - started) };
          policy = await policyFactory({ runtimeId: id, permit, options, installer, resolved }); assertCurrent();
          beginWorkspaceNativePolicy(permit, policy.policy);
          // Print alone is AFK. Controlled must add its documented plan flag and outer read-only policy.
          if (policy.tier !== "full-protected" && policy.tier !== "controlled") throw new Error("runtime_protection_unavailable");
          if (policy.tier === "controlled" && !(id === "gemini" ? /--approval-mode(?=[\s,=]|$)/ : /--plan(?=[\s,=]|$)/).test(help.stdout)) throw new Error("runtime_controlled_mode_unavailable");
          const mcp = writeJsonCliMcp(id, endpoint, directory, permit.binding.budget.timeoutMs);
          const args = jsonCliArgs({ runtime: id, prompt, cwd: permit.binding.project.root, model: selection?.modelId ?? null, mcpPath: mcp.path,
            tier: policy.tier });
          env = { ...resolved.env, ...endpoint.env, ...mcp.env,
            HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
          const record = installer.captureSuccessfulUse(id, resolved.command), stages = workspaceRunRuntimeStages(permit);
          stages?.setRuntime({ id, version: installer.list().options.find(row => row.runtimeId === id)?.version ?? null, loginSource: resolved.loginSource,
            model: selection?.modelId ?? null, effort: null });
          observer = createRuntimeStageProcessObserver(stages, id, native.signal);
          const nativeEvents = createJsonCliNativeObserver(id, event => { policy!.policy.observeNativeEvent(event); publishWorkspaceNativeRisks(permit); });
          const wrapped = policy.policy.wrap({ command: resolved.command, args, env }); assertCurrent();
          const result = await runExternalCommandCapture(wrapped, wrapped.args, {
            cwd: permit.binding.project.root, signal: native.signal, timeoutMs: permit.binding.budget.timeoutMs, governedDeadline: permit.binding.budget.mode === "interactive",
            waitForClose: true, failureKind: "runtime", proxyUrl: resolved.proxyUrl, maxOutputBytes: 4 * 1024 * 1024, retainStdoutOnFailure: true,
            onSpawn: observer.onSpawn, onStdout: chunk => { observer?.onStdout(chunk); nativeEvents.onStdout(chunk); activity(); },
          });
          nativeEvents.finish();
          if (native.signal.aborted || result.errorCode === "interrupted") return { ...result, ok: false, stdout: "", errorCode: "interrupted" };
          const parsed = normalizeJsonCliOutput(id, result.stdout);
          if (!result.ok || parsed.failure) {
            const kind = result.ok ? parsed.failure! : classifyRuntimeFailure({ code: result.errorCode, timedOut: result.timedOut });
            observer.finish(false, kind); return { ...result, ok: false, stdout: "", runtimeFailure: tracker.failed(kind, Date.now() - started) };
          }
          policy.policy.collectWorkspaceEvidence();
          observer.finish(true); tracker.succeeded(); success = record;
          return { ...result, stdout: redactToolSubprocessOutput(result.stdout, env) };
        } catch (error) {
          if (native.signal.aborted) return { ok: false, stdout: "", code: null, timedOut: false, errorCode: "interrupted" };
          const kind = runtimeProxyFailure(error) ? "runtime_proxy" : error instanceof Error && /runtime_(protection|controlled_mode)_unavailable/.test(error.message)
            ? "runtime_permission_denied" : "runtime_failed";
          observer?.finish(false, kind);
          return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: tracker ? tracker.failed(kind, Date.now() - started)
            : runtimeFailureMessage({ ...installer.failureContext(id), kind, elapsedMs: Date.now() - started }) };
        } finally {
          observer?.finish(false); if (env) delete env[WORKSPACE_MCP_TOKEN_ENV];
          if (policy) { await endWorkspaceNativePolicy(permit, policy.policy); await policy.policy.close(); }
        }
      },
    });
    try {
      attachWorkspaceRuntimeModel(permit, options, id, args => native.turn(args));
      const outcome = await runGovernedAgent(history, options, id, (provider, args) => provider.turn(args));
      if (outcome.status === "completed" && !options.signal?.aborted && success) { assertCurrent(); success(); }
      return outcome;
    } finally {
      await native.close(history); // launch awaits Host end/drain before returning its final result.
      if (policy) { await endWorkspaceNativePolicy(permit, policy.policy); await policy.policy.close(); }
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  } };
}
