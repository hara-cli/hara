import { join } from "node:path";
import { withPrivateStateLockSync } from "../security/private-state.js";
import { readdirSync, rmSync } from "./resource-fs.js";
import { currentWorkspaceResourceBinding, inspectWorkspaceResourceFile, workspaceResourceDirectory, workspaceStateHome } from "./resource-context.js";
import type { ProviderRetryEvent } from "../providers/types.js";
import { exact, plain, text, UUID, WorkspaceJsonState } from "./local-state.js";
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
export const WORKSPACE_EXECUTION_AUDIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseAudit(value: unknown, binding: WorkspaceResourceBinding, runId: string, agentId?: string): Audit {
  if (!plain(value) || !exact(value, ["revision", "resourceBinding", "runId", "agentId", "operations"])
    || !nonnegative(value.revision) || value.revision < 1 || value.runId !== runId || !text(value.agentId, 128)
    || (agentId !== undefined && value.agentId !== agentId)
    || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, binding)
    || !Array.isArray(value.operations) || value.operations.length > 320 || !value.operations.every(valid)) throw new Error("invalid Workspace execution audit");
  return value as unknown as Audit;
}

/** Opportunistic cleanup in one already-authorized Workspace; never recurse or follow a file alias.
 * Share the writer's per-file interprocess lock, then re-read and validate before fenced removal.
 * An unfinished row after a crash is unknown physical work, irrespective of its age or UI state.
 * These files are diagnostics only; budgets, checkpoints, receipts and session state are untouched. */
export function pruneWorkspaceExecutionAudits(storage: WorkspaceResourceStorage, now = Date.now()): { removed: number; held: number } {
  if (!nonnegative(now)) throw new Error("invalid execution audit cleanup time");
  return storage.run(() => {
    const directory = workspaceResourceDirectory([]), result = { removed: 0, held: 0 };
    for (const filename of readdirSync(directory)) {
      const match = /^execution-([a-f0-9-]{36})\.json$/.exec(filename);
      if (!match || !UUID.test(match[1]!)) continue;
      try {
        withPrivateStateLockSync(workspaceStateHome(), [], filename.slice(0, -5), () => {
          const file = inspectWorkspaceResourceFile(join(directory, filename), 4 * 1024 * 1024);
          if (!file.snapshot) return;
          const audit = parseAudit(JSON.parse(file.snapshot.text), currentWorkspaceResourceBinding()!, match[1]!);
          if (!audit.operations.length || audit.operations.some(row => row.outcome === "running")) { result.held++; return; }
          const endedAt = Math.max(...audit.operations.map(row => row.endedAt!));
          if (now < endedAt || now - endedAt < WORKSPACE_EXECUTION_AUDIT_TTL_MS) return;
          file.assertCurrent();
          rmSync(file.path);
          result.removed++;
        }, { attempts: 1 });
      } catch { result.held++; } // Invalid, busy or changed entries stay intact; never guess a replacement.
    }
    return result;
  });
}

/** Persist the start before dispatch and the end after physical settlement, including late cancellation.
 * Never retain arguments, output, prompt, reasoning, model names, paths or raw exception messages.
 * Repeated tool executions are separate call rows; tools are never automatically retried here. */
export class WorkspaceExecutionAudit {
  private readonly state: WorkspaceJsonState<Audit>;
  constructor(storage: WorkspaceResourceStorage, runId: string, agentId: string) {
    this.state = new WorkspaceJsonState(storage, `execution-${runId}.json`, value => {
      return parseAudit(value, this.state.binding(), runId, agentId);
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
