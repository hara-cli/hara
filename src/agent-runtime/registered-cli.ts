import { claudeRuntimeEnvironment, parseClaudeCliOutput } from "./claude-cli.js";
import { workspaceRunPermissionTier } from "./execution-policy.js";
import { newWorkspaceNativePolicy, endWorkspaceNativePolicy, observeWorkspaceNativeItem } from "./workspace-native-policy.js";
import { classifyRuntimeFailure, runtimeFailureMessage } from "./failure-diagnostics.js";
import { runtimeFailureTracker } from "./failure-tracker.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runExternalCommandCapture } from "../external-sessions/process.js";
import { runGovernedAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { assertWorkspaceRunAdmission, attachWorkspaceRuntimeModel, recordWorkspaceRuntimeUsage, workspaceRunHasManagedProject, workspaceRunRuntimeStages } from "../workspace/execution.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { createRegisteredCliMcpTurn, WORKSPACE_MCP_TOKEN_ENV } from "./registered-cli-mcp.js";
import { codexHostToolOverrides } from "./codex-host-config.js";
import { runtimeProxyFailure } from "../security/runtime-proxy.js";
import { createRuntimeStageProcessObserver } from "./stage-observer.js";
import { runtimeUseProtocolSucceeded } from "./runtime-use-success.js";
import { codexSessionPool } from "./codex-session.js";

/** Only the level published by this Workspace's live model inventory may reach the native CLI. */
function codexEffortArgs(effort: string | null): string[] {
  return effort ? ["-c", "model_reasoning_effort=" + JSON.stringify(effort)] : [];
}
function claudeEffortArgs(effort: string | null): string[] { return effort ? ["--effort", effort] : []; }

/** The outer runtime policy owns native confinement; Codex's nested OS sandbox stays disabled.
 * Only the private per-attempt Hara MCP server is trusted, with canonical governor/Desk approval. */
export function registeredCliArgs(input: {
  id: "codex" | "claude"; prompt: string; cwd: string; model: string | null; effort: string | null; skipGitRepoCheck: boolean;
  mcp?: { url: string; timeoutMs: number; serverName?: string }; hostToolOverrides?: string[]; permissionTier?: "full-protected" | "controlled"; claudeStreamJson?: boolean; claudePermissionMode?: "plan" | "bypassPermissions";
}): string[] {
  const bridge = input.mcp;
  const server = bridge?.serverName ?? "hara_workspace";
  if (!/^hara_workspace(?:_[a-f0-9]{24})?$/u.test(server)) throw new Error("Invalid Host MCP namespace");
  const mcp = !bridge ? [] : input.id === "codex" ? [
    "-c", `mcp_servers.${server}={}`,
    "-c", `mcp_servers.${server}.url=` + JSON.stringify(bridge.url),
    "-c", `mcp_servers.${server}.bearer_token_env_var=` + JSON.stringify(WORKSPACE_MCP_TOKEN_ENV),
    "-c", `mcp_servers.${server}.default_tools_approval_mode="approve"`,
    "-c", `mcp_servers.${server}.required=true`,
    "-c", `mcp_servers.${server}.tool_timeout_sec=` + Math.ceil(bridge.timeoutMs / 1000),
    "-c", 'approval_policy="never"',
    "-c", 'shell_environment_policy.set.HARA_WORKSPACE_MCP_TOKEN=""', "--json",
  ] : ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { hara: { type: "http", url: bridge.url,
    headers: { Authorization: "Bearer $" + "{" + WORKSPACE_MCP_TOKEN_ENV + "}" }, timeout: bridge.timeoutMs } } }),
    "--allowedTools", "mcp__hara__*"];
  return input.id === "codex"
    ? ["exec", input.prompt, "--cd", input.cwd, ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      ...(input.model ? ["-m", input.model] : []), ...codexEffortArgs(input.effort), "--dangerously-bypass-approvals-and-sandbox",
      ...(bridge ? input.hostToolOverrides ?? [] : []), ...mcp]
    : ["-p", input.prompt, "--output-format", input.claudeStreamJson ? "stream-json" : "text", ...(input.claudeStreamJson ? ["--verbose"] : []), ...(input.model ? ["--model", input.model] : []),
      ...claudeEffortArgs(input.effort), "--permission-mode", input.permissionTier !== undefined ? input.permissionTier === "full-protected" ? "bypassPermissions" : "plan" : input.claudePermissionMode ?? "plan",
      ...(input.permissionTier === "full-protected" ? ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"] : []),
      "--setting-sources", "project,local", "--settings", JSON.stringify({ disableAllHooks: true, sandbox: { enabled: false } }),
      "--disallowedTools", "EnterPlanMode", "ExitPlanMode", "ScheduleWakeup", "CronCreate", "CronList", "CronDelete", "Cron*", "Monitor", "Agent", "Task", ...mcp];
}

