import { exact, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import type { WorkspaceColleagueReference } from "./start-context.js";
interface Relations { revision: number; resourceBinding: WorkspaceResourceBinding; merges: { from: string; to: string }[] }

/** Rename aliases come from immutable configurations. A merge is explicit owner composition data,
 * never a guessed similarity or model-provided authority. No HTTP/model mutation tool is exposed. */
export class WorkspaceColleagueReferences {
  private readonly state: WorkspaceJsonState<Relations>;
  constructor(storage: WorkspaceResourceStorage, private readonly roster: () => WorkspaceColleagueReference[]) {
    this.state = new WorkspaceJsonState(storage, "colleague-references.json", value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "merges"])
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.merges) || value.merges.length > 512
        || !value.merges.every(row => plain(row) && exact(row, ["from", "to"]) && isWorkspaceAgentId(row.from)
          && isWorkspaceAgentId(row.to) && row.from !== row.to)
        || new Set(value.merges.map(row => (row as { from: string }).from)).size !== value.merges.length) throw new Error("invalid colleague relations; execution refused");
      return value as unknown as Relations;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), merges: [] }));
  }
  read(): WorkspaceColleagueReference[] {
    const rows = this.roster(), merges = this.state.read().merges;
    return rows.map(row => {
      let target = row.agentId; const seen = new Set<string>();
      while (merges.some(merge => merge.from === target)) {
        if (seen.has(target) || seen.size >= 32) throw new Error("cyclic or excessive colleague merge chain");
        seen.add(target);
        const source = rows.find(item => item.agentId === target);
        if (!source || source.state !== "archived") throw new Error("merged colleague source is not archived");
        target = merges.find(merge => merge.from === target)!.to;
      }
      if (seen.size && !rows.some(item => item.agentId === target && item.state === "active")) throw new Error("colleague merge target is unavailable");
      return { ...row, ...(seen.size ? { mergedInto: target } : {}) };
    });
  }
  recordMerge(from: string, to: string, expectedRevision: number): void {
    const rows = this.roster();
    if (from === to || !rows.some(row => row.agentId === from && row.state === "archived")
      || !rows.some(row => row.agentId === to && row.state === "active")) throw new Error("merge needs a same-Workspace archived source and active target");
    this.state.update(expectedRevision, value => {
      if (value.merges.some(row => row.from === from)) throw new Error("colleague merge already recorded");
      return { ...value, merges: [...value.merges, { from, to }] };
    });
  }
}
