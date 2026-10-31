import { runExternalCommandCapture } from "../external-sessions/process.js";
import type { RunOpts, RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { assertWorkspaceRunAdmission, beginWorkspaceGovernedRun, prepareWorkspaceRunHistory } from "../workspace/execution.js";

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
    const model = models?.selected(id);
    beginWorkspaceGovernedRun(permit, options, id);
    const projected = prepareWorkspaceRunHistory(permit, history);
    const prompt = [options.systemOverride ?? "", ...projected.map(message => message.role === "user" ? `User: ${message.content}`
      : message.role === "assistant" ? `Assistant: ${message.text}` : "")].filter(Boolean).join("\n\n");
    if (!prompt.trim() || prompt.length > 200_000 || projected.some(message => message.role === "user" && message.images?.length)) {
      return { status: "error", error: "Native Agent Runtime context is unsupported or too large" };
    }
    const args = id === "codex" ? ["exec", prompt, "--cd", options.ctx.cwd, ...(model ? ["-m", model] : []), "--sandbox", "read-only"]
      : ["-p", prompt, "--output-format", "text", ...(model ? ["--model", model] : []), "--permission-mode", "plan"];
    const result = await runExternalCommandCapture({ command, env }, args, {
      cwd: options.ctx.cwd, signal: options.signal, timeoutMs: Number(options.timeoutMs) || 120_000, maxOutputBytes: 2 * 1024 * 1024,
    });
    if (!result.ok) return { status: "error", error: `${id} Runtime failed (${result.errorCode ?? (result.timedOut ? "timeout" : "exit")}); no fallback was selected` };
    if (!result.stdout.trim()) return { status: "empty" };
    history.push({ role: "assistant", text: result.stdout.trim(), toolUses: [] });
    return { status: "completed" };
  } };
}
