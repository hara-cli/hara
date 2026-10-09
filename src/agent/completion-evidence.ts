import { createHash } from "node:crypto";
import type { TaskExecution } from "../session/task.js";
import type { ToolEffect } from "../tools/registry.js";
import { redactSensitiveText, requestsCredentialDisclosure } from "../security/secrets.js";

const MAX_OBSERVATIONS = 512;
const MAX_REFERENCES = 4;
const EXCLUDED_TOOLS = new Set([
  "task_intake", "task_checkpoint", "todo_write", "ask_user", "tool_search", "tool_result_read",
  "memory_search", "session_search", "skill", "mcp_connect",
]);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Only task authority changes invalidate observations; ordinary checkpoint/usage updates do not. */
export function completionEvidenceScope(task: TaskExecution | undefined): string | undefined {
  if (!task?.brief) return undefined;
  return digest(JSON.stringify([task.id, task.turnId, task.startedAt, task.objective, task.brief,
    task.steering?.map(({ id, content, createdAt }) => [id, content, createdAt])]));
}

interface Observation {
  key: string;
  eligible: boolean;
  ambiguous: boolean;
  receipt?: string;
}

/** Run-local, bounded provenance, not a semantic/business-success oracle. Never retains tool arguments,
 * raw results or credentials. Observations can only be supplied by the dispatch boundary, not history. */
export class CompletionEvidenceLedger {
  private readonly observations = new Map<string, Observation>();

  begin(scope: string | undefined, id: string, name: string, effect: ToolEffect | undefined): Observation | undefined {
    if (!scope || !id || id.length > 240 || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
    const key = digest(JSON.stringify([scope, id]));
    const previous = this.observations.get(key);
    if (previous) {
      previous.ambiguous = true; // including denied/failed reuses; never resurrect an earlier success
      return undefined;
    }
    if (this.observations.size >= MAX_OBSERVATIONS) return undefined; // fail closed, no eviction/reuse
    const observation: Observation = {
      key, ambiguous: false,
      eligible: !EXCLUDED_TOOLS.has(name) && effect !== undefined && effect !== "state" && effect !== "interactive",
    };
    this.observations.set(key, observation);
    return observation;
  }

  finish(observation: Observation | undefined, result: string, failed: boolean): void {
    if (!observation || !observation.eligible || observation.ambiguous || failed) return;
    observation.receipt = digest(JSON.stringify([observation.key, digest(result)]));
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
      const ids = check.tool_call_ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_REFERENCES || new Set(ids).size !== ids.length) {
        return { ok: false, reason: "each completion check needs 1-4 distinct observed tool_call_ids" };
      }
      const references: string[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || !id || id.length > 240 || /[\u0000-\u001f\u007f]/u.test(id)) {
          return { ok: false, reason: "invalid completion tool_call_id" };
        }
        const observation = this.observations.get(digest(JSON.stringify([scope, id])));
        if (!observation?.receipt || observation.ambiguous || !observation.eligible) {
          return { ok: false, reason: "completion references an unavailable, failed, bookkeeping, ambiguous or stale tool result; reconcile existing receipts without repeating side effects" };
        }
        references.push(`sha256:${observation.receipt}`);
      }
      seen.add(index);
      const interpretation = redactSensitiveText(check.evidence).text.replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").trim();
      evidence.push({ index, text: `Criterion ${index + 1}: ${interpretation} [engine-observed sources: ${references.join(", ")}]` });
    }
    const { checks: _checks, ...rest } = receipt;
    return { ok: true, input: { ...checkpoint, completion: { ...rest,
      evidence: evidence.sort((a, b) => a.index - b.index).map((item) => item.text) } } };
  }
}
