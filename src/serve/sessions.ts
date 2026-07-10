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
  deriveTitle,
} from "../session/store.js";

export interface SessionStore {
  load(id: string): SessionData | null;
  save(meta: SessionMeta, history: NeutralMsg[]): void;
  list(cwd?: string): SessionMeta[];
  acquire(id: string): { ok: boolean; pid?: number };
  release(id: string): void;
}

/** The real ~/.hara/sessions store (default). */
export const realStore: SessionStore = {
  load: loadSession,
  save: saveSession,
  list: listSessions,
  acquire: acquireSessionLock,
  release: releaseSessionLock,
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

  /** Release all locks (server shutdown). In-flight turns are aborted by the caller first. */
  releaseAll(): void {
    for (const id of this.sessions.keys()) this.store.release(id);
    this.sessions.clear();
  }
}
