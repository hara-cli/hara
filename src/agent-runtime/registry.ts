import { runAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import { runPiAgent } from "./pi.js";
import type { NeutralMsg } from "../providers/types.js";
import { AGENT_RUNTIME_IDS, freezeTaskRuntimeBinding, isTaskRuntimeBinding, type AgentRuntimeId, type TaskRuntimeBinding } from "./bindings.js";
import { WORKSPACE_AGENT_EXECUTION_PENDING } from "../workspace/agent-binding.js";
import { assertWorkspaceRunAdmission } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { registeredCliDriver } from "./registered-cli.js";

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
  reason?: "general_agent_adapter_pending" | "adapter_pending_p05" | "not_registered" | "not_installed" | "integrity_failed";
  /** Product direction only; never used to silently substitute an execution Runtime. */
  recommended: boolean;
}

const LABELS: Record<AgentRuntimeId, string> = {
  hara: "Hara（現有相容引擎）", pi: "Pi（內建）", opencode: "OpenCode", codex: "Codex", claude: "Claude Code", agy: "Antigravity",
};

export class AgentRuntimeRegistry {
  private readonly drivers = new Map<AgentRuntimeId, GovernedAgentRuntimeDriver>();

  constructor(drivers?: readonly GovernedAgentRuntimeDriver[], private readonly installer?: WorkspaceRuntimeInstaller,
    models?: WorkspaceRuntimeModels) {
    const selected = drivers ?? [{ id: "hara", run: runAgent }, { id: "pi", run: runPiAgent }];
    for (const driver of [...selected, ...(installer ? [registeredCliDriver("codex", installer, models), registeredCliDriver("claude", installer, models)] : [])]) {
      if (!AGENT_RUNTIME_IDS.includes(driver.id) || this.drivers.has(driver.id) || typeof driver.run !== "function") {
        throw new Error("invalid or duplicate governed Agent Runtime driver");
      }
      this.drivers.set(driver.id, { id: driver.id, run: driver.run.bind(driver) });
    }
  }

  options(): AgentRuntimeOption[] {
    const installed = this.installer?.list().options;
    return AGENT_RUNTIME_IDS.map(id => {
      const row = installed?.find(option => option.runtimeId === id);
      const driver = this.drivers.has(id);
      const available = id === "opencode" || id === "agy" ? false
        : id === "codex" || id === "claude" ? Boolean(driver && row?.generalAgentDriverAvailable) : driver;
      const reason = available ? undefined : id === "opencode" ? "adapter_pending_p05" : id === "agy" ? "general_agent_adapter_pending"
        : row?.state === "integrity_failed" ? "integrity_failed"
        : row?.state === "not_installed" ? "not_installed"
        : row?.state === "detected" || !row ? "not_registered" : "general_agent_adapter_pending";
      return { id, label: LABELS[id], available, ...(reason ? { reason: reason as AgentRuntimeOption["reason"] } : {}), recommended: id === "pi" };
    });
  }

  assertAvailable(id: AgentRuntimeId): void {
    if (!this.options().some(row => row.id === id && row.available)) throw new Error(`Agent Runtime '${id}' is not available for general Agents; no fallback was selected`);
  }

  /** Separate trusted entry: no legacy TaskRuntimeBinding or personal/org Space substitution. */
  runWorkspace(history: NeutralMsg[], options: RunOpts): Promise<RunOutcome> {
    if (!options.workspaceRun) throw new Error(WORKSPACE_AGENT_EXECUTION_PENDING);
    const runtimeId = options.workspaceRun.binding.agent.runtimeId;
    assertWorkspaceRunAdmission(options.workspaceRun, options, runtimeId);
    this.assertAvailable(runtimeId);
    if (runtimeId === "pi") return runPiAgent(history, options);
    if (runtimeId === "hara") return runAgent(history, options);
    const agent = options.workspaceRun.binding.agent;
    const binding = freezeTaskRuntimeBinding({ version: 1, spaceId: "personal", agentRef: "main", runtimeId,
      revision: agent.configRevision }, agent.taskId);
    return this.drivers.get(runtimeId)!.run(history, options, binding);
  }

  run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome> {
    if (options.workspaceRun !== undefined || options.taskIntake?.task.workspaceRunBinding !== undefined || options.taskIntake?.current?.()?.workspaceRunBinding !== undefined
      || options.taskIntake?.task.workspaceAgentBinding !== undefined
      || options.taskIntake?.current?.()?.workspaceAgentBinding !== undefined) {
      if (!options.workspaceRun) throw new Error(WORKSPACE_AGENT_EXECUTION_PENDING);
      return this.runWorkspace(history, options);
    }
    if (!isTaskRuntimeBinding(binding) || options.ctx.spaceId !== binding.spaceId
      || (options.taskIntake?.current?.() ?? options.taskIntake?.task)?.id !== binding.taskId) throw new Error("Agent Runtime execution binding does not match this task audience");
    this.assertAvailable(binding.runtimeId);
    if (options.signal?.aborted) throw new Error("Agent Runtime execution was cancelled before dispatch");
    // Never read the current Agent preference here. Editing it cannot retarget a task already in flight.
    return this.drivers.get(binding.runtimeId)!.run(history, options, Object.freeze({ ...binding }));
  }
}
