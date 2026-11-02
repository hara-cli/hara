// Observational metadata only. A record is provenance, never execution authority or a receipt
// proving a tool's external effect. Only trusted Host composition supplies these identities.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { writePrivateStateFileSync } from "../security/private-state.js";
import { isAgentRuntimeId, type AgentRuntimeId } from "../agent-runtime/bindings.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { isWorkspaceId } from "./registry.js";
import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import {
  currentWorkspaceResourceBinding, inspectWorkspaceResourceFile, sameWorkspaceResourceBinding,
  workspaceResourceDirectory, type WorkspaceResourceBinding, type WorkspaceResourceStorage,
} from "./resource-context.js";

export const MAX_RUNTIME_STAGE_EVENTS = 256;
export const MAX_RUNTIME_STAGE_REPORTS = 16;
export const MAX_RUNTIME_STAGE_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_COUNTER = 1_000_000;
const MAX_HISTORY = 4000;
export const RUNTIME_STAGE_ERROR_KINDS = [
  "not_installed", "version_incompatible", "runtime_auth_required", "runtime_auth_rejected",
  "runtime_network", "runtime_proxy", "invalid_model", "runtime_quota", "runtime_rate_limit",
  "runtime_permission_denied", "runtime_crashed", "project_not_trusted", "timeout", "spawn_failed", "runtime_failed",
] as const;
export type RuntimeStageErrorKind = typeof RUNTIME_STAGE_ERROR_KINDS[number];
export type RuntimeStageKind = "spawn" | "cold_start" | "first_token" | "first_output" | "model_roundtrip" | "tool_call" | "complete";
export type RuntimeStageSource = "host" | "provider_stream" | "native_event";
export type RuntimeStageOutcome = "completed" | "error" | "cancelled";
export type RuntimeStageState = "running" | "completed" | "blocked" | "cancelled" | "error" | "incomplete";
type SpanKind = Exclude<RuntimeStageKind, "first_token" | "first_output" | "complete">;
export interface RuntimeStageIdentity {
  workspaceId: string;
  resourceGeneration: string;
  agentId: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  historyStart: number;
}
export interface RuntimeStageRuntime {
  id: AgentRuntimeId;
  version: string | null;
  loginSource: "host" | "isolated" | "unknown";
  model: string | null;
  effort: string | null;
}
export interface RuntimeStageEvent {
  seq: number;
  kind: RuntimeStageKind;
  phase: "start" | "end" | "mark";
  offsetMs: number;
  durationMs: number | null;
  call: number | null;
  toolName: string | null;
  outcome: RuntimeStageOutcome | null;
  source: RuntimeStageSource;
  errorKind: RuntimeStageErrorKind | null;
}
export interface RuntimeStageReport extends RuntimeStageIdentity {
  schemaVersion: 1;
  runtime: RuntimeStageRuntime;
  state: RuntimeStageState;
  durationMs: number | null;
  errorKind: RuntimeStageErrorKind | null;
  events: RuntimeStageEvent[];
  droppedEvents: number;
}
export interface RuntimeStageExportReceipt { fileName: string; path: string; bytes: number; sha256: string }
const identityKeys = ["workspaceId", "resourceGeneration", "agentId", "sessionId", "runId", "attemptId", "historyStart"] as const;
const runtimeKeys = ["id", "version", "loginSource", "model", "effort"] as const;
const eventKeys = ["seq", "kind", "phase", "offsetMs", "durationMs", "call", "toolName", "outcome", "source", "errorKind"] as const;
const reportKeys = ["schemaVersion", ...identityKeys, "runtime", "state", "durationMs", "errorKind", "events", "droppedEvents"] as const;
const stages: readonly string[] = ["spawn", "cold_start", "first_token", "first_output", "model_roundtrip", "tool_call", "complete"];
const states: readonly string[] = ["running", "completed", "blocked", "cancelled", "error", "incomplete"];
const outcomes: readonly string[] = ["completed", "error", "cancelled"];
const sources: readonly string[] = ["host", "provider_stream", "native_event"];
const spanKinds: readonly string[] = ["spawn", "cold_start", "model_roundtrip", "tool_call"];
const integer = (value: unknown, maximum = MAX_COUNTER): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const errorKind = (value: unknown): value is RuntimeStageErrorKind => typeof value === "string" && (RUNTIME_STAGE_ERROR_KINDS as readonly string[]).includes(value);
const nullableError = (value: unknown): value is RuntimeStageErrorKind | null => value === null || errorKind(value);
const toolName = (value: unknown): value is string => typeof value === "string" && value === value.trim() && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const source = (value: unknown): value is RuntimeStageSource => typeof value === "string" && sources.includes(value);
const duration = (value: unknown): value is number => integer(value, MAX_RUNTIME_STAGE_DURATION_MS);
function invalid(): never { throw new Error("Invalid Runtime stage metadata; no content was exported"); }

