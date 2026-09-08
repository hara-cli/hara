import { createHash } from "node:crypto";
import type { TaskExecution } from "../session/task.js";
import type { Todo } from "../tools/todo.js";
import { keyOf } from "./repeat-guard.js";

export const SIMILAR_EVIDENCE_THRESHOLD = 0.8;
export const REPEATED_SUCCESSFUL_CALL_STOP = 4;
export const SIMILAR_EVIDENCE_STOP_ROUNDS = 6;
export const UNATTENDED_PROGRESS_NUDGE_ROUNDS = 5;
export const UNATTENDED_PROGRESS_STOP_ROUNDS = 8;
export const UNATTENDED_NO_PROGRESS_TOKEN_LIMIT = 200_000;

const MAX_OBSERVATIONS = 128;
const MAX_CALL_IDENTITIES = 128;
const MAX_NORMALIZED_OBSERVATION_CHARS = 12_000;
const SAFE_PROGRESS_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u;

export type ProgressStopTrigger =
  | "repeated_tool_call"
  | "similar_tool_evidence"
  | "unattended_without_checkpoint"
  | "unattended_token_budget";

export interface ProgressObservation {
  name: string;
  input: unknown;
  content: string;
}

export interface ProgressUsage {
  input: number;
  output: number;
}

export interface ProgressState {
  state: "working" | "warning" | "stopped";
  trigger?: ProgressStopTrigger;
  toolCalls: number;
  unattendedRounds: number;
  /** Consecutive substantive rounds whose successful observations were substantially unchanged. */
  evidenceStaleRounds: number;
  noProgressRounds: number;
  checkpointStaleRounds: number;
  checkpointAdvanced: boolean;
  similarity?: number;
  repeatedTool?: string;
  repeatedCount?: number;
  tokens: ProgressUsage & { total: number };
  todo: {
    done: number;
    total: number;
    unchangedRounds: number;
    advanced: boolean;
  };
}

export interface ProgressDecision {
  state: ProgressState;
  warn: boolean;
  stop: boolean;
}

interface Fingerprint {
  exact: string;
  normalizedLength: number;
  shingles: Set<string>;
  progressMetric?: string;
}

interface StoredObservation {
  name: string;
  fingerprint: Fingerprint;
}

interface CallStreak {
  name: string;
  count: number;
  round: number;
  fingerprint: Fingerprint;
}

export interface ProgressRound {
  observations: readonly ProgressObservation[];
  toolCalls: number;
  substantive: boolean;
  userIntervened: boolean;
  task?: TaskExecution;
  todos: readonly Todo[];
  usage?: ProgressUsage;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function progressToolName(value: string): string {
  const normalized = value.trim();
  return SAFE_PROGRESS_TOOL_NAME.test(normalized) ? normalized : "tool";
}

/** Normalize only high-confidence volatile transport values. Ordinary numbers remain significant so a
 * changing percentage, row count, or job state can still prove real progress. The normalized text never
 * leaves this in-memory tracker; only digests and character shingles are retained. */
export function normalizeProgressObservation(content: string): string {
  return content
    .normalize("NFKC")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gu, "<timestamp>")
    .replace(/\b(elapsed|duration|attempt|round|request[_ -]?id|trace[_ -]?id)\s*[:=#-]?\s*[0-9a-f][0-9a-f.-]*\b/giu, "$1=<volatile>")
    .replace(/\b[0-9a-f]{24,}\b/giu, "<opaque-id>")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, MAX_NORMALIZED_OBSERVATION_CHARS);
}

/** Extract only high-confidence progress counters. Hashing the normalized matches keeps the rolling ledger
 * credential-free while ensuring a long, otherwise identical status line can still advance from 10% to 45%.
 * Bare offsets and line numbers are deliberately excluded: changing those is a common no-progress loop. */
function progressMetricSignature(normalized: string): string | undefined {
  const matches = new Set<string>();
  const patterns = [
    /\b\d+(?:\.\d+)?\s*%/giu,
    /\b\d+\s*(?:\/|of)\s*\d+\b/giu,
    /(?:progress|processed|uploaded|downloaded|transferred|completed|进度|已处理|已上传|已下载|已传输|已完成)[^\d\n]{0,16}\d+(?:\.\d+)?(?:\s*%)?/giu,
    /\b\d+(?:\.\d+)?\s*(?:files?|items?|rows?|bytes?|tokens?|文件|项目|条目|行|字节|令牌)(?=\s|[.,;:!?，。；：！？)]|$)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) matches.add(match[0].replace(/\s+/gu, " ").trim());
  }
  return matches.size ? digest([...matches].sort().join("\0")) : undefined;
}

function fingerprint(content: string): Fingerprint {
  const normalized = normalizeProgressObservation(content);
  const progressMetric = progressMetricSignature(normalized);
  const shingles = new Set<string>();
  if (normalized.length >= 24) {
    const compact = normalized.replace(/\s+/gu, " ");
    for (let index = 0; index <= compact.length - 5; index += 2) {
      shingles.add(compact.slice(index, index + 5));
      if (shingles.size >= 2_048) break;
    }
  }
  return {
    exact: digest(normalized),
    normalizedLength: normalized.length,
    shingles,
    ...(progressMetric ? { progressMetric } : {}),
  };
}

