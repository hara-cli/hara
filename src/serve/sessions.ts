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
  abort: AbortController | null; // in-flight turn's interrupt handle
  /** per-session thinking dial override (set via session.set-model) — informational; the provider carries it */
  effort?: string;
}

export class SessionHub {
  private sessions = new Map<string, ServeSession>();
  constructor(private store: SessionStore = realStore) {}

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
    this.store.acquire(meta.id); // fresh id — always ours; registers the single-writer claim
    const s: ServeSession = { meta, history: [], provider: o.provider, approval: o.approval, autoApprove: new Set(), stats: { input: 0, output: 0 }, projectContext: o.projectContext, busy: false, abort: null };
    this.sessions.set(meta.id, s);
    return s;
  }

  /** Resume a persisted session. Returns the live session, or a lock/missing failure. */
  resume(
    id: string,
    o: { provider: Provider; approval: ApprovalMode; projectContext?: string },
  ): { session: ServeSession } | { missing: true } | { lockedBy: number } {
    const live = this.sessions.get(id);
    if (live) return { session: live }; // already attached to this server
    const prior = this.store.load(id);
    if (!prior) return { missing: true };
    const lock = this.store.acquire(id);
    if (!lock.ok) return { lockedBy: lock.pid ?? 0 };
    const s: ServeSession = { meta: prior.meta, history: [...prior.history], provider: o.provider, approval: o.approval, autoApprove: new Set(), stats: { input: 0, output: 0 }, projectContext: o.projectContext, busy: false, abort: null };
    this.sessions.set(id, s);
    return { session: s };
  }

  get(id: string): ServeSession | undefined {
    return this.sessions.get(id);
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
      live.meta.title = title;
      this.store.save(live.meta, live.history);
      return true;
    }
    const prior = this.store.load(id);
    if (!prior) return false;
    prior.meta.title = title;
    this.store.save(prior.meta, prior.history);
    return true;
  }

  /** Archive/unarchive (hidden from lists, kept on disk). Returns false when unknown. */
  setArchived(id: string, on: boolean): boolean {
    const live = this.sessions.get(id);
    if (live) {
      live.meta.archived = on;
      this.store.save(live.meta, live.history);
      return true;
    }
    const prior = this.store.load(id);
    if (!prior) return false;
    prior.meta.archived = on;
    this.store.save(prior.meta, prior.history);
    return true;
  }

  /** Fork: duplicate a session's history into a NEW session (codex thread/fork) — the non-destructive
   *  sibling of rewind. Source may be live or on-disk; the fork is always a fresh live session. */
  fork(
    id: string,
    o: { provider: Provider; providerId: string; approval: ApprovalMode; projectContext?: string },
  ): { session: ServeSession } | { missing: true } {
    const live = this.sessions.get(id);
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
    };
    this.store.acquire(meta.id);
    const s: ServeSession = {
      meta,
      history: [...src.history],
      provider: o.provider,
      approval: o.approval,
      autoApprove: new Set(),
      stats: { input: 0, output: 0 },
      projectContext: o.projectContext,
      busy: false,
      abort: null,
    };
    this.sessions.set(meta.id, s);
    this.store.save(meta, s.history); // persist immediately — a fork should survive a crash unsent
    return { session: s };
  }

  /** Permanently delete (live or on-disk). Refuses a busy live session. Returns:
   *  "gone" on success, "busy" when a turn is running, "missing" when unknown/held elsewhere. */
  delete(id: string): "gone" | "busy" | "missing" {
    const live = this.sessions.get(id);
    if (live?.busy) return "busy";
    const ok = this.store.delete(id);
    if (!ok && !live) return "missing";
    if (live) this.sessions.delete(id);
    this.store.release(id);
    return "gone";
  }

  /** Release all locks (server shutdown). In-flight turns are aborted by the caller first. */
  releaseAll(): void {
    for (const id of this.sessions.keys()) this.store.release(id);
    this.sessions.clear();
  }
}
