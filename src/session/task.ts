import { randomUUID } from "node:crypto";
import type { RunOutcome } from "../agent/loop.js";
import type { Todo } from "../tools/todo.js";

export const TASK_SCHEMA_VERSION = 1;
export const MAX_TASK_OBJECTIVE_CHARS = 4096;
export const MAX_TASK_STEERING_CHARS = 24_000;
export const MAX_TASK_STEERING_ENTRIES = 24;
export const MAX_TASK_BRIEF_GOAL_CHARS = 2_000;
export const MAX_TASK_BRIEF_LIST_ENTRIES = 12;
export const MAX_TASK_BRIEF_ITEM_CHARS = 800;

export type TaskExecutionStatus = "running" | "paused" | "completed" | "blocked";
export type TaskIntent = "answer" | "investigate" | "change";
export type TaskInteraction =
  | { kind: "turn"; turnId: string }
  | { kind: "steer"; turnId: string; expectedTurnId: string };

/** Model-authored understanding checkpoint. The raw user request remains `objective`; this brief records
 * the interpreted goal and proof of completion before side effects begin. */
export interface TaskBrief {
  intent: TaskIntent;
  goal: string;
  constraints: string[];
  acceptance: string[];
  steps: string[];
  createdAt: string;
}

export interface TaskSteering {
  id: string;
  turnId: string;
  content: string;
  createdAt: string;
  /** New entries are a durable inbox until copied into conversation history. Missing means a legacy
   *  audit-only entry from before delivery tracking existed, so old sessions are never replayed. */
  deliveryState?: "pending" | "consumed";
  consumedAt?: string;
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
  /** Present once the model has explicitly understood this execution. Required before side effects. */
  brief?: TaskBrief;
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

function boundedList(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) return [fallback];
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => boundedText(item, MAX_TASK_BRIEF_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TASK_BRIEF_LIST_ENTRIES);
  return out.length ? out : [fallback];
}

function validBriefList(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_TASK_BRIEF_LIST_ENTRIES &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_TASK_BRIEF_ITEM_CHARS);
}

export function newTurnInteraction(): Extract<TaskInteraction, { kind: "turn" }> {
  return { kind: "turn", turnId: randomUUID() };
}

export function newSteerInteraction(expectedTurnId: string): Extract<TaskInteraction, { kind: "steer" }> {
  return { kind: "steer", expectedTurnId, turnId: randomUUID() };
}

export interface RoutedTaskInteraction {
  interaction: TaskInteraction;
  /** A type-ahead message raced with the end of the UI operation it targeted. There is no executable
   * task left to steer, so the input must fall forward into a normal turn instead of being rejected or
   * dropped. This mirrors Codex's NoActiveTurn race recovery at the conversation boundary. */
  recoveredMissingTask: boolean;
}

/** Resolve a UI-delivery hint against authoritative task state. `steer` is never itself proof that an
 * executable task is running: controls also occupy the composer briefly, and a real turn may finish between
 * enqueue and dequeue. Preserve the submitted turn id but promote late input to a new turn. Only an explicit
 * continuation path may opt into reopening a paused/completed task; stale live-turn ids remain hard errors
 * in `continueTaskExecution`. */
