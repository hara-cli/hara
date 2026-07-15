import { randomUUID } from "node:crypto";
import type { RunOutcome } from "../agent/loop.js";
import type { Todo } from "../tools/todo.js";

export const TASK_SCHEMA_VERSION = 1;
export const MAX_TASK_OBJECTIVE_CHARS = 4096;
export const MAX_TASK_STEERING_CHARS = 4096;
export const MAX_TASK_STEERING_ENTRIES = 24;

export type TaskExecutionStatus = "running" | "paused" | "completed" | "blocked";
export type TaskInteraction =
  | { kind: "turn"; turnId: string }
  | { kind: "steer"; turnId: string; expectedTurnId: string };

export interface TaskSteering {
  id: string;
  turnId: string;
  content: string;
  createdAt: string;
}

/** Durable execution state. It intentionally lives beside, not inside, conversation history. */
export interface TaskExecution {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  id: string;
  /** The request that created the task. Later chat/steering must not silently replace it. */
  objective: string;
  status: TaskExecutionStatus;
  /** Current or most recently completed turn within this task. */
  turnId: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
  lastOutcome?: RunOutcome["status"] | "interrupted";
  /** Bounded audit trail; full user messages remain in the transcript. */
  steering?: TaskSteering[];
}

function iso(at: Date | string = new Date()): string {
  return typeof at === "string" ? at : at.toISOString();
}

