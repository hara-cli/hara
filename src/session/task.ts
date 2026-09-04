import { randomUUID } from "node:crypto";
import type { RunOutcome } from "../agent/loop.js";
import type { Todo } from "../tools/todo.js";
import { redactSensitiveText, requestsCredentialDisclosure } from "../security/secrets.js";

export const TASK_SCHEMA_VERSION = 1;
export const MAX_TASK_OBJECTIVE_CHARS = 4096;
export const MAX_TASK_STEERING_CHARS = 24_000;
export const MAX_TASK_STEERING_ENTRIES = 24;
export const MAX_TASK_BRIEF_GOAL_CHARS = 2_000;
export const MAX_TASK_BRIEF_LIST_ENTRIES = 12;
export const MAX_TASK_BRIEF_ITEM_CHARS = 800;
export const MAX_TASK_CHECKPOINT_STEP_CHARS = 800;
export const MAX_TASK_CHECKPOINT_ARTIFACTS = 32;
export const MAX_TASK_CHECKPOINT_ARTIFACT_CHARS = 1_000;
export const MAX_TASK_CHECKPOINT_FACTS = 64;
export const MAX_TASK_CHECKPOINT_CAPABILITIES = 32;
export const MAX_TASK_COMPLETION_EVIDENCE = 12;
export const MAX_TASK_DEPENDENCY_EVIDENCE = 8;
export const MAX_TASK_MANUAL_COMMAND_CHARS = 2_048;
export const MAX_TASK_VERIFY_COMMAND_CHARS = 2_048;
export const MAX_TASK_RESUME_PHRASE_CHARS = 500;
export const MAX_TASK_MANUAL_HINTS = 8;
export const MAX_TASK_MANUAL_HINT_TERM_CHARS = 80;
export const MAX_TASK_MANUAL_HINT_DETAIL_CHARS = 500;
export const MAX_TASK_STATE_KEY_CHARS = 120;
export const MAX_TASK_FACT_STRING_CHARS = 2_000;
export const MAX_TASK_EVIDENCE_CHARS = 1_000;
export const DEFAULT_TASK_ROUND_BUDGET = 100;
export const TASK_ROUND_CHECKPOINT_INTERVAL = 50;
export const MAX_TASK_ROUND_BUDGET = 1_000_000;

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
  /** Capabilities whose availability materially changes the approach (for example vision or computer
   * control). Core file/shell tools do not need to be listed. */
  requiredCapabilities?: string[];
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

export type TaskFactValue = string | number | boolean;
export type TaskCapabilityState = "available" | "unavailable" | "blocked" | "unknown";

export interface TaskFact {
  value: TaskFactValue;
  /** Concise observation that justified the latest value. Required when a prior value changes. */
  evidence?: string;
  updatedAt: string;
}

export interface TaskCapability {
  state: TaskCapabilityState;
  /** Concrete preflight result or blocker; never a private chain-of-thought explanation. */
  detail?: string;
  checkedAt: string;
}

export type TaskCompletionState = "verified" | "awaiting_user";
export type TaskUserDependencyKind =
  | "missing_secret"
  | "missing_authority"
  | "physical_action"
  | "material_choice"
  | "external_state"
  | "destructive_confirmation";

/** The only engine-recognized reasons an accepted action may be handed back to a human. A typed,
 * evidenced dependency prevents free-form model reluctance from masquerading as a real blocker. */
export interface TaskUserDependency {
  kind: TaskUserDependencyKind;
  detail: string;
  evidence: string[];
  capability?: string;
  manualAction?: {
    /** Display/copy only. Desktop never executes this command. Recognizable credentials are redacted. */
    command?: string;
    /** Optional copy-only command that proves the external action took effect. */
    verifyCommand?: string;
    /** Exact safe phrase the user can send after completing the external action. */
    resumePhrase?: string;
    hints?: Array<{ term: string; detail: string }>;
  };
}

/** Context compaction and bounded tool previews are Hara-owned continuation mechanics, not events that a
 * human can resolve. Models sometimes misclassify them as external state and ask the user to rerun a script
 * or paste output. Keep that invalid handoff out of durable task state regardless of provider behavior. */
function describesEngineRecoverableOutputBoundary(parts: readonly string[]): boolean {
  const text = parts.join("\n").toLowerCase();
  const namesEngineOutput = /(?:hara|tool(?:_|\s*)output|historical tool|read_file|tool_result_read|bash|python|工具输出|历史工具|文件内容|脚本输出|命令输出|读取文件)/u.test(text);
  const namesBoundedVisibility = /(?:truncat|chars? omitted|cut off|too long|cannot (?:read|see)|unable to (?:read|see)|incomplete output|截断|被截|省略|看不全|无法读取|不可见|不完整|过长)/u.test(text);
  return namesEngineOutput && namesBoundedVisibility;
}

/** Engine-readable completion receipt. Free-form assistant prose is never treated as proof that the accepted
 * brief succeeded. A verified task names observable evidence; a task waiting on the user names the exact
 * missing input without falsely entering the completed state. */
export interface TaskCompletion {
  state: TaskCompletionState;
  evidence: string[];
  waitingFor?: string;
  dependency?: TaskUserDependency;
  updatedAt: string;
}

/** Supplementary durable checkpoint. Canonical completed/pending steps remain SessionMeta.todos so there
 * is only one checklist to resume; this object stores the non-derivable cursor, blockers, outputs, facts,
 * and capability preflight used by progress UI and final synthesis. */
