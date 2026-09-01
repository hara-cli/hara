// hara serve session hub — the in-memory registry of live sessions behind the WS server. Persistence is
// the SAME ~/.hara/sessions store the CLI uses, so a serve session and `hara resume <id>` are the same
// thing (the single-writer lock keeps them from racing). The store is injected so tests run hermetically.
import type { NeutralMsg, Provider } from "../providers/types.js";
import type { ApprovalMode } from "../config.js";
import {
  type SessionMeta,
  type SessionData,
  type SessionMetadataPage,
  type SessionMetadataPageOptions,
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  listSessionMetadataPage,
  acquireSessionLock,
  releaseSessionLock,
  deleteSession,
  deriveTitle,
  sanitizeSessionTitle,
  sessionMetadataMatchesOptions,
} from "../session/store.js";
import { forkTaskExecution, recoverTaskExecution, type TaskExecution } from "../session/task.js";

export interface SessionStore {
  load(id: string): SessionData | null;
  save(meta: SessionMeta, history: NeutralMsg[], task?: TaskExecution): void;
  list(cwd?: string): SessionMeta[];
  /** Optional bounded metadata path. Real persistence provides it; small injected test stores may fall
   * back to an in-memory page without changing their transcript semantics. */
  listPage?(options?: SessionMetadataPageOptions): SessionMetadataPage;
  acquire(id: string): { ok: boolean; pid?: number };
  release(id: string): void;
  /** permanent removal (codex thread/delete); false = missing or held by a live other process */
  delete(id: string): boolean;
}

/** The real ~/.hara/sessions store (default). */
export const realStore: SessionStore = {
  load: loadSession,
  save: saveSession,
  list: listSessions,
  listPage: listSessionMetadataPage,
  acquire: acquireSessionLock,
  release: releaseSessionLock,
  delete: deleteSession,
};

export interface ServeSession {
  meta: SessionMeta;
  history: NeutralMsg[];
  task?: TaskExecution;
  provider: Provider;
  approval: ApprovalMode;
  autoApprove: Set<string>; // opaque project-scope grants accepted while this session is attached
  stats: { input: number; output: number; lastInput?: number };
  projectContext?: string;
  /** This live attachment came from persisted history (resume/fork), not a fresh empty session. */
  continuationSession: boolean;
  /** False only for a freshly-created, still-empty draft. It exists in the live client but is not placed
   * in durable history until the first user turn/task, so opening and abandoning “new chat” leaves no
   * orphan transcript. Omitted by older embedders means already durable. */
  durable?: boolean;
  busy: boolean; // one turn per session at a time
  configuring: boolean; // provider/model/resume handshakes are serialized against turns/deletes
  /** Provider Promises that are still physically in flight after the agent's hard cancellation boundary. */
  pendingProviderTurns: number;
  /** Tool Promises still physically in flight after a logical deadline/cancel boundary. */
  pendingToolRuns: number;
  abort: AbortController | null; // in-flight turn/compaction interrupt handle
  /** Per-session thinking dial. `null` freezes provider/model automatic; `undefined` is legacy inherit. */
  effort?: string | null;
}

/** Embedders predating Space metadata may still pass only a profile id. Treat every non-default route
 * as its own organization boundary until a runtime supplies an authoritative Space id; misclassifying a
 * named personal route is recoverable, while misclassifying a company route as Personal can leak history. */
function failClosedSpaceId(profileId?: string): string {
  return profileId && profileId !== "personal" ? `org-profile:${profileId}` : "personal";
}

const HUB_SESSION_CURSOR_PREFIX = "hara-live-v1:";

type HubSessionCursor =
  | { phase: "drafts"; offset: number }
  | { phase: "stored"; cursor?: string };