/** Native CLIs own model inference. Hara owns the exact same tool/governor path as Pi. */
export function registeredCliDriver(id: "codex" | "claude", installer: WorkspaceRuntimeInstaller,
  models?: WorkspaceRuntimeModels): GovernedAgentRuntimeDriver {
  return { id, async run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome> {
    const permit = options.workspaceRun;
    if (!permit || permit.binding.agent.runtimeId !== id || permit.binding.agent.taskId !== binding.taskId) {
      return { status: "error", error: "Agent Runtime '" + id + "' requires its exact Workspace run permit" };
    }
    const assertCurrent = () => assertWorkspaceRunAdmission(permit, options, id);
    assertCurrent();
    if (options.signal?.aborted) return { status: "error", error: "Agent Runtime execution cancelled" };
    const selection = models ? await models.launchSelection(id).catch(() => models.selection(id)) : null;
    const model = selection?.modelId ?? null, effort = selection?.effort ?? null;
    if (effort && models && !(await models.effortLaunchable(id))) {
      return { status: "error", error: "Agent Runtime '" + id + "' does not support reasoning effort; no level was applied" };
    }
    let successfulUse: (() => void) | undefined;
    const session = id === "codex" ? await codexSessionPool(installer).acquire(permit, assertCurrent) : undefined;
    const native = createRegisteredCliMcpTurn({
      signal: options.signal!, assertCurrent, jsonEvents: id === "codex",
      ...(session ? { bearerToken: session.token, createEndpoint: session.createEndpoint.bind(session),
        prompt: (args: import("../providers/types.js").TurnArgs) => args.history.flatMap(message => message.role === "user" ? [message.content] : []).join("\n\n"),
        takeUsage: () => session.takeUsage(), decorateResult: session.decorateResult.bind(session) } : {}),
      async launch(endpoint, prompt, activity, turnArgs) {
        assertCurrent();
        if (session) {
          if (turnArgs.system.length > 200_000) throw new Error("Native Agent Runtime system context is too large");
          const resolved = installer.resolveBound(id), started = Date.now();
          const tracker = runtimeFailureTracker(installer, id, permit.binding.agent.agentId,
            JSON.stringify([resolved.command, resolved.loginSource, resolved.env.HOME, installer.proxy.read().revision, permit.binding.agent.configRevision, model, effort]), resolved, permit.binding.sessionId);
          const held = tracker.blocked(); if (held) return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: held };
          try {
            const result = await session.launch(endpoint, prompt, turnArgs, { model, effort, cwd: options.ctx.cwd, signal: native.signal, assertCurrent, activity });
            if (!result.ok) return native.signal.aborted || result.errorCode === "interrupted" ? result : { ...result,
              runtimeFailure: tracker.failed(result.nativeFailureKind ?? classifyRuntimeFailure({ code: result.errorCode }), Date.now() - started, result.errorFirstLine, result.nativeRpc) };
            tracker.succeeded();
            if (!native.signal.aborted) successfulUse = installer.captureSuccessfulUse(id, resolved.command);
            return result;
          } catch (error) {
            return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: tracker.failed(runtimeProxyFailure(error) ? "runtime_proxy" : "runtime_failed", Date.now() - started) };
          }
        }
        // Resolve at the actual physical launch, after context preparation; recheck the installed binary.
        let resolved;
        try { resolved = await installer.prepareBound(id, native.signal); assertCurrent(); }
        catch (error) { return { ok: false, stdout: "", code: null, timedOut: false,
          runtimeFailure: runtimeFailureMessage({ ...installer.failureContext(id),
            kind: runtimeProxyFailure(error) ? "runtime_proxy" : "runtime_failed", elapsedMs: 0 }) }; }
        const recordSuccessfulUse = installer.captureSuccessfulUse(id, resolved.command);
        const stages = workspaceRunRuntimeStages(permit);
        try { stages?.setRuntime({ id, version: installer.list().options.find(row => row.runtimeId === id)?.version ?? null,
          loginSource: resolved.loginSource, model, effort }); } catch { /* Metadata is diagnostic only. */ }
        const observer = createRuntimeStageProcessObserver(stages, id, native.signal);
        const tracker = runtimeFailureTracker(installer, id, permit.binding.agent.agentId,
          JSON.stringify([resolved.command, resolved.loginSource, resolved.env.HOME, resolved.proxyUrl, permit.binding.agent.configRevision, model, effort]), resolved, permit.binding.sessionId);
        const held = tracker.blocked();
        if (held) return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: held };
        const started = Date.now();
        const env: NodeJS.ProcessEnv = { ...resolved.env, ...endpoint.env,
          HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(","),
          ...(id === "claude" ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_AGENT_VIEW: "1" } : {}) };
        const serverName = "hara_workspace_" + createHash("sha256").update(permit.binding.sessionId).digest("hex").slice(0, 24);
        const args = registeredCliArgs({ id, claudeStreamJson: id === "claude", permissionTier: workspaceRunPermissionTier(permit), prompt, cwd: options.ctx.cwd, model, effort,
          skipGitRepoCheck: workspaceRunHasManagedProject(permit) && !existsSync(join(options.ctx.cwd, ".git")),
          hostToolOverrides: id === "codex" && resolved.loginSource === "host" && resolved.env.HOME
            ? codexHostToolOverrides(resolved.env.HOME, resolved.env.CODEX_HOME, options.ctx.cwd, serverName) : [],
          mcp: { serverName, url: endpoint.url, timeoutMs: Number(options.timeoutMs) || 120_000 } });
        const policy = newWorkspaceNativePolicy(permit, id, resolved, installer);
        try {
          const launch = policy.wrap({ command: resolved.command, env, args });
          if (id === "claude") launch.env = claudeRuntimeEnvironment(launch.env, policy.tempRoot);
          const result = await runExternalCommandCapture(launch, launch.args, {
            cwd: options.ctx.cwd, signal: native.signal, waitForClose: true, governedDeadline: permit.binding.budget.mode === "interactive", failureKind: "runtime", captureErrorFirstLine: true, proxyUrl: resolved.proxyUrl, timeoutMs: Number(options.timeoutMs) || 120_000,
            maxOutputBytes: 2 * 1024 * 1024, onSpawn: observer.onSpawn,
            onStdout: chunk => { observer.onStdout(chunk); activity(); }, retainStdoutOnFailure: true,
          });

          // Codex may deliver a terminal error frame with a zero exit. Classify only the error frame,
          // never model prose, and discard all native output on this path.
          let eventFailure: string | undefined;
          const claude = id === "claude" ? parseClaudeCliOutput(result.stdout, event => policy.observeNativeEvent(event)) : null;
          if (claude && !claude.ok) eventFailure = claude.error;
          observer.finish(result.ok && (claude?.ok ?? true), result.errorCode, Boolean((claude?.text ?? result.stdout).trim()));
          if (id === "codex") for (const line of result.stdout.split(/\r?\n/u)) {
            try {
              const event = JSON.parse(line);
              if (event.item) observeWorkspaceNativeItem(permit, policy, event.item, "completed");
              if (event.type === "turn.completed") eventFailure = undefined;
              else if (event.type === "error" || event.type === "turn.failed") {
                eventFailure = JSON.stringify(event.error ?? event.message ?? {}).slice(0, 64 * 1024);
              }
            } catch { /* text-mode fixtures and older CLIs remain supported */ }
          }
          if (!result.ok || eventFailure !== undefined) {
            if (native.signal.aborted || result.errorCode === "interrupted") return { ...result, ok: false, stdout: "", errorCode: "interrupted" };
            const kind = classifyRuntimeFailure({ code: eventFailure !== undefined && result.errorCode === "runtime_failed" ? undefined : result.errorCode,
              stderr: eventFailure, timedOut: result.timedOut });
            return { ...result, ok: false, stdout: "", runtimeFailure: tracker.failed(kind, Date.now() - started, result.errorFirstLine) };
          }
          tracker.succeeded();
          if (result.ok && !native.signal.aborted && runtimeUseProtocolSucceeded(id, result.stdout)) successfulUse = recordSuccessfulUse;
          return { ...result, stdout: redactToolSubprocessOutput(claude?.text ?? result.stdout, env) };
        } finally { observer.finish(false); delete env[WORKSPACE_MCP_TOKEN_ENV]; await endWorkspaceNativePolicy(permit, policy); await policy.close(); }
      },
    });
    try {
      attachWorkspaceRuntimeModel(permit, options, id, async args => {
        const result = await native.turn(args);
        return session?.needsNewSession ? { ...result, errorMsg: "Native context limit reached. Open a new session to continue.",
          errorMetadata: { code: "native_context_limit" } } : result;
      });
      const outcome = await runGovernedAgent(history, options, id, (provider, args) => provider.turn(args));
      if (outcome.status === "completed" && !options.signal?.aborted && successfulUse) { assertCurrent(); successfulUse(); }
      return session?.needsNewSession && !options.signal?.aborted
        ? { status: "halted", stopReason: "native_context_limit", error: "Native context limit reached. Open a new session to continue." } : outcome;
    } finally {
      try { await native.close(history); }
      finally { if (session) { try { recordWorkspaceRuntimeUsage(permit, session.takeUsage()); } finally { await session.release(); } } }
    }
  } };
}