function similarity(left: Fingerprint, right: Fingerprint): number {
  if (left.exact === right.exact) return 1;
  if (
    (left.progressMetric || right.progressMetric)
    && left.progressMetric !== right.progressMetric
  ) return 0;
  // Short status values such as state-1/state-2 are intentionally exact-only: a changed counter may be
  // the entire progress signal, and fuzzy matching it would stop a healthy bounded poll.
  if (left.normalizedLength < 24 || right.normalizedLength < 24) return 0;
  if (!left.shingles.size || !right.shingles.size) return 0;
  const smaller = left.shingles.size <= right.shingles.size ? left.shingles : right.shingles;
  const larger = smaller === left.shingles ? right.shingles : left.shingles;
  let shared = 0;
  for (const item of smaller) if (larger.has(item)) shared += 1;
  return (2 * shared) / (left.shingles.size + right.shingles.size);
}

/** Exported for deterministic threshold tests without retaining or exposing either source string. */
export function progressObservationSimilarity(left: string, right: string): number {
  return similarity(fingerprint(left), fingerprint(right));
}

function checkpointEvidence(task: TaskExecution | undefined): Set<string> {
  const checkpoint = task?.checkpoint;
  const evidence = new Set<string>();
  if (!checkpoint) return evidence;
  for (const artifact of checkpoint.artifacts) evidence.add(digest(`artifact\0${artifact}`));
  for (const [key, fact] of Object.entries(checkpoint.facts).sort(([left], [right]) => left.localeCompare(right))) {
    evidence.add(digest(`fact\0${key}\0${JSON.stringify(fact.value)}\0${fact.evidence ?? ""}`));
  }
  for (const [name, capability] of Object.entries(checkpoint.capabilities).sort(([left], [right]) => left.localeCompare(right))) {
    evidence.add(digest(`capability\0${name}\0${capability.state}\0${capability.detail ?? ""}`));
  }
  if (checkpoint.completion) {
    evidence.add(digest(`completion\0${checkpoint.completion.state}\0${checkpoint.completion.waitingFor ?? ""}`));
    for (const item of checkpoint.completion.evidence) evidence.add(digest(`completion-evidence\0${item}`));
  }
  return evidence;
}