export interface TaskCheckpoint {
  currentStep?: string;
  blockedStep?: string;
  blockReason?: string;
  nextStep?: string;
  artifacts: string[];
  facts: Record<string, TaskFact>;
  capabilities: Record<string, TaskCapability>;
  completion?: TaskCompletion;
  updatedAt: string;
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
  /** Cumulative provider rounds across every run/continue within this execution. */
  roundsUsed?: number;
  /** Explicitly extended in 100-round tranches only when the user resumes at the current cap. */
  roundBudgetLimit?: number;
  /** Present once the model has explicitly understood this execution. Required before side effects. */
  brief?: TaskBrief;
  /** Structured state shared by resume, progress UI, and final synthesis. Optional only for v1 sessions
   * written before checkpoints were introduced. */
  checkpoint?: TaskCheckpoint;
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

function validRequiredCapabilities(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_TASK_CHECKPOINT_CAPABILITIES) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    const parsed = taskStateKey(item, "required capability");
    if (!parsed.ok || parsed.value !== item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
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
    roundsUsed: 0,
    roundBudgetLimit: DEFAULT_TASK_ROUND_BUDGET,
    checkpoint: {
      artifacts: [],
      facts: {},
      capabilities: {},
      updatedAt: now,
    },
  };
}

export interface TaskBriefInput {
  intent?: unknown;
  goal?: unknown;
  constraints?: unknown;
  acceptance?: unknown;
  steps?: unknown;
  required_capabilities?: unknown;
}

export interface TaskFactUpdateInput {
  key?: unknown;
  value?: unknown;
  evidence?: unknown;
  remove?: unknown;
}

export interface TaskCapabilityUpdateInput {
  name?: unknown;
  state?: unknown;
  detail?: unknown;
}

export interface TaskCheckpointInput {
  current_step?: unknown;
  blocked_step?: unknown;
  block_reason?: unknown;
  next_step?: unknown;
  artifacts?: unknown;
  facts?: unknown;
  capabilities?: unknown;
  completion?: unknown;
}

interface TaskCompletionInput {
  state?: unknown;
  evidence?: unknown;
  waiting_for?: unknown;
  dependency?: unknown;
}

interface TaskUserDependencyInput {
  kind?: unknown;
  detail?: unknown;
  evidence?: unknown;
  capability?: unknown;
  manual_action?: unknown;
}

interface TaskManualActionInput {
  command?: unknown;
  verify_command?: unknown;
  resume_phrase?: unknown;
  hints?: unknown;
}

function safeManualText(value: unknown, label: string, max: number): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false, reason: `${label} must be a string` };
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim();
  if (!normalized) return { ok: true };
  // The task event reaches a live renderer before durable session redaction. Apply the shared recognizer at
  // intake so even a model-authored copy command can never echo an observed credential into Desktop.
  return { ok: true, value: redactSensitiveText(normalized).text.slice(0, max) };
}

function manualActionInput(value: unknown):
  | { ok: true; value?: TaskUserDependency["manualAction"] }
  | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "dependency manual_action must be an object" };
  }
  const input = value as TaskManualActionInput;
  const command = safeManualText(input.command, "manual command", MAX_TASK_MANUAL_COMMAND_CHARS);
  if (!command.ok) return command;
  const verifyCommand = safeManualText(input.verify_command, "manual verification command", MAX_TASK_VERIFY_COMMAND_CHARS);
  if (!verifyCommand.ok) return verifyCommand;
  const resumePhrase = safeManualText(input.resume_phrase, "resume phrase", MAX_TASK_RESUME_PHRASE_CHARS);
  if (!resumePhrase.ok) return resumePhrase;
  if (input.hints !== undefined && !Array.isArray(input.hints)) {
    return { ok: false, reason: "manual action hints must be an array" };
  }
  const hints: Array<{ term: string; detail: string }> = [];
  for (const raw of input.hints ?? []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "every manual action hint must be an object" };
    }
    const item = raw as { term?: unknown; detail?: unknown };
    const term = safeManualText(item.term, "manual hint term", MAX_TASK_MANUAL_HINT_TERM_CHARS);
    if (!term.ok || !term.value) return { ok: false, reason: term.ok ? "manual hint term is required" : term.reason };
    const detail = safeManualText(item.detail, "manual hint detail", MAX_TASK_MANUAL_HINT_DETAIL_CHARS);
    if (!detail.ok || !detail.value) return { ok: false, reason: detail.ok ? "manual hint detail is required" : detail.reason };
    hints.push({ term: term.value, detail: detail.value });
    if (hints.length > MAX_TASK_MANUAL_HINTS) {
      return { ok: false, reason: `manual action hints cannot exceed ${MAX_TASK_MANUAL_HINTS} entries` };
    }
  }
  if (!command.value && !verifyCommand.value && !resumePhrase.value && hints.length === 0) {
    return { ok: false, reason: "manual_action must include a command, verify_command, resume_phrase, or hint" };
  }
  return {
    ok: true,
    value: {
      ...(command.value ? { command: command.value } : {}),
      ...(verifyCommand.value ? { verifyCommand: verifyCommand.value } : {}),
      ...(resumePhrase.value ? { resumePhrase: resumePhrase.value } : {}),
      ...(hints.length ? { hints } : {}),
    },
  };
}

function taskStateKey(value: unknown, label: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: `${label} must be a string` };
  const key = value.trim();
  if (!/^[a-z][a-z0-9_.-]*$/.test(key) || key.length > MAX_TASK_STATE_KEY_CHARS) {
    return {
      ok: false,
      reason: `${label} must use 1-${MAX_TASK_STATE_KEY_CHARS} lowercase letters, digits, dot, dash, or underscore and start with a letter`,
    };
  }
  return { ok: true, value: key };
}

function checkpointText(value: unknown, label: string): { ok: true; value?: string } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false, reason: `${label} must be a string` };
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return { ok: true, ...(normalized ? { value: normalized.slice(0, MAX_TASK_CHECKPOINT_STEP_CHARS) } : {}) };
}

