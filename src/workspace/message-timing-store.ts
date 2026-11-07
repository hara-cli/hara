import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { parseMessageTimingReport, type MessageTimingReport } from "./message-timing.js";
interface TimingDocument { revision: number; resourceBinding: WorkspaceResourceBinding; sessionId: string; agentId: string; reports: MessageTimingReport[] }
/** Separate from immutable runtime terminal receipts: late renderer timing may fill only T7. */
export class WorkspaceMessageTimingStore {
  private readonly state: WorkspaceJsonState<TimingDocument>;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly sessionId: string, private readonly agentId: string) {
    if (!UUID.test(sessionId)) throw new Error("Invalid message timing session");
    this.state = new WorkspaceJsonState(storage, `message-timings-${sessionId}.json`, value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "sessionId", "agentId", "reports"])
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || value.sessionId !== sessionId || value.agentId !== agentId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || !Array.isArray(value.reports) || value.reports.length > 16) throw new Error("Invalid message timing metadata");
      const reports = value.reports.map(value => this.owned(value));
      if (new Set(reports.map(row => row.attemptId)).size !== reports.length) throw new Error("Duplicate message timing metadata");
      return { revision: Number(value.revision), resourceBinding: value.resourceBinding as unknown as WorkspaceResourceBinding, sessionId, agentId, reports };
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), sessionId, agentId, reports: [] }));
  }
  private owned(value: unknown): MessageTimingReport {
    const report = parseMessageTimingReport(value);
    if (!report || report.workspaceId !== this.storage.scope.workspaceId || report.sessionId !== this.sessionId || report.agentId !== this.agentId
      || report.resourceGeneration !== this.state.binding().generation) throw new Error("Foreign message timing metadata");
    return report;
  }
  list(): MessageTimingReport[] { return this.state.read().reports; }
  save(value: MessageTimingReport): void {
    const report = this.storage.run(() => this.owned(value)), before = this.state.read(), old = before.reports.find(row => row.attemptId === report.attemptId);
    if (old) {
      if (canonical(old) === canonical(report)) return;
      const { points: previous, ...identity } = old, { points: next, ...newIdentity } = report;
      if (canonical(identity) !== canonical(newIdentity) || Object.keys(previous).some(key => {
        const point = key as keyof typeof previous;
        return previous[point] !== null && previous[point] !== next[point] || previous.T9 !== null && point !== "T7" && previous[point] !== next[point];
      })) throw new Error("Message timing observations cannot be rewritten");
    }
    this.state.update(before.revision, current => ({ ...current, reports: [...current.reports.filter(row => row.attemptId !== report.attemptId), report].slice(-16) }));
  }
}
