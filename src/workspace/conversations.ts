import type { NeutralMsg } from "../providers/types.js";
import { isTaskExecution, type TaskExecution } from "../session/task.js";
import { redactSensitiveValue } from "../security/secrets.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { workspaceRunMatchesTask } from "./run-binding.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { canonical, exact, plain, positive, UUID, WorkspaceJsonState } from "./local-state.js";

export type WorkspaceAttemptState = "running" | "draining" | "completed" | "cancelled" | "interrupted" | "blocked";
export interface WorkspaceAttempt {
  attemptId: string;
  fence: number;
  runId: string;
  state: WorkspaceAttemptState;
  startedAt: string;
  endedAt: string | null;
}
export interface WorkspaceUsage { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number }
export interface WorkspaceConversation {
  schemaVersion: 2;
  resourceBinding: WorkspaceResourceBinding;
  revision: number;
  sessionId: string;
  agentId: string;
  history: NeutralMsg[];
  task: TaskExecution | null;
  attempt: WorkspaceAttempt | null;
  usage: WorkspaceUsage;
  runUsage: WorkspaceUsage;
  pastTasks: { task: TaskExecution; usage: WorkspaceUsage; endedAt: string }[];
}
const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function usageValid(value: unknown): value is WorkspaceUsage {
  return plain(value) && exact(value, ["modelCalls", "toolCalls", "inputTokens", "outputTokens"])
    && Object.values(value).every(v => Number.isSafeInteger(v) && Number(v) >= 0);
}
function historyValid(value: unknown): value is NeutralMsg[] {
  if (!Array.isArray(value) || value.length > 4000) return false;
  return value.every(row => {
    if (!plain(row)) return false;
    if (row.role === "user") return exact(row, ["role", "content"]) && typeof row.content === "string" && row.content.length <= 24_000;
    if (row.role === "assistant") return Object.keys(row).every(key => ["role", "text", "toolUses", "continuation"].includes(key))
      && typeof row.text === "string" && row.text.length <= 200_000 && Array.isArray(row.toolUses) && row.toolUses.length <= 64
      && row.toolUses.every(use => plain(use) && typeof use.id === "string" && typeof use.name === "string" && plain(use.input));
    if (row.role === "tool") return exact(row, ["role", "results"]) && Array.isArray(row.results) && row.results.length <= 64
      && row.results.every(result => plain(result) && typeof result.id === "string" && typeof result.name === "string" && typeof result.content === "string"
        && Object.keys(result).every(key => ["id", "name", "content", "isError"].includes(key)));
    return false;
  });
}

