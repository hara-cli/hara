// Explicit Host-only reset epochs. Durable UI history and previous native files are retained.
import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntimeId } from "../agent-runtime/bindings.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
export const resettableNativeRuntime = (id: unknown): id is "pi" | "claude" => id === "pi" || id === "claude";
interface Entry { requestId: string; runtimeId: "pi" | "claude"; epoch: string; historyStart: number; actorId: string; at: string; revision: number }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; agentId: string; sessionId: string; entries: Entry[] }
export class WorkspaceNativeSessions {
  private readonly state: WorkspaceJsonState<State>;
  constructor(storage: WorkspaceResourceStorage, agentId: string, sessionId: string) {
    if (!isWorkspaceAgentId(agentId) || !UUID.test(sessionId)) throw new Error("Invalid native session identity");
    const key = createHash("sha256").update(canonical([agentId, sessionId])).digest("hex").slice(0, 24);
    this.state = new WorkspaceJsonState(storage, "native-session-boundary-" + key + ".json", raw => {
      if (!plain(raw) || !exact(raw, ["revision", "resourceBinding", "agentId", "sessionId", "entries"]) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
        || raw.agentId !== agentId || raw.sessionId !== sessionId || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(raw.entries) || raw.entries.length > 1024 || new Set(raw.entries.map(row => row?.requestId)).size !== raw.entries.length
        || raw.entries.some(row => !plain(row) || !exact(row, ["requestId", "runtimeId", "epoch", "historyStart", "actorId", "at", "revision"])
          || ![row.requestId, row.epoch].every(id => typeof id === "string" && UUID.test(id)) || !resettableNativeRuntime(row.runtimeId)
          || !Number.isSafeInteger(row.historyStart) || Number(row.historyStart) < 0 || Number(row.historyStart) > 4000
          || typeof row.actorId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.actorId) || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
          || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || Number(row.revision) > Number(raw.revision))) throw new Error("Invalid native reset audit; history was preserved");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), agentId, sessionId, entries: [] }));
  }
  read() { return this.state.read(); }
  latest(runtimeId: AgentRuntimeId, length: number) {
    const last = [...this.state.read().entries].reverse().find(row => row.runtimeId === runtimeId);
    if (last && last.historyStart > length) throw new Error("Native history moved behind its reset boundary");
    return last ?? null;
  }
  reset(expected: number, requestId: string, runtimeId: "pi" | "claude", historyStart: number, actorId: string) {
    const previous = this.state.read(), duplicate = previous.entries.find(row => row.requestId === requestId);
    if (duplicate) { if (duplicate.runtimeId !== runtimeId) throw new Error("Native reset request changed"); return { requestId, revision: duplicate.revision, duplicate: true }; }
    if (previous.revision !== expected || previous.entries.length >= 1024) throw new Error("Native reset state changed or audit is full; refresh before resetting");
    const entry: Entry = { requestId, runtimeId, epoch: randomUUID(), historyStart, actorId, at: new Date().toISOString(), revision: expected + 1 };
    const value = this.state.update(expected, current => ({ ...current, entries: [...current.entries, entry] }));
    return { requestId, revision: value.revision, duplicate: false };
  }
  view(runtimeId: "pi" | "claude", historyLength: number) {
    const value = this.state.read(), last = this.latest(runtimeId, historyLength);
    return { runtimeId, revision: value.revision, status: historyLength === (last?.historyStart ?? 0) ? "empty" as const : "ready" as const,
      contextTokens: null, contextLimit: null, lastAttempt: { input: 0, output: 0, cachedInput: 0 }, lastResetRequestId: last?.requestId ?? null };
  }
}
