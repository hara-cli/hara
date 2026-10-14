import { runAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import { AGENT_RUNTIME_IDS, isTaskRuntimeBinding, type AgentRuntimeId, type TaskRuntimeBinding } from "./bindings.js";

/** Host-owned code only. Imported persona text and renderer fields cannot register a driver or grant
 * tools. New drivers must implement the same Hara admission, approval, cancellation and recovery rules. */
export interface GovernedAgentRuntimeDriver {
  id: AgentRuntimeId;
  run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome>;
}

export interface AgentRuntimeOption {
  id: AgentRuntimeId;
  label: string;
  available: boolean;
  reason?: "general_agent_adapter_pending";
  /** Product direction only; never used to silently substitute an execution Runtime. */
  recommended: boolean;
}

const LABELS: Record<AgentRuntimeId, string> = {
  hara: "Hara（現有相容引擎）", pi: "Pi（內建）", opencode: "OpenCode", codex: "Codex", claude: "Claude Code",
};

export class AgentRuntimeRegistry {
  private readonly drivers = new Map<AgentRuntimeId, GovernedAgentRuntimeDriver>();

  constructor(drivers: readonly GovernedAgentRuntimeDriver[] = [{ id: "hara", run: runAgent }]) {
    for (const driver of drivers) {
      if (!AGENT_RUNTIME_IDS.includes(driver.id) || this.drivers.has(driver.id) || typeof driver.run !== "function") {
        throw new Error("invalid or duplicate governed Agent Runtime driver");
      }
      this.drivers.set(driver.id, { id: driver.id, run: driver.run.bind(driver) });
    }
  }

  options(): AgentRuntimeOption[] {
    return AGENT_RUNTIME_IDS.map((id) => ({ id, label: LABELS[id], available: this.drivers.has(id),
      ...(!this.drivers.has(id) ? { reason: "general_agent_adapter_pending" as const } : {}), recommended: id === "pi" }));
  }

  assertAvailable(id: AgentRuntimeId): void {
    if (!this.drivers.has(id)) throw new Error(`Agent Runtime '${id}' is not available for general Agents; no fallback was selected`);
  }

  run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome> {
    if (!isTaskRuntimeBinding(binding) || options.ctx.spaceId !== binding.spaceId
      || (options.taskIntake?.current?.() ?? options.taskIntake?.task)?.id !== binding.taskId) throw new Error("Agent Runtime execution binding does not match this task audience");
    this.assertAvailable(binding.runtimeId);
    if (options.signal?.aborted) throw new Error("Agent Runtime execution was cancelled before dispatch");
    // Never read the current Agent preference here. Editing it cannot retarget a task already in flight.
    return this.drivers.get(binding.runtimeId)!.run(history, options, Object.freeze({ ...binding }));
  }
}