/** New scoped history is intentionally not opened through legacy SessionHub/profile resume. */
export class WorkspaceConversationStore {
  private readonly state: WorkspaceJsonState<WorkspaceConversation>;
  readonly sessionId: string;
  constructor(storage: WorkspaceResourceStorage, readonly agentId: string) {
    if (!isWorkspaceAgentId(agentId)) throw new Error("invalid scoped conversation Agent");
    this.sessionId = agentId.slice(3); // one durable chat per stable Agent, independent of task/run IDs
    const binding = () => this.state.binding();
    this.state = new WorkspaceJsonState(storage, `conversation-${this.sessionId}.json`, value => {
      const fail = (): never => { throw new Error("invalid scoped conversation; history preserved and execution refused"); };
      if (!plain(value) || !exact(value, ["schemaVersion", "resourceBinding", "revision", "sessionId", "agentId", "history", "task", "attempt", "usage", "runUsage", "pastTasks"])
        || value.schemaVersion !== 2 || !positive(value.revision) || value.sessionId !== this.sessionId || value.agentId !== agentId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, binding()) || !historyValid(value.history)
        || !usageValid(value.usage) || !usageValid(value.runUsage) || !Array.isArray(value.pastTasks) || value.pastTasks.length > 128) return fail();
      for (const archived of value.pastTasks) {
        if (!plain(archived) || !exact(archived, ["task", "usage", "endedAt"]) || !isTaskExecution(archived.task)
          || !workspaceRunMatchesTask(archived.task.workspaceRunBinding, archived.task)
          || !sameWorkspaceResourceBinding(archived.task.workspaceAgentBinding!.resourceBinding, binding())
          || archived.task.workspaceAgentBinding?.agentId !== agentId || archived.task.workspaceRunBinding?.sessionId !== this.sessionId
          || !usageValid(archived.usage) || !validTime(archived.endedAt)) return fail();
      }
      if (value.task !== null && (!isTaskExecution(value.task) || !workspaceRunMatchesTask(value.task.workspaceRunBinding, value.task)
        || !sameWorkspaceResourceBinding(value.task.workspaceAgentBinding!.resourceBinding, binding())
        || value.task.workspaceAgentBinding?.agentId !== agentId || value.task.workspaceRunBinding?.sessionId !== this.sessionId)) return fail();
      if (value.attempt !== null && (!plain(value.attempt)
        || !exact(value.attempt, ["attemptId", "fence", "runId", "state", "startedAt", "endedAt"])
        || typeof value.attempt.attemptId !== "string" || !UUID.test(value.attempt.attemptId) || !positive(value.attempt.fence)
        || !["running", "draining", "completed", "cancelled", "interrupted", "blocked"].includes(String(value.attempt.state))
        || !validTime(value.attempt.startedAt) || (value.attempt.endedAt !== null && !validTime(value.attempt.endedAt))
        || value.task === null || value.attempt.runId !== (value.task as TaskExecution).workspaceRunBinding?.runId)) return fail();
      return structuredClone(value) as unknown as WorkspaceConversation;
    }, () => ({ schemaVersion: 2, resourceBinding: binding(), revision: 0, sessionId: this.sessionId, agentId,
      history: [], task: null, attempt: null, usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 },
      runUsage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, pastTasks: [] }));
  }
  read(): WorkspaceConversation { return this.state.read(); }
  save(expectedRevision: number, value: WorkspaceConversation): WorkspaceConversation {
    if (value.sessionId !== this.sessionId || value.agentId !== this.agentId) throw new Error("conversation ownership cannot change");
    const safe = redactSensitiveValue(value).value;
    safe.resourceBinding = structuredClone(value.resourceBinding);
    if (value.task?.workspaceAgentBinding && safe.task) safe.task.workspaceAgentBinding = structuredClone(value.task.workspaceAgentBinding);
    if (value.task?.workspaceRunBinding && safe.task) safe.task.workspaceRunBinding = structuredClone(value.task.workspaceRunBinding);
    for (let index = 0; index < value.pastTasks.length; index++) {
      const task = value.pastTasks[index]!.task, target = safe.pastTasks[index]!.task;
      if (task.workspaceAgentBinding) target.workspaceAgentBinding = structuredClone(task.workspaceAgentBinding);
      if (task.workspaceRunBinding) target.workspaceRunBinding = structuredClone(task.workspaceRunBinding);
    }
    return this.state.update(expectedRevision, previous => {
      if (previous.attempt && value.attempt && value.attempt.fence < previous.attempt.fence) throw new Error("stale Workspace attempt fence");
      if (previous.attempt?.state === "running" && value.attempt?.attemptId !== previous.attempt.attemptId) throw new Error("running attempt must be recovered before replacement");
      if (previous.attempt && value.attempt?.attemptId !== previous.attempt.attemptId
        && (!value.attempt || value.attempt.fence <= previous.attempt.fence)) throw new Error("new Workspace attempt requires a higher fence");
      for (const key of Object.keys(previous.usage) as (keyof WorkspaceUsage)[]) {
        if (value.usage[key] < previous.usage[key]) throw new Error("Workspace cumulative usage cannot decrease");
        if (previous.task?.id === value.task?.id && value.runUsage[key] < previous.runUsage[key]) throw new Error("Workspace run budget cannot reset on resume");
      }
      if (previous.task && previous.task.id !== value.task?.id) {
        if (value.pastTasks.length !== previous.pastTasks.length + 1
          || canonical(value.pastTasks.slice(0, -1)) !== canonical(previous.pastTasks)
          || canonical(value.pastTasks.at(-1)?.task) !== canonical(previous.task)
          || canonical(value.pastTasks.at(-1)?.usage) !== canonical(previous.runUsage)) throw new Error("previous Workspace task must be archived atomically");
      } else if (canonical(value.pastTasks) !== canonical(previous.pastTasks)) throw new Error("retained Workspace task history cannot be rewritten");
      return safe;
    });
  }
}