function encodeHubSessionCursor(cursor: HubSessionCursor): string {
  return `${HUB_SESSION_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeHubSessionCursor(value: string): HubSessionCursor | null {
  if (!value.startsWith(HUB_SESSION_CURSOR_PREFIX) || value.length > 8_192) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(HUB_SESSION_CURSOR_PREFIX.length), "base64url").toString("utf8")) as Partial<HubSessionCursor>;
    if (parsed.phase === "drafts") {
      return Number.isSafeInteger(parsed.offset) && (parsed.offset ?? -1) >= 0
        ? { phase: "drafts", offset: parsed.offset! }
        : null;
    }
    if (parsed.phase === "stored") {
      return parsed.cursor === undefined || (typeof parsed.cursor === "string" && parsed.cursor.length > 0)
        ? { phase: "stored", ...(parsed.cursor ? { cursor: parsed.cursor } : {}) }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

export class SessionHub {
  private sessions = new Map<string, ServeSession>();
  constructor(private store: SessionStore = realStore, private haraVersion?: string) {}

  private stampVersion(meta: SessionMeta): void {
    if (this.haraVersion) meta.haraVersion = this.haraVersion;
  }

  /** Mutate an on-disk session under the same single-writer lock used by live sessions. The load happens
   *  only AFTER acquisition, so a writer that finished immediately before us cannot be overwritten by a
   *  stale pre-lock snapshot. */
  private mutateStored(id: string, mutate: (data: SessionData) => void): boolean {
    const lock = this.store.acquire(id);
    if (!lock.ok) return false;
    try {
      const current = this.store.load(id);
      if (!current) return false;
      mutate(current);
      this.stampVersion(current.meta);
      this.store.save(current.meta, current.history, current.task);
      return true;
    } finally {
      this.store.release(id);
    }
  }

  create(o: { cwd: string; profileId?: string; spaceId?: string; provider: Provider; providerId: string; model: string; effort?: string | null; approval: ApprovalMode; projectContext?: string; agentRef?: string }): ServeSession {
    const profileId = o.profileId ?? "personal";
    const createdAt = new Date().toISOString();
    const meta: SessionMeta = {
      id: newSessionId(),
      cwd: o.cwd,
      ...(this.haraVersion ? { haraVersion: this.haraVersion } : {}),
      profileId,
      spaceId: o.spaceId ?? failClosedSpaceId(profileId),
      provider: o.providerId,
      model: o.model,
      approval: o.approval,
      title: "",
      createdAt,
      // A live draft needs a stable timeline position before its first durable save. saveSession replaces
      // this timestamp when the first user turn is written.
      updatedAt: createdAt,
      source: "interactive", // serve sessions are user-driven (desktop/IDE clients)
      ...(o.effort !== undefined ? { effort: o.effort } : {}),
      ...(o.agentRef ? { agentRef: o.agentRef } : {}),
    };
    const lock = this.store.acquire(meta.id); // fresh UUID, but filesystem errors must still fail closed
    if (!lock.ok) throw new Error(`could not acquire session lock for ${meta.id}${lock.pid ? ` (held by pid ${lock.pid})` : ""}`);
    const s: ServeSession = { meta, history: [], provider: o.provider, approval: o.approval, autoApprove: new Set(), stats: { input: 0, output: 0 }, projectContext: o.projectContext, continuationSession: false, durable: false, busy: false, configuring: false, pendingProviderTurns: 0, pendingToolRuns: 0, abort: null, effort: o.effort };
    try {
      this.sessions.set(meta.id, s);
      return s;
    } catch (error) {
      this.sessions.delete(meta.id);
      this.store.release(meta.id);
      throw error;
    }
  }

  /** Resume a persisted session. Returns the live session, or a lock/missing failure. */
  resume(
    id: string,
    o: {
      provider: Provider;
      approval: ApprovalMode;
      legacyApproval?: ApprovalMode;
      projectContext?: string;
    },
  ): { session: ServeSession } | { missing: true } | { lockedBy: number } | { busy: true } {
    const live = this.sessions.get(id);
    if (live?.busy || live?.configuring) return { busy: true };
    if (live) return { session: live }; // already attached to this server
    const lock = this.store.acquire(id);
    if (!lock.ok) return { lockedBy: lock.pid ?? 0 };
    let keepLock = false;
    try {
      const prior = this.store.load(id); // lock-before-load: this is the authoritative latest snapshot
      if (!prior) return { missing: true };
      // Credentials are refreshed live inside the session's persisted identity route; the model remains
      // the session's explicit pin.
      prior.meta.provider = o.provider.id;
      this.stampVersion(prior.meta);
      const task = recoverTaskExecution(prior.task);
      const approval = prior.meta.approval ?? o.legacyApproval ?? o.approval;
      prior.meta.approval = approval;
      const s: ServeSession = { meta: prior.meta, history: [...prior.history], task, provider: o.provider, approval, autoApprove: new Set(), stats: { input: 0, output: 0 }, projectContext: o.projectContext, continuationSession: prior.history.length > 0, durable: true, busy: false, configuring: false, pendingProviderTurns: 0, pendingToolRuns: 0, abort: null, effort: prior.meta.effort };
      this.sessions.set(id, s);
      keepLock = true; // live session owns it until delete/releaseAll
      return { session: s };
    } finally {
      if (!keepLock) this.store.release(id);
    }
  }

  get(id: string): ServeSession | undefined {
    return this.sessions.get(id);
  }

  /** Dismissal is an Agent-wide lifecycle operation, not just a property of the currently selected chat. */
  hasActiveWorkForAgent(agentRef: string): boolean {
    return [...this.sessions.values()].some((session) =>
      session.meta.agentRef === agentRef
      && (
        session.busy
        || session.configuring
        || session.abort !== null
        || session.pendingProviderTurns > 0
        || session.pendingToolRuns > 0
      ));
  }

  /** Drop an attached but idle session and release its lock without deleting persistence. This is used
   * when resume attached successfully but live provider validation failed before the client got a handle. */
  detach(id: string): boolean {
    const live = this.sessions.get(id);
    if (
      !live ||
      live.busy ||
      live.configuring ||
      live.abort !== null ||
      live.pendingProviderTurns > 0 ||
      live.pendingToolRuns > 0
    ) return false;
    this.sessions.delete(id);
    this.store.release(id);
    return true;
  }

  /** Read model/cwd routing metadata without attaching the session. The authoritative resume still reloads
   * after acquiring its lock; callers use this only to build the likely provider before that handoff. */
  peekMeta(id: string): SessionMeta | undefined {
    return this.sessions.get(id)?.meta ?? this.store.load(id)?.meta;
  }

  /** Read a local conversation without attaching a provider or acquiring its writer lock. Session files
   * are atomically replaced by the store, so this is a safe recovery path for history whose persisted
   * model/profile is no longer authorized. The returned clone can never mutate live or stored state. */
  read(id: string): SessionData | null {
    const live = this.sessions.get(id);
    const source: SessionData | null = live
      ? {
          meta: live.meta,
          history: live.history,
          ...(live.task ? { task: live.task } : {}),
        }
      : this.store.load(id);
    return source ? structuredClone(source) : null;
  }

  list(cwd?: string): SessionMeta[] {
    const options = cwd ? { cwd } : {};
    const drafts = this.liveDrafts(options);
    const draftIds = new Set(drafts.map((meta) => meta.id));
    return [...drafts, ...this.store.list(cwd).filter((meta) => !draftIds.has(meta.id))]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  listPage(options: SessionMetadataPageOptions = {}): SessionMetadataPage {
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const suppliedCursor = options.cursor;
    const hubCursor = suppliedCursor?.startsWith(HUB_SESSION_CURSOR_PREFIX)
      ? decodeHubSessionCursor(suppliedCursor)
      : undefined;
    if (suppliedCursor?.startsWith(HUB_SESSION_CURSOR_PREFIX) && !hubCursor) {
      throw new Error("invalid session metadata cursor");
    }

    // A continuation in the durable phase must never prepend live drafts again. Raw cursors are accepted
    // for compatibility with clients that cached a pre-0.160 page cursor.
    if (hubCursor?.phase === "stored" || (suppliedCursor !== undefined && hubCursor === undefined)) {
      const stored = this.listStoredPage({
        ...options,
        ...(hubCursor?.phase === "stored"
          ? (hubCursor.cursor ? { cursor: hubCursor.cursor } : { cursor: undefined })
          : {}),
        limit,
      });
      return {
        ...stored,
        ...(stored.nextCursor
          ? { nextCursor: encodeHubSessionCursor({ phase: "stored", cursor: stored.nextCursor }) }
          : {}),
      };
    }

    const { cursor: _cursor, limit: _limit, ...filters } = options;
    const drafts = this.liveDrafts(filters);
    const draftOffset = hubCursor?.phase === "drafts" ? hubCursor.offset : 0;
    const sessions = drafts.slice(draftOffset, draftOffset + limit);
    const nextDraftOffset = draftOffset + sessions.length;
    if (nextDraftOffset < drafts.length) {
      return {
        sessions,
        hasMore: true,
        nextCursor: encodeHubSessionCursor({ phase: "drafts", offset: nextDraftOffset }),
        limit,
      };
    }

    const remaining = limit - sessions.length;
    if (remaining > 0) {
      const stored = this.listStoredPage({ ...filters, limit: remaining });
      sessions.push(...stored.sessions);
      return {
        sessions,
        hasMore: stored.hasMore,
        ...(stored.nextCursor
          ? { nextCursor: encodeHubSessionCursor({ phase: "stored", cursor: stored.nextCursor }) }
          : {}),
        limit,
      };
    }

    // The page ended exactly at the live/durable boundary. Probe one bounded stored result so hasMore is
    // truthful without persisting the drafts or enumerating the transcript directory.
    const storedProbe = this.listStoredPage({ ...filters, limit: 1 });
    const hasMore = storedProbe.sessions.length > 0 || storedProbe.hasMore;
    return {
      sessions,
      hasMore,
      ...(storedProbe.sessions.length > 0
        ? { nextCursor: encodeHubSessionCursor({ phase: "stored" }) }
        : storedProbe.nextCursor
          ? { nextCursor: encodeHubSessionCursor({ phase: "stored", cursor: storedProbe.nextCursor }) }
          : {}),
      limit,
    };
  }

  private liveDrafts(options: Omit<SessionMetadataPageOptions, "cursor" | "limit">): SessionMeta[] {
    return [...this.sessions.values()]
      .filter((session) => session.durable === false)
      .map((session) => session.meta)
      .filter((meta) => sessionMetadataMatchesOptions(meta, options))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  private listStoredPage(options: SessionMetadataPageOptions): SessionMetadataPage {
    if (this.store.listPage) return this.store.listPage(options);
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
    const offsetMatch = options.cursor === undefined
      ? null
      : /^memory:(\d{1,9})$/.exec(options.cursor);
    if (options.cursor !== undefined && !offsetMatch) {
      throw new Error("invalid session metadata cursor");
    }
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const { cursor: _cursor, limit: _limit, ...filters } = options;
    const filtered = this.store.list(options.cwd)
      .filter((meta) => sessionMetadataMatchesOptions(meta, filters))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const sessions = filtered.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < filtered.length;
    return {
      sessions,
      hasMore,
      ...(hasMore ? { nextCursor: `memory:${nextOffset}` } : {}),
      limit,
    };
  }

  /** Persist a session after a turn (sets a title from the first user message once). */
  save(s: ServeSession): void {
    if (!s.meta.title) {
      const first = s.history.find((m) => m.role === "user");
      if (first && "content" in first && typeof first.content === "string") s.meta.title = deriveTitle(first.content);
    }
    this.stampVersion(s.meta);
    if (s.durable === false && s.history.length === 0 && !s.task) return;
    this.store.save(s.meta, s.history, s.task);
    s.durable = true;
  }

  /** Persist a projected transcript/task transition without mutating the live arrays first. Steering uses
   *  this write-ahead snapshot so an accepted inbox item is durable in history before runAgent observes it. */
  saveSnapshot(s: ServeSession, history: NeutralMsg[], task: TaskExecution | undefined): void {
    if (!s.meta.title) {
      const first = history.find((m) => m.role === "user");
      if (first && "content" in first && typeof first.content === "string") s.meta.title = deriveTitle(first.content);
    }
    this.stampVersion(s.meta);
    if (s.durable === false && history.length === 0 && !task) return;
    this.store.save(s.meta, history, task);
    s.durable = true;
  }

  /** Rename a session (live or on-disk). Returns false when the id is unknown. */
  rename(id: string, title: string): boolean {
    const safeTitle = sanitizeSessionTitle(title);
    const live = this.sessions.get(id);
    if (live) {
      if (live.busy || live.configuring) return false;
      live.meta.title = safeTitle;
      this.stampVersion(live.meta);
      this.save(live);
      return true;
    }
    return this.mutateStored(id, (current) => {
      current.meta.title = safeTitle;
    });
  }

  /** Archive/unarchive (hidden from lists, kept on disk). Returns false when unknown. */
  setArchived(id: string, on: boolean): boolean {
    const live = this.sessions.get(id);
    if (live) {
      if (live.busy || live.configuring) return false;
      live.meta.archived = on;
      this.stampVersion(live.meta);
      this.save(live);
      return true;
    }
    return this.mutateStored(id, (current) => {
      current.meta.archived = on;
    });
  }

  /** Change one conversation's approval policy. The active turn remains immutable; callers retry after
   * it finishes. Persisting the choice keeps reconnect/restart semantics identical to the visible UI. */
  setApproval(id: string, approval: ApprovalMode): "updated" | "busy" | "missing" {
    const live = this.sessions.get(id);
    if (live) {
      if (live.busy || live.configuring) return "busy";
      live.approval = approval;
      live.meta.approval = approval;
      this.stampVersion(live.meta);
      this.save(live);
      return "updated";
    }
    const updated = this.mutateStored(id, (current) => {
      current.meta.approval = approval;
    });
    return updated ? "updated" : "missing";
  }

  /** Fork: duplicate a session's history into a NEW session (codex thread/fork) — the non-destructive
   *  sibling of rewind. Source may be live or on-disk; the fork is always a fresh live session. */
  fork(
    id: string,
    o: {
      profileId?: string;
      spaceId?: string;
      model?: string;
      /** Frozen default for the new fork. `null` means provider/model automatic. */
      effort?: string | null;
      provider: Provider;
      providerId: string;
      approval: ApprovalMode;
      projectContext?: string;
      /** Immutable source captured before asynchronous target-provider setup. A live turn may continue
       * changing after this snapshot, but the fork remains one coherent point-in-time copy. */
      sourceSnapshot?: SessionData;
    },
  ): { session: ServeSession } | { missing: true } | { busy: true } {
    const live = this.sessions.get(id);
    if (live?.configuring) return { busy: true };
    const src: { meta: SessionMeta; history: NeutralMsg[]; task?: TaskExecution } | null =
      o.sourceSnapshot ?? live ?? this.store.load(id);
    if (!src) return { missing: true };
    const sourceProfileId = src.meta.profileId ?? "personal";
    const targetProfileId = o.profileId ?? sourceProfileId;
    const sourceSpaceId = src.meta.spaceId ?? failClosedSpaceId(sourceProfileId);
    const targetSpaceId = o.spaceId
      ?? (targetProfileId === sourceProfileId ? sourceSpaceId : failClosedSpaceId(targetProfileId));
    const targetModel = o.model ?? (src.meta.model || o.provider.model);
    const preservesRoute = targetProfileId === sourceProfileId && targetModel === src.meta.model;
    const approval = src.meta.approval ?? o.approval;
    const meta: SessionMeta = {
      id: newSessionId(),
      cwd: src.meta.cwd,
      ...(this.haraVersion ? { haraVersion: this.haraVersion } : {}),
      profileId: targetProfileId,
      spaceId: targetSpaceId,
      provider: o.providerId,
      model: targetModel,
      approval,
      title: src.meta.title ? `${src.meta.title} ⑂` : "",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
      ...(src.meta.workingSet ? { workingSet: [...src.meta.workingSet] } : {}),
      ...(src.meta.todos ? { todos: src.meta.todos.map((todo) => ({ ...todo, ...(todo.blockedBy ? { blockedBy: [...todo.blockedBy] } : {}) })) } : {}),
      ...(o.effort !== undefined
        ? { effort: o.effort }
        : preservesRoute && src.meta.effort !== undefined
          ? { effort: src.meta.effort }
          : {}),
      ...(targetProfileId === sourceProfileId && targetSpaceId === sourceSpaceId && src.meta.agentRef
        ? { agentRef: src.meta.agentRef }
        : {}),
    };
    const lock = this.store.acquire(meta.id);
    if (!lock.ok) throw new Error(`could not acquire fork lock for ${meta.id}${lock.pid ? ` (held by pid ${lock.pid})` : ""}`);
    const history = structuredClone(src.history);
    // A live agent appends assistant tool_use before the matching tool result. Copying at that exact
    // boundary would create an invalid conversation that the target provider cannot resume. Preserve the
    // user's current request and every closed round, but omit only the unfinished assistant action.
    const trailing = history.at(-1);
    if (trailing?.role === "assistant" && trailing.toolUses.length > 0) history.pop();
    const s: ServeSession = {
      meta,
      history,
      task: forkTaskExecution(src.task),
      provider: o.provider,
      approval,
      autoApprove: new Set(),
      stats: { input: 0, output: 0 },
      projectContext: o.projectContext,
      continuationSession: history.length > 0,
      durable: true,
      busy: false,
      configuring: false,
      pendingProviderTurns: 0,
      pendingToolRuns: 0,
      abort: null,
      effort: o.effort !== undefined ? o.effort : preservesRoute ? src.meta.effort : undefined,
    };
    try {
      this.sessions.set(meta.id, s);
      this.store.save(meta, s.history, s.task); // persist immediately — a fork should survive a crash unsent
      return { session: s };
    } catch (error) {
      this.sessions.delete(meta.id);
      this.store.release(meta.id);
      throw error;
    }
  }

  /** Permanently delete (live or on-disk). Refuses a busy live session. Returns:
   *  "gone" on success, "busy" when a turn is running, "missing" when unknown/held elsewhere. */
  delete(id: string): "gone" | "busy" | "missing" {
    const live = this.sessions.get(id);
    if (
      live?.busy ||
      live?.configuring ||
      (live?.abort ?? null) !== null ||
      (live?.pendingProviderTurns ?? 0) > 0 ||
      (live?.pendingToolRuns ?? 0) > 0
    ) return "busy";
    if (live?.durable === false) {
      this.sessions.delete(id);
      this.store.release(id);
      return "gone";
    }
    const ok = this.store.delete(id);
    if (!ok) return "missing";
    if (live) this.sessions.delete(id);
    this.store.release(id);
    return "gone";
  }

  /** Release all locks (server shutdown). In-flight turns are aborted by the caller first. */
  releaseAll(): void {
    for (const id of this.sessions.keys()) this.store.release(id);
    this.sessions.clear();
  }

  /** Snapshot live sessions for graceful shutdown/health handling. */
  active(): ServeSession[] {
    return [...this.sessions.values()];
  }

  /** Release only idle sessions; logical work and abandoned-but-physical provider turns retain their locks. */
  releaseIdle(): void {
    for (const [id, session] of this.sessions) {
      if (session.busy || session.configuring || session.pendingProviderTurns > 0 || session.pendingToolRuns > 0) continue;
      this.store.release(id);
      this.sessions.delete(id);
    }
  }
}
