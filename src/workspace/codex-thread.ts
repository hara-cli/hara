// Host-private native context/telemetry. This is not execution authority or the Hara task budget.
import { createHash, randomUUID } from "node:crypto";
import { canonical, exact, plain, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";

export const nativeCodexId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export const nativeTokenCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
// Conservative default: leaves 32k of a 128k window for the next response and governance. Smaller
// reported model windows also reserve 25%. This limit is independent of the 128k *run* allowance.
export const DEFAULT_CODEX_CONTEXT_LIMIT = 96_000;
export function codexContextLimit(): number {
  const raw = process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS;
  if (raw === undefined) return DEFAULT_CODEX_CONTEXT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1024 || Number(raw) > 1_000_000)
    throw new Error("HARA_CODEX_CONTEXT_LIMIT_TOKENS must be an integer from 1024 to 1000000");
  return Number(raw);
}
export interface CodexThreadState {
  schemaVersion: 3; resourceBinding: WorkspaceResourceBinding; revision: number;
  agentId: string; sessionId: string; origin: string; threadId: string | null;
  input: number; output: number; cachedInput: number | null;
  contextTokens: number | null; modelContextWindow: number | null;
  phase: "idle" | "unknown" | "new_session_required";
  lastAttempt: { input: number; output: number; cachedInput: number };
  resets: { requestId: string; actorId: string; at: string; oldThreadId: string | null; revision: number }[];
  /** Host-private model memory epoch; separate from Workspace resource authority generation. */
  contextGeneration: string | null; standingPromptHash: string | null;
}
const LEGACY_FIELDS = ["schemaVersion", "resourceBinding", "revision", "agentId", "sessionId", "origin", "threadId", "input", "output", "phase"];
const FIELDS = [...LEGACY_FIELDS, "cachedInput", "contextTokens", "modelContextWindow", "lastAttempt", "resets"];
const V3_FIELDS = [...FIELDS, "contextGeneration", "standingPromptHash"];
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const codexConversationKey = (binding: WorkspaceResourceBinding, agentId: string, sessionId: string): string => hash([binding, agentId, sessionId]);
export function codexThreadState(storage: WorkspaceResourceStorage, agentId: string, sessionId: string, origin = hash("uninitialized")): WorkspaceJsonState<CodexThreadState> {
  const state: WorkspaceJsonState<CodexThreadState> = new WorkspaceJsonState(storage, "codex-thread-" + hash([agentId, sessionId]).slice(0, 24) + ".json", raw => {
    const fail = (): never => { throw new Error("Saved Codex thread binding is invalid; history was preserved"); };
    if (!plain(raw) || ![1, 2, 3].includes(Number(raw.schemaVersion)) || !exact(raw, raw.schemaVersion === 1 ? LEGACY_FIELDS : raw.schemaVersion === 2 ? FIELDS : V3_FIELDS)
      || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
      || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, state.binding())
      || raw.agentId !== agentId || raw.sessionId !== sessionId || typeof raw.origin !== "string" || !/^[a-f0-9]{64}$/.test(raw.origin)
      || !(raw.threadId === null || nativeCodexId(raw.threadId)) || !nativeTokenCount(raw.input) || !nativeTokenCount(raw.output)
      || !["idle", "unknown", ...(raw.schemaVersion !== 1 ? ["new_session_required"] : [])].includes(String(raw.phase))) return fail();
    // Legacy cache watermarks are unknown. Never subtract a historical cache total from fresh input.
    const v2 = raw.schemaVersion === 1 ? { ...raw, cachedInput: null, contextTokens: null, modelContextWindow: null,
      lastAttempt: { input: 0, output: 0, cachedInput: 0 }, resets: [] } : raw;
    const value = raw.schemaVersion === 3 ? raw : { ...v2, schemaVersion: 3, contextGeneration: null, standingPromptHash: null };
    if (!(value.cachedInput === null || nativeTokenCount(value.cachedInput) && value.cachedInput <= Number(value.input))
      || !(value.contextTokens === null || nativeTokenCount(value.contextTokens))
      || !(value.modelContextWindow === null || nativeTokenCount(value.modelContextWindow) && value.modelContextWindow > 0)
      || !plain(value.lastAttempt) || !exact(value.lastAttempt, ["input", "output", "cachedInput"])
      || !Object.values(value.lastAttempt).every(nativeTokenCount) || Number(value.lastAttempt.cachedInput) > Number(value.lastAttempt.input)
      || !Array.isArray(value.resets) || value.resets.length > 1024
      || !(value.contextGeneration === null || typeof value.contextGeneration === "string" && UUID.test(value.contextGeneration))
      || !(value.standingPromptHash === null || typeof value.standingPromptHash === "string" && /^[a-f0-9]{64}$/.test(value.standingPromptHash))) return fail();
    const seen = new Set<string>();
    for (const row of value.resets) {
      if (!plain(row) || !exact(row, ["requestId", "actorId", "at", "oldThreadId", "revision"])
        || typeof row.requestId !== "string" || !UUID.test(row.requestId) || seen.has(row.requestId)
        || typeof row.actorId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.actorId)
        || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))
        || !(row.oldThreadId === null || nativeCodexId(row.oldThreadId)) || !nativeTokenCount(row.revision) || row.revision < 1 || row.revision > Number(raw.revision)) return fail();
      seen.add(row.requestId);
    }
    return structuredClone(value) as unknown as CodexThreadState;
  }, () => ({ schemaVersion: 3, resourceBinding: state.binding(), revision: 0, agentId, sessionId, origin, threadId: null,
    input: 0, output: 0, cachedInput: 0, contextTokens: null, modelContextWindow: null, phase: "idle",
    lastAttempt: { input: 0, output: 0, cachedInput: 0 }, resets: [], contextGeneration: null, standingPromptHash: null }));
  return state;
}
export function nativeContextLimit(value: CodexThreadState): number {
  return Math.min(codexContextLimit(), value.modelContextWindow === null ? Infinity : Math.max(1, Math.floor(value.modelContextWindow * 0.75)));
}
/** Compact before the existing conservative hard cap, leaving 30% for new work. Cached tokens still occupy context. */
export function codexCompactionThreshold(value: CodexThreadState): number {
  return Math.max(1, Math.floor(nativeContextLimit(value) * 0.7));
}
export function nativeContextFull(value: CodexThreadState): boolean {
  return value.phase === "new_session_required" || value.contextTokens !== null && value.contextTokens >= nativeContextLimit(value);
}
export function codexThreadView(value: CodexThreadState) {
  return { runtimeId: "codex" as const, revision: value.revision,
    status: nativeContextFull(value) ? "new_session_required" as const : value.threadId === null ? "empty" as const
      : value.phase === "unknown" ? "recovery_needed" as const : "ready" as const,
    contextTokens: value.contextTokens, contextLimit: nativeContextLimit(value),
    lastAttempt: { ...value.lastAttempt }, lastResetRequestId: value.resets.at(-1)?.requestId ?? null };
}

