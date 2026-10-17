import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { canonical, exact, plain, positive, UUID, WorkspaceJsonState } from "./local-state.js";
import type { WorkspaceRunBinding } from "./run-binding.js";
import type { WorkspaceUsage } from "./conversations.js";

interface TreeBudgetState { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding;
  rootRunId: string; limits: WorkspaceRunBinding["budget"]; usage: WorkspaceUsage }
export class WorkspaceBudgetAdmissionError extends Error {
  constructor(readonly reason: string) { super(`Workspace resume budget exhausted (${reason}); no model call or new chat turn started`); }
}
/** Reserve before effects. A failed downstream journal may conservatively overcount, never undercount. */
export class WorkspaceTreeBudget {
  private readonly state: WorkspaceJsonState<TreeBudgetState>;
  constructor(storage: WorkspaceResourceStorage, rootRunId: string, limits: WorkspaceRunBinding["budget"]) {
    if (!UUID.test(rootRunId)) throw new Error("invalid Workspace budget root");
    this.state = new WorkspaceJsonState(storage, `tree-budget-${rootRunId}.json`, value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "rootRunId", "limits", "usage"])
        || value.schemaVersion !== 1 || !positive(value.revision) || value.rootRunId !== rootRunId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || canonical(value.limits) !== canonical(limits) || !plain(value.usage)
        || !exact(value.usage, ["modelCalls", "toolCalls", "inputTokens", "outputTokens"])
        || !Object.values(value.usage).every(v => Number.isSafeInteger(v) && Number(v) >= 0)) throw new Error("invalid Workspace tree budget; execution refused");
      return structuredClone(value) as unknown as TreeBudgetState;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), rootRunId, limits: { ...limits },
      usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } }));
  }
  read(): Readonly<TreeBudgetState> { return this.state.read(); }
  /** Read-only admission BEFORE provider construction, continuation/fence or chat persistence. */
  assertResumeAdmission(runUsage: WorkspaceUsage): void {
    const tree = this.read();
    for (const [scope, usage] of [["run", runUsage], ["tree", tree.usage]] as const) {
      if (usage.modelCalls >= tree.limits.maxRounds) throw new WorkspaceBudgetAdmissionError(`${scope}_rounds`);
      if (usage.toolCalls >= tree.limits.maxToolCalls) throw new WorkspaceBudgetAdmissionError(`${scope}_tools`);
      if (usage.inputTokens + usage.outputTokens >= tree.limits.maxTokens) throw new WorkspaceBudgetAdmissionError(`${scope}_tokens`);
    }
    if (tree.revision === 0 && Object.values(runUsage).some(value => value > 0)) throw new WorkspaceBudgetAdmissionError("missing_tree_receipt");
  }
  consume(delta: WorkspaceUsage): void {
    const before = this.state.read();
    this.state.update(before.revision, current => {
      if (Object.values(delta).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid Workspace budget delta");
      if ((delta.modelCalls || delta.toolCalls) && (current.usage.modelCalls + delta.modelCalls > current.limits.maxRounds
        || current.usage.toolCalls + delta.toolCalls > current.limits.maxToolCalls
        || current.usage.inputTokens + current.usage.outputTokens >= current.limits.maxTokens)) throw new Error("Workspace delegation-tree budget exhausted; no action started");
      for (const key of Object.keys(delta) as (keyof WorkspaceUsage)[]) {
        if (!Number.isSafeInteger(current.usage[key] + delta[key])) throw new Error("Workspace budget exhausted");
        current.usage[key] += delta[key];
      }
      return current;
    });
  }
}