function factValue(value: unknown): { ok: true; value: TaskFactValue } | { ok: false; reason: string } {
  if (typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
  if (typeof value === "string") return { ok: true, value: value.slice(0, MAX_TASK_FACT_STRING_CHARS) };
  return { ok: false, reason: "fact value must be a finite number, boolean, or string" };
}

function sameFactValue(left: TaskFactValue, right: TaskFactValue): boolean {
  return typeof left === typeof right && left === right;
}

function requiredCapabilityList(value: unknown): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "required_capabilities must be an array" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const parsed = taskStateKey(raw, "required capability");
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value)) continue;
    seen.add(parsed.value);
    out.push(parsed.value);
    if (out.length > MAX_TASK_CHECKPOINT_CAPABILITIES) {
      return { ok: false, reason: `required_capabilities cannot exceed ${MAX_TASK_CHECKPOINT_CAPABILITIES} entries` };
    }
  }
  return { ok: true, value: out };
}

function completionInput(
  value: unknown,
  at: string,
  capabilities: Record<string, TaskCapability>,
): { ok: true; value: TaskCompletion } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "completion must be an object" };
  }
  const input = value as TaskCompletionInput;
  if (input.state !== "verified" && input.state !== "awaiting_user") {
    return { ok: false, reason: "completion state must be verified or awaiting_user" };
  }
  if (!Array.isArray(input.evidence)) {
    return { ok: false, reason: "completion evidence must be an array of observed checks" };
  }
  const evidence: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.evidence) {
    if (typeof raw !== "string") return { ok: false, reason: "every completion evidence item must be a string" };
    const item = raw.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_EVIDENCE_CHARS);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    evidence.push(item);
    if (evidence.length > MAX_TASK_COMPLETION_EVIDENCE) {
      return { ok: false, reason: `completion evidence cannot exceed ${MAX_TASK_COMPLETION_EVIDENCE} entries` };
    }
  }
  const waitingFor = typeof input.waiting_for === "string"
    ? input.waiting_for.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_CHECKPOINT_STEP_CHARS)
    : "";
  if (input.waiting_for !== undefined && typeof input.waiting_for !== "string") {
    return { ok: false, reason: "completion waiting_for must be a string" };
  }
  if (input.state === "verified" && !evidence.length) {
    return { ok: false, reason: "verified completion requires at least one observable evidence item" };
  }
  if (input.state === "verified" && input.dependency !== undefined) {
    return { ok: false, reason: "verified completion cannot include a user dependency" };
  }
  let dependency: TaskUserDependency | undefined;
  if (input.state === "awaiting_user") {
    if (!evidence.length) {
      return { ok: false, reason: "awaiting_user completion requires observable evidence of the blocker" };
    }
    if (!input.dependency || typeof input.dependency !== "object" || Array.isArray(input.dependency)) {
      return {
        ok: false,
        reason: "awaiting_user requires a structured dependency; advice or model reluctance is not a user dependency",
      };
    }
    const raw = input.dependency as TaskUserDependencyInput;
    const allowedKinds = new Set<TaskUserDependencyKind>([
      "missing_secret",
      "missing_authority",
      "physical_action",
      "material_choice",
      "external_state",
      "destructive_confirmation",
    ]);
    if (typeof raw.kind !== "string" || !allowedKinds.has(raw.kind as TaskUserDependencyKind)) {
      return { ok: false, reason: "dependency kind is not an allowed human-only blocker" };
    }
    if (typeof raw.detail !== "string" || !raw.detail.trim()) {
      return { ok: false, reason: "dependency detail must name the exact human input or action required" };
    }
    const detail = raw.detail.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_CHECKPOINT_STEP_CHARS);
    if (waitingFor && waitingFor !== detail) {
      return { ok: false, reason: "deprecated waiting_for must match dependency.detail when both are supplied" };
    }
    if (!Array.isArray(raw.evidence)) {
      return { ok: false, reason: "dependency evidence must be an array of observed facts" };
    }
    const dependencyEvidence: string[] = [];
    const dependencySeen = new Set<string>();
    for (const item of raw.evidence) {
      if (typeof item !== "string") return { ok: false, reason: "every dependency evidence item must be a string" };
      const normalized = item.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_EVIDENCE_CHARS);
      if (!normalized || dependencySeen.has(normalized)) continue;
      dependencySeen.add(normalized);
      dependencyEvidence.push(normalized);
      if (dependencyEvidence.length > MAX_TASK_DEPENDENCY_EVIDENCE) {
        return { ok: false, reason: `dependency evidence cannot exceed ${MAX_TASK_DEPENDENCY_EVIDENCE} entries` };
      }
    }
    if (!dependencyEvidence.length) {
      return { ok: false, reason: "dependency requires at least one observed evidence item" };
    }
    if (describesEngineRecoverableOutputBoundary([detail, ...evidence, ...dependencyEvidence])) {
      return {
        ok: false,
        reason:
          "tool/history output truncation is engine-recoverable, not a human-only dependency; " +
          "use a narrow grep/read_file offset+limit request or tool_result_read instead of asking the user to rerun or paste output",
      };
    }
    let capability: string | undefined;
    if (raw.capability !== undefined) {
      const parsedCapability = taskStateKey(raw.capability, "dependency capability");
      if (!parsedCapability.ok) return parsedCapability;
      capability = parsedCapability.value;
      const observed = capabilities[capability];
      if (!observed || (observed.state !== "blocked" && observed.state !== "unavailable")) {
        return {
          ok: false,
          reason: `dependency capability '${capability}' must first be checkpointed as blocked or unavailable`,
        };
      }
    }
    if ((raw.kind === "missing_secret" || raw.kind === "missing_authority") && !capability) {
      return { ok: false, reason: `${raw.kind} dependency requires the blocked/unavailable capability name` };
    }
    const manualAction = manualActionInput(raw.manual_action);
    if (!manualAction.ok) return manualAction;
    const handoffText = [
      detail,
      manualAction.value?.command,
      manualAction.value?.verifyCommand,
      manualAction.value?.resumePhrase,
      ...(manualAction.value?.hints ?? []).flatMap((hint) => [hint.term, hint.detail]),
    ].filter((part): part is string => typeof part === "string").join("\n");
    if (requestsCredentialDisclosure(handoffText)) {
      return {
        ok: false,
        reason:
          "a user dependency must not ask the user to paste or send credentials into chat; use a registered trusted login/provider surface or an exported file that contains no account access data",
      };
    }
    dependency = {
      kind: raw.kind as TaskUserDependencyKind,
      detail,
      evidence: dependencyEvidence,
      ...(capability ? { capability } : {}),
      ...(manualAction.value ? { manualAction: manualAction.value } : {}),
    };
  }
  return {
    ok: true,
    value: {
      state: input.state,
      evidence,
      ...(dependency ? { waitingFor: dependency.detail, dependency } : {}),
      updatedAt: at,
    },
  };
}