function completedTodoEvidence(todos: readonly Todo[]): Set<string> {
  return new Set(
    todos
      .filter((todo) => todo.status === "done")
      .map((todo) => digest(todo.text.replace(/\s+/gu, " ").trim().toLowerCase())),
  );
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Engine-owned rolling progress ledger. It retains no raw arguments, output, prompts, paths, or secrets. */
export class AgentProgressWatchdog {
  private readonly unattended: boolean;
  private readonly baselineUsage: ProgressUsage;
  private readonly observations: StoredObservation[] = [];
  private readonly callStreaks = new Map<string, CallStreak>();
  private readonly knownCheckpointEvidence: Set<string>;
  private readonly knownCompletedTodos: Set<string>;
  private toolCalls = 0;
  private unattendedRounds = 0;
  private similarEvidenceRounds = 0;
  private checkpointStaleRounds = 0;
  private todoUnchangedRounds = 0;
  private trackedRounds = 0;

  constructor(options: {
    unattended: boolean;
    task?: TaskExecution;
    todos?: readonly Todo[];
    usage?: ProgressUsage;
  }) {
    this.unattended = options.unattended;
    this.knownCheckpointEvidence = checkpointEvidence(options.task);
    this.knownCompletedTodos = completedTodoEvidence(options.todos ?? []);
    this.baselineUsage = {
      input: nonNegative(options.usage?.input),
      output: nonNegative(options.usage?.output),
    };
  }

  recordRound(round: ProgressRound): ProgressDecision {
    this.toolCalls += Math.max(0, Math.floor(round.toolCalls));
    if (round.substantive) this.trackedRounds += 1;
    if (round.userIntervened) this.unattendedRounds = 0;
    else if (round.substantive) this.unattendedRounds += 1;

    const currentCheckpointEvidence = checkpointEvidence(round.task);
    const checkpointAdvanced = [...currentCheckpointEvidence]
      .some((item) => !this.knownCheckpointEvidence.has(item));
    for (const item of currentCheckpointEvidence) this.knownCheckpointEvidence.add(item);

    const currentCompletedTodos = completedTodoEvidence(round.todos);
    const todoAdvanced = [...currentCompletedTodos]
      .some((item) => !this.knownCompletedTodos.has(item));
    for (const item of currentCompletedTodos) this.knownCompletedTodos.add(item);

    const done = round.todos.filter((todo) => todo.status === "done").length;
    const total = round.todos.length;
    if (round.substantive && total > 0) {
      this.todoUnchangedRounds = todoAdvanced ? 0 : this.todoUnchangedRounds + 1;
    } else if (todoAdvanced) {
      this.todoUnchangedRounds = 0;
    }
    if (round.substantive) {
      this.checkpointStaleRounds = checkpointAdvanced || todoAdvanced
        ? 0
        : this.checkpointStaleRounds + 1;
    }
    const durableProgress = checkpointAdvanced || todoAdvanced;

    let roundSimilarity = 0;
    let everyObservationIsStale = round.observations.length > 0;
    let highestRepeatedCount = 0;
    let repeatedTool: string | undefined;
    for (const observation of round.observations) {
      const name = progressToolName(observation.name);
      const current = fingerprint(observation.content);
      let best = 0;
      for (const prior of this.observations) {
        if (prior.name !== name) continue;
        best = Math.max(best, similarity(current, prior.fingerprint));
      }
      roundSimilarity = Math.max(roundSimilarity, best);
      if (best < SIMILAR_EVIDENCE_THRESHOLD) everyObservationIsStale = false;

      const callIdentity = digest(keyOf(name, observation.input));
      const previous = this.callStreaks.get(callIdentity);
      const repeated = previous
        && this.trackedRounds - previous.round <= UNATTENDED_PROGRESS_STOP_ROUNDS
        && similarity(current, previous.fingerprint) >= SIMILAR_EVIDENCE_THRESHOLD
        ? previous.count + 1
        : 1;
      this.callStreaks.delete(callIdentity);
      this.callStreaks.set(callIdentity, {
        name,
        count: repeated,
        round: this.trackedRounds,
        fingerprint: current,
      });
      if (repeated > highestRepeatedCount) {
        highestRepeatedCount = repeated;
        repeatedTool = name;
      }

      this.observations.push({ name, fingerprint: current });
    }
    while (this.observations.length > MAX_OBSERVATIONS) this.observations.shift();
    while (this.callStreaks.size > MAX_CALL_IDENTITIES) {
      const oldest = this.callStreaks.keys().next().value as string | undefined;
      if (!oldest) break;
      this.callStreaks.delete(oldest);
    }

    // Durable state is authoritative progress even when a state-writing tool returns boilerplate such as
    // "checkpoint saved" every time. Break both semantic-evidence streaks here so a sequence of genuinely
    // new facts/artifacts or completed todos cannot be killed merely because the tool's receipt is similar.
    if (durableProgress) {
      this.similarEvidenceRounds = 0;
      this.callStreaks.clear();
      highestRepeatedCount = 0;
      repeatedTool = undefined;
    } else if (round.substantive) {
      this.similarEvidenceRounds = everyObservationIsStale
        ? this.similarEvidenceRounds + 1
        : 0;
    }

    const input = Math.max(0, nonNegative(round.usage?.input) - this.baselineUsage.input);
    const output = Math.max(0, nonNegative(round.usage?.output) - this.baselineUsage.output);
    const totalTokens = input + output;
    let trigger: ProgressStopTrigger | undefined;
    if (highestRepeatedCount >= REPEATED_SUCCESSFUL_CALL_STOP) {
      trigger = "repeated_tool_call";
    } else if (this.similarEvidenceRounds >= SIMILAR_EVIDENCE_STOP_ROUNDS) {
      trigger = "similar_tool_evidence";
    } else if (
      this.unattended
      && totalTokens >= UNATTENDED_NO_PROGRESS_TOKEN_LIMIT
      && this.unattendedRounds >= 4
      && this.checkpointStaleRounds >= 4
    ) {
      trigger = "unattended_token_budget";
    } else if (
      this.unattended
      && this.unattendedRounds >= UNATTENDED_PROGRESS_STOP_ROUNDS
      && this.checkpointStaleRounds >= UNATTENDED_PROGRESS_STOP_ROUNDS
    ) {
      trigger = "unattended_without_checkpoint";
    }
    const warn = Boolean(trigger)
      || highestRepeatedCount >= 2
      || this.similarEvidenceRounds >= 2
      || (this.unattended
        && this.unattendedRounds >= UNATTENDED_PROGRESS_NUDGE_ROUNDS
        && this.checkpointStaleRounds >= UNATTENDED_PROGRESS_NUDGE_ROUNDS)
      || (this.unattended
        && totalTokens >= Math.floor(UNATTENDED_NO_PROGRESS_TOKEN_LIMIT * 0.8)
        && this.checkpointStaleRounds >= 3);
    const state: ProgressState = {
      state: trigger ? "stopped" : warn ? "warning" : "working",
      ...(trigger ? { trigger } : {}),
      toolCalls: this.toolCalls,
      unattendedRounds: this.unattendedRounds,
      evidenceStaleRounds: this.similarEvidenceRounds,
      noProgressRounds: Math.max(this.similarEvidenceRounds, this.checkpointStaleRounds),
      checkpointStaleRounds: this.checkpointStaleRounds,
      checkpointAdvanced,
      ...(roundSimilarity > 0 ? { similarity: Math.round(roundSimilarity * 100) / 100 } : {}),
      ...(repeatedTool ? { repeatedTool } : {}),
      ...(highestRepeatedCount > 0 ? { repeatedCount: highestRepeatedCount } : {}),
      tokens: { input, output, total: totalTokens },
      todo: { done, total, unchangedRounds: this.todoUnchangedRounds, advanced: todoAdvanced },
    };
    return { state, warn, stop: Boolean(trigger) };
  }
}
