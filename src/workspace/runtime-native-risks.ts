import { createHash } from "node:crypto";
import { WorkspaceJsonState, plain, UUID } from "./local-state.js";
import type { WorkspaceResourceStorage } from "./resource-context.js";
import type { RuntimeRiskEvent } from "../agent-runtime/execution-policy.js";
interface RiskRow extends RuntimeRiskEvent { runId: string }
interface State { revision: number; agentId: string; sessionId: string; events: RiskRow[] }
/** Sanitized, bounded per-conversation observation log. It is never an approval or effect receipt. */
export class WorkspaceNativeRiskStore {
  private readonly state: WorkspaceJsonState<State>;
  constructor(storage: WorkspaceResourceStorage, agentId: string, sessionId: string) {
    const filename = "native-risks-" + createHash("sha256").update(JSON.stringify([agentId, sessionId])).digest("hex").slice(0, 40) + ".json";
    this.state = new WorkspaceJsonState(storage, filename, raw => {
      if (!plain(raw) || raw.agentId !== agentId || raw.sessionId !== sessionId || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
        || !Array.isArray(raw.events) || raw.events.length > 64) throw new Error("Invalid native risk log");
      const events = raw.events.map(row => {
        if (!plain(row) || !UUID.test(String(row.id)) || !UUID.test(String(row.runId)) || row.state !== "observed"
          || !["outside-workspace-delete", "external-publish"].includes(String(row.kind)) || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) throw new Error("Invalid native risk entry");
        const kind = row.kind as RuntimeRiskEvent["kind"];
        return { id: String(row.id), runId: String(row.runId), kind, state: "observed" as const, at: row.at,
          summary: kind === "external-publish" ? "Native runtime publication command observed" : "Native runtime deletion outside its working directory observed" };
      });
      return { revision: Number(raw.revision), agentId, sessionId, events };
    }, () => ({ revision: 0, agentId, sessionId, events: [] }));
  }
  read(): RiskRow[] { return this.state.read().events; }
  save(runId: string, events: readonly RuntimeRiskEvent[]): void {
    const current = this.state.read();
    this.state.update(current.revision, value => ({ ...value, events: [...value.events.filter(row => row.runId !== runId), ...events.map(row => ({ ...row, runId }))].slice(-64) }));
  }
}
