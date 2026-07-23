// Global agent index — ~/.hara/projects.json registers canonical project homes. The registry is private,
// atomically replaced, and guarded across processes because gateway/desktop/CLI may update it concurrently.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadRoles, loadGlobalRoles, type Role } from "./roles.js";
import { sleepSync } from "../sync-sleep.js";

export interface RegisteredProject {
  name: string;
  path: string;
}

export interface AgentIndexEntry {
  name: string;
  description: string;
  home: string;
  project?: string;
}

const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const LOCK_ATTEMPTS = 500;
const LOCK_WAIT_MS = 10;

function haraDir(): string {
  const dir = join(homedir(), ".hara");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort on non-POSIX filesystems */
  }
  return dir;
}

const projectsFile = (): string => join(haraDir(), "projects.json");

/** Handles are case-insensitive and form the left side of `project:agent`; canonical storage is lowercase. */
export function canonicalProjectName(value: string): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return PROJECT_NAME.test(name) ? name : null;
}

/** Existing paths resolve symlinks so one project cannot be registered twice through aliases. */
export function canonicalProjectPath(value: string, requireDirectory = false): string | null {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) return null;
  const absolute = resolve(value);
  try {
    if (requireDirectory && !statSync(absolute).isDirectory()) return null;
    return realpathSync.native(absolute);
  } catch {
    return requireDirectory ? null : absolute;
  }
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

function withProjectsLock<T>(fn: () => T): T {
  const file = projectsFile();
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
        // Another writer is reclaiming, or the evidence is malformed. Never fail open.
      } finally {
        const currentGuard = readLock(reclaim);
        if (currentGuard?.pid === process.pid && currentGuard.token === guard.token) rmSync(reclaim, { force: true });
      }
    }
    sleepSync(LOCK_WAIT_MS);
  }

  if (!claim) throw new Error("projects registry is busy; retry the operation");
  try {
    return fn();
  } finally {
    const current = readLock(lock);
    if (current?.pid === process.pid && current.token === claim.token) rmSync(lock, { force: true });
  }
}

function parseProjects(raw: string, strict: boolean): RegisteredProject[] {
  const parsed = JSON.parse(raw);
  const source = Array.isArray(parsed) ? parsed : parsed?.projects;
  if (!Array.isArray(source)) throw new Error("projects registry must contain a projects array");
  const out: RegisteredProject[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const value of source) {
    const name = canonicalProjectName(value?.name);
    const path = canonicalProjectPath(value?.path);
    if (!name || !path || names.has(name) || paths.has(path)) {
      if (strict) throw new Error("projects registry contains invalid or duplicate entries");
      continue;
    }
    names.add(name);
    paths.add(path);
    out.push({ name, path });
  }
  return out;
}

