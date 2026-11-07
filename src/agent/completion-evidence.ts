import type { NativeWorkspaceEvidence } from "../agent-runtime/execution-policy.js";
import { createHash } from "node:crypto";
import type { TaskExecution } from "../session/task.js";
import type { ToolEffect } from "../tools/registry.js";
import { redactSensitiveText, requestsCredentialDisclosure } from "../security/secrets.js";

const MAX_OBSERVATIONS = 512;
const MAX_REFERENCES = 4;
const EXCLUDED_TOOLS = new Set([
  "task_intake", "task_checkpoint", "todo_write", "ask_user", "tool_search", "tool_result_read",
  "memory_search", "session_search", "skill", "mcp_connect", "workspace_receipt_read",
]);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Only task authority changes invalidate observations; ordinary checkpoint/usage updates do not. */
export function completionEvidenceScope(task: TaskExecution | undefined): string | undefined {
  if (!task?.brief) return undefined;
  return digest(JSON.stringify([task.id, task.turnId, task.startedAt, task.objective, task.brief,
    task.steering?.map(({ id, content, createdAt }) => [id, content, createdAt])]));
}

export interface CompletionObservation {
  key: string;
  scope: string;
  eligible: boolean;
  ambiguous: boolean;
  mutating: boolean;
  receipt?: string;
}

export interface CompletionEvidenceSnapshot { schemaVersion: 1; observations: CompletionObservation[] }
/** Host-private storage only; never accept this snapshot from model history, RPC or a runtime. */
export function parseCompletionEvidenceSnapshot(value: unknown): CompletionEvidenceSnapshot {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
    && [Object.prototype, null].includes(Object.getPrototypeOf(v));
  const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const invalid = (): never => { throw new Error("Invalid private completion provenance; state was preserved"); };
  if (!plain(value) || !exact(value, ["schemaVersion", "observations"]) || value.schemaVersion !== 1
    || !Array.isArray(value.observations) || value.observations.length > MAX_OBSERVATIONS) return invalid();
  const observations = value.observations.map((row): CompletionObservation => {
    if (!plain(row) || !exact(row, ["key", "scope", "eligible", "ambiguous", "mutating", ...(Object.hasOwn(row, "receipt") ? ["receipt"] : [])])
      || !hash(row.key) || !hash(row.scope) || typeof row.eligible !== "boolean" || typeof row.ambiguous !== "boolean" || typeof row.mutating !== "boolean"
      || (Object.hasOwn(row, "receipt") && (!hash(row.receipt) || !row.eligible))) return invalid();
    return structuredClone(row) as unknown as CompletionObservation;
  });
  if (new Set(observations.map(row => row.key)).size !== observations.length) return invalid();
  return { schemaVersion: 1, observations };
}

/** Bounded dispatch provenance, not a semantic/business-success oracle. No arguments, raw results or
 * credentials. Workspace Host may restore its protected same-run journal; history is never a source.
 * Native diff evidence is deliberately attempt-local and absent from the durable snapshot. */
export class CompletionEvidenceLedger {
  private native?: { scope: string; evidence: NativeWorkspaceEvidence };
  observeNative(scope: string | undefined, evidence: NativeWorkspaceEvidence | null): void {
    this.native = scope && evidence?.verified && evidence.nativeEventCount > 0 ? { scope, evidence: structuredClone(evidence) } : undefined;
  }
  private readonly observations = new Map<string, CompletionObservation>();
  private readonly fresh = new Set<string>();
  constructor(private readonly journal?: { restored: unknown; persist(value: CompletionEvidenceSnapshot): void;
    recovery?: { previousScope: string; currentScope: string } }) {
    if (journal) for (const row of parseCompletionEvidenceSnapshot(journal.restored).observations) this.observations.set(row.key, row);
  }
  private persist(): void {
    this.journal?.persist({ schemaVersion: 1, observations: [...this.observations.values()].map(row => structuredClone(row)) });
  }

