import { existsSync } from "node:fs";
import { join } from "node:path";
import { runExternalCommandCapture } from "../external-sessions/process.js";
import { runGovernedAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { assertWorkspaceRunAdmission, attachWorkspaceRuntimeModel, recordWorkspaceRuntimeUsage, workspaceRunHasManagedProject } from "../workspace/execution.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { createRegisteredCliMcpTurn, WORKSPACE_MCP_TOKEN_ENV } from "./registered-cli-mcp.js";
import { codexSessionPool } from "./codex-session.js";

/** Only the level published by this Workspace's live model inventory may reach the native CLI. */
function codexEffortArgs(effort: string | null): string[] {
  return effort ? ["-c", "model_reasoning_effort=" + JSON.stringify(effort)] : [];
}
function claudeEffortArgs(effort: string | null): string[] { return effort ? ["--effort", effort] : []; }

/** Keep read-only/plan confinement. Only Hara's per-attempt MCP server is explicitly trusted:
 * its calls still yield to the canonical Hara governor and Desk approval, never to tool.run here. */
export function registeredCliArgs(input: {
  id: "codex" | "claude"; prompt: string; cwd: string; model: string | null; effort: string | null; skipGitRepoCheck: boolean;
  mcp?: { url: string; timeoutMs: number };
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
      ...(input.model ? ["-m", input.model] : []), ...codexEffortArgs(input.effort), "--sandbox", "read-only", ...mcp]
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
    const selection = models?.selection(id), model = selection?.modelId ?? null, effort = selection?.effort ?? null;
    if (effort && models && !(await models.effortLaunchable(id))) {
      return { status: "error", error: "Agent Runtime '" + id + "' does not support reasoning effort; no level was applied" };
    }
    const session = id === "codex" ? await codexSessionPool(installer).acquire(permit, assertCurrent) : undefined;
    const native = createRegisteredCliMcpTurn({
      signal: options.signal!, assertCurrent, jsonEvents: id === "codex",
      ...(session ? { bearerToken: session.token,
        prompt: (args: import("../providers/types.js").TurnArgs) => args.history.flatMap(message => message.role === "user" ? [message.content] : []).join("\n\n"),
        takeUsage: () => session.takeUsage(), decorateResult: session.decorateResult.bind(session) } : {}),
      async launch(endpoint, prompt, activity, turnArgs) {
        assertCurrent();
        if (session) {
          if (turnArgs.system.length > 200_000) throw new Error("Native Agent Runtime system context is too large");
          return session.launch(endpoint, prompt, turnArgs, { model, effort, cwd: options.ctx.cwd, signal: native.signal, assertCurrent, activity });
        }
        // Resolve at the actual physical launch, after context preparation; recheck the installed binary.
        const resolved = installer.resolveBound(id);
        const env: NodeJS.ProcessEnv = { ...resolved.env, ...endpoint.env,
          HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
        const args = registeredCliArgs({ id, prompt, cwd: options.ctx.cwd, model, effort,
          skipGitRepoCheck: workspaceRunHasManagedProject(permit) && !existsSync(join(options.ctx.cwd, ".git")),
          mcp: { url: endpoint.url, timeoutMs: Number(options.timeoutMs) || 120_000 } });
        try {
          const result = await runExternalCommandCapture({ command: resolved.command, env }, args, {
            cwd: options.ctx.cwd, signal: native.signal, failureKind: "registered-cli", timeoutMs: Number(options.timeoutMs) || 120_000,
            maxOutputBytes: 2 * 1024 * 1024, onStdout: activity,
          });
          return { ...result, stdout: redactToolSubprocessOutput(result.stdout, env) };
        } finally { delete env[WORKSPACE_MCP_TOKEN_ENV]; }
      },
    });
    try {
      attachWorkspaceRuntimeModel(permit, options, id, async args => {
        const result = await native.turn(args);
        return session?.needsNewSession ? { ...result, errorMsg: "Native context limit reached. Open a new session to continue.",
          errorMetadata: { code: "native_context_limit" } } : result;
      });
      const outcome = await runGovernedAgent(history, options, id, (provider, args) => provider.turn(args));
      return session?.needsNewSession && !options.signal?.aborted
        ? { status: "halted", stopReason: "native_context_limit", error: "Native context limit reached. Open a new session to continue." } : outcome;
    } finally {
      try { await native.close(history); }
      finally { if (session) { try { recordWorkspaceRuntimeUsage(permit, session.takeUsage()); } finally { await session.release(); } } }
    }
  } };
}
