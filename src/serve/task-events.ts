import type { TaskExecution, TaskExecutionStatus } from "../session/task.js";
import type { Todo } from "../tools/todo.js";

export const TASK_LIFECYCLE_EVENT_VERSION = 1;

export type TaskLifecycleState = TaskExecutionStatus | "waiting";
export type TaskLifecyclePhase =
  | "restored"
  | "starting"
  | "thinking"
  | "responding"
  | "tool"
  | "approval"
  | "checkpoint"
  | "steering"
  | "stopping"
  | "finished";

export interface TaskLifecycleActivity {
  state?: TaskLifecycleState;
  phase: TaskLifecyclePhase;
  detail?: string;
  approval?: {
    id: string;
    question: string;
  };
}

export interface TaskLifecycleEvent {
  version: typeof TASK_LIFECYCLE_EVENT_VERSION;
  sessionId: string;
  taskId: string;
  turnId: string;
  objective: string;
  state: TaskLifecycleState;
  /** Durable task status. It remains `running` while the runtime state is temporarily `waiting`. */
  taskStatus: TaskExecutionStatus;
  phase: TaskLifecyclePhase;
  at: string;
  updatedAt: string;
  lastOutcome?: TaskExecution["lastOutcome"];
  brief?: {
    intent: NonNullable<TaskExecution["brief"]>["intent"];
    goal: string;
  };
  checkpoint: {
    done: number;
    total: number;
    current?: string;
    owner?: string;
  };
  detail?: string;
  approval?: {
    id: string;
    question: string;
  };
}

function bounded(value: string | undefined, max: number): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

/** Build the single task-state shape consumed by Desktop, IDE clients, and the companion. Conversation
 * streaming remains separate; this event is the authoritative execution/status plane. */
export function taskLifecycleEvent(
  sessionId: string,
  task: TaskExecution,
  todos: Todo[] = [],
  activity: TaskLifecycleActivity,
  at = new Date().toISOString(),
): TaskLifecycleEvent {
  const current = todos.find((todo) => todo.status === "in_progress")
    ?? todos.find((todo) => todo.status === "pending");
  const detail = bounded(activity.detail, 500);
  const approval = activity.approval
    ? {
        id: activity.approval.id,
        question: bounded(activity.approval.question, 4_000) ?? "Approval required",
      }
    : undefined;
  // Runtime phases may only refine an actively running task. Once durable state reaches a terminal or
  // resumable boundary, a late notification cannot visually resurrect it as running/waiting.
  const state = task.status === "running"
    ? (activity.state ?? task.status)
    : task.status;
  return {
    version: TASK_LIFECYCLE_EVENT_VERSION,
    sessionId,
    taskId: task.id,
    turnId: task.turnId,
    objective: task.objective,
    state,
    taskStatus: task.status,
    phase: activity.phase,
    at,
    updatedAt: task.updatedAt,
    ...(task.lastOutcome ? { lastOutcome: task.lastOutcome } : {}),
    ...(task.brief ? { brief: { intent: task.brief.intent, goal: task.brief.goal } } : {}),
    checkpoint: {
      done: todos.filter((todo) => todo.status === "done").length,
      total: todos.length,
      ...(current ? { current: bounded(current.activeForm || current.text, 300) } : {}),
      ...(current?.owner ? { owner: bounded(current.owner, 120) } : {}),
    },
    ...(detail ? { detail } : {}),
    ...(approval ? { approval } : {}),
  };
}