/** Atomically update the task's shared factual/capability checkpoint. A changed fact or capability needs
 * fresh evidence so the engine cannot silently overwrite an earlier conclusion and later contradict it. */
export function applyTaskCheckpoint(
  task: TaskExecution | undefined,
  input: TaskCheckpointInput,
  at: Date | string = new Date(),
): { ok: true; task: TaskExecution; checkpoint: TaskCheckpoint; changes: string[] } | { ok: false; reason: string } {
  if (!task) return { ok: false, reason: "there is no task to checkpoint" };
  if (task.status !== "running") return { ok: false, reason: `task ${task.id} is ${task.status}, not running` };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "checkpoint input must be an object" };
  }
  const now = iso(at);
  const prior = task.checkpoint ?? {
    artifacts: [],
    facts: {},
    capabilities: {},
    updatedAt: task.updatedAt,
  };
  const next: TaskCheckpoint = {
    ...prior,
    artifacts: [...prior.artifacts],
    facts: { ...prior.facts },
    capabilities: { ...prior.capabilities },
    updatedAt: now,
  };
  const changes: string[] = [];

  for (const [field, label] of [
    ["current_step", "current_step"],
    ["blocked_step", "blocked_step"],
    ["block_reason", "block_reason"],
    ["next_step", "next_step"],
  ] as const) {
    if (!(field in input)) continue;
    const parsed = checkpointText(input[field], label);
    if (!parsed.ok) return parsed;
    const target = field === "current_step"
      ? "currentStep"
      : field === "blocked_step"
        ? "blockedStep"
        : field === "block_reason"
          ? "blockReason"
          : "nextStep";
    if (parsed.value) next[target] = parsed.value;
    else delete next[target];
    changes.push(label);
  }
  if ("blocked_step" in input && !next.blockedStep) delete next.blockReason;
  if (next.blockReason && !next.blockedStep) {
    return { ok: false, reason: "block_reason requires blocked_step; clear both when the blocker is resolved" };
  }
  if (next.blockedStep && !next.blockReason) {
    return { ok: false, reason: "blocked_step requires a non-empty block_reason" };
  }

  if (input.artifacts !== undefined) {
    if (!Array.isArray(input.artifacts)) return { ok: false, reason: "artifacts must be an array of strings" };
    const artifacts: string[] = [];
    const seen = new Set<string>();
    for (const raw of input.artifacts) {
      if (typeof raw !== "string") return { ok: false, reason: "every artifact must be a string" };
      const artifact = raw.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_CHECKPOINT_ARTIFACT_CHARS);
      if (!artifact || seen.has(artifact)) continue;
      seen.add(artifact);
      artifacts.push(artifact);
      if (artifacts.length > MAX_TASK_CHECKPOINT_ARTIFACTS) {
        return { ok: false, reason: `artifacts cannot exceed ${MAX_TASK_CHECKPOINT_ARTIFACTS} entries` };
      }
    }
    next.artifacts = artifacts;
    changes.push("artifacts");
  }

  if (input.facts !== undefined) {
    if (!Array.isArray(input.facts)) return { ok: false, reason: "facts must be an array of keyed updates" };
    const seen = new Set<string>();
    for (const raw of input.facts as TaskFactUpdateInput[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "every fact update must be an object" };
      const parsedKey = taskStateKey(raw.key, "fact key");
      if (!parsedKey.ok) return parsedKey;
      const key = parsedKey.value;
      if (seen.has(key)) return { ok: false, reason: `fact '${key}' appears more than once in one checkpoint` };
      seen.add(key);
      if (raw.evidence !== undefined && typeof raw.evidence !== "string") {
        return { ok: false, reason: `fact '${key}' evidence must be a string` };
      }
      const evidence = typeof raw.evidence === "string"
        ? raw.evidence.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_EVIDENCE_CHARS)
        : undefined;
      const existing = Object.prototype.hasOwnProperty.call(next.facts, key) ? next.facts[key] : undefined;
      if (raw.remove === true) {
        if (existing && !evidence) {
          return { ok: false, reason: `fact '${key}' removal requires fresh evidence` };
        }
        delete next.facts[key];
        continue;
      }
      const parsedValue = factValue(raw.value);
      if (!parsedValue.ok) return { ok: false, reason: `fact '${key}': ${parsedValue.reason}` };
      if (existing && !sameFactValue(existing.value, parsedValue.value) && !evidence) {
        return { ok: false, reason: `fact '${key}' changed value; provide fresh evidence for the revision` };
      }
      next.facts[key] = {
        value: parsedValue.value,
        ...(evidence ? { evidence } : existing?.evidence ? { evidence: existing.evidence } : {}),
        updatedAt: now,
      };
    }
    if (Object.keys(next.facts).length > MAX_TASK_CHECKPOINT_FACTS) {
      return { ok: false, reason: `fact table cannot exceed ${MAX_TASK_CHECKPOINT_FACTS} entries` };
    }
    changes.push("facts");
  }

  if (input.capabilities !== undefined) {
    if (!Array.isArray(input.capabilities)) return { ok: false, reason: "capabilities must be an array of preflight results" };
    const seen = new Set<string>();
    for (const raw of input.capabilities as TaskCapabilityUpdateInput[]) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "every capability update must be an object" };
      const parsedName = taskStateKey(raw.name, "capability name");
      if (!parsedName.ok) return parsedName;
      const name = parsedName.value;
      if (seen.has(name)) return { ok: false, reason: `capability '${name}' appears more than once in one checkpoint` };
      seen.add(name);
      const state = raw.state;
      if (state !== "available" && state !== "unavailable" && state !== "blocked" && state !== "unknown") {
        return { ok: false, reason: `capability '${name}' state must be available, unavailable, blocked, or unknown` };
      }
      if (raw.detail !== undefined && typeof raw.detail !== "string") {
        return { ok: false, reason: `capability '${name}' detail must be a string` };
      }
      const detail = typeof raw.detail === "string"
        ? raw.detail.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_EVIDENCE_CHARS)
        : undefined;
      const existing = Object.prototype.hasOwnProperty.call(next.capabilities, name) ? next.capabilities[name] : undefined;
      if (existing && existing.state !== state && !detail) {
        return { ok: false, reason: `capability '${name}' changed state; provide fresh detail for the revision` };
      }
      next.capabilities[name] = {
        state,
        ...(detail ? { detail } : existing?.detail ? { detail: existing.detail } : {}),
        checkedAt: now,
      };
    }
    if (Object.keys(next.capabilities).length > MAX_TASK_CHECKPOINT_CAPABILITIES) {
      return { ok: false, reason: `capability table cannot exceed ${MAX_TASK_CHECKPOINT_CAPABILITIES} entries` };
    }
    changes.push("capabilities");
  }

  if (input.completion !== undefined) {
    const parsed = completionInput(input.completion, now, next.capabilities);
    if (!parsed.ok) return parsed;
    if (parsed.value.state === "verified" && (next.blockedStep || next.blockReason)) {
      return {
        ok: false,
        reason: "verified completion cannot retain a blocker; clear blocked_step and block_reason in the same checkpoint",
      };
    }
    next.completion = parsed.value;
    if (parsed.value.state === "awaiting_user") {
      next.blockedStep ??= next.currentStep ?? "complete the accepted task";
      next.blockReason ??= parsed.value.waitingFor;
      next.nextStep ??= `Continue after the user provides: ${parsed.value.waitingFor}`;
    }
    changes.push("completion");
  } else if (changes.length && next.completion) {
    // Any later state mutation invalidates an earlier receipt unless the caller explicitly re-attests in
    // the same atomic checkpoint. This prevents stale success from surviving newly discovered evidence.
    delete next.completion;
    changes.push("completion invalidated");
  }

  if (!changes.length) return { ok: false, reason: "checkpoint must update at least one field" };
  return {
    ok: true,
    checkpoint: next,
    changes,
    task: { ...task, checkpoint: next, updatedAt: now },
  };
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
  const requiredCapabilities = requiredCapabilityList(input.required_capabilities);
  if (!requiredCapabilities.ok) return requiredCapabilities;
  const now = iso(at);
  const brief: TaskBrief = {
    intent,
    goal: boundedText(input.goal, MAX_TASK_BRIEF_GOAL_CHARS),
    constraints: boundedList(input.constraints, "preserve unrelated user work and stated boundaries"),
    acceptance: boundedList(input.acceptance, intent === "change" ? "the requested change is verified" : "the answer is supported by relevant evidence"),
    steps: boundedList(input.steps, intent === "change" ? "inspect, change, and verify" : "inspect and report"),
    ...(requiredCapabilities.value.length ? { requiredCapabilities: requiredCapabilities.value } : {}),
    createdAt: now,
  };
  const checkpoint = task.checkpoint
    ? { ...task.checkpoint, completion: undefined, updatedAt: now }
    : task.checkpoint;
  return {
    ok: true,
    brief,
    task: { ...task, brief, ...(checkpoint ? { checkpoint } : {}), updatedAt: now },
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
  const budget = taskRoundBudget(task);
  const roundBudgetLimit = budget.used >= budget.limit
    ? Math.min(MAX_TASK_ROUND_BUDGET, budget.limit + DEFAULT_TASK_ROUND_BUDGET)
    : budget.limit;
  return {
    ok: true,
    task: {
      ...task,
      ...(task.checkpoint
        ? { checkpoint: { ...task.checkpoint, completion: undefined, updatedAt: now } }
        : {}),
      status: "running",
      turnId: interaction.turnId,
      updatedAt: now,
      startedAt: now,
      endedAt: undefined,
      lastOutcome: undefined,
      roundsUsed: budget.used,
      roundBudgetLimit,
    },
  };
}

