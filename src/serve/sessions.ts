// hara serve session hub — the in-memory registry of live sessions behind the WS server. Persistence is
// the SAME ~/.hara/sessions store the CLI uses, so a serve session and `hara resume <id>` are the same
// thing (the single-writer lock keeps them from racing). The store is injected so tests run hermetically.
import type { NeutralMsg, Provider } from "../providers/types.js";
import type { ApprovalMode } from "../config.js";
import {
  type SessionMeta,
  type SessionData,
  newSessionId,
  saveSession,
  loadSession,
  listSessions,
  acquireSessionLock,
  releaseSessionLock,
  deleteSession,
  deriveTitle,
} from "../session/store.js";

export interface SessionStore {
  load(id: string): SessionData | null;
  save(meta: SessionMeta, history: NeutralMsg[]): void;
  list(cwd?: string): SessionMeta[];
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
  acquire: acquireSessionLock,
  release: releaseSessionLock,
  delete: deleteSession,
};

export interface ServeSession {
  meta: SessionMeta;
  history: NeutralMsg[];
  provider: Provider;
  approval: ApprovalMode;
  autoApprove: Set<string>; // "don't ask again" tool names, session-scoped (runAgent mutates it)
  stats: { input: number; output: number; lastInput?: number };
  projectContext?: string;
  busy: boolean; // one turn per session at a time
  configuring: boolean; // provider/model/resume handshakes are serialized against turns/deletes
  /** Provider Promises that are still physically in flight after the agent's hard cancellation boundary. */
  pendingProviderTurns: number;
  /** Tool Promises still physically in flight after a logical deadline/cancel boundary. */
  pendingToolRuns: number;
  abort: AbortController | null; // in-flight turn/compaction interrupt handle
  /** per-session thinking dial override (set via session.set-model) — informational; the provider carries it */
  effort?: string;
}

export class SessionHub {
  private sessions = new Map<string, ServeSession>();
  constructor(private store: SessionStore = realStore) {}

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
      this.store.save(current.meta, current.history);
      return true;
    } finally {
      this.store.release(id);
    }
  }

  create(o: { cwd: string; provider: Provider; providerId: string; model: string; approval: ApprovalMode; projectContext?: string }): ServeSession {
    const meta: SessionMeta = {
      id: newSessionId(),
      cwd: o.cwd,
      provider: o.providerId,
      model: o.model,
      title: "",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive", // serve sessions are user-driven (desktop/IDE clients)
    };
    const lock = this.store.acquire(meta.id); // fresh UUID, but filesystem errors must still fail closed
    if (!lock.ok) throw new Error(`could not acquire session lock for ${meta.id}${lock.pid ? ` (held by pid ${lock.pid})` : ""}`);
    const s: ServeSession = { meta, history: [], provider: o.provider, approval: o.approval, autoApprove: new Set(), stats: { input: 0, output: 0 }, projectContext: o.projectContext, busy: false, configuring: false, pendingProviderTurns: 0, pendingToolRuns: 0, abort: null };
    try {
      this.sessions.set(meta.id, s);
      this.store.save(meta, []); // an empty newly-created thread must survive restart and appear in lists
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
    o: { provider: Provider; approval: ApprovalMode; projectContext?: string },
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
      // Credential/provider routing is live, while the model remains the session's explicit pin.
      prior.meta.provider = o.provider.id;
      const s: ServeSession = { meta: prior.meta, history: [...prior.history], provider: o.provider, approval: o.approval, autoApprove: new Set(), stats: { input: 0, output: 0 }, projectContext: o.projectContext, busy: false, configuring: false, pendingProviderTurns: 0, pendingToolRuns: 0, abort: null, effort: prior.meta.effort };
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

  /** Drop an attached but idle session and release its lock without deleting persistence. This is used
   * when resume attached successfully but live provider validation failed before the client got a handle. */
  detach(id: string): boolean {
    const live = this.sessions.get(id);
    if (!live || live.busy || live.configuring) return false;
    this.sessions.delete(id);
    this.store.release(id);
    return true;
  }

  /** Read model/cwd routing metadata without attaching the session. The authoritative resume still reloads
   * after acquiring its lock; callers use this only to build the likely provider before that handoff. */
  peekMeta(id: string): SessionMeta | undefined {
    return this.sessions.get(id)?.meta ?? this.store.load(id)?.meta;
  }

  list(cwd?: string): SessionMeta[] {
    return this.store.list(cwd);
  }

  /** Persist a session after a turn (sets a title from the first user message once). */
  save(s: ServeSession): void {
    if (!s.meta.title) {
      const first = s.history.find((m) => m.role === "user");
      if (first && "content" in first && typeof first.content === "string") s.meta.title = deriveTitle(first.content);
    }
    this.store.save(s.meta, s.history);
  }

  /** Rename a session (live or on-disk). Returns false when the id is unknown. */
  rename(id: string, title: string): boolean {
    const live = this.sessions.get(id);
    if (live) {
      if (live.busy || live.configuring) return false;
      live.meta.title = title;
      this.store.save(live.meta, live.history);
      return true;
    }
    return this.mutateStored(id, (current) => {
      current.meta.title = title;
    });
  }

  /** Archive/unarchive (hidden from lists, kept on disk). Returns false when unknown. */
  setArchived(id: string, on: boolean): boolean {
    const live = this.sessions.get(id);
    if (live) {
      if (live.busy || live.configuring) return false;
      live.meta.archived = on;
      this.store.save(live.meta, live.history);
      return true;
    }
    return this.mutateStored(id, (current) => {
      current.meta.archived = on;
    });
  }

  /** Fork: duplicate a session's history into a NEW session (codex thread/fork) — the non-destructive
   *  sibling of rewind. Source may be live or on-disk; the fork is always a fresh live session. */
  fork(
    id: string,
    o: { provider: Provider; providerId: string; approval: ApprovalMode; projectContext?: string },
  ): { session: ServeSession } | { missing: true } | { busy: true } {
    const live = this.sessions.get(id);
    if (live?.busy || live?.configuring) return { busy: true };
    const src: { meta: SessionMeta; history: NeutralMsg[] } | null = live ?? this.store.load(id);
    if (!src) return { missing: true };
    const meta: SessionMeta = {
      id: newSessionId(),
      cwd: src.meta.cwd,
      provider: o.providerId,
      model: src.meta.model,
      title: src.meta.title ? `${src.meta.title} ⑂` : "",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
      ...(src.meta.workingSet ? { workingSet: [...src.meta.workingSet] } : {}),
      ...(src.meta.todos ? { todos: src.meta.todos.map((todo) => ({ ...todo, ...(todo.blockedBy ? { blockedBy: [...todo.blockedBy] } : {}) })) } : {}),
      ...(src.meta.effort ? { effort: src.meta.effort } : {}),
    };
    const lock = this.store.acquire(meta.id);
    if (!lock.ok) throw new Error(`could not acquire fork lock for ${meta.id}${lock.pid ? ` (held by pid ${lock.pid})` : ""}`);
    const s: ServeSession = {
      meta,
      history: [...src.history],
      provider: o.provider,
      approval: o.approval,
      autoApprove: new Set(),
      stats: { input: 0, output: 0 },
      projectContext: o.projectContext,
      busy: false,
      configuring: false,
      pendingProviderTurns: 0,
      pendingToolRuns: 0,
      abort: null,
      effort: src.meta.effort,
    };
    try {
      this.sessions.set(meta.id, s);
      this.store.save(meta, s.history); // persist immediately — a fork should survive a crash unsent
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
    if (live?.busy || live?.configuring) return "busy";
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