  begin(scope: string | undefined, id: string, name: string, effect: ToolEffect | undefined): CompletionObservation | undefined {
    if (!scope || !id || id.length > 240 || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
    const key = digest(JSON.stringify([scope, id]));
    const previous = this.observations.get(key);
    if (previous) {
      previous.ambiguous = true; // including denied/failed reuses; never resurrect an earlier success
      this.persist(); return undefined;
    }
    if (this.observations.size >= MAX_OBSERVATIONS) return undefined; // fail closed, no eviction/reuse
    const observation: CompletionObservation = {
      key, scope, ambiguous: false, mutating: effect === "edit" || effect === "exec" || effect === "computer",
      eligible: !EXCLUDED_TOOLS.has(name) && effect !== undefined && effect !== "state" && effect !== "interactive",
    };
    this.observations.set(key, observation); this.fresh.add(key);
    try { this.persist(); } catch (error) { observation.ambiguous = true; throw error; }
    return observation;
  }

  finish(observation: CompletionObservation | undefined, result: string, failed: boolean): void {
    if (!observation || !observation.eligible || observation.ambiguous || failed) return;
    observation.receipt = digest(JSON.stringify([observation.key, digest(result)]));
    try { this.persist(); } catch (error) { delete observation.receipt; observation.ambiguous = true; throw error; }
  }

  /** Optional checks augment legacy evidence without changing stored task schemas or adding a model
   * round. A cited success proves only that the tool result was observed, NOT that its interpretation
   * or every external business requirement is true. */
  bind(task: TaskExecution | undefined, input: unknown): { ok: true; input: unknown } | { ok: false; reason: string } {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: true, input };
    const checkpoint = input as Record<string, unknown>;
    const completion = checkpoint.completion;
    if (!completion || typeof completion !== "object" || Array.isArray(completion)) return { ok: true, input };
    const receipt = completion as Record<string, unknown>;
    if (!("checks" in receipt)) return { ok: true, input }; // legacy callers remain unchanged
    const scope = completionEvidenceScope(task);
    const acceptance = task?.brief?.acceptance;
    if (receipt.state !== "verified" || !scope || !acceptance?.length) {
      return { ok: false, reason: "completion.checks requires verified state and the current accepted task brief" };
    }
    if (!Array.isArray(receipt.checks) || receipt.checks.length !== acceptance.length) {
      return { ok: false, reason: "completion.checks must cover each current acceptance_index exactly once" };
    }
    let hasMutation = false, allChecksFresh = true;
    const seen = new Set<number>();
    const evidence: { index: number; text: string }[] = [];
    for (const raw of receipt.checks) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid completion check" };
      const check = raw as Record<string, unknown>;
      const index = check.acceptance_index;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= acceptance.length || seen.has(index)) {
        return { ok: false, reason: "completion.checks must cover each current acceptance_index exactly once" };
      }
      if (typeof check.evidence !== "string" || !check.evidence.trim() || check.evidence.length > 400
        || requestsCredentialDisclosure(check.evidence)) {
        return { ok: false, reason: "each completion check needs a short, credential-free evidence interpretation (maximum 400 characters)" };
      }
      const ids = check.tool_call_ids ?? [], nativeIds = check.native_evidence_ids ?? [];
      if (!Array.isArray(ids) || !Array.isArray(nativeIds) || ids.length + nativeIds.length < 1 || ids.length + nativeIds.length > MAX_REFERENCES || new Set([...ids, ...nativeIds]).size !== ids.length + nativeIds.length) {
        return { ok: false, reason: "each completion check needs 1-4 distinct observed tool_call_ids or native_evidence_ids" };
      }
      const references: string[] = []; let freshCheck = false;
      for (const id of ids) {
        if (typeof id !== "string" || !id || id.length > 240 || /[\u0000-\u001f\u007f]/u.test(id)) {
          return { ok: false, reason: "invalid completion tool_call_id" };
        }
        const observation = this.observations.get(digest(JSON.stringify([scope, id])));
        if (!observation?.receipt || observation.ambiguous || !observation.eligible) {
          return { ok: false, reason: "completion references an unavailable, failed, bookkeeping, ambiguous or stale tool result; reconcile existing receipts without repeating side effects" };
        }
        freshCheck ||= this.fresh.has(observation.key);
        references.push(`sha256:${observation.receipt}`); hasMutation ||= observation.mutating;
      }
      for (const id of nativeIds) {
        const proof = this.native?.scope === scope ? this.native.evidence : undefined;
        if (!proof || typeof id !== "string" || proof.id !== id || !nativeEvidenceAllowedForTask(task)) {
          return { ok: false, reason: "native evidence is unavailable, stale, ambiguous or outside this file-change task" };
        }
        references.push(`native-workspace-diff:sha256:${proof.digest}`); hasMutation = true;
      }
      allChecksFresh &&= freshCheck;
      seen.add(index);
      const interpretation = redactSensitiveText(check.evidence).text.replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").trim();
      evidence.push({ index, text: `Criterion ${index + 1}: ${interpretation} [engine-observed sources: ${references.join(", ")}]` });
    }
    // Only the trusted Host can link a same-task continuation or actual pending-question answer. A previous
    // dispatch proves an effect occurred, never its current state: EVERY criterion must cite a
    // successful newly dispatched observation in this attempt. Native diffs are never carried.
    if (task?.brief?.intent === "change" && !hasMutation && allChecksFresh && this.journal?.recovery?.currentScope === scope) {
      const previous = [...this.observations.values()].find(row => row.scope === this.journal!.recovery!.previousScope
        && row.mutating && row.eligible && !row.ambiguous && row.receipt);
      if (previous && evidence[0]) {
        hasMutation = true;
        evidence[0].text += " [Host-linked previous dispatch: sha256:" + previous.receipt + "; current state re-observed]";
      }
    }
    if (task?.brief?.intent === "change" && !hasMutation) return { ok: false, reason: "a change completion requires at least one observed write effect; read-only checks are insufficient" };
    const { checks: _checks, ...rest } = receipt;
    return { ok: true, input: { ...checkpoint, completion: { ...rest,
      evidence: evidence.sort((a, b) => a.index - b.index).map((item) => item.text) } } };
  }
}

/** Native file evidence cannot attest to Hara management or scheduling state. */
export function nativeEvidenceAllowedForTask(task: TaskExecution | undefined): boolean {
  return task?.brief?.intent === "change" && !/(?:同事|委派|定时|定時|排程|colleague|delegate|schedule|permission tier|workspace membership|(?:create|rename|archive|invite|remove|delete)\s+(?:(?:a|an|the|new|existing|another)\s+){0,4}(?:agent|bot|member|workspace)\b)/iu.test(task.objective);
}
