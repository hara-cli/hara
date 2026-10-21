import { isWorkspaceAgentId } from "./agent-binding.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { exact, plain, positive, text, UUID, WorkspaceJsonState } from "./local-state.js";
import { channelSessionId } from "./channel-session.js";

export type WorkspaceRequestSource = "ui" | "cli" | "automatic_retry" | "delegation" | "host" | "legacy_rpc";
export interface WorkspaceRequestOrigin { source: WorkspaceRequestSource; channel: "rpc" | "cli" | "internal"; clientId: string; rpcIdHash?: string }
interface RequestEntry extends WorkspaceRequestOrigin {
  requestId: string; digest: string; operation: "send" | "resume" | "continue";
  receivedAt: string; settledAt: string | null; state: "received" | "accepted" | "rejected";
  taskId: string | null; runId: string | null; reason: string | null;
}
interface Journal { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; agentId: string; sessionId?: string; entries: RequestEntry[] }
const SOURCES = ["ui", "cli", "automatic_retry", "delegation", "host", "legacy_rpc"];
export function workspaceRequestSource(value: unknown): value is WorkspaceRequestSource { return typeof value === "string" && SOURCES.includes(value); }
function validOrigin(value: WorkspaceRequestOrigin): boolean {
  return workspaceRequestSource(value.source) && ["rpc", "cli", "internal"].includes(value.channel) && text(value.clientId, 128)
    && (value.rpcIdHash === undefined || /^[a-f0-9]{64}$/.test(value.rpcIdHash));
}
/** Separate from chat/model usage: refused resumes are auditable, not new conversation turns.
 * RPC source is client-declared diagnostic metadata, never an identity or authority grant. */
export class WorkspaceRequestJournal {
  private readonly state: WorkspaceJsonState<Journal>;
  constructor(storage: WorkspaceResourceStorage, agentId: string, channelId?: string) {
    if (!isWorkspaceAgentId(agentId)) throw new Error("invalid request journal Agent");
    const sessionId = channelId ? channelSessionId(channelId, agentId) : undefined;
    this.state = new WorkspaceJsonState(storage, `requests-${sessionId ?? agentId.slice(3)}.json`, value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "agentId", "entries", ...(sessionId ? ["sessionId"] : [])])
        || value.schemaVersion !== 1 || !positive(value.revision) || value.agentId !== agentId
        || (sessionId && value.sessionId !== sessionId)
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.entries) || value.entries.length > 512) throw new Error("invalid Workspace request journal; retained");
      const ids = new Set<string>();
      for (const entry of value.entries) {
        if (!plain(entry) || !exact(entry, ["source", "channel", "clientId", "requestId", "digest", "operation", "receivedAt", "settledAt", "state", "taskId", "runId", "reason",
          ...(Object.hasOwn(entry, "rpcIdHash") ? ["rpcIdHash"] : [])])
          || !validOrigin(entry as unknown as WorkspaceRequestOrigin) || typeof entry.requestId !== "string" || !UUID.test(entry.requestId) || ids.has(entry.requestId)
          || typeof entry.digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.digest) || !["send", "resume", "continue"].includes(String(entry.operation))
          || typeof entry.receivedAt !== "string" || !Number.isFinite(Date.parse(entry.receivedAt))
          || (entry.settledAt !== null && (typeof entry.settledAt !== "string" || !Number.isFinite(Date.parse(entry.settledAt))))
          || !["received", "accepted", "rejected"].includes(String(entry.state))
          || (entry.taskId !== null && (typeof entry.taskId !== "string" || !UUID.test(entry.taskId)))
          || (entry.runId !== null && (typeof entry.runId !== "string" || !UUID.test(entry.runId)))
          || (entry.reason !== null && (typeof entry.reason !== "string" || !/^[a-z_]{1,80}$/.test(entry.reason)))) throw new Error("invalid Workspace request provenance; retained");
        ids.add(entry.requestId);
      }
      return structuredClone(value) as unknown as Journal;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), agentId, ...(sessionId ? { sessionId } : {}), entries: [] }));
  }
  find(requestId: string): Readonly<RequestEntry> | undefined { return this.state.read().entries.find(entry => entry.requestId === requestId); }
  receive(input: Pick<RequestEntry, "requestId" | "digest" | "operation">, origin: WorkspaceRequestOrigin): void {
    if (!validOrigin(origin)) throw new Error("invalid Workspace request source");
    const before = this.state.read();
    this.state.update(before.revision, value => {
      if (value.entries.some(row => row.requestId === input.requestId)) throw new Error("Workspace request journal already owns this nonce");
      value.entries.push({ ...origin, ...input, receivedAt: new Date().toISOString(), settledAt: null, state: "received", taskId: null, runId: null, reason: null });
      return value;
    });
  }
  settle(requestId: string, state: "accepted" | "rejected", details: { taskId?: string; runId?: string; reason?: string }): void {
    const before = this.state.read(), prior = before.entries.find(row => row.requestId === requestId);
    if (!prior || prior.state !== "received") return;
    this.state.update(before.revision, value => {
      const entry = value.entries.find(row => row.requestId === requestId)!;
      Object.assign(entry, { state, settledAt: new Date().toISOString(), taskId: details.taskId ?? null, runId: details.runId ?? null, reason: details.reason ?? null });
      return value;
    });
  }
}
