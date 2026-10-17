import type { WorkspaceResourceStorage, WorkspaceResourceBinding } from "./resource-context.js";
import { sameWorkspaceResourceBinding } from "./resource-context.js";
import { exact, plain, WorkspaceJsonState } from "./local-state.js";
import type { WorkspaceContextStats } from "./model-context.js";

export interface WorkspaceContextObservation extends WorkspaceContextStats {
  modelCall: number; systemChars: number; toolSchemaChars: number; systemAndToolsUtf8Bytes: number;
  modelHistoryChars: number; wakeChars: number; input: number | null; output: number | null; inputWarning: boolean;
}
interface Audit { revision: number; resourceBinding: WorkspaceResourceBinding; runId: string; agentId: string;
  observations: WorkspaceContextObservation[] }
/** Numeric diagnostics only. No prompt, tool body, credentials or private provider reasoning. */
export class WorkspaceContextAudit {
  private readonly state: WorkspaceJsonState<Audit>;
  constructor(storage: WorkspaceResourceStorage, runId: string, agentId: string) {
    const keys = ["modelCall", "systemChars", "toolSchemaChars", "systemAndToolsUtf8Bytes", "modelHistoryChars", "wakeChars", "input", "output", "inputWarning",
      "compacted", "originalChars", "recentChars", "summaryChars", "toolMaxChars", "agedToolMaxChars"];
    this.state = new WorkspaceJsonState(storage, `context-${runId}.json`, value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "runId", "agentId", "observations"])
        || value.runId !== runId || value.agentId !== agentId || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.observations) || value.observations.length > 64
        || value.observations.some(row => !plain(row) || !exact(row, keys) || keys.some(key => key === "inputWarning" || key === "compacted"
          ? typeof row[key] !== "boolean" : (key === "input" || key === "output") && row[key] === null ? false : !Number.isSafeInteger(row[key]) || Number(row[key]) < 0))) {
        throw new Error("invalid Workspace context audit");
      }
      return value as unknown as Audit;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), runId, agentId, observations: [] }));
  }
  append(observation: WorkspaceContextObservation): void {
    const before = this.state.read();
    if (before.observations.at(-1)?.modelCall !== undefined && before.observations.at(-1)!.modelCall >= observation.modelCall) throw new Error("Workspace context audit cannot reset");
    this.state.update(before.revision, value => ({ ...value, observations: [...value.observations, observation] }));
  }
}
