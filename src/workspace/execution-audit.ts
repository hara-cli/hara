import type { ProviderRetryEvent } from "../providers/types.js";
import { exact, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";

type Outcome = "running" | "completed" | "error" | "cancelled";
export type WorkspaceExecutionError = "provider_error" | "tool_error" | "thrown" | "cancelled" | "budget_exhausted" | null;
type Retry = Pick<ProviderRetryEvent, "attempt" | "nextAttempt" | "kind" | "delayMs" | "elapsedMs"> & { status: number | null };
export interface WorkspaceExecutionObservation {
  kind: "model" | "tool"; call: number; name: string; startedAt: number; endedAt: number | null;
  durationMs: number | null; outcome: Outcome; error: WorkspaceExecutionError;
  status: number | null; retryCount: number; retries: Retry[];
}
interface Audit { revision: number; resourceBinding: WorkspaceResourceBinding; runId: string; agentId: string; operations: WorkspaceExecutionObservation[] }
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const httpStatus = (value: unknown): value is number | null => value === null || (nonnegative(value) && value >= 100 && value <= 599);
const nullableNumber = (value: unknown) => value === null || nonnegative(value);
const keys = ["kind", "call", "name", "startedAt", "endedAt", "durationMs", "outcome", "error", "status", "retryCount", "retries"];
const retryKeys = ["attempt", "nextAttempt", "kind", "delayMs", "elapsedMs", "status"];
function valid(row: unknown): boolean {
  return plain(row) && exact(row, keys) && ["model", "tool"].includes(String(row.kind))
    && nonnegative(row.call) && row.call > 0 && typeof row.name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(row.name)
    && nonnegative(row.startedAt) && nullableNumber(row.endedAt) && nullableNumber(row.durationMs)
    && ["running", "completed", "error", "cancelled"].includes(String(row.outcome))
    && (row.error === null || ["provider_error", "tool_error", "thrown", "cancelled", "budget_exhausted"].includes(String(row.error)))
    && httpStatus(row.status) && nonnegative(row.retryCount) && Array.isArray(row.retries) && row.retries.length <= 8
    && row.retries.length <= row.retryCount && row.retries.every(retry => plain(retry) && exact(retry, retryKeys)
      && nonnegative(retry.attempt) && retry.attempt > 0 && nonnegative(retry.nextAttempt) && retry.nextAttempt === retry.attempt + 1
      && ["rate_limit", "overloaded", "timeout", "transient"].includes(String(retry.kind))
      && nonnegative(retry.delayMs) && nonnegative(retry.elapsedMs) && httpStatus(retry.status))
    && (row.outcome === "running" ? row.endedAt === null && row.durationMs === null && row.error === null
      : row.endedAt !== null && row.durationMs !== null && Number(row.endedAt) >= row.startedAt);
}
/** Persist the start before dispatch and the end after physical settlement, including late cancellation.
 * Never retain arguments, output, prompt, reasoning, model names, paths or raw exception messages.
 * Repeated tool executions are separate call rows; tools are never automatically retried here. */
export class WorkspaceExecutionAudit {
  private readonly state: WorkspaceJsonState<Audit>;
  constructor(storage: WorkspaceResourceStorage, runId: string, agentId: string) {
    this.state = new WorkspaceJsonState(storage, `execution-${runId}.json`, value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "runId", "agentId", "operations"])
        || !nonnegative(value.revision) || value.revision < 1 || value.runId !== runId || value.agentId !== agentId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.operations) || value.operations.length > 320 || !value.operations.every(valid)) throw new Error("invalid Workspace execution audit");
      return value as unknown as Audit;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), runId, agentId, operations: [] }));
  }
  read(): Readonly<Audit> { return this.state.read(); }
  start(kind: "model" | "tool", call: number, name: string): number {
    const before = this.state.read(), index = before.operations.length;
    if (index >= 320) throw new Error("Workspace execution audit limit reached");
    this.state.update(before.revision, value => ({ ...value, operations: [...value.operations, {
      kind, call, name, startedAt: Date.now(), endedAt: null, durationMs: null, outcome: "running", error: null,
      status: null, retryCount: 0, retries: [],
    }] }));
    return index;
  }
  retry(index: number, event: ProviderRetryEvent): void {
    this.update(index, row => ({ ...row, retryCount: row.retryCount + 1, retries: [...row.retries.slice(-7), {
      attempt: event.attempt, nextAttempt: event.nextAttempt, kind: event.kind, delayMs: event.delayMs,
      elapsedMs: event.elapsedMs, status: event.status ?? null,
    }] }));
  }
  finish(index: number, durationMs: number, outcome: Exclude<Outcome, "running">, error: WorkspaceExecutionError, status: number | null = null): void {
    this.update(index, row => ({ ...row, endedAt: Math.max(row.startedAt, Date.now()), durationMs: Math.max(0, Math.round(durationMs)), outcome, error, status }));
  }
  private update(index: number, change: (row: WorkspaceExecutionObservation) => WorkspaceExecutionObservation): void {
    const before = this.state.read(), row = before.operations[index];
    if (!row || row.outcome !== "running") throw new Error("Workspace execution audit operation already ended");
    this.state.update(before.revision, value => ({ ...value, operations: value.operations.map((item, i) => i === index ? change(item) : item) }));
  }
}
