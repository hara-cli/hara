// Session persistence — conversations saved as JSON under ~/.hara/sessions, resumable.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import type { NeutralMsg } from "../providers/types.js";
import { redactSensitiveValue } from "../security/secrets.js";
import { isTaskExecution, type TaskExecution } from "./task.js";

/** Who created a session. Absent = legacy/interactive. Drives UI segregation (desktop: automated
 *  sessions render as a status timeline, never mixed into the manual list) and the title strategy
 *  (automated sessions get "name · time", NEVER the raw prompt). */
export type SessionSource = "interactive" | "gateway" | "cron";

/** Derive the session source from the spawn environment — the gateway subprocess runs with
 *  HARA_GATEWAY=<platform>, the cron runner with HARA_CRON=1 (+ HARA_CRON_NAME=<job name>). */
export function sessionSourceFromEnv(): { source: SessionSource; sourceName?: string } {
  if (process.env.HARA_CRON) return { source: "cron", sourceName: process.env.HARA_CRON_NAME || undefined };
  if (process.env.HARA_GATEWAY) return { source: "gateway", sourceName: process.env.HARA_GATEWAY };
  return { source: "interactive" };
}

/** Title for a NON-interactive session: "name · MM-DD HH:mm" — the raw prompt never becomes a title. */
export function automatedTitle(source: SessionSource, sourceName: string | undefined, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${sourceName || source} · ${stamp}`;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  provider: string;
  /** Per-session pinned model. Set at session creation from cfg.model, **updated by `/model X`**,
   *  and restored into cfg.model on resume so a session keeps the model the user picked.
   *  Resume precedence (see index.ts session init): `--model` flag > meta.model > profile defaults. */
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** short-term working memory — a few durable one-liners that survive /compact + resume */
  workingSet?: string[];
  /** the agent's todo checklist snapshot — kept live by single-session runners (TUI / -p resume) so a
   *  resumed session picks its task state back up instead of starting amnesiac */
  todos?: import("../tools/todo.js").Todo[];
  /** creator of this session (absent = legacy/interactive) — see SessionSource */
  source?: SessionSource;
  /** human tag for automated sessions: cron job name / gateway platform */
  sourceName?: string;
  /** Per-session reasoning effort pin used by persistent Serve clients. */
  effort?: string;
  /** archived sessions are hidden from pickers/lists but kept on disk (codex thread/archive) */
  archived?: boolean;
  /** Gateway thread ownership marker; absent for interactive/cron and legacy sessions. */
  gatewayOwner?: string;
}
export interface SessionData {
  meta: SessionMeta;
  history: NeutralMsg[];
  /** Active/most-recent task execution, deliberately separate from the conversational transcript. */
  task?: TaskExecution;
}

function sessionsDir(): string {
  const d = join(homedir(), ".hara", "sessions");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  // `mode` is ignored when the directory already exists. Tighten legacy installs too: a session holds
  // private conversation history, so inheriting a permissive umask (typically 0755) is not acceptable.
  chmodSync(d, 0o700);
  return d;
}

/** Session ids become filenames. Gateway/platform ids are not always UUIDs, so allow printable filename
 * characters broadly while rejecting separators, traversal sentinels, NULs, and unbounded names. */
export function validSessionId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 220 && id !== "." && id !== ".." && !/[\\/\0]/.test(id);
}

function checkedSessionId(id: unknown): string {
  if (!validSessionId(id)) throw new Error("invalid session id");
  return id;
}

const sessionFile = (id: string) => join(sessionsDir(), `${checkedSessionId(id)}.json`);
const lockFile = (id: string) => join(sessionsDir(), `${checkedSessionId(id)}.lock`);
const reclaimFile = (id: string) => join(sessionsDir(), `${checkedSessionId(id)}.lock.reclaim`);

/** Distinguish a missing session from an existing but unreadable/corrupt one without exposing its path. */
export function sessionFileExists(id: unknown): boolean {
  if (!validSessionId(id)) return false;
  return existsSync(sessionFile(id));
}

interface LockRecord {
  pid: number;
  startedAt: number;
  /** Added by the atomic-lock format. Legacy pid-only locks remain readable for safe live/stale handling,
   *  but can never be mistaken for a lock owned by this module instance. */
  token?: string;
}

// A pid alone is not ownership: pids are reused, and another writer could replace a lock between read and
// release. Keep the random token for every lock this module actually created and require both on release.
const ownedLocks = new Map<string, string>();

function readLockRecord(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (
      !Number.isInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.startedAt !== "number" ||
      (parsed.token !== undefined && (typeof parsed.token !== "string" || !parsed.token))
    ) {
      return null;
    }
    return { pid: Number(parsed.pid), startedAt: parsed.startedAt, ...(parsed.token ? { token: parsed.token } : {}) };
  } catch {
    return null;
  }
}

/** Create one private file without ever replacing an existing path. On a partial write, remove only the
 *  inode we just created. Callers use this for both the primary lock and the stale-lock reclaimer. */
function writeExclusive(path: string, record: LockRecord): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        fd = undefined;
      } catch {
        /* continue with best-effort removal */
      }
      try {
        rmSync(path, { force: true });
      } catch {
        /* the original error is more useful */
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the acquisition will fail closed */
      }
    }
  }
}

function newLockRecord(): LockRecord & { token: string } {
  return { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
}

/** Is a process with this pid alive? `process.kill(pid, 0)` sends no signal — it just probes: throws
 *  ESRCH if dead, EPERM if alive-but-not-ours (still alive). Best-effort across platforms. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Take an O_EXCL lock on a session so two hara processes cannot both pass a check-then-write race.
 *  Filesystem/malformed-lock errors fail CLOSED. A well-formed dead holder can be reclaimed under a second
 *  O_EXCL guard; a corrupt lock is deliberately left for explicit operator inspection/removal. */
export function acquireSessionLock(id: string): { ok: boolean; pid?: number } {
  let f: string;
  let reclaim: string;
  try {
    f = lockFile(id);
    reclaim = reclaimFile(id);
  } catch {
    return { ok: false };
  }

  // A stale-lock recovery is changing the primary lock. New contenders wait/fail instead of creating a
  // primary lock in the short remove→create window.
  if (existsSync(reclaim)) {
    const stale = readLockRecord(reclaim);
    if (!stale?.token || !Number.isFinite(stale.startedAt) || stale.startedAt <= 0 || pidAlive(stale.pid)) {
      return { ok: false, pid: readLockRecord(f)?.pid };
    }
    const current = readLockRecord(reclaim);
    if (
      !current?.token ||
      current.pid !== stale.pid ||
      current.token !== stale.token ||
      current.startedAt !== stale.startedAt ||
      pidAlive(current.pid)
    ) {
      return { ok: false, pid: readLockRecord(f)?.pid };
    }
    try {
      rmSync(reclaim);
    } catch {
      return { ok: false, pid: readLockRecord(f)?.pid };
    }
  }

  const claim = newLockRecord();
  try {
    writeExclusive(f, claim);
    ownedLocks.set(id, claim.token);
    return { ok: true };
  } catch (error: any) {
    if (error?.code !== "EEXIST") return { ok: false };
  }

  const held = readLockRecord(f);
  if (!held) return { ok: false }; // malformed/unreadable is not proof that the owner is dead
  if (held.pid === process.pid && !!held.token && ownedLocks.get(id) === held.token) return { ok: true }; // re-entrant
  if (pidAlive(held.pid)) return { ok: false, pid: held.pid };

  // Serialize stale takeover. All participants check this guard before attempting the primary O_EXCL create,
  // so no second contender can steal the freshly-created primary lock during reclamation.
  const reclaimClaim = newLockRecord();
  try {
    writeExclusive(reclaim, reclaimClaim);
  } catch {
    return { ok: false, pid: held.pid };
  }
  try {
    const current = readLockRecord(f);
    if (!current) return { ok: false }; // disappeared/corrupted unexpectedly: fail closed
    if (current.pid === process.pid && !!current.token && ownedLocks.get(id) === current.token) return { ok: true };
    if (pidAlive(current.pid)) return { ok: false, pid: current.pid };

    rmSync(f); // known-dead, well-formed owner; protected by the reclaim guard
    const replacement = newLockRecord();
    writeExclusive(f, replacement);
    ownedLocks.set(id, replacement.token);
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    // Only remove our own reclaimer. A replacement would indicate outside interference and must survive.
    const currentReclaim = readLockRecord(reclaim);
    if (currentReclaim?.pid === process.pid && currentReclaim.token === reclaimClaim.token) {
      try {
        rmSync(reclaim);
      } catch {
        /* fail closed on the next acquisition until this guard can be inspected/removed */
      }
    }
  }
}

/** Release a session lock we hold (only removes it if the pid matches ours — never steals another's). */
export function releaseSessionLock(id: string): void {
  const token = ownedLocks.get(id);
  if (!token) return;
  try {
    const f = lockFile(id);
    const held = readLockRecord(f);
    if (held?.pid === process.pid && held.token === token) rmSync(f);
    ownedLocks.delete(id);
  } catch {
    // Keep the ownership token so a later cleanup attempt can still prove ownership. Never unlink blindly.
  }
}

/** Permanently delete a session from disk (codex thread/delete — unlike archive, irreversible).
 *  Refuses when a LIVE other process holds the lock; removes the session file and any lock we may hold.
 *  Returns false when the session doesn't exist or is held elsewhere. */
export function deleteSession(id: string): boolean {
  let f: string;
  try {
    f = sessionFile(id);
  } catch {
    return false;
  }
  if (!existsSync(f)) return false;
  const ownedBefore = ownedLocks.has(id);
  const lock = acquireSessionLock(id);
  if (!lock.ok) return false;
  let deleted = false;
  try {
    rmSync(f);
    deleted = true;
    return true;
  } catch {
    return false;
  } finally {
    // A successful delete ends the session. On failure, release only a lock acquired by this call; a live
    // SessionHub that already owned the lock must retain it and remain protected.
    if (deleted || !ownedBefore) releaseSessionLock(id);
  }
}

/** A full UUID per session (the stable identity). */
export const newSessionId = (): string => randomUUID();
/** First segment of the UUID — a compact label for the status bar / `/sessions`. */
export const shortId = (id: string): string => id.slice(0, 8);

/** Resolve a full id OR a unique prefix (e.g. the short id) to a session id, for `--resume`. */
export function resolveSessionId(idOrPrefix: string): string | null {
  if (!validSessionId(idOrPrefix)) return null;
  if (existsSync(sessionFile(idOrPrefix))) return idOrPrefix;
  const hits = listSessions().filter((m) => m.id.startsWith(idOrPrefix));
  return hits.length === 1 ? hits[0]!.id : null;
}

const STOP = new Set(
  "the a an to of for and or with in on at my our your this that it is please can could you help me we add fix make do run create update change implement".split(" "),
);
const WORDS = "amber basalt cedar delta ember flint grove harbor indigo jade kelp larch maple onyx quartz river slate terra umber vale willow zephyr".split(" ");

/** A short, ASCII, few-word session name from the first message — no CJK or garbled chars. For
 *  all-CJK / empty input, a stable word derived from the text. Keeps the status bar tidy. */
export function cleanSessionName(raw: string): string {
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const slug = words.slice(0, 3).join("-").slice(0, 24).replace(/^-+|-+$/g, "");
  if (slug) return slug;
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WORDS[h % WORDS.length] ?? "session";
}

/** A concise, human session name auto-summarized from the first message. Language-agnostic — keeps CJK
 *  (unlike the ASCII-slug `cleanSessionName`), trims code/whitespace, caps length. Empty for blank input
 *  (callers fall back to the short id, never "new session"). */
export function deriveTitle(text: string): string {
  if (typeof text !== "string") return ""; // a malformed/hand-edited session may have a non-string content
  const t = text
    .replace(/^\/\S+\s*/, "") // drop a leading slash-command
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code blocks
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const max = 40;
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, "").trim() + "…";
}

export function titleFrom(history: NeutralMsg[]): string {
  const firstUser = history.find((h) => h.role === "user");
  return deriveTitle(firstUser && firstUser.role === "user" ? firstUser.content : "");
}

/** Normalize a phrase to an ASCII kebab-case slug (lowercase, a–z0–9 + single hyphens, capped). Non-ASCII
 *  is dropped — used to clean a model-generated English session name. Returns "" if nothing ASCII remains. */
export function slugify(text: string, max = 40): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Redact a deep in-memory copy while retaining fields that define session identity/routing. */
function redactedSessionCopy(data: SessionData): SessionData {
  // Redact a deep COPY: the live turn may still need a credential the user supplied, but the durable
  // transcript never should. Tool inputs/results are included, not just user message content.
  const safe = redactSensitiveValue(data).value;
  // Structural routing/identity fields must remain byte-for-byte stable even if a path happens to contain
  // credential-looking text. Free-form meta (title, workingSet, todos, sourceName) and ALL history remain
  // deeply redacted. The live objects are not modified by the redaction walk.
  safe.meta.id = data.meta.id;
  safe.meta.cwd = data.meta.cwd;
  safe.meta.provider = data.meta.provider;
  safe.meta.model = data.meta.model;
  safe.meta.createdAt = data.meta.createdAt;
  safe.meta.updatedAt = data.meta.updatedAt;
  if (data.meta.source !== undefined) safe.meta.source = data.meta.source;
  if (data.meta.effort !== undefined) safe.meta.effort = data.meta.effort;
  if (data.meta.archived !== undefined) safe.meta.archived = data.meta.archived;
  if (data.meta.gatewayOwner !== undefined) safe.meta.gatewayOwner = data.meta.gatewayOwner;
  if (data.task && safe.task) {
    // Task objective/steering are free-form and stay redacted. Execution identity and transition metadata
    // are structural: preserve them exactly so resume/expectedTurnId validation cannot be corrupted by a
    // credential-looking identifier.
    safe.task.schemaVersion = data.task.schemaVersion;
    safe.task.id = data.task.id;
    safe.task.status = data.task.status;
    safe.task.turnId = data.task.turnId;
    safe.task.createdAt = data.task.createdAt;
    safe.task.updatedAt = data.task.updatedAt;
    safe.task.startedAt = data.task.startedAt;
    if (data.task.endedAt !== undefined) safe.task.endedAt = data.task.endedAt;
    if (data.task.lastOutcome !== undefined) safe.task.lastOutcome = data.task.lastOutcome;
    if (data.task.steering && safe.task.steering) {
      for (let index = 0; index < data.task.steering.length; index++) {
        const source = data.task.steering[index];
        const target = safe.task.steering[index];
        if (!source || !target) continue;
        target.id = source.id;
        target.turnId = source.turnId;
        target.createdAt = source.createdAt;
        if (source.deliveryState !== undefined) target.deliveryState = source.deliveryState;
        if (source.consumedAt !== undefined) target.consumedAt = source.consumedAt;
      }
    }
  }
  return safe;
}

export function saveSession(meta: SessionMeta, history: NeutralMsg[], task?: TaskExecution): void {
  checkedSessionId(meta.id);
  meta.updatedAt = new Date().toISOString();
  const safe = redactedSessionCopy({ meta, history, ...(task ? { task } : {}) });

  const target = sessionFile(meta.id);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(safe, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Same directory/filesystem: readers observe the complete old JSON or complete new JSON, never a prefix.
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* preserve the original error */
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* preserve the original error */
    }
    throw error;
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPersistedTodo(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const todo = value as { text?: unknown; status?: unknown; activeForm?: unknown; blockedBy?: unknown; owner?: unknown };
  return (
    typeof todo.text === "string" &&
    (todo.status === "pending" || todo.status === "in_progress" || todo.status === "done") &&
    (todo.activeForm === undefined || typeof todo.activeForm === "string") &&
    (todo.blockedBy === undefined || isStringArray(todo.blockedBy)) &&
    (todo.owner === undefined || typeof todo.owner === "string")
  );
}

function isNeutralMessage(value: unknown): value is NeutralMsg {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "user") {
    return typeof message.content === "string" && (
      message.images === undefined || (
        Array.isArray(message.images) && message.images.every((image) => {
          if (!image || typeof image !== "object" || Array.isArray(image)) return false;
          const attachment = image as Record<string, unknown>;
          return typeof attachment.path === "string" && typeof attachment.mediaType === "string";
        })
      )
    );
  }
  if (message.role === "assistant") {
    return typeof message.text === "string" && Array.isArray(message.toolUses) && message.toolUses.every((use) => {
      if (!use || typeof use !== "object" || Array.isArray(use)) return false;
      const tool = use as Record<string, unknown>;
      return typeof tool.id === "string" && typeof tool.name === "string" && Object.hasOwn(tool, "input");
    });
  }
  if (message.role === "tool") {
    return Array.isArray(message.results) && message.results.every((result) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return false;
      const tool = result as Record<string, unknown>;
      return typeof tool.id === "string" && typeof tool.name === "string" && typeof tool.content === "string" &&
        (tool.isError === undefined || typeof tool.isError === "boolean");
    });
  }
  return false;
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Partial<Record<keyof SessionMeta, unknown>>;
  return (
    validSessionId(meta.id) &&
    typeof meta.cwd === "string" &&
    typeof meta.provider === "string" &&
    typeof meta.model === "string" &&
    typeof meta.title === "string" &&
    isTimestamp(meta.createdAt) &&
    isTimestamp(meta.updatedAt) &&
    (meta.workingSet === undefined || isStringArray(meta.workingSet)) &&
    (meta.todos === undefined || (Array.isArray(meta.todos) && meta.todos.every(isPersistedTodo))) &&
    (meta.source === undefined || meta.source === "interactive" || meta.source === "gateway" || meta.source === "cron") &&
    (meta.sourceName === undefined || typeof meta.sourceName === "string") &&
    (meta.effort === undefined || typeof meta.effort === "string") &&
    (meta.archived === undefined || typeof meta.archived === "boolean") &&
    (meta.gatewayOwner === undefined || typeof meta.gatewayOwner === "string")
  );
}

/** True if a parsed object has the SessionData shape we can safely use. */
function isSessionData(d: unknown): d is SessionData {
  const o = d as { meta?: unknown; history?: unknown; task?: unknown } | null;
  return !!o && typeof o === "object" && !Array.isArray(o) && isSessionMeta(o.meta) &&
    Array.isArray(o.history) && o.history.every(isNeutralMessage) &&
    (o.task === undefined || isTaskExecution(o.task));
}

/** Read only. Legacy plaintext is redacted in the returned in-memory copy but intentionally not migrated
 *  here: listing/resuming must not perform an unlocked write. The next explicit save atomically migrates it. */
function readSessionFile(p: string): SessionData | null {
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    return isSessionData(d) ? redactedSessionCopy(d) : null;
  } catch {
    return null;
  }
}

export function loadSession(id: string): SessionData | null {
  if (!validSessionId(id)) return null;
  const p = sessionFile(id);
  if (!existsSync(p)) return null;
  const data = readSessionFile(p);
  return data?.meta.id === id ? data : null; // a corrupt, spoofed, or hand-edited file resumes as "no session"
}

/** Session metas, newest first; optionally filtered to a cwd. */
export function listSessions(cwd?: string): SessionMeta[] {
  let metas: SessionMeta[] = [];
  for (const f of readdirSync(sessionsDir())) {
    if (!f.endsWith(".json")) continue;
    const d = readSessionFile(join(sessionsDir(), f));
    if (d?.meta.id && validSessionId(d.meta.id) && f === `${d.meta.id}.json` && d.meta.updatedAt) metas.push(d.meta); // skip spoofed/metalless/corrupt; never mutate while listing
  }
  if (cwd) metas = metas.filter((m) => m.cwd === cwd);
  return metas.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function latestForCwd(cwd: string): SessionData | null {
  const [m] = listSessions(cwd);
  return m ? loadSession(m.id) : null;
}