function loadProjectsUnlocked(strict: boolean): RegisteredProject[] {
  const file = projectsFile();
  if (!existsSync(file)) return [];
  try {
    return parseProjects(readFileSync(file, "utf8"), strict);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export function loadProjects(): RegisteredProject[] {
  return loadProjectsUnlocked(false);
}

function atomicSave(list: RegisteredProject[]): void {
  const file = projectsFile();
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ projects: list }, null, 2) + "\n", "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on non-POSIX filesystems */
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

function normalizeProjectList(list: RegisteredProject[]): RegisteredProject[] {
  if (!Array.isArray(list)) throw new Error("projects must be an array");
  const normalized = list.map((value) => {
    const name = canonicalProjectName(value?.name);
    const path = canonicalProjectPath(value?.path);
    if (!name || !path) throw new Error("project entries require a valid name and absolute path");
    return { name, path };
  });
  if (new Set(normalized.map((p) => p.name)).size !== normalized.length || new Set(normalized.map((p) => p.path)).size !== normalized.length) {
    throw new Error("project names and paths must be unique");
  }
  return normalized;
}

export function saveProjects(list: RegisteredProject[]): void {
  withProjectsLock(() => atomicSave(normalizeProjectList(list)));
}

export function addProject(nameInput: string, pathInput: string): string | null {
  const name = canonicalProjectName(nameInput);
  if (!name) return "invalid project name: use 1-64 lowercase letters, numbers, '.', '_' or '-'";
  const path = canonicalProjectPath(pathInput, true);
  if (!path) return `path does not exist or is not a directory: ${pathInput}`;
  try {
    return withProjectsLock(() => {
      const list = loadProjectsUnlocked(true);
      const alias = list.find((p) => p.path === path && p.name !== name);
      if (alias) return `path is already registered as '${alias.name}': ${path}`;
      const next = list.filter((p) => p.name !== name);
      next.push({ name, path });
      atomicSave(next);
      return null;
    });
  } catch (error) {
    return `projects registry: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function removeProject(nameInput: string): boolean {
  const name = canonicalProjectName(nameInput);
  if (!name) return false;
  return withProjectsLock(() => {
    const list = loadProjectsUnlocked(true);
    const next = list.filter((p) => p.name !== name);
    if (next.length === list.length) return false;
    atomicSave(next);
    return true;
  });
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

/** Project roles with the same prompt can still intentionally override model/routing/tool policy. */
function sameRoleDefinition(a: Role, b: Role): boolean {
  return (
    a.id === b.id &&
    a.description === b.description &&
    a.system === b.system &&
    a.model === b.model &&
    sameList(a.owns, b.owns) &&
    sameList(a.rejects, b.rejects) &&
    sameList(a.allowTools, b.allowTools) &&
    sameList(a.denyTools, b.denyTools) &&
    a.readOnly === b.readOnly &&
    a.modelInvocable === b.modelInvocable &&
    sameList(a.compatibilityWarnings, b.compatibilityWarnings)
  );
}

/** Build the global index: inherited globals are listed once; any project override gets its qualified home. */
export function buildAgentsIndex(profileId?: string): AgentIndexEntry[] {
  const globals = loadGlobalRoles(profileId);
  const globalById = new Map(globals.map((role) => [role.id, role]));
  const out: AgentIndexEntry[] = globals.map((role) => ({ name: role.id, description: role.description, home: "" }));
  for (const project of loadProjects()) {
    let roles: Role[] = [];
    try {
      roles = loadRoles(project.path, profileId);
    } catch {
      continue;
    }
    for (const role of roles) {
      const global = globalById.get(role.id);
      if (global && sameRoleDefinition(global, role)) continue;
      out.push({ name: role.id, description: role.description, home: project.path, project: project.name });
    }
  }
  return out;
}

/** Resolve `global:agent`, `project:agent`, or a bare name.
 *
 * Bare names normally prefer the global definition, then a unique project match. Callers that already
 * have a working directory (the chat gateway, for example) may pass it as `preferredHome`; a matching
 * project override then wins before the global fallback. This makes `/agent reviewer` do the local thing
 * while keeping registry-wide, context-free lookups deterministic. */
export function resolveAgent(
  refInput: string,
  preferredHome?: string,
  profileId?: string,
): AgentIndexEntry | { ambiguous: AgentIndexEntry[] } | null {
  if (typeof refInput !== "string") return null;
  const ref = refInput.trim();
  const index = buildAgentsIndex(profileId);
  const separator = ref.indexOf(":");
  if (separator > 0) {
    const namespace = ref.slice(0, separator).trim().toLowerCase();
    const name = ref.slice(separator + 1).trim();
    if (namespace === "global") {
      if (!name || name.includes(":")) return null;
      return index.find((entry) => !entry.project && entry.name === name) ?? null;
    }
    const project = canonicalProjectName(namespace);
    if (!project || !name || name.includes(":")) return null;
    return index.find((entry) => entry.project === project && entry.name === name) ?? null;
  }
  const hits = index.filter((entry) => entry.name === ref);
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  if (preferredHome) {
    const preferred = canonicalProjectPath(preferredHome);
    const local = preferred ? hits.find((entry) => !!entry.project && entry.home === preferred) : undefined;
    if (local) return local;
  }
  const global = hits.find((entry) => !entry.project);
  if (global) return global;
  return { ambiguous: hits };
}
