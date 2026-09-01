// Chat → working-dir + session mapping, so each chat is a continuous, resumable thread that can ROAM across
// projects. Persisted at ~/.hara/gateway/chats.json. A chat has a current cwd (switchable via /cd) and a
// session id scoped to that (chat, cwd) pair — so switching projects switches threads, and switching back
// resumes the right one. /sessions then lists the current dir's threads (codex-style), while the chat itself
// stays a single conversation front-end (hermes-style). The same model backs a future desktop app.
// Sessions are stored by id in ~/.hara/sessions, so these are real sessions resumable via `hara -p … --resume`.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sleepSync } from "../sync-sleep.js";

interface ChatThread {
  sessionId: string;
  fork: number;
}

interface ChatEntry extends ChatThread {
  cwd: string;
  threads: Record<string, ChatThread>;
  threadKeysVersion?: 2;
  voice?: boolean; // /voice toggle — speak replies as TTS audio
  lastUsed?: number; // last inbound message ts — drives idle auto-rotation (session hygiene)
  agent?: string; // /agent — pin an org role / indexed agent for this chat
  agentReturnCwd?: string; // cwd to restore when `/agent main` clears a role with its own home
  /** Explicit `/coding use` selection. Ordinary chat never routes here implicitly. */
  codingSessionId?: string;
}

export interface ChatWho {
  userId?: number | string;
  chatType?: "p2p" | "group";
}

/** Idle window before a chat auto-rotates to a FRESH session (hours). A WeChat/Feishu chat is one
 *  endless surface — without this, days-old context piles onto every new ask and the agent answers
 *  from stale state (the "gateway answers with old context" report). Default 8h: overnight gaps start
 *  clean, a same-afternoon follow-up continues. HARA_GATEWAY_IDLE_HOURS tunes it; 0 disables. */
export function idleRotationMs(): number {
  const raw = Number(process.env.HARA_GATEWAY_IDLE_HOURS ?? 8);
  if (!Number.isFinite(raw) || raw <= 0) return 0; // 0/garbage → disabled
  return raw * 3_600_000;
}

interface ChatMap {
  [key: string]: ChatEntry;
}

const haraDir = (): string => join(homedir(), ".hara");
const dir = (): string => join(haraDir(), "gateway");
const file = (): string => join(dir(), "chats.json");
const lockFile = (): string => `${file()}.lock`;
const reclaimFile = (): string => `${lockFile()}.reclaim`;
const LOCK_WAIT_MS = 5_000;

