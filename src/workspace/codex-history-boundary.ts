import { createHash } from "node:crypto";
import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import type { CodexThreadState } from "./codex-thread.js";

interface Boundary { requestId: string; historyStart: number }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; agentId: string; sessionId: string; entries: Boundary[] }
/** Write ahead of reset; only a matching committed native reset activates a boundary. Old v3 state stays readable. */
export class CodexHistoryBoundaries {
  private readonly state: WorkspaceJsonState<State>;
  constructor(storage: WorkspaceResourceStorage, agentId: string, sessionId: string) {
    if (!isWorkspaceAgentId(agentId) || !UUID.test(sessionId)) throw new Error("Invalid native history identity");
    const key = createHash("sha256").update(canonical([agentId, sessionId])).digest("hex").slice(0, 24);
    this.state = new WorkspaceJsonState(storage, "codex-history-boundary-" + key + ".json", raw => {
      if (!plain(raw) || !exact(raw, ["revision", "resourceBinding", "agentId", "sessionId", "entries"])
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || raw.agentId !== agentId || raw.sessionId !== sessionId
        || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || !Array.isArray(raw.entries) || raw.entries.length > 1024
        || !raw.entries.every(row => plain(row) && exact(row, ["requestId", "historyStart"]) && typeof row.requestId === "string" && UUID.test(row.requestId)
          && Number.isSafeInteger(row.historyStart) && Number(row.historyStart) >= 0 && Number(row.historyStart) <= 4000)
        || new Set(raw.entries.map(row => row.requestId)).size !== raw.entries.length) throw new Error("Invalid native history boundary; history preserved");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), agentId, sessionId, entries: [] }));
  }
  record(requestId: string, historyStart: number, committed: CodexThreadState["resets"]): void {
    if (!UUID.test(requestId) || !Number.isSafeInteger(historyStart) || historyStart < 0 || historyStart > 4000) throw new Error("Invalid native history boundary");
    const before = this.state.read(), found = before.entries.find(row => row.requestId === requestId);
    if (found) { if (found.historyStart !== historyStart) throw new Error("Native reset boundary changed"); return; }
    const retained = before.entries.filter(row => committed.some(reset => reset.requestId === row.requestId));
    if (retained.length >= 1024) throw new Error("Native history boundary audit is full");
    this.state.update(before.revision, value => ({ ...value, entries: [...retained, { requestId, historyStart }] }));
  }
  read(committed: CodexThreadState["resets"], historyLength: number): number {
    const entries = this.state.read().entries;
    for (const reset of [...committed].reverse()) {
      const entry = entries.find(row => row.requestId === reset.requestId);
      if (!entry) continue;
      if (entry.historyStart > historyLength) throw new Error("Native history moved behind its reset boundary");
      return entry.historyStart;
    }
    return 0; // Pre-boundary v3 records retain their original interpretation until the next explicit reset.
  }
}