function boundedText(value: string, max: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return (normalized || "(image-only task)").slice(0, max);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 220 && !/[\\/\0]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function newTurnInteraction(): Extract<TaskInteraction, { kind: "turn" }> {
  return { kind: "turn", turnId: randomUUID() };
}

export function newSteerInteraction(expectedTurnId: string): Extract<TaskInteraction, { kind: "steer" }> {
  return { kind: "steer", expectedTurnId, turnId: randomUUID() };
}

export function createTaskExecution(objective: string, turnId: string, at: Date | string = new Date()): TaskExecution {
  const now = iso(at);
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: randomUUID(),
    objective: boundedText(objective, MAX_TASK_OBJECTIVE_CHARS),
    status: "running",
    turnId,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
}

export function continueTaskExecution(
  task: TaskExecution | undefined,
  interaction: Extract<TaskInteraction, { kind: "steer" }>,
  at: Date | string = new Date(),
): { ok: true; task: TaskExecution } | { ok: false; reason: string } {
  if (!task) return { ok: false, reason: "there is no task to steer" };
  if (task.turnId !== interaction.expectedTurnId) {
    return { ok: false, reason: `stale steer for turn ${interaction.expectedTurnId}; active turn is ${task.turnId}` };
  }
  const now = iso(at);
  return {
    ok: true,
    task: {
      ...task,
      status: "running",
      turnId: interaction.turnId,
      updatedAt: now,
      startedAt: now,
      endedAt: undefined,
      lastOutcome: undefined,
    },
  };
}

export function recordTaskSteering(
  task: TaskExecution | undefined,
  expectedTurnId: string,
  content: string,
  at: Date | string = new Date(),
): { ok: true; task: TaskExecution } | { ok: false; reason: string } {
  if (!task) return { ok: false, reason: "there is no running task to steer" };
  if (task.status !== "running") return { ok: false, reason: `task ${task.id} is ${task.status}, not running` };
  if (task.turnId !== expectedTurnId) {
    return { ok: false, reason: `stale steer for turn ${expectedTurnId}; active turn is ${task.turnId}` };
  }
  const now = iso(at);
  const steering = [
    ...(task.steering ?? []),
    { id: randomUUID(), turnId: expectedTurnId, content: boundedText(content, MAX_TASK_STEERING_CHARS), createdAt: now },
  ].slice(-MAX_TASK_STEERING_ENTRIES);
  return { ok: true, task: { ...task, steering, updatedAt: now } };
}

export function finishTaskExecution(
  task: TaskExecution | undefined,
  outcome: RunOutcome | undefined,
  todos: Todo[] = [],
  interrupted = false,
  at: Date | string = new Date(),
): TaskExecution | undefined {
  if (!task) return undefined;
  const now = iso(at);
  const incomplete = todos.some((todo) => todo.status !== "done");
  const lastOutcome = interrupted ? "interrupted" : (outcome?.status ?? "interrupted");
  const status: TaskExecutionStatus = interrupted
    ? "paused"
    : outcome?.status === "completed"
      ? (incomplete ? "paused" : "completed")
      : outcome?.status === "error" || outcome?.status === "empty" || outcome?.status === "halted"
        ? "blocked"
        : "paused";
  return { ...task, status, lastOutcome, updatedAt: now, endedAt: now };
}

/** A process died while this task was running. Recovery is explicit and never claims success. */
export function recoverTaskExecution(task: TaskExecution | undefined, at: Date | string = new Date()): TaskExecution | undefined {
  if (!task || task.status !== "running") return task;
  const now = iso(at);
  return { ...task, status: "paused", lastOutcome: "interrupted", updatedAt: now, endedAt: now };
}

export function forkTaskExecution(task: TaskExecution | undefined, at: Date | string = new Date()): TaskExecution | undefined {
  if (!task) return undefined;
  const now = iso(at);
  return {
    ...task,
    id: randomUUID(),
    status: "paused",
    turnId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: now,
    lastOutcome: "interrupted",
    steering: task.steering?.slice(-MAX_TASK_STEERING_ENTRIES).map((entry) => ({ ...entry })),
  };
}

export function taskExecutionContext(task: TaskExecution, interaction: TaskInteraction): string {
  const steeringNote = interaction.kind === "steer"
    ? "This interaction steers the existing task. Refine execution without replacing its objective."
    : "This interaction created a new task.";
  return [
    "# Task execution (authoritative; separate from conversation history)",
    `Task ID: ${task.id}`,
    `Turn ID: ${task.turnId}`,
    `Objective: ${task.objective}`,
    `Interaction: ${interaction.kind}`,
    steeringNote,
    "Conversation messages provide evidence and refinements, but the task objective above remains authoritative until an explicit new task starts.",
  ].join("\n");
}

export function formatTaskExecution(task: TaskExecution | undefined): string {
  if (!task) return "(no task state)";
  return [
    `task ${task.id.slice(0, 8)} · ${task.status}`,
    `turn ${task.turnId.slice(0, 8)} · outcome ${task.lastOutcome ?? "running"}`,
    `objective: ${task.objective}`,
    `steering: ${task.steering?.length ?? 0}`,
  ].join("\n");
}

export function isTaskExecution(value: unknown): value is TaskExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (
    task.schemaVersion !== TASK_SCHEMA_VERSION ||
    !validId(task.id) ||
    typeof task.objective !== "string" || task.objective.length === 0 || task.objective.length > MAX_TASK_OBJECTIVE_CHARS ||
    (task.status !== "running" && task.status !== "paused" && task.status !== "completed" && task.status !== "blocked") ||
    !validId(task.turnId) ||
    !validTimestamp(task.createdAt) || !validTimestamp(task.updatedAt) || !validTimestamp(task.startedAt) ||
    (task.endedAt !== undefined && !validTimestamp(task.endedAt)) ||
    (task.lastOutcome !== undefined && task.lastOutcome !== "completed" && task.lastOutcome !== "error" && task.lastOutcome !== "empty" && task.lastOutcome !== "halted" && task.lastOutcome !== "interrupted")
  ) return false;
  if (task.steering === undefined) return true;
  if (!Array.isArray(task.steering) || task.steering.length > MAX_TASK_STEERING_ENTRIES) return false;
  return task.steering.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const steering = entry as Record<string, unknown>;
    return validId(steering.id) && validId(steering.turnId) &&
      typeof steering.content === "string" && steering.content.length > 0 && steering.content.length <= MAX_TASK_STEERING_CHARS &&
      validTimestamp(steering.createdAt);
  });
}