export function taskRoundBudget(task: TaskExecution): { used: number; limit: number; checkpointAt: number } {
  const used = Number.isSafeInteger(task.roundsUsed) && (task.roundsUsed ?? -1) >= 0
    ? task.roundsUsed!
    : 0;
  const storedLimit = Number.isSafeInteger(task.roundBudgetLimit)
    && (task.roundBudgetLimit ?? 0) >= DEFAULT_TASK_ROUND_BUDGET
    ? task.roundBudgetLimit!
    : DEFAULT_TASK_ROUND_BUDGET;
  const limit = storedLimit;
  return {
    used,
    limit,
    checkpointAt: Math.max(0, limit - TASK_ROUND_CHECKPOINT_INTERVAL),
  };
}

/** Persist one closed run's provider-round usage without changing task completion semantics. */
export function recordTaskRoundUsage(
  task: TaskExecution,
  rounds: number,
  at: Date | string = new Date(),
): TaskExecution {
  if (!Number.isSafeInteger(rounds) || rounds <= 0) return task;
  const budget = taskRoundBudget(task);
  return {
    ...task,
    roundsUsed: Math.min(budget.limit, budget.used + rounds),
    roundBudgetLimit: budget.limit,
    updatedAt: iso(at),
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
  return /^(?:\/continue(?:\s|$)|(?:continue|resume|go\s+on)(?:[\s,.:;!?，。：；！？]|$)|(?:继续|接着|接着做|继续处理|重新执行|现在去执行任务)(?:[\s,.:;!?，。：；！？]|$))/.test(value);
}

/** A receipt is authoritative only for the current execution tranche and the latest accepted brief. */
export function freshTaskCompletion(task: TaskExecution | undefined): TaskCompletion | undefined {
  const completion = task?.checkpoint?.completion;
  if (!task || !completion) return undefined;
  if (Date.parse(completion.updatedAt) < Date.parse(task.startedAt)) return undefined;
  if (task.brief && Date.parse(completion.updatedAt) < Date.parse(task.brief.createdAt)) return undefined;
  return completion;
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
  const completion = freshTaskCompletion(task);
  const completionIsFresh = Boolean(completion);
  const acceptedBriefVerified = !task.brief
    || (completionIsFresh && completion?.state === "verified");
  const lastOutcome = interrupted ? "interrupted" : (outcome?.status ?? "interrupted");
  const status: TaskExecutionStatus = interrupted
    ? "paused"
    : outcome?.status === "completed"
      ? (incomplete || !acceptedBriefVerified ? "paused" : "completed")
      : outcome?.status === "halted" && (
          outcome.stopReason === "deadline"
          || outcome.stopReason === "task_round_budget"
          || outcome.stopReason === "max_rounds"
          || outcome.stopReason === "strategy_stall"
        )
        ? "paused"
      : outcome?.status === "error" || outcome?.status === "empty" || outcome?.status === "halted"
        ? "blocked"
        : "paused";
  const current = todos.find((todo) => todo.status === "in_progress")
    ?? todos.find((todo) => todo.status === "pending");
  const prior = task.checkpoint ?? {
    artifacts: [],
    facts: {},
    capabilities: {},
    updatedAt: task.updatedAt,
  };
  const checkpoint: TaskCheckpoint = {
    ...prior,
    artifacts: [...prior.artifacts],
    facts: { ...prior.facts },
    capabilities: { ...prior.capabilities },
    updatedAt: now,
  };
  if (status === "completed") {
    delete checkpoint.currentStep;
    delete checkpoint.blockedStep;
    delete checkpoint.blockReason;
    delete checkpoint.nextStep;
  } else if (current) {
    checkpoint.currentStep = boundedText(current.activeForm || current.text, MAX_TASK_CHECKPOINT_STEP_CHARS);
    checkpoint.nextStep ??= boundedText(current.text, MAX_TASK_CHECKPOINT_STEP_CHARS);
  } else if (outcome?.status === "completed" && task.brief && !acceptedBriefVerified) {
    if (completionIsFresh && completion?.state === "awaiting_user") {
      checkpoint.blockedStep ??= "complete the accepted task";
      checkpoint.blockReason ??= completion.dependency?.detail ?? completion.waitingFor ?? "required user input is missing";
      checkpoint.nextStep ??= completion.waitingFor
        ? `Continue after the user provides: ${completion.waitingFor}`
        : "continue after the required user input arrives";
    } else {
      checkpoint.currentStep = "verify the accepted completion checks";
      checkpoint.nextStep = "record a verified completion receipt or the exact input still needed from the user";
    }
  }
  if (status === "blocked") {
    const checkpointUpdatedThisRun = Date.parse(prior.updatedAt) >= Date.parse(task.startedAt);
    if (!checkpointUpdatedThisRun || !checkpoint.blockedStep) {
      checkpoint.blockedStep = checkpoint.currentStep ?? "complete the current task step";
    }
    if (!checkpointUpdatedThisRun || !checkpoint.blockReason) {
      checkpoint.blockReason = boundedText(
        outcome?.status === "empty"
          ? "the model returned an empty response after retrying"
          : outcome?.error ?? "the task stopped before completion",
        MAX_TASK_CHECKPOINT_STEP_CHARS,
      );
    }
  }
  return { ...task, status, lastOutcome, checkpoint, updatedAt: now, endedAt: now };
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

/** Dynamic prompt projection. Tool results may update this during a run, so compose it from the current
 * task every model round instead of freezing it into the interaction-start execution context. */
export function taskCheckpointContext(checkpoint: TaskCheckpoint | undefined): string {
  if (!checkpoint) return "";
  const facts = Object.entries(checkpoint.facts);
  const capabilities = Object.entries(checkpoint.capabilities);
  const hasState = checkpoint.currentStep || checkpoint.blockedStep || checkpoint.blockReason || checkpoint.nextStep
    || checkpoint.artifacts.length || facts.length || capabilities.length || checkpoint.completion;
  if (!hasState) return "";
  const lines = [
    "# Structured task state (authoritative)",
    "Read progress, final claims, and resume decisions from this state plus the canonical Todo checklist. Update it with `task_checkpoint`; do not invent a parallel conclusion.",
  ];
  if (checkpoint.currentStep) lines.push(`Current step: ${checkpoint.currentStep}`);
  if (checkpoint.blockedStep) lines.push(`Blocked step: ${checkpoint.blockedStep}`);
  if (checkpoint.blockReason) lines.push(`Block reason: ${checkpoint.blockReason}`);
  if (checkpoint.nextStep) lines.push(`Next step: ${checkpoint.nextStep}`);
  if (capabilities.length) {
    lines.push(
      "## Capability preflight",
      ...capabilities.map(([name, capability]) =>
        `- ${name}: ${capability.state}${capability.detail ? ` — ${capability.detail}` : ""}`),
    );
  }
  if (facts.length) {
    lines.push(
      "## Verified facts",
      ...facts.map(([key, fact]) =>
        `- ${key} = ${JSON.stringify(fact.value)}${fact.evidence ? ` — evidence: ${fact.evidence}` : ""}`),
    );
  }
  if (checkpoint.artifacts.length) {
    lines.push("## Artifacts", ...checkpoint.artifacts.map((artifact) => `- ${artifact}`));
  }
  if (checkpoint.completion) {
    lines.push(
      "## Completion receipt",
      `- state: ${checkpoint.completion.state}`,
      ...(checkpoint.completion.waitingFor ? [`- waiting for: ${checkpoint.completion.waitingFor}`] : []),
      ...(checkpoint.completion.dependency
        ? [
            `- dependency kind: ${checkpoint.completion.dependency.kind}`,
            ...(checkpoint.completion.dependency.capability
              ? [`- blocked capability: ${checkpoint.completion.dependency.capability}`]
              : []),
            ...(checkpoint.completion.dependency.manualAction?.command
              ? [`- manual command (copy only): ${checkpoint.completion.dependency.manualAction.command}`]
              : []),
            ...(checkpoint.completion.dependency.manualAction?.verifyCommand
              ? [`- verification command (copy only): ${checkpoint.completion.dependency.manualAction.verifyCommand}`]
              : []),
            ...(checkpoint.completion.dependency.manualAction?.resumePhrase
              ? [`- resume phrase: ${checkpoint.completion.dependency.manualAction.resumePhrase}`]
              : []),
            ...checkpoint.completion.dependency.evidence.map((item) => `- dependency evidence: ${item}`),
          ]
        : []),
      ...checkpoint.completion.evidence.map((item) => `- evidence: ${item}`),
    );
  }
  return lines.join("\n");
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
    `Cumulative round budget: ${taskRoundBudget(task).used}/${taskRoundBudget(task).limit}`,
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
  const receipt = task.checkpoint?.completion;
  return [
    `task ${task.id.slice(0, 8)} · ${task.status}`,
    `turn ${task.turnId.slice(0, 8)} · outcome ${task.lastOutcome ?? "running"}`,
    `rounds: ${taskRoundBudget(task).used}/${taskRoundBudget(task).limit}`,
    `objective: ${task.objective}`,
    `brief: ${task.brief ? `${task.brief.intent} · ${task.brief.goal}` : "(not accepted yet)"}`,
    `checkpoint: ${task.checkpoint ? `${Object.keys(task.checkpoint.facts).length} fact(s) · ${Object.keys(task.checkpoint.capabilities).length} capability check(s) · ${task.checkpoint.artifacts.length} artifact(s)` : "(legacy none)"}`,
    `completion: ${receipt ? `${receipt.state} · ${receipt.evidence.length} evidence item(s)${receipt.waitingFor ? ` · waiting for ${receipt.waitingFor}` : ""}` : "(no receipt)"}`,
    `steering: ${task.steering?.length ?? 0}`,
  ].join("\n");
}

function validCheckpointText(value: unknown, max = MAX_TASK_CHECKPOINT_STEP_CHARS): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= max);
}