/** Separate audit document preserves v3 thread-state rollback compatibility. No prompt/tool bodies. */
export function recordCodexEmptyThreadReset(storage: WorkspaceResourceStorage, value: CodexThreadState, oldThreadId: string, newThreadId: string): CodexThreadState["resets"][number] {
  interface Entry { requestId: string; at: string; reason: "codex_thread_never_materialized"; oldThreadId: string; newThreadId: string }
  interface Audit { schemaVersion: 1; revision: number; resourceBinding: WorkspaceResourceBinding; agentId: string; sessionId: string; entries: Entry[] }
  const state: WorkspaceJsonState<Audit> = new WorkspaceJsonState(storage,
    "codex-empty-thread-resets-" + hash([value.agentId, value.sessionId]).slice(0, 24) + ".json", raw => {
      if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "agentId", "sessionId", "entries"])
        || raw.schemaVersion !== 1 || !nativeTokenCount(raw.revision) || Number(raw.revision) < 1
        || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, state.binding())
        || raw.agentId !== value.agentId || raw.sessionId !== value.sessionId || !Array.isArray(raw.entries) || raw.entries.length > 1024)
        throw new Error("Invalid empty Codex thread reset audit");
      const seen = new Set<string>();
      for (const row of raw.entries) {
        if (!plain(row) || !exact(row, ["requestId", "at", "reason", "oldThreadId", "newThreadId"])
          || typeof row.requestId !== "string" || !UUID.test(row.requestId) || seen.has(row.requestId)
          || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) || row.reason !== "codex_thread_never_materialized"
          || !nativeCodexId(row.oldThreadId) || !nativeCodexId(row.newThreadId) || row.oldThreadId === row.newThreadId)
          throw new Error("Invalid empty Codex thread reset audit entry");
        seen.add(row.requestId);
      }
      return structuredClone(raw) as unknown as Audit;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: state.binding(), agentId: value.agentId, sessionId: value.sessionId, entries: [] }));
  if (value.input !== 0 || value.output !== 0 || value.contextTokens !== null || value.threadId !== oldThreadId
    || !nativeCodexId(newThreadId) || newThreadId === oldThreadId) throw new Error("Nonempty Codex thread reset refused");
  const entry: Entry = { requestId: randomUUID(), at: new Date().toISOString(), reason: "codex_thread_never_materialized", oldThreadId, newThreadId };
  const current = state.read();
  state.update(current.revision, audit => ({ ...audit, entries: [...audit.entries.slice(-1023), entry] }));
  return { requestId: entry.requestId, at: entry.at, actorId: "system", oldThreadId, revision: value.revision + 1 };
}
