import { homedir } from "node:os";
import { runAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskExecution } from "../session/task.js";
import { AgentRuntimeBindingStore, freezeTaskRuntimeBinding } from "./bindings.js";
import { AgentRuntimeRegistry } from "./registry.js";
import { WORKSPACE_AGENT_EXECUTION_PENDING } from "../workspace/agent-binding.js";
import { assertWorkspaceRunAdmission } from "../workspace/execution.js";

/** Called only when a trusted host creates a NEW task. Old unfinished tasks without provenance keep
 * Hara; never infer their engine from today's Agent preference or a model/imported persona field. */
export function bindNewAgentTask(
  task: TaskExecution, spaceId: string, agentRef: string, home?: string, workspaceOptions?: RunOpts,
): TaskExecution {
  if (task.workspaceAgentBinding !== undefined || task.workspaceRunBinding !== undefined) {
    if (!workspaceOptions?.workspaceRun || workspaceOptions.taskIntake?.task !== task) throw new Error(WORKSPACE_AGENT_EXECUTION_PENDING);
    assertWorkspaceRunAdmission(workspaceOptions.workspaceRun, workspaceOptions, "pi");
    return task;
  }
  if (task.runtimeBinding !== undefined) throw new Error("new task already has a Runtime binding");
  const binding = spaceId === "personal" ? new AgentRuntimeBindingStore(home ?? homedir()).read(spaceId, agentRef)
    : { version: 1 as const, spaceId, agentRef, runtimeId: "hara" as const, revision: 0 };
  new AgentRuntimeRegistry().assertAvailable(binding.runtimeId);
  return { ...task, runtimeBinding: freezeTaskRuntimeBinding(binding, task.id) };
}

/** Shared CLI/TUI/headless dispatch, also used by gateway/cron's existing CLI subprocess transport.
 * The selected kernel is exact; read-only helpers with no persistent task retain legacy Hara. */
export function runConfiguredAgent(history: NeutralMsg[], options: RunOpts, registry = new AgentRuntimeRegistry()): Promise<RunOutcome> {
  const task = options.taskIntake?.current?.() ?? options.taskIntake?.task;
  if (options.workspaceRun !== undefined || task?.workspaceRunBinding !== undefined || options.taskIntake?.task.workspaceRunBinding !== undefined
    || task?.workspaceAgentBinding !== undefined || options.taskIntake?.task.workspaceAgentBinding !== undefined) {
    if (!options.workspaceRun) return Promise.resolve({ status: "error", error: WORKSPACE_AGENT_EXECUTION_PENDING });
    try { return registry.runWorkspace(history, options); }
    catch (error) { return Promise.resolve({ status: "error", error: error instanceof Error ? error.message : "Workspace admission refused" }); }
  }
  if (task?.runtimeBinding === undefined) return runAgent(history, options);
  return new AgentRuntimeRegistry().run(history, options, task.runtimeBinding);
}
