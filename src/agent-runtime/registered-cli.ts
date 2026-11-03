import { classifyRuntimeFailure, runtimeFailureMessage } from "./failure-diagnostics.js";
import { runtimeFailureTracker } from "./failure-tracker.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runExternalCommandCapture } from "../external-sessions/process.js";
import { runGovernedAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { assertWorkspaceRunAdmission, attachWorkspaceRuntimeModel, workspaceRunHasManagedProject } from "../workspace/execution.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { createRegisteredCliMcpTurn, WORKSPACE_MCP_TOKEN_ENV } from "./registered-cli-mcp.js";
import { codexHostToolOverrides } from "./codex-host-config.js";
import { runtimeProxyFailure } from "../security/runtime-proxy.js";

/** Only the level published by this Workspace's live model inventory may reach the native CLI. */
function codexEffortArgs(effort: string | null): string[] {
  return effort ? ["-c", "model_reasoning_effort=" + JSON.stringify(effort)] : [];
}
function claudeEffortArgs(effort: string | null): string[] { return effort ? ["--effort", effort] : []; }

/** Keep read-only/plan confinement. Only Hara's per-attempt MCP server is explicitly trusted:
 * its calls still yield to the canonical Hara governor and Desk approval, never to tool.run here. */
export function registeredCliArgs(input: {
  id: "codex" | "claude"; prompt: string; cwd: string; model: string | null; effort: string | null; skipGitRepoCheck: boolean;
  mcp?: { url: string; timeoutMs: number }; hostToolOverrides?: string[];
}): string[] {
  const bridge = input.mcp;
  const mcp = !bridge ? [] : input.id === "codex" ? [
    "-c", "mcp_servers.hara={}",
    "-c", "mcp_servers.hara.url=" + JSON.stringify(bridge.url),
    "-c", "mcp_servers.hara.bearer_token_env_var=" + JSON.stringify(WORKSPACE_MCP_TOKEN_ENV),
    "-c", 'mcp_servers.hara.default_tools_approval_mode="auto"',
    "-c", "mcp_servers.hara.required=true",
    "-c", "mcp_servers.hara.tool_timeout_sec=" + Math.ceil(bridge.timeoutMs / 1000),
    "-c", 'approval_policy="on-request"',
    "-c", 'shell_environment_policy.set.HARA_WORKSPACE_MCP_TOKEN=""', "--json",
  ] : ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { hara: { type: "http", url: bridge.url,
    headers: { Authorization: "Bearer $" + "{" + WORKSPACE_MCP_TOKEN_ENV + "}" }, timeout: bridge.timeoutMs } } }),
    "--allowedTools", "mcp__hara__*"];
  return input.id === "codex"
    ? ["exec", input.prompt, "--cd", input.cwd, ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      ...(input.model ? ["-m", input.model] : []), ...codexEffortArgs(input.effort), "--sandbox", "read-only",
      ...(bridge ? input.hostToolOverrides ?? [] : []), ...mcp]
    : ["-p", input.prompt, "--output-format", "text", ...(input.model ? ["--model", input.model] : []),
      ...claudeEffortArgs(input.effort), "--permission-mode", "plan", ...mcp];
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
    const native = createRegisteredCliMcpTurn({
      signal: options.signal!, assertCurrent, jsonEvents: id === "codex",
      async launch(endpoint, prompt, activity) {
        assertCurrent();
        // Resolve at the actual physical launch, after context preparation; recheck the installed binary.
        let resolved;
        try { resolved = await installer.prepareBound(id, native.signal); assertCurrent(); }
        catch (error) { return { ok: false, stdout: "", code: null, timedOut: false,
          runtimeFailure: runtimeFailureMessage({ ...installer.failureContext(id),
            kind: runtimeProxyFailure(error) ? "runtime_proxy" : "runtime_failed", elapsedMs: 0 }) }; }
        const tracker = runtimeFailureTracker(installer, id, permit.binding.agent.agentId,
          JSON.stringify([resolved.command, resolved.loginSource, resolved.env.HOME, resolved.proxyUrl, permit.binding.agent.configRevision, model, effort]), resolved);
        const held = tracker.blocked();
        if (held) return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: held };
        const started = Date.now();
        const env: NodeJS.ProcessEnv = { ...resolved.env, ...endpoint.env,
          HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
        const args = registeredCliArgs({ id, prompt, cwd: options.ctx.cwd, model, effort,
          skipGitRepoCheck: workspaceRunHasManagedProject(permit) && !existsSync(join(options.ctx.cwd, ".git")),
          hostToolOverrides: id === "codex" && resolved.loginSource === "host" && resolved.env.HOME
            ? codexHostToolOverrides(resolved.env.HOME) : [],
          mcp: { url: endpoint.url, timeoutMs: Number(options.timeoutMs) || 120_000 } });
        try {
          const result = await runExternalCommandCapture({ command: resolved.command, env }, args, {
            cwd: options.ctx.cwd, signal: native.signal, failureKind: "runtime", proxyUrl: resolved.proxyUrl, timeoutMs: Number(options.timeoutMs) || 120_000,
            maxOutputBytes: 2 * 1024 * 1024, onStdout: activity, retainStdoutOnFailure: id === "codex",
          });
          // Codex may deliver a terminal error frame with a zero exit. Classify only the error frame,
          // never model prose, and discard all native output on this path.
          let eventFailure: string | undefined;
          if (id === "codex") for (const line of result.stdout.split(/\r?\n/u)) {
            try {
              const event = JSON.parse(line);
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
            return { ...result, ok: false, stdout: "", runtimeFailure: tracker.failed(kind, Date.now() - started) };
          }
          tracker.succeeded();
          return { ...result, stdout: redactToolSubprocessOutput(result.stdout, env) };
        } finally { delete env[WORKSPACE_MCP_TOKEN_ENV]; }
      },
    });
    try {
      attachWorkspaceRuntimeModel(permit, options, id, args => native.turn(args));
      return await runGovernedAgent(history, options, id, (provider, args) => provider.turn(args));
    } finally { await native.close(history); }
  } };
}