function validIdentity(value: Record<string, unknown>): boolean {
  return isWorkspaceId(value.workspaceId) && isWorkspaceAgentId(value.agentId)
    && ["resourceGeneration", "sessionId", "runId", "attemptId"].every(key => typeof value[key] === "string" && UUID.test(value[key] as string))
    && integer(value.historyStart, MAX_HISTORY);
}
function safeVersion(value: unknown): string | null {
  return typeof value === "string" && value === value.trim() && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value : null;
}
function safeModel(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,159}$/.test(value)
    || /^(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|Bearer|https?:|[A-Za-z]:[\\/])/i.test(value)
    || /(?:^|\/)(?:Users|home|credentials?|secrets?)(?:\/|$)/i.test(value)
    || /^[a-f0-9]{32,}$/i.test(value)) return null;
  return value;
}
function safeEffort(value: unknown): string | null {
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value) ? value : null;
}
/** Project known Host-owned fields; no environment or raw runtime payload is copied. */
export function projectRuntimeStageRuntime(input: RuntimeStageRuntime): RuntimeStageRuntime {
  if (!isAgentRuntimeId(input.id)) return invalid();
  return { id: input.id, version: safeVersion(input.version),
    loginSource: input.loginSource === "host" || input.loginSource === "isolated" ? input.loginSource : "unknown",
    model: safeModel(input.model), effort: safeEffort(input.effort) };
}
function validRuntime(value: unknown): value is RuntimeStageRuntime {
  if (!plain(value) || !exact(value, runtimeKeys) || !isAgentRuntimeId(value.id)) return false;
  return (value.version === null || safeVersion(value.version) === value.version)
    && ["host", "isolated", "unknown"].includes(String(value.loginSource))
    && (value.model === null || safeModel(value.model) === value.model)
    && (value.effort === null || safeEffort(value.effort) === value.effort);
}
function validEvent(value: unknown): value is RuntimeStageEvent {
  if (!plain(value) || !exact(value, eventKeys) || !integer(value.seq) || value.seq === 0
    || !stages.includes(String(value.kind)) || !["start", "end", "mark"].includes(String(value.phase))
    || !duration(value.offsetMs) || !(value.durationMs === null || duration(value.durationMs))
    || !(value.call === null || integer(value.call) && value.call > 0)
    || !(value.toolName === null || toolName(value.toolName))
    || !(value.outcome === null || outcomes.includes(String(value.outcome))) || !source(value.source) || !nullableError(value.errorKind)) return false;
  if (value.durationMs !== null && value.durationMs > value.offsetMs) return false;
  if (spanKinds.includes(String(value.kind))) {
    if (value.phase === "mark") return false;
    return value.phase === "start" ? value.durationMs === null && value.outcome === null && value.errorKind === null
      : value.durationMs !== null && value.outcome !== null;
  }
  if (value.phase !== "mark" || value.call !== null || value.toolName !== null) return false;
  if (value.kind === "complete") return value.outcome !== null && value.durationMs !== null && value.source === "host";
  return value.durationMs === null && value.outcome === null && value.errorKind === null
    && (value.kind === "first_output" || value.source !== "host");
}
/** Exact wire validation also applies on disk reads and again before exporting. */
export function parseRuntimeStageReport(value: unknown): RuntimeStageReport {
  if (!plain(value) || !exact(value, reportKeys) || value.schemaVersion !== 1 || !validIdentity(value)
    || !validRuntime(value.runtime) || !states.includes(String(value.state))
    || !(value.durationMs === null || duration(value.durationMs)) || !nullableError(value.errorKind)
    || !integer(value.droppedEvents) || !Array.isArray(value.events) || value.events.length > MAX_RUNTIME_STAGE_EVENTS
    || !value.events.every(validEvent)) return invalid();
  const events = value.events as RuntimeStageEvent[];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!, previous = events[i - 1];
    if (previous && (event.seq <= previous.seq || event.offsetMs < previous.offsetMs)) return invalid();
    if (value.durationMs !== null && event.offsetMs > Number(value.durationMs)) return invalid();
    if (event.kind === "complete" && i !== events.length - 1) return invalid();
  }
  const completed = events.at(-1)?.kind === "complete";
  if (value.state === "running" || value.state === "incomplete") {
    if (completed || value.durationMs !== null) return invalid();
  } else {
    const terminal = events.at(-1);
    const expected = value.state === "completed" ? "completed" : value.state === "cancelled" ? "cancelled" : "error";
    if (!completed || value.durationMs === null || terminal?.offsetMs !== value.durationMs
      || terminal.durationMs !== value.durationMs || terminal.outcome !== expected || terminal.errorKind !== value.errorKind) return invalid();
  }
  if (new Set(events.filter(row => row.kind === "first_token" || row.kind === "first_output").map(row => row.kind)).size
    !== events.filter(row => row.kind === "first_token" || row.kind === "first_output").length) return invalid();
  return structuredClone(value) as unknown as RuntimeStageReport;
}

