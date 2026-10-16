import { homedir } from "node:os";
import { runAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskExecution } from "../session/task.js";
import { AgentRuntimeBindingStore, freezeTaskRuntimeBinding } from "./bindings.js";
import { AgentRuntimeRegistry } from "./registry.js";
import { WORKSPACE_AGENT_EXECUTION_PENDING } from "../workspace/agent-binding.js";

/** Called only when a trusted host creates a NEW task. Old unfinished tasks without provenance keep
 * Hara; never infer their engine from today's Agent preference or a model/imported persona field. */
export function bindNewAgentTask(
  task: TaskExecution, spaceId: string, agentRef: string, home = homedir(),
): TaskExecution {
  if (task.workspaceAgentBinding !== undefined) throw new Error(WORKSPACE_AGENT_EXECUTION_PENDING);
  if (task.runtimeBinding !== undefined) throw new Error("new task already has a Runtime binding");
  const binding = spaceId === "personal" ? new AgentRuntimeBindingStore(home).read(spaceId, agentRef)
    : { version: 1 as const, spaceId, agentRef, runtimeId: "hara" as const, revision: 0 };
  new AgentRuntimeRegistry().assertAvailable(binding.runtimeId);
  return { ...task, runtimeBinding: freezeTaskRuntimeBinding(binding, task.id) };
}

/** Shared CLI/TUI/headless dispatch, also used by gateway/cron's existing CLI subprocess transport.
 * The selected kernel is exact; read-only helpers with no persistent task retain legacy Hara. */
export function runConfiguredAgent(history: NeutralMsg[], options: RunOpts): Promise<RunOutcome> {
  const task = options.taskIntake?.current?.() ?? options.taskIntake?.task;
  if (task?.workspaceAgentBinding !== undefined || options.taskIntake?.task.workspaceAgentBinding !== undefined) {
    return Promise.resolve({ status: "error", error: WORKSPACE_AGENT_EXECUTION_PENDING });
  }
  if (task?.runtimeBinding === undefined) return runAgent(history, options);
  return new AgentRuntimeRegistry().run(history, options, task.runtimeBinding);
}
