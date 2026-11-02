import { existsSync } from "node:fs";
import { join } from "node:path";
import { runExternalCommandCapture } from "../external-sessions/process.js";
import type { RunOpts, RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { assertWorkspaceRunAdmission, beginWorkspaceGovernedRun, prepareWorkspaceRunHistory, workspaceRunHasManagedProject } from "../workspace/execution.js";

/**
 * Hara does not probe a CLI's flag surface, so the launch only forwards a level that the Workspace's own
 * live inventory declared for the selected model. The level therefore comes from what the provider
 * published, never from a Hara-side guess, and a model without published levels never gets a flag.
 */
function codexEffortArgs(effort: string | null): string[] {
  // `-c key=value` is parsed as TOML; a bare identifier is a valid TOML string only when quoted.
  return effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : [];
}
function claudeEffortArgs(effort: string | null): string[] {
  return effort ? ["--effort", effort] : [];
}

/** The exact bounded launch vector for a registered CLI. Exported so the no-write/no-shell
 * confinement and the model/effort projection can be asserted without spawning a provider. */
export function registeredCliArgs(input: {
  id: "codex" | "claude"; prompt: string; cwd: string; model: string | null; effort: string | null; skipGitRepoCheck: boolean;
}): string[] {
  return input.id === "codex"
    ? ["exec", input.prompt, "--cd", input.cwd, ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      ...(input.model ? ["-m", input.model] : []), ...codexEffortArgs(input.effort), "--sandbox", "read-only"]
    : ["-p", input.prompt, "--output-format", "text", ...(input.model ? ["--model", input.model] : []),
      ...claudeEffortArgs(input.effort), "--permission-mode", "plan"];
}

/** Native CLIs are confined to read-only/plan mode until a separate host-mediated tool bridge exists.
 * Binding a Runtime does not grant a CLI arbitrary write or shell authority. */
export function registeredCliDriver(id: "codex" | "claude", installer: WorkspaceRuntimeInstaller,
  models?: WorkspaceRuntimeModels): GovernedAgentRuntimeDriver {
  return { id, async run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome> {
    const permit = options.workspaceRun;
    if (!permit || permit.binding.agent.runtimeId !== id || permit.binding.agent.taskId !== binding.taskId) {
      return { status: "error", error: `Agent Runtime '${id}' requires its exact Workspace run permit` };
    }
    assertWorkspaceRunAdmission(permit, options, id);
    if (options.signal?.aborted) return { status: "error", error: "Agent Runtime execution cancelled" };
    // Resolve immediately before spawn; the installer rechecks the registered path and fingerprint.
    const { command, env } = installer.resolveBound(id);
    const selection = models?.selection(id);
    const model = selection?.modelId ?? null;
    const effort = selection?.effort ?? null;
    // Claude's `--effort` is version-dependent. A stored level must not be forwarded to a binary that
    // dropped the flag; the failure is explicit rather than a silently weaker run.
    if (effort && models && !(await models.effortLaunchable(id))) {
      return { status: "error", error: `Agent Runtime '${id}' does not support reasoning effort; no level was applied` };
    }
    beginWorkspaceGovernedRun(permit, options, id);
    const projected = prepareWorkspaceRunHistory(permit, history);
    const prompt = [options.systemOverride ?? "", ...projected.map(message => message.role === "user" ? `User: ${message.content}`
      : message.role === "assistant" ? `Assistant: ${message.text}` : "")].filter(Boolean).join("\n\n");
    if (!prompt.trim() || prompt.length > 200_000 || projected.some(message => message.role === "user" && message.images?.length)) {
      return { status: "error", error: "Native Agent Runtime context is unsupported or too large" };
    }
    const args = registeredCliArgs({ id, prompt, cwd: options.ctx.cwd, model: model ?? null, effort,
      skipGitRepoCheck: workspaceRunHasManagedProject(permit) && !existsSync(join(options.ctx.cwd, ".git")) });
    const result = await runExternalCommandCapture({ command, env }, args, {
      cwd: options.ctx.cwd, signal: options.signal, failureKind: "registered-cli", timeoutMs: Number(options.timeoutMs) || 120_000, maxOutputBytes: 2 * 1024 * 1024,
    });
    if (!result.ok) return { status: "error", error: `${id} Runtime failed (${result.errorCode ?? (result.timedOut ? "timeout" : "exit")}); no fallback was selected` };
    if (!result.stdout.trim()) return { status: "empty" };
    history.push({ role: "assistant", text: result.stdout.trim(), toolUses: [] });
    return { status: "completed" };
  } };
}