/** Monotonic, bounded in-memory observations. Missing events are never synthesized as success. */
export class RuntimeStageRecorder {
  private readonly report: RuntimeStageReport;
  private readonly began: number;
  private lastOffset = 0;
  private nextSeq = 1;
  private closed = false;
  private readonly firstMarks = new Set<"first_token" | "first_output">();
  constructor(identity: RuntimeStageIdentity, runtime: RuntimeStageRuntime, private readonly options: { now?: () => number } = {}) {
    if (!plain(identity) || !exact(identity as unknown as Record<string, unknown>, identityKeys) || !validIdentity(identity as unknown as Record<string, unknown>)) invalid();
    const now = (options.now ?? performance.now.bind(performance))();
    if (!Number.isFinite(now)) invalid();
    this.began = now;
    this.report = { schemaVersion: 1, ...structuredClone(identity), runtime: projectRuntimeStageRuntime(runtime),
      state: "running", durationMs: null, errorKind: null, events: [], droppedEvents: 0 };
  }
  private offset(): number {
    const now = (this.options.now ?? performance.now.bind(performance))();
    if (Number.isFinite(now)) this.lastOffset = Math.min(MAX_RUNTIME_STAGE_DURATION_MS, Math.max(this.lastOffset, Math.floor(now - this.began)));
    return this.lastOffset;
  }
  private append(event: Omit<RuntimeStageEvent, "seq">, terminal = false): void {
    const seq = Math.min(MAX_COUNTER, this.nextSeq++);
    if (!terminal && this.report.events.length >= MAX_RUNTIME_STAGE_EVENTS - 1) {
      this.report.droppedEvents = Math.min(MAX_COUNTER, this.report.droppedEvents + 1); return;
    }
    this.report.events.push({ seq, ...event });
  }
  setRuntime(input: Partial<RuntimeStageRuntime>): void {
    if (this.closed) return;
    if (!plain(input) || Object.keys(input).some(key => !(runtimeKeys as readonly string[]).includes(key))
      || input.id !== undefined && input.id !== this.report.runtime.id) return invalid();
    this.report.runtime = projectRuntimeStageRuntime({ ...this.report.runtime, ...input });
  }
  beginEvent(kind: SpanKind, input: { call?: number; toolName?: string; source?: RuntimeStageSource } = {}):
    (outcome?: RuntimeStageOutcome, error?: RuntimeStageErrorKind | null) => void {
    if (this.closed) return () => {};
    if (!spanKinds.includes(kind) || !plain(input) || Object.keys(input).some(key => !["call", "toolName", "source"].includes(key))
      || input.call !== undefined && (!integer(input.call) || input.call === 0)
      || input.toolName !== undefined && !toolName(input.toolName)
      || input.source !== undefined && !source(input.source)) return invalid();
    const started = this.offset(), call = input.call ?? null, name = input.toolName ?? null, origin = input.source ?? "host";
    this.append({ kind, phase: "start", offsetMs: started, durationMs: null, call, toolName: name,
      outcome: null, source: origin, errorKind: null });
    let ended = false;
    return (outcome = "completed", error = null): void => {
      if (ended || this.closed) return;
      if (!outcomes.includes(outcome)) return invalid();
      ended = true;
      const offsetMs = this.offset();
      this.append({ kind, phase: "end", offsetMs, durationMs: offsetMs - started, call, toolName: name,
        outcome, source: origin, errorKind: error === null ? null : errorKind(error) ? error : "runtime_failed" });
    };
  }
  mark(kind: "first_token" | "first_output", origin: RuntimeStageSource = "provider_stream"): void {
    if (this.closed) return;
    if (!["first_token", "first_output"].includes(kind) || !source(origin) || kind === "first_token" && origin === "host") return invalid();
    if (this.firstMarks.has(kind)) return;
    this.firstMarks.add(kind);
    this.append({ kind, phase: "mark", offsetMs: this.offset(), durationMs: null, call: null, toolName: null,
      outcome: null, source: origin, errorKind: null });
  }
  finish(state: Exclude<RuntimeStageState, "running">, error: RuntimeStageErrorKind | null = null): void {
    if (this.closed) return;
    if (!states.includes(state) || state === ("running" as string)) return invalid();
    this.closed = true;
    this.report.state = state;
    this.report.errorKind = error === null ? null : errorKind(error) ? error : "runtime_failed";
    if (state === "incomplete") return;
    const offsetMs = this.offset();
    this.report.durationMs = offsetMs;
    this.append({ kind: "complete", phase: "mark", offsetMs, durationMs: offsetMs, call: null, toolName: null,
      outcome: state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "error",
      source: "host", errorKind: this.report.errorKind }, true);
  }
  snapshot(): RuntimeStageReport { return parseRuntimeStageReport(this.report); }
}