export function routeTaskInteraction(
  task: TaskExecution | undefined,
  interaction: TaskInteraction,
  options: { allowInactive?: boolean } = {},
): RoutedTaskInteraction {
  const steerable = !!task && (task.status === "running" || options.allowInactive === true);
  if (interaction.kind !== "steer" || steerable) return { interaction, recoveredMissingTask: false };
  return {
    interaction: { kind: "turn", turnId: interaction.turnId },
    recoveredMissingTask: true,
  };
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

export interface TaskBriefInput {
  intent?: unknown;
  goal?: unknown;
  constraints?: unknown;
  acceptance?: unknown;
  steps?: unknown;
}

/** Attach or revise the explicit understanding checkpoint. Revision is intentional: steering may add a
 * constraint or convert an investigation into an approved change, while the original request remains intact. */
export function applyTaskBrief(
  task: TaskExecution | undefined,
  input: TaskBriefInput,
  at: Date | string = new Date(),
): { ok: true; task: TaskExecution; brief: TaskBrief } | { ok: false; reason: string } {
  if (!task) return { ok: false, reason: "there is no task to brief" };
  if (task.status !== "running") return { ok: false, reason: `task ${task.id} is ${task.status}, not running` };
  const intent = input.intent;
  if (intent !== "answer" && intent !== "investigate" && intent !== "change") {
    return { ok: false, reason: "intent must be answer, investigate, or change" };
  }
  if (typeof input.goal !== "string" || !input.goal.trim()) {
    return { ok: false, reason: "goal must be a non-empty string" };
  }
  const now = iso(at);
  const brief: TaskBrief = {
    intent,
    goal: boundedText(input.goal, MAX_TASK_BRIEF_GOAL_CHARS),
    constraints: boundedList(input.constraints, "preserve unrelated user work and stated boundaries"),
    acceptance: boundedList(input.acceptance, intent === "change" ? "the requested change is verified" : "the answer is supported by relevant evidence"),
    steps: boundedList(input.steps, intent === "change" ? "inspect, change, and verify" : "inspect and report"),
    createdAt: now,
  };
  return {
    ok: true,
    brief,
    task: { ...task, brief, updatedAt: now },
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
  const normalized = content.replace(/\r\n?/g, "\n").trim() || "(image-only steering)";
  if (normalized.length > MAX_TASK_STEERING_CHARS) {
    return { ok: false, reason: `steering input is too large (${normalized.length} chars; maximum ${MAX_TASK_STEERING_CHARS})` };
  }
  const now = iso(at);
  const steering: TaskSteering[] = [
    ...(task.steering ?? []),
    {
      id: randomUUID(),
      turnId: expectedTurnId,
      content: normalized,
      createdAt: now,
      deliveryState: "pending",
    },
  ];
  // Never silently evict accepted-but-undelivered input. Prefer dropping the oldest consumed/legacy audit
  // entry; if all slots are pending, apply backpressure and let the caller surface a retryable queue-full
  // error instead of acknowledging data that cannot be retained.
  if (steering.length > MAX_TASK_STEERING_ENTRIES) {
    const removable = steering.findIndex((entry) => entry.deliveryState !== "pending");
    if (removable < 0) return { ok: false, reason: `task steering inbox is full (${MAX_TASK_STEERING_ENTRIES}); wait for the running turn to consume it` };
    steering.splice(removable, 1);
  }
  return { ok: true, task: { ...task, steering, updatedAt: now } };
}

export interface ConsumedTaskSteering {
  task: TaskExecution;
  entries: TaskSteering[];
}

/** Mark every accepted inbox entry consumed in one immutable transition. Callers persist the projected
 *  transcript plus this returned task before exposing the messages to the agent loop, making delivery
 *  crash-safe and exactly-once. Legacy entries without deliveryState remain audit-only. */
export function consumePendingTaskSteering(
  task: TaskExecution | undefined,
  at: Date | string = new Date(),
): ConsumedTaskSteering | null {
  if (!task?.steering?.some((entry) => entry.deliveryState === "pending")) return null;
  const now = iso(at);
  const entries = task.steering.filter((entry) => entry.deliveryState === "pending").map((entry) => ({ ...entry }));
  const steering = task.steering.map((entry) => entry.deliveryState === "pending"
    ? { ...entry, deliveryState: "consumed" as const, consumedAt: now }
    : entry);
  return { task: { ...task, steering, updatedAt: now }, entries };
}

export function hasPendingTaskSteering(task: TaskExecution | undefined): boolean {
  return !!task?.steering?.some((entry) => entry.deliveryState === "pending");
}

/** Idle messages start a new task by default. Only an explicit continuation phrase resumes an unfinished
 *  execution, matching Codex's separation between steering an active turn and starting the next task. */
export function requestsTaskContinuation(text: string): boolean {
  const value = text.trim().toLocaleLowerCase();
  if (!value) return false;
  return /^(?:\/continue(?:\s|$)|(?:continue|resume|go\s+on)(?:[\s,.:;!?，。：；！？]|$)|(?:继续|接着|接着做|继续处理)(?:[\s,.:;!?，。：；！？]|$))/.test(value);
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
      : outcome?.status === "halted" && outcome.stopReason === "deadline"
        ? "paused"
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
    // A fork copies audit context, never ownership of an executable inbox item. Pending steering remains
    // pending only in the source session; replaying it in both branches would violate exactly-once delivery.
    steering: task.steering?.slice(-MAX_TASK_STEERING_ENTRIES).map((entry) => entry.deliveryState === "pending"
      ? { ...entry, deliveryState: "consumed", consumedAt: now }
      : { ...entry }),
  };
}

export function taskExecutionContext(task: TaskExecution, interaction: TaskInteraction, todos: Todo[] = []): string {
  const steeringNote = interaction.kind === "steer"
    ? "This interaction steers the existing task. Refine execution without replacing its objective."
    : "This interaction created a new task.";
  const lines = [
    "# Task execution (authoritative; separate from conversation history)",
    `Task ID: ${task.id}`,
    `Turn ID: ${task.turnId}`,
    `Objective: ${task.objective}`,
    `Interaction: ${interaction.kind}`,
    steeringNote,
    "Conversation messages provide evidence and refinements, but the task objective above remains authoritative until an explicit new task starts.",
  ];
  // The accepted brief is deliberately absent here. `taskExecutionContext` is the stable per-interaction
  // identity/recovery snapshot, while runAgent composes the current brief dynamically on every model round.
  // Duplicating it here would leave the pre-run version in the prompt after a mid-run task_intake revision.
  if (todos.length) {
    lines.push(
      "## Persisted execution checkpoint",
      ...todos.slice(0, 24).map((todo) => {
        const mark = todo.status === "done" ? "done" : todo.status === "in_progress" ? "in progress" : "pending";
        return `- [${mark}] ${todo.text.replace(/\s+/g, " ").trim().slice(0, 240)}`;
      }),
    );
    if (todos.length > 24) lines.push(`- … ${todos.length - 24} additional item(s) omitted; call todo_write to inspect/update the full list.`);
    lines.push("Treat this checklist as the recovery cursor: continue from the first unfinished item, verify current workspace state, and update it as work changes.");
  }
  return lines.join("\n");
}

export function formatTaskExecution(task: TaskExecution | undefined): string {
  if (!task) return "(no task state)";
  return [
    `task ${task.id.slice(0, 8)} · ${task.status}`,
    `turn ${task.turnId.slice(0, 8)} · outcome ${task.lastOutcome ?? "running"}`,
    `objective: ${task.objective}`,
    `brief: ${task.brief ? `${task.brief.intent} · ${task.brief.goal}` : "(not accepted yet)"}`,
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
  if (task.brief !== undefined) {
    if (!task.brief || typeof task.brief !== "object" || Array.isArray(task.brief)) return false;
    const brief = task.brief as Record<string, unknown>;
    if (
      (brief.intent !== "answer" && brief.intent !== "investigate" && brief.intent !== "change") ||
      typeof brief.goal !== "string" || brief.goal.length === 0 || brief.goal.length > MAX_TASK_BRIEF_GOAL_CHARS ||
      !validBriefList(brief.constraints) ||
      !validBriefList(brief.acceptance) ||
      !validBriefList(brief.steps) ||
      !validTimestamp(brief.createdAt)
    ) return false;
  }
  if (task.steering === undefined) return true;
  if (!Array.isArray(task.steering) || task.steering.length > MAX_TASK_STEERING_ENTRIES) return false;
  return task.steering.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const steering = entry as Record<string, unknown>;
    const deliveryValid = steering.deliveryState === undefined
      ? steering.consumedAt === undefined
      : steering.deliveryState === "pending"
        ? steering.consumedAt === undefined
        : steering.deliveryState === "consumed" && validTimestamp(steering.consumedAt);
    return validId(steering.id) && validId(steering.turnId) &&
      typeof steering.content === "string" && steering.content.length > 0 && steering.content.length <= MAX_TASK_STEERING_CHARS &&
      validTimestamp(steering.createdAt) && deliveryValid;
  });
}
