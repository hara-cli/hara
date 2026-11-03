// Host-only dispatch receipts. No RPC/model input and no native diff evidence enters this journal.
import type { TaskExecution } from "../session/task.js";
import { createHash } from "node:crypto";
import { CompletionEvidenceLedger, completionEvidenceScope, parseCompletionEvidenceSnapshot, type CompletionEvidenceSnapshot } from "../agent/completion-evidence.js";
import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { freezeWorkspaceRunBinding, workspaceRunBindingsEqual, workspaceRunMatchesTask, type WorkspaceRunBinding } from "./run-binding.js";

interface Document {
  schemaVersion: 1;
  revision: number;
  resourceBinding: WorkspaceResourceBinding;
  runBindingHash: string;
  snapshot: CompletionEvidenceSnapshot;
}
/** The whole frozen run binding, including task/Agent/connection/project/authority/budget, must match.
 * Per-operation updates are synchronous and atomic: persist pending before dispatch, success after
 * observation. A crash in between leaves an unusable receipt; it never authorizes automatic replay. */
export function createWorkspaceCompletionEvidence(storage: WorkspaceResourceStorage, input: WorkspaceRunBinding, resume?: { previousTask: TaskExecution; currentTask: TaskExecution; answeredQuestionId?: string }): CompletionEvidenceLedger {
  const binding = freezeWorkspaceRunBinding(input);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const runBindingHash = hash(canonical(binding));
  const invalid = (): never => { throw new Error("Invalid private completion run binding; state was preserved"); };
  const state: WorkspaceJsonState<Document> = new WorkspaceJsonState<Document>(storage, "completion-" + hash(binding.runId) + ".json", value => {
    if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "runBindingHash", "snapshot"])
      || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, state.binding())
      || value.runBindingHash !== runBindingHash) return invalid();
    return { schemaVersion: 1, revision: Number(value.revision), resourceBinding: state.binding(), runBindingHash,
      snapshot: parseCompletionEvidenceSnapshot(value.snapshot) };
  }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: state.binding(), runBindingHash,
    snapshot: { schemaVersion: 1, observations: [] } }));
  let current = state.read();
  let recovery: { previousScope: string; currentScope: string } | undefined;
  if (resume) {
    const { previousTask: before, currentTask: after } = resume;
    const authority = (task: TaskExecution) => canonical([task.id, task.objective, task.brief, task.steering ?? []]);
    const previousScope = completionEvidenceScope(before), currentScope = completionEvidenceScope(after);
    const priorDecisions = before.decisions ?? [], currentDecisions = after.decisions ?? [], answer = currentDecisions.at(-1);
    // A Host-validated pending question may add exactly its actual interactive answer. Defaults,
    // rewritten prior decisions, unknown questions and changed accepted scope cannot carry effects.
    const decisionsMatch = resume.answeredQuestionId === undefined
      ? canonical(priorDecisions) === canonical(currentDecisions)
      : UUID.test(resume.answeredQuestionId) && currentDecisions.length === priorDecisions.length + 1
        && canonical(currentDecisions.slice(0, -1)) === canonical(priorDecisions)
        && answer?.callId === resume.answeredQuestionId && answer.source === "interactive" && answer.turnId === before.turnId;
    if (!workspaceRunMatchesTask(before.workspaceRunBinding, before) || !workspaceRunMatchesTask(after.workspaceRunBinding, after)
      || !workspaceRunBindingsEqual(binding, before.workspaceRunBinding) || !workspaceRunBindingsEqual(binding, after.workspaceRunBinding)
      || authority(before) !== authority(after) || !decisionsMatch || !previousScope || !currentScope) return invalid();
    recovery = { previousScope, currentScope };
  }
  return new CompletionEvidenceLedger({ restored: current.snapshot, recovery, persist(snapshot) {
    current = state.update(current.revision, value => ({ ...value, snapshot }));
  } });
}