interface LockRecord {
  pid: number;
  token: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function ensurePrivateDir(): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  // Tighten legacy directories as well. A private leaf is insufficient when ~/.hara itself is traversable.
  try {
    chmodSync(haraDir(), 0o700);
    chmodSync(dir(), 0o700);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed?.token === "string" && parsed.token
      ? { pid: parsed.pid, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function writeLock(path: string, record: LockRecord): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
      fd = undefined;
      try { removeIfPresent(path); } catch { /* preserve the original error */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Serialize read-modify-write cycles across gateway processes. A tokenized owner may only be reclaimed
 * after its PID is proven dead; malformed locks fail closed instead of being unlinked by age. */
function acquireLock(): () => void {
  ensurePrivateDir();
  const deadline = Date.now() + LOCK_WAIT_MS;
  const claim = { pid: process.pid, token: randomBytes(16).toString("hex") };
  for (;;) {
    if (existsSync(reclaimFile())) {
      const stale = readLock(reclaimFile());
      if (stale && !pidAlive(stale.pid)) {
        const current = readLock(reclaimFile());
        if (current?.pid === stale.pid && current.token === stale.token && !pidAlive(current.pid)) {
          removeIfPresent(reclaimFile());
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for gateway session store lock: ${lockFile()}`);
      sleepSync(10);
      continue;
    }
    try {
      writeLock(lockFile(), claim);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = readLock(lockFile());
        if (current?.pid === claim.pid && current.token === claim.token) {
          removeIfPresent(lockFile());
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const held = readLock(lockFile());
      if (held && !pidAlive(held.pid)) {
        const guard = { pid: process.pid, token: randomBytes(16).toString("hex") };
        try {
          writeLock(reclaimFile(), guard);
          const current = readLock(lockFile());
          if (current?.pid === held.pid && current.token === held.token && !pidAlive(current.pid)) {
            removeIfPresent(lockFile());
          }
        } catch (reclaimError) {
          if (errorCode(reclaimError) !== "EEXIST") throw reclaimError;
        } finally {
          const currentGuard = readLock(reclaimFile());
          if (currentGuard?.pid === guard.pid && currentGuard.token === guard.token) {
            removeIfPresent(reclaimFile());
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for gateway session store lock: ${lockFile()}`);
      }
      sleepSync(10);
    }
  }
}

function emptyThreads(): Record<string, ChatThread> {
  return Object.create(null) as Record<string, ChatThread>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFork(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid fork counter in gateway session store (${label})`);
  }
  return value as number;
}

function normalizeThread(value: unknown, label: string): ChatThread {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error(`Invalid thread in gateway session store (${label})`);
  }
  return { sessionId: value.sessionId, fork: normalizeFork(value.fork, label) };
}

function normalizeEntry(value: unknown, key: string): ChatEntry {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error(`Invalid entry in gateway session store (${key})`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error(`Invalid cwd in gateway session store (${key})`);
  }
  const threads = emptyThreads();
  if (value.threads !== undefined) {
    if (!isRecord(value.threads)) throw new Error(`Invalid thread map in gateway session store (${key})`);
    for (const [cwd, thread] of Object.entries(value.threads)) {
      threads[cwd] = normalizeThread(thread, `${key}:${cwd}`);
    }
  }
  const entry: ChatEntry = {
    cwd: typeof value.cwd === "string" ? value.cwd : "", // pre-cwd stores are migrated by chatContext
    sessionId: value.sessionId,
    fork: normalizeFork(value.fork, key),
    threads,
  };
  if (value.threadKeysVersion !== undefined && value.threadKeysVersion !== 2) {
    throw new Error(`Invalid thread key version in gateway session store (${key})`);
  }
  if (value.threadKeysVersion === 2) entry.threadKeysVersion = 2;
  if (typeof value.voice === "boolean") entry.voice = value.voice;
  if (typeof value.lastUsed === "number" && Number.isFinite(value.lastUsed)) entry.lastUsed = value.lastUsed;
  if (typeof value.agent === "string" && value.agent) entry.agent = value.agent;
  if (typeof value.agentReturnCwd === "string" && value.agentReturnCwd) entry.agentReturnCwd = value.agentReturnCwd;
  if (typeof value.codingSessionId === "string" && /^ext_runtime_[a-f0-9]{24}$/u.test(value.codingSessionId)) {
    entry.codingSessionId = value.codingSessionId;
  }
  return entry;
}

function load(): ChatMap {
  let raw: string;
  try {
    raw = readFileSync(file(), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Object.create(null) as ChatMap;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in gateway session store: ${file()}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`Invalid gateway session store: ${file()}`);
  const result = Object.create(null) as ChatMap;
  for (const [key, value] of Object.entries(parsed)) result[key] = normalizeEntry(value, key);
  return result;
}

function fsyncDirectory(): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir(), "r");
    fsyncSync(fd);
  } catch {
    /* best-effort durability on platforms that cannot fsync directory handles */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Write a complete replacement privately and atomically; a crash leaves the previous JSON intact. */
function save(map: ChatMap): void {
  ensurePrivateDir();
  const tmp = join(dir(), `.chats.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(map, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file());
    try { chmodSync(file(), 0o600); } catch { /* best effort */ }
    fsyncDirectory();
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    removeIfPresent(tmp);
    throw error;
  }
}

function mutate<T>(fn: (map: ChatMap) => T): T {
  const release = acquireLock();
  try {
    const map = load();
    const result = fn(map);
    save(map);
    return result;
  } finally {
    release();
  }
}

/** Thread identity is (platform, chat) for DMs — chatId IS the user — but (platform, chat, USER) in group
 *  chats. A missing group user fails closed instead of silently sharing another member's context. */
function scopedUser(who?: ChatWho): number | string | undefined {
  if (who?.chatType !== "group") return undefined;
  if (who.userId === undefined || who.userId === null || who.userId === "") {
    throw new Error("A group gateway session requires a userId");
  }
  return who.userId;
}

function mapKey(platform: string, chatId: number | string, userId?: number | string): string {
  if (userId === undefined) return `${platform}:${chatId}`;
  const userTag = createHash("sha256").update(String(userId)).digest("hex").slice(0, 24);
  return `${platform}:${chatId}:u${userTag}`;
}

/** A stable, short, dir-specific suffix so each (chat, cwd) pair gets its own session thread. */
export function cwdTag(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 6);
}

function agentTag(agent: string): string {
  return createHash("sha256").update("hara-gateway-agent-v1\0").update(agent).digest("hex").slice(0, 16);
}

function threadKey(cwd: string, agent?: string): string {
  // JSON's length-delimited strings keep a real path such as `/work#agent=deadbeef` from colliding with
  // an Agent-qualified key. The v2 prefix also makes legacy raw-cwd entries identifiable during migration.
  return `v2:${JSON.stringify([cwd, agent ? agentTag(agent) : null])}`;
}

function threadFor(entry: ChatEntry, cwd: string, agent?: string): ChatThread | undefined {
  return entry.threads[threadKey(cwd, agent)];
}

/** Derived session id for a (chat[, user], cwd, agent, fork). Agent identity is hashed into the id so two
 * personas in one project can never collide or append into one another's transcript. */
function deriveId(
  platform: string,
  chatId: number | string,
  cwd: string,
  fork: number,
  userId?: number | string,
  agent?: string,
): string {
  const u = userId === undefined
    ? ""
    : `-u${createHash("sha256").update(String(userId)).digest("hex").slice(0, 24)}`;
  const identity = agent ? `-a${agentTag(agent)}` : "-m2";
  return `${platform}-${chatId}${u}-${cwdTag(cwd)}${identity}${fork ? `-${fork}` : ""}`;
}

/** Stable index prefix for one chat actor's derived session ids. */
export function chatSessionIdPrefix(platform: string, chatId: number | string, who?: ChatWho): string {
  const userId = scopedUser(who);
  const user = userId === undefined
    ? ""
    : `-u${createHash("sha256").update(String(userId)).digest("hex").slice(0, 24)}`;
  return `${platform}-${chatId}${user}-`;
}

/** A gateway thread may resume/list only ids derived for its own chat identity. This blocks an allowlisted
 * operator from using `/sessions` or `/resume` to cross into another chat/user's persisted transcript. */
export function ownsChatSession(platform: string, chatId: number | string, sessionId: string, who?: ChatWho): boolean {
  try {
    const namespace = chatSessionIdPrefix(platform, chatId, who)
      .slice(0, -1)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Anchor the complete derived-id grammar. A raw startsWith check lets chat "room" accidentally own
    // chat "room-extra"; the cwd hash + optional numeric fork make the namespace boundary unambiguous.
    // The absent identity segment is accepted for pre-v2 main sessions. Every newly derived id carries
    // `-m2` or an Agent hash so a legacy mixed transcript can never be selected by a fresh identity.
    return new RegExp(`^${namespace}-[a-f0-9]{6}(?:-m2|-a[a-f0-9]{16})?(?:-[1-9]\\d*)?$`).test(sessionId);
  } catch {
    return false;
  }
}

export type OwnedSessionMatch = { id: string } | { ambiguous: string[] } | null;

/** Resolve the compact ids shown by the chat UI without ever searching another user's sessions. Exact ids
 * win; otherwise a displayed prefix OR suffix is accepted only when it identifies one owned session. */
export function resolveOwnedSessionId(
  platform: string,
  chatId: number | string,
  idOrFragment: string,
  candidates: Iterable<string>,
  who?: ChatWho,
): OwnedSessionMatch {
  const fragment = idOrFragment.trim();
  if (!fragment) return null;
  const owned = [...new Set(candidates)].filter((id) => ownsChatSession(platform, chatId, id, who));
  if (owned.includes(fragment)) return { id: fragment };
  const matches = owned.filter((id) => id.startsWith(fragment) || id.endsWith(fragment));
  if (matches.length === 1) return { id: matches[0] };
  return matches.length > 1 ? { ambiguous: matches.sort() } : null;
}

function rememberCurrent(entry: ChatEntry): void {
  if (!entry.cwd || !entry.sessionId) return;
  entry.threads[threadKey(entry.cwd, entry.agent)] = { sessionId: entry.sessionId, fork: entry.fork };
}

function freshEntry(platform: string, chatId: number | string, cwd: string, userId?: number | string): ChatEntry {
  const sessionId = deriveId(platform, chatId, cwd, 0, userId);
  const entry: ChatEntry = { cwd, sessionId, fork: 0, threads: emptyThreads(), threadKeysVersion: 2 };
  rememberCurrent(entry);
  return entry;
}

function migrateEntry(entry: ChatEntry, platform: string, chatId: number | string, defaultCwd: string, userId?: number | string): void {
  if (!entry.cwd) entry.cwd = defaultCwd;
  if (!entry.sessionId) entry.sessionId = deriveId(platform, chatId, entry.cwd, entry.fork, userId, entry.agent);
  if (entry.threadKeysVersion !== 2) {
    // Raw cwd keys can collide with any delimiter-based Agent suffix. Retire legacy routing pointers once;
    // their session files remain searchable/resumable. The current main session is safe to retain, but a
    // current selected-Agent session may already contain mixed persona history and therefore starts clean.
    entry.threads = emptyThreads();
    entry.threadKeysVersion = 2;
    if (entry.agent) {
      entry.fork = 0;
      entry.sessionId = deriveId(platform, chatId, entry.cwd, 0, userId, entry.agent);
    }
  }
  rememberCurrent(entry);
}

function switchCwd(entry: ChatEntry, platform: string, chatId: number | string, cwd: string, userId?: number | string): void {
  rememberCurrent(entry);
  const prior = threadFor(entry, cwd, entry.agent);
  entry.cwd = cwd;
  entry.sessionId = prior?.sessionId ?? deriveId(platform, chatId, cwd, 0, userId, entry.agent);
  entry.fork = prior?.fork ?? 0;
  rememberCurrent(entry);
}

function switchAgentContext(
  entry: ChatEntry,
  platform: string,
  chatId: number | string,
  cwd: string,
  agent: string | undefined,
  userId?: number | string,
): void {
  rememberCurrent(entry);
  entry.cwd = cwd;
  if (agent) entry.agent = agent;
  else delete entry.agent;
  const prior = threadFor(entry, cwd, agent);
  entry.sessionId = prior?.sessionId ?? deriveId(platform, chatId, cwd, 0, userId, agent);
  entry.fork = prior?.fork ?? 0;
  rememberCurrent(entry);
}

/** Get (or initialize) the chat's context. `who` adds the user dimension for group chats. */
export function chatContext(
  platform: string,
  chatId: number | string,
  defaultCwd: string,
  who?: ChatWho,
): { cwd: string; sessionId: string; voice: boolean; agent?: string; rotatedFrom?: string } {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  return mutate((map) => {
    const now = Date.now();
    let entry = map[key];
    if (!entry) {
      entry = freshEntry(platform, chatId, defaultCwd, uid);
      entry.lastUsed = now;
      map[key] = entry;
      return { cwd: entry.cwd, sessionId: entry.sessionId, voice: false };
    }
    migrateEntry(entry, platform, chatId, defaultCwd, uid);
    // Session hygiene: a chat idle past the window rotates to a fresh thread (same mechanics as /new).
    // The old id is returned so the gateway can offer `/resume <id>`; persisted sessions are not deleted.
    const idleMs = idleRotationMs();
    let rotatedFrom: string | undefined;
    if (idleMs > 0 && typeof entry.lastUsed === "number" && now - entry.lastUsed > idleMs && entry.sessionId) {
      rotatedFrom = entry.sessionId;
      entry.fork += 1;
      entry.sessionId = deriveId(platform, chatId, entry.cwd, entry.fork, uid, entry.agent);
      rememberCurrent(entry);
    }
    entry.lastUsed = now;
    return {
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      voice: !!entry.voice,
      ...(entry.agent ? { agent: entry.agent } : {}),
      ...(rotatedFrom ? { rotatedFrom } : {}),
    };
  });
}

/** `/agent <ref|main>` — pin a role and optionally enter its home, or restore the pre-role cwd on clear.
 *  Callers must pass `home` here instead of calling chatCd first, otherwise the previous cwd is unknowable. */
export function setChatAgent(
  platform: string,
  chatId: number | string,
  agent: string | undefined,
  who?: ChatWho,
  home?: string,
): string | undefined {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  return mutate((map) => {
    const entry = map[key];
    if (!entry) return undefined; // chatContext normally initializes the entry
    if (agent) {
      let targetCwd = entry.cwd;
      if (home && home !== entry.cwd) {
        if (!entry.agentReturnCwd) entry.agentReturnCwd = entry.cwd;
        targetCwd = home;
      } else if (agent.startsWith("global:")) {
        // Moving from a project-pinned role to a portable global role makes the current directory the
        // user's real working directory again. Drop the old return point so a later `/agent main` does
        // not unexpectedly jump back past subsequent `/cd` changes.
        delete entry.agentReturnCwd;
      }
      switchAgentContext(entry, platform, chatId, targetCwd, agent, uid);
    } else {
      const restore = entry.agentReturnCwd;
      delete entry.agentReturnCwd;
      switchAgentContext(entry, platform, chatId, restore || entry.cwd, undefined, uid);
    }
    return entry.agent;
  });
}

/** The Hara Live terminal explicitly selected by this chat actor. This is only a pointer: command handling
 * must still rediscover the runtime session before reading, sending, or interrupting it. */
export function chatCodingSession(
  platform: string,
  chatId: number | string,
  who?: ChatWho,
): string | undefined {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  const release = acquireLock();
  try {
    return load()[key]?.codingSessionId;
  } finally {
    release();
  }
}

/** Select or clear the Hara Live terminal controlled by `/coding`. The owning ChatEntry is initialized by
 * `chatContext` before gateway commands are handled; refusing to manufacture one here preserves its cwd and
 * Hara-thread invariants. */
export function setChatCodingSession(
  platform: string,
  chatId: number | string,
  sessionId: string | undefined,
  who?: ChatWho,
): string | undefined {
  if (sessionId !== undefined && !/^ext_runtime_[a-f0-9]{24}$/u.test(sessionId)) {
    throw new Error("Invalid Hara Live session id");
  }
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  return mutate((map) => {
    const entry = map[key];
    if (!entry) return undefined;
    if (sessionId) entry.codingSessionId = sessionId;
    else delete entry.codingSessionId;
    return entry.codingSessionId;
  });
}

/** `/voice` — toggle whether this chat member's replies are spoken (TTS audio). */
export function toggleVoice(platform: string, chatId: number | string, who?: ChatWho): boolean {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  return mutate((map) => {
    const entry = map[key];
    if (!entry) return false; // chatContext normally initializes the entry
    entry.voice = !entry.voice;
    return !!entry.voice;
  });
}

/** `/cd <dir>` — switch cwd and restore that cwd's last selected/forked session. */
export function chatCd(platform: string, chatId: number | string, cwd: string, who?: ChatWho): string {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  return mutate((map) => {
    let entry = map[key];
    if (!entry) {
      entry = freshEntry(platform, chatId, cwd, uid);
      map[key] = entry;
    } else {
      migrateEntry(entry, platform, chatId, cwd, uid);
      switchCwd(entry, platform, chatId, cwd, uid);
    }
    return entry.sessionId;
  });
}

/** `/new` — fork a fresh thread for the chat member's current dir (the old session remains on disk). */
export function newChatSession(
  platform: string,
  chatId: number | string,
  defaultCwd: string,
  who?: ChatWho,
): string {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  return mutate((map) => {
    let entry = map[key];
    if (!entry) {
      entry = freshEntry(platform, chatId, defaultCwd, uid);
      map[key] = entry;
    } else {
      migrateEntry(entry, platform, chatId, defaultCwd, uid);
    }
    entry.fork += 1;
    entry.sessionId = deriveId(platform, chatId, entry.cwd, entry.fork, uid, entry.agent);
    rememberCurrent(entry);
    return entry.sessionId;
  });
}

/** `/resume <id>` — select a persisted session and bind it to its cwd for future /cd round trips. */
export function setChatSession(
  platform: string,
  chatId: number | string,
  sessionId: string,
  cwd: string,
  who?: ChatWho,
): void {
  const uid = scopedUser(who);
  const key = mapKey(platform, chatId, uid);
  mutate((map) => {
    let entry = map[key];
    if (!entry) {
      entry = freshEntry(platform, chatId, cwd, uid);
      map[key] = entry;
    } else {
      migrateEntry(entry, platform, chatId, cwd, uid);
      switchCwd(entry, platform, chatId, cwd, uid);
    }
    entry.sessionId = sessionId;
    rememberCurrent(entry);
  });
}