/** A crashed Host's old running row stays incomplete; a UI refresh is not a completion signal. */
export function projectRuntimeStageReports(reports: readonly RuntimeStageReport[], activeAttemptIds: ReadonlySet<string>): RuntimeStageReport[] {
  return reports.map(value => {
    const report = parseRuntimeStageReport(value);
    return report.state === "running" && !activeAttemptIds.has(report.attemptId) ? { ...report, state: "incomplete" } : report;
  });
}
interface StageDocument {
  revision: number;
  resourceBinding: WorkspaceResourceBinding;
  sessionId: string;
  agentId: string;
  reports: RuntimeStageReport[];
}
/** Explicit save only: Host may coalesce updates; no timers and no per-token disk writes. */
export class WorkspaceRuntimeStageStore {
  private readonly state: WorkspaceJsonState<StageDocument>;
  private readonly generation: string;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly sessionId: string, private readonly agentId: string) {
    if (!UUID.test(sessionId) || !isWorkspaceAgentId(agentId)) invalid();
    this.generation = storage.run(() => currentWorkspaceResourceBinding()!.generation);
    this.state = new WorkspaceJsonState(storage, `runtime-stages-${sessionId}.json`, value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "sessionId", "agentId", "reports"])
        || !integer(value.revision, Number.MAX_SAFE_INTEGER) || Number(value.revision) === 0
        || value.sessionId !== sessionId || value.agentId !== agentId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.reports) || value.reports.length > MAX_RUNTIME_STAGE_REPORTS) return invalid();
      const reports = value.reports.map(report => this.owned(report));
      if (new Set(reports.map(row => row.attemptId)).size !== reports.length) return invalid();
      return { revision: Number(value.revision), resourceBinding: value.resourceBinding as unknown as WorkspaceResourceBinding,
        sessionId, agentId, reports };
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), sessionId, agentId, reports: [] }));
  }
  private owned(value: unknown): RuntimeStageReport {
    const report = parseRuntimeStageReport(value);
    if (report.workspaceId !== this.storage.scope.workspaceId || report.resourceGeneration !== this.generation
      || report.sessionId !== this.sessionId || report.agentId !== this.agentId) return invalid();
    return report;
  }
  save(value: RuntimeStageReport): void {
    const report = this.owned(value), before = this.state.read(), previous = before.reports.find(row => row.attemptId === report.attemptId);
    if (previous) {
      if (canonical(previous) === canonical(report)) return;
      if (previous.runId !== report.runId || previous.historyStart !== report.historyStart || previous.runtime.id !== report.runtime.id
        || previous.state !== "running" || report.droppedEvents < previous.droppedEvents
        || report.events.length < previous.events.length
        || canonical(report.events.slice(0, previous.events.length)) !== canonical(previous.events)) return invalid();
    }
    this.state.update(before.revision, current => {
      const reports = current.reports.filter(row => row.attemptId !== report.attemptId);
      reports.push(report);
      return { ...current, reports: reports.slice(-MAX_RUNTIME_STAGE_REPORTS) };
    });
  }
  list(): RuntimeStageReport[] { return this.state.read().reports; }
  export(attemptId: string, options: { active?: boolean } = {}): RuntimeStageExportReceipt {
    if (!UUID.test(attemptId) || !plain(options) || Object.keys(options).some(key => key !== "active")
      || options.active !== undefined && typeof options.active !== "boolean") return invalid();
    const stored = this.list().find(report => report.attemptId === attemptId);
    if (!stored) throw new Error("Runtime stage report unavailable in this conversation");
    const report = projectRuntimeStageReports([stored], new Set(options.active ? [attemptId] : []))[0]!;
    const content = JSON.stringify(this.owned(report), null, 2) + "\n";
    return this.storage.run(() => {
      const fileName = `runtime-feedback-${randomUUID()}.json`;
      const directory = workspaceResourceDirectory(["runtime-diagnostics"]);
      const file = inspectWorkspaceResourceFile(join(directory, fileName), 1024 * 1024);
      if (file.snapshot) throw new Error("Runtime diagnostic filename already exists");
      writePrivateStateFileSync(file, content, { expectedMissing: true, assertCurrent: file.assertCurrent });
      const verified = inspectWorkspaceResourceFile(file.path, 1024 * 1024);
      if (!verified.snapshot || verified.snapshot.text !== content) throw new Error("Runtime diagnostic file was not verified");
      const bytes = Buffer.from(content);
      return { fileName, path: file.path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  }
}