function validTaskManualAction(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (
    !validCheckpointText(action.command, MAX_TASK_MANUAL_COMMAND_CHARS)
    || !validCheckpointText(action.verifyCommand, MAX_TASK_VERIFY_COMMAND_CHARS)
    || !validCheckpointText(action.resumePhrase, MAX_TASK_RESUME_PHRASE_CHARS)
    || (action.hints !== undefined && !Array.isArray(action.hints))
  ) return false;
  const hints = (action.hints ?? []) as unknown[];
  if (hints.length > MAX_TASK_MANUAL_HINTS) return false;
  for (const raw of hints) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const hint = raw as Record<string, unknown>;
    if (
      !validCheckpointText(hint.term, MAX_TASK_MANUAL_HINT_TERM_CHARS)
      || !validCheckpointText(hint.detail, MAX_TASK_MANUAL_HINT_DETAIL_CHARS)
    ) return false;
  }
  return action.command !== undefined
    || action.verifyCommand !== undefined
    || action.resumePhrase !== undefined
    || hints.length > 0;
}

function validTaskCheckpoint(value: unknown): value is TaskCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  if (
    !validCheckpointText(checkpoint.currentStep) ||
    !validCheckpointText(checkpoint.blockedStep) ||
    !validCheckpointText(checkpoint.blockReason) ||
    !validCheckpointText(checkpoint.nextStep) ||
    (checkpoint.blockReason !== undefined && checkpoint.blockedStep === undefined) ||
    !validTimestamp(checkpoint.updatedAt) ||
    !Array.isArray(checkpoint.artifacts) ||
    checkpoint.artifacts.length > MAX_TASK_CHECKPOINT_ARTIFACTS ||
    !checkpoint.artifacts.every((artifact) => typeof artifact === "string" && artifact.length > 0 && artifact.length <= MAX_TASK_CHECKPOINT_ARTIFACT_CHARS) ||
    !checkpoint.facts || typeof checkpoint.facts !== "object" || Array.isArray(checkpoint.facts) ||
    !checkpoint.capabilities || typeof checkpoint.capabilities !== "object" || Array.isArray(checkpoint.capabilities)
  ) return false;
  const facts = Object.entries(checkpoint.facts as Record<string, unknown>);
  if (facts.length > MAX_TASK_CHECKPOINT_FACTS) return false;
  for (const [key, raw] of facts) {
    const parsedKey = taskStateKey(key, "fact key");
    if (!parsedKey.ok || parsedKey.value !== key || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const fact = raw as Record<string, unknown>;
    const storedValueValid = typeof fact.value === "boolean"
      || (typeof fact.value === "number" && Number.isFinite(fact.value))
      || (typeof fact.value === "string" && fact.value.length <= MAX_TASK_FACT_STRING_CHARS);
    if (!storedValueValid || !validCheckpointText(fact.evidence, MAX_TASK_EVIDENCE_CHARS) || !validTimestamp(fact.updatedAt)) return false;
  }
  const capabilities = Object.entries(checkpoint.capabilities as Record<string, unknown>);
  if (capabilities.length > MAX_TASK_CHECKPOINT_CAPABILITIES) return false;
  for (const [name, raw] of capabilities) {
    const parsedName = taskStateKey(name, "capability name");
    if (!parsedName.ok || parsedName.value !== name || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const capability = raw as Record<string, unknown>;
    if (
      (capability.state !== "available" && capability.state !== "unavailable" && capability.state !== "blocked" && capability.state !== "unknown") ||
      !validCheckpointText(capability.detail, MAX_TASK_EVIDENCE_CHARS) ||
      !validTimestamp(capability.checkedAt)
    ) return false;
  }
  if (checkpoint.completion !== undefined) {
    if (!checkpoint.completion || typeof checkpoint.completion !== "object" || Array.isArray(checkpoint.completion)) return false;
    const completion = checkpoint.completion as Record<string, unknown>;
    const dependency = completion.dependency;
    const dependencyObject = dependency && typeof dependency === "object" && !Array.isArray(dependency)
      ? dependency as Record<string, unknown>
      : undefined;
    const dependencyKind = dependencyObject?.kind;
    const dependencyCapability = dependencyObject?.capability;
    const dependencyCapabilityState = typeof dependencyCapability === "string"
      ? (checkpoint.capabilities as Record<string, TaskCapability>)[dependencyCapability]?.state
      : undefined;
    const dependencyValid = dependency === undefined || (
      dependencyObject
      && ["missing_secret", "missing_authority", "physical_action", "material_choice", "external_state", "destructive_confirmation"].includes(dependencyKind as string)
      && typeof dependencyObject.detail === "string" && validCheckpointText(dependencyObject.detail)
      && Array.isArray(dependencyObject.evidence)
      && dependencyObject.evidence.length > 0
      && dependencyObject.evidence.length <= MAX_TASK_DEPENDENCY_EVIDENCE
      && dependencyObject.evidence.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_TASK_EVIDENCE_CHARS)
      && (dependencyCapability === undefined
        || (typeof dependencyCapability === "string"
          && taskStateKey(dependencyCapability, "dependency capability").ok
          && (dependencyCapabilityState === "blocked" || dependencyCapabilityState === "unavailable")))
      && ((dependencyKind !== "missing_secret" && dependencyKind !== "missing_authority")
        || typeof dependencyCapability === "string")
      && validTaskManualAction(dependencyObject.manualAction)
    );
    if (
      (completion.state !== "verified" && completion.state !== "awaiting_user")
      || !Array.isArray(completion.evidence)
      || completion.evidence.length > MAX_TASK_COMPLETION_EVIDENCE
      || !completion.evidence.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_TASK_EVIDENCE_CHARS)
      || (completion.waitingFor !== undefined && !validCheckpointText(completion.waitingFor))
      || (completion.state === "verified" && completion.evidence.length === 0)
      || (completion.state === "awaiting_user" && !completion.waitingFor)
      || !dependencyValid
      || (completion.state === "verified" && dependency !== undefined)
      || (completion.state === "awaiting_user" && dependency !== undefined
        && dependencyObject?.detail !== completion.waitingFor)
      || !validTimestamp(completion.updatedAt)
    ) return false;
  }
  return true;
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
    || ((task.roundsUsed === undefined) !== (task.roundBudgetLimit === undefined))
    || (task.roundsUsed !== undefined && (!Number.isSafeInteger(task.roundsUsed) || (task.roundsUsed as number) < 0 || (task.roundsUsed as number) > MAX_TASK_ROUND_BUDGET))
    || (task.roundBudgetLimit !== undefined && (!Number.isSafeInteger(task.roundBudgetLimit) || (task.roundBudgetLimit as number) < DEFAULT_TASK_ROUND_BUDGET || (task.roundBudgetLimit as number) > MAX_TASK_ROUND_BUDGET || (task.roundBudgetLimit as number) % DEFAULT_TASK_ROUND_BUDGET !== 0))
    || (typeof task.roundsUsed === "number" && typeof task.roundBudgetLimit === "number" && task.roundsUsed > task.roundBudgetLimit)
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
      (brief.requiredCapabilities !== undefined && !validRequiredCapabilities(brief.requiredCapabilities)) ||
      !validTimestamp(brief.createdAt)
    ) return false;
  }
  if (task.checkpoint !== undefined && !validTaskCheckpoint(task.checkpoint)) return false;
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
