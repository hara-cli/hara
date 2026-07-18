// task — a PROJECT-level, cross-session task pool (the durable big brother of todo_write's in-session
// checklist). The store is private, atomic, and protected by a per-project cross-process lock so TUI,
// headless, cron, gateway, and desktop writers cannot silently overwrite one another.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { sleepSync } from "../sync-sleep.js";

export type TaskStatus = "pending" | "in_progress" | "done";
export interface TaskItem {
  id: string;
  subject: string;
  status: TaskStatus;
  owner?: string;
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_STATUSES = new Set<TaskStatus>(["pending", "in_progress", "done"]);
const LOCK_ATTEMPTS = 500;
const LOCK_WAIT_MS = 10;

/** Resolve aliases/symlinks before deriving the key. A missing path still gets a stable absolute key so
 * callers receive a deterministic error/store location rather than colliding on a lossy slug. */
export function canonicalTaskCwd(cwd: string): string {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("task cwd must be a non-empty path");
  const absolute = resolve(cwd);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** Human-readable basename + 96 bits of the canonical path. The old path-to-dashes format made
 * `/a-b` and `/a/b` share one task file; the hash makes those registries independent. */
export function taskSlug(cwd: string): string {
  const canonical = canonicalTaskCwd(cwd);
  const label = (basename(canonical) || "root")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "root";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return `${label}-${hash}`;
}

function tasksDir(): string {
  const hara = join(homedir(), ".hara");
  const tasks = join(hara, "tasks");
  mkdirSync(tasks, { recursive: true, mode: 0o700 });
  try {
    chmodSync(hara, 0o700);
    chmodSync(tasks, 0o700);
  } catch {
    // Non-POSIX filesystems may not implement modes; O_EXCL/atomic rename still provide correctness.
  }
  return tasks;
}

function taskFile(cwd: string): string {
  return join(tasksDir(), `${taskSlug(cwd)}.json`);
}

interface LockRecord {
  pid: number;
  token: string;
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
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function writeExclusive(path: string, record: LockRecord): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        fd = undefined;
      } finally {
        rmSync(path, { force: true });
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Bounded O_EXCL mutex. A well-formed dead owner can be reclaimed under a second guard; malformed locks
 * fail closed instead of being guessed stale and risking two writers. */
function withTaskLock<T>(cwd: string, fn: () => T): T {
  const file = taskFile(cwd);
  const lock = `${file}.lock`;
  const reclaim = `${lock}.reclaim`;
  let claim: LockRecord | undefined;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (existsSync(reclaim)) {
      const stale = readLock(reclaim);
      if (stale && !pidAlive(stale.pid)) {
        const current = readLock(reclaim);
        if (current?.pid === stale.pid && current.token === stale.token && !pidAlive(current.pid)) {
          rmSync(reclaim, { force: true });
          continue;
        }
      }
      sleepSync(LOCK_WAIT_MS);
      continue;
    }
    const candidate = { pid: process.pid, token: randomUUID() };
    try {
      writeExclusive(lock, candidate);
      claim = candidate;
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const held = readLock(lock);
    if (held && !pidAlive(held.pid)) {
      const guard = { pid: process.pid, token: randomUUID() };
      try {
        writeExclusive(reclaim, guard);
        const current = readLock(lock);
        if (current?.pid === held.pid && current.token === held.token && !pidAlive(current.pid)) rmSync(lock);
      } catch {
        // Another process won reclamation, or the lock is malformed. Retry without failing open.
      } finally {
        const currentGuard = readLock(reclaim);
        if (currentGuard?.pid === process.pid && currentGuard.token === guard.token) rmSync(reclaim, { force: true });
      }
    }
    sleepSync(LOCK_WAIT_MS);
  }

  if (!claim) throw new Error("task store is busy; retry the operation");
  try {
    return fn();
  } finally {
    const current = readLock(lock);
    if (current?.pid === process.pid && current.token === claim.token) rmSync(lock, { force: true });
  }
}

function isTaskItem(value: unknown): value is TaskItem {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<TaskItem>;
  return (
    typeof t.id === "string" && TASK_ID.test(t.id) &&
    typeof t.subject === "string" && !!t.subject.trim() && t.subject.length <= 500 &&
    typeof t.status === "string" && TASK_STATUSES.has(t.status as TaskStatus) &&
    (t.owner === undefined || (typeof t.owner === "string" && t.owner.length <= 128)) &&
    (t.blockedBy === undefined ||
      (Array.isArray(t.blockedBy) && t.blockedBy.length <= 100 && t.blockedBy.every((id) => typeof id === "string" && TASK_ID.test(id)))) &&
    typeof t.createdAt === "string" && Number.isFinite(Date.parse(t.createdAt)) &&
    typeof t.updatedAt === "string" && Number.isFinite(Date.parse(t.updatedAt))
  );
}

function parseTaskStore(raw: string, cwd: string): TaskItem[] {
  const parsed = JSON.parse(raw);
  const canonical = canonicalTaskCwd(cwd);
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object" && typeof parsed.project === "string" && parsed.project !== canonical) {
    throw new Error("task store project key mismatch");
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!validTaskList(list)) throw new Error("task store contains invalid data");
  return list;
}

function loadTasksUnlocked(cwd: string, strict: boolean): TaskItem[] {
  const file = taskFile(cwd);
  if (!existsSync(file)) return [];
  try {
    return parseTaskStore(readFileSync(file, "utf8"), cwd);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

function validTaskList(value: unknown): value is TaskItem[] {
  if (!Array.isArray(value) || value.length > 10_000 || !value.every(isTaskItem)) return false;
  const ids = new Set(value.map((task) => task.id));
  if (ids.size !== value.length) return false;
  if (!value.every((task) => {
    const blockedBy = task.blockedBy ?? [];
    return new Set(blockedBy).size === blockedBy.length && !blockedBy.includes(task.id) && blockedBy.every((id) => ids.has(id));
  })) return false;
  const byId = new Map(value.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.blockedBy ?? []) {
      if (cyclic(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return value.every((task) => !cyclic(task.id));
}

export function loadTasks(cwd: string): TaskItem[] {
  return loadTasksUnlocked(cwd, false);
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort on non-POSIX filesystems */
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

function saveTasksUnlocked(cwd: string, list: TaskItem[]): void {
  if (!validTaskList(list)) {
    throw new Error("refusing to save invalid task data");
  }
  atomicWrite(taskFile(cwd), JSON.stringify({ project: canonicalTaskCwd(cwd), tasks: list }, null, 2) + "\n");
}

export function saveTasks(cwd: string, list: TaskItem[]): void {
  withTaskLock(cwd, () => saveTasksUnlocked(cwd, list));
}

/** A task is blocked if any dependency is unfinished OR missing. Missing dependencies fail closed rather
 * than accidentally making work runnable after a malformed edit/removal. */
export function isBlocked(t: TaskItem, all: TaskItem[]): boolean {
  return (t.blockedBy ?? []).some((id) => {
    const dependency = all.find((x) => x.id === id);
    return !dependency || dependency.status !== "done";
  });
}

export function renderTasks(list: TaskItem[]): string {
  if (!list.length) return "(no project tasks)";
  const mark: Record<TaskStatus, string> = { pending: "☐", in_progress: "▶", done: "☑" };
  const open = list.filter((t) => t.status !== "done").length;
  return (
    `Project tasks (${open} open / ${list.length} total):\n` +
    list
      .map((t) => {
        const flags = [t.owner ? `@${t.owner}` : "", isBlocked(t, list) ? `⛔blocked by ${(t.blockedBy ?? []).join(",")}` : ""]
          .filter(Boolean)
          .join(" ");
        return `  ${mark[t.status]} [${t.id}] ${t.subject}${flags ? `  (${flags})` : ""}`;
      })
      .join("\n")
  );
}

export interface TaskActionInput {
  action: "add" | "update" | "list" | "remove";
  subject?: string;
  id?: string;
  status?: TaskStatus;
  owner?: string;
  blockedBy?: string[];
}

function invalid(message: string, list: TaskItem[]): { list: TaskItem[]; reply: string } {
  return { list, reply: `task: invalid input (${message}).` };
}

function normalizeInput(input: unknown, list: TaskItem[]): { value: TaskActionInput } | { result: { list: TaskItem[]; reply: string } } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { result: invalid("expected an object", list) };
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["action", "subject", "id", "status", "owner", "blockedBy"]);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) return { result: invalid(`unknown field '${extra}'`, list) };
  if (typeof raw.action !== "string" || !["add", "update", "list", "remove"].includes(raw.action)) {
    return { result: invalid("action must be add, update, list, or remove", list) };
  }

  const value: TaskActionInput = { action: raw.action as TaskActionInput["action"] };
  if (raw.subject !== undefined) {
    if (typeof raw.subject !== "string" || !raw.subject.trim() || raw.subject.trim().length > 500) {
      return { result: invalid("subject must be 1-500 characters", list) };
    }
    value.subject = raw.subject.trim();
  }
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string" || !TASK_ID.test(raw.id)) return { result: invalid("id has an invalid format", list) };
    value.id = raw.id;
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== "string" || !TASK_STATUSES.has(raw.status as TaskStatus)) return { result: invalid("status is invalid", list) };
    value.status = raw.status as TaskStatus;
  }
  if (raw.owner !== undefined) {
    if (typeof raw.owner !== "string" || raw.owner.trim().length > 128) return { result: invalid("owner must be at most 128 characters", list) };
    value.owner = raw.owner.trim();
  }
  if (raw.blockedBy !== undefined) {
    if (
      !Array.isArray(raw.blockedBy) || raw.blockedBy.length > 100 ||
      !raw.blockedBy.every((id) => typeof id === "string" && TASK_ID.test(id))
    ) return { result: invalid("blockedBy must contain at most 100 valid task ids", list) };
    value.blockedBy = [...new Set(raw.blockedBy as string[])];
  }

  if (value.action === "list" && Object.keys(raw).length !== 1) return { result: invalid("list accepts no other fields", list) };
  if (value.action === "add") {
    if (!value.subject) return { result: invalid("subject is required for add", list) };
    if (value.id !== undefined || value.status !== undefined) return { result: invalid("add does not accept id or status", list) };
  }
  if (value.action === "update") {
    if (!value.id) return { result: invalid("id is required for update", list) };
    if (value.subject === undefined && value.status === undefined && value.owner === undefined && value.blockedBy === undefined) {
      return { result: invalid("update requires a field to change", list) };
    }
  }
  if (value.action === "remove") {
    if (!value.id) return { result: invalid("id is required for remove", list) };
    if (Object.keys(raw).some((key) => key !== "action" && key !== "id")) return { result: invalid("remove accepts only id", list) };
  }
  return { value };
}

function newId(existing: TaskItem[]): string {
  let id: string;
  do id = `t${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  while (existing.some((t) => t.id === id));
  return id;
}

/** Pure state transition — returns the new list + a reply string (testable without fs). */
export function applyTaskAction(list: TaskItem[], input: TaskActionInput, nowIso: string): { list: TaskItem[]; reply: string } {
  const normalized = normalizeInput(input, list);
  if ("result" in normalized) return normalized.result;
  const value = normalized.value;
  if (!Number.isFinite(Date.parse(nowIso))) return invalid("timestamp is invalid", list);
  if (value.action === "list") return { list, reply: renderTasks(list) };

  if (value.action === "add") {
    const missing = (value.blockedBy ?? []).find((id) => !list.some((t) => t.id === id));
    if (missing) return invalid(`blockedBy references unknown task '${missing}'`, list);
    const item: TaskItem = {
      id: newId(list),
      subject: value.subject!,
      status: "pending",
      ...(value.owner ? { owner: value.owner } : {}),
      ...(value.blockedBy?.length ? { blockedBy: value.blockedBy } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const next = [...list, item];
    return { list: next, reply: `added [${item.id}] ${item.subject}\n\n${renderTasks(next)}` };
  }

  const task = list.find((item) => item.id === value.id);
  if (!task) return { list, reply: `task ${value.action}: no task with id '${value.id ?? ""}' — use action:"list" to see ids.` };
  if (value.action === "remove") {
    const dependent = list.find((item) => item.id !== task.id && item.blockedBy?.includes(task.id));
    if (dependent) return invalid(`task '${task.id}' still blocks '${dependent.id}'; clear that dependency first`, list);
    const next = list.filter((item) => item.id !== task.id);
    return { list: next, reply: `removed [${task.id}] ${task.subject}` };
  }

  if (value.blockedBy?.includes(task.id)) return invalid("a task cannot block itself", list);
  const missing = (value.blockedBy ?? []).find((id) => !list.some((item) => item.id === id));
  if (missing) return invalid(`blockedBy references unknown task '${missing}'`, list);
  const next = list.map((item) =>
    item.id !== task.id
      ? item
      : {
          ...item,
          ...(value.subject !== undefined ? { subject: value.subject } : {}),
          ...(value.status !== undefined ? { status: value.status } : {}),
          ...(value.owner !== undefined ? (value.owner ? { owner: value.owner } : { owner: undefined }) : {}),
          ...(value.blockedBy !== undefined ? (value.blockedBy.length ? { blockedBy: value.blockedBy } : { blockedBy: undefined }) : {}),
          updatedAt: nowIso,
        },
  );
  if (!validTaskList(next)) return invalid("blockedBy would create a dependency cycle", list);
  const updated = next.find((item) => item.id === task.id)!;
  // Validate the whole merged graph, not only the edited task. Reopening a prerequisite must not silently
  // leave an already-running/done dependent in a logically impossible state.
  const blockedActive = next.find((item) => item.status !== "pending" && isBlocked(item, next));
  if (blockedActive) {
    return invalid(`task '${blockedActive.id}' cannot remain ${blockedActive.status} until every blockedBy task is done`, list);
  }
  return { list: next, reply: `updated [${updated.id}] → ${updated.status}${updated.owner ? ` @${updated.owner}` : ""}` };
}

registerTool({
  name: "task",
  description:
    "The PROJECT's persistent task pool — survives sessions and is shared by every hara run in this directory " +
    "(unlike todo_write, which is your in-session scratchpad). Use it for work that outlives this conversation: " +
    "backlog items, delegated work, multi-day efforts. Actions: `add` (subject, optional owner/blockedBy), " +
    "`update` (id + status/subject/owner/blockedBy), `list`, `remove` (id). Dependencies: blockedBy holds task " +
    "ids that must be done first. Keep subjects short and imperative.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "update", "list", "remove"] },
      subject: { type: "string", minLength: 1, maxLength: 500, description: "task text (add/update) — short imperative phrase" },
      id: { type: "string", minLength: 1, maxLength: 128, pattern: TASK_ID.source, description: "task id (update/remove) — see list output" },
      status: { type: "string", enum: ["pending", "in_progress", "done"], description: "new status (update)" },
      owner: { type: "string", maxLength: 128, description: "who's on it — a role/agent name (add/update; empty string clears)" },
      blockedBy: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", pattern: TASK_ID.source }, description: "task ids that must finish first (add/update; [] clears)" },
    },
    required: ["action"],
  },
  kind: "edit",
  classify(input) {
    return input?.action === "list"
      ? { effect: "read", concurrencySafe: true }
      : { effect: "edit", concurrencySafe: false, destructive: input?.action === "remove" };
  },
  async run(input: TaskActionInput, ctx) {
    try {
      return withTaskLock(ctx.cwd, () => {
        const list = loadTasksUnlocked(ctx.cwd, true);
        const { list: next, reply } = applyTaskAction(list, input, new Date().toISOString());
        if (next !== list) saveTasksUnlocked(ctx.cwd, next);
        return reply;
      });
    } catch (error) {
      return `task: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
