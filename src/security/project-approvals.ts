import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { findProjectRoot } from "../context/agents-md.js";
import { isUnsafeProjectWorkspace } from "../context/workspace-scope.js";
import {
  PrivateStateConflictError,
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
} from "./private-state.js";

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_PROJECTS = 128;
const MAX_GRANTS_PER_PROJECT = 256;
const GRANT_KEY = /^v1:[a-f0-9]{64}$/;
const PROJECT_KEY = /^p1:[a-f0-9]{64}$/;
const MAX_SCOPE_BYTES = 1024 * 1024;
const SCRATCH_DIRECTORIES = [".tmp", "logs", "output"] as const;

interface ProjectIdentity {
  root: string;
  rootKey: string;
  dev: number;
  ino: number;
}

interface StoredGrant {
  key: string;
  createdAt: string;
}

interface StoredProject {
  rootKey: string;
  dev: number;
  ino: number;
  updatedAt: string;
  grants: StoredGrant[];
}

interface ProjectApprovalState {
  version: 1;
  projects: StoredProject[];
}

export interface ProjectApprovalScope {
  /** Opaque, non-reversible identity. Commands, source code and paths never enter the state file. */
  key: string;
  /** Safe text appended to the interactive approval question. */
  summary: string;
}

export interface ProjectApprovalPolicy {
  has(key: string): boolean;
  remember(key: string): void;
}

const emptyState = (): ProjectApprovalState => ({ version: STORE_VERSION, projects: [] });

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function finiteIdentity(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseState(text: string): ProjectApprovalState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("project approval store is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project approval store has an invalid root");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STORE_VERSION || !Array.isArray(record.projects)) {
    throw new Error("project approval store has an unsupported schema");
  }
  const projects: StoredProject[] = [];
  for (const rawProject of record.projects.slice(0, MAX_PROJECTS)) {
    if (!rawProject || typeof rawProject !== "object" || Array.isArray(rawProject)) continue;
    const item = rawProject as Record<string, unknown>;
    const rootKey = boundedText(item.rootKey, 80);
    const dev = finiteIdentity(item.dev);
    const ino = finiteIdentity(item.ino);
    const updatedAt = boundedText(item.updatedAt, 64);
    if (!rootKey || !PROJECT_KEY.test(rootKey) || dev === null || ino === null || !updatedAt || !Array.isArray(item.grants)) continue;
    const grants: StoredGrant[] = [];
    const seen = new Set<string>();
    for (const rawGrant of item.grants.slice(0, MAX_GRANTS_PER_PROJECT)) {
      if (!rawGrant || typeof rawGrant !== "object" || Array.isArray(rawGrant)) continue;
      const grant = rawGrant as Record<string, unknown>;
      const key = boundedText(grant.key, 80);
      const createdAt = boundedText(grant.createdAt, 64);
      if (!key || !GRANT_KEY.test(key) || !createdAt || seen.has(key)) continue;
      seen.add(key);
      grants.push({ key, createdAt });
    }
    projects.push({ rootKey, dev, ino, updatedAt, grants });
  }
  return { version: STORE_VERSION, projects };
}

function projectIdentity(cwd: string, home = homedir()): ProjectIdentity {
  const root = realpathSync.native(findProjectRoot(cwd));
  if (isUnsafeProjectWorkspace(root, home)) {
    throw new Error("remembered approvals require an explicit project workspace");
  }
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(root) !== root) {
    throw new Error("project approval root is not a stable directory");
  }
  const rootKey = `p1:${createHash("sha256").update(root).digest("hex")}`;
  return { root, rootKey, dev: info.dev, ino: info.ino };
}

function sameProject(
  left: Pick<ProjectIdentity, "rootKey" | "dev" | "ino">,
  right: Pick<ProjectIdentity, "rootKey" | "dev" | "ino">,
): boolean {
  return left.rootKey === right.rootKey && left.dev === right.dev && left.ino === right.ino;
}

function serialized(state: ProjectApprovalState): string {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) {
    throw new Error("project approval store exceeds its private-state limit");
  }
  return text;
}

function fitProjects(projects: StoredProject[]): StoredProject[] {
  const fitted: StoredProject[] = [];
  for (const project of projects.slice(0, MAX_PROJECTS)) {
    const candidate = [...fitted, project];
    const text = `${JSON.stringify({ version: STORE_VERSION, projects: candidate }, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") <= MAX_STORE_BYTES) fitted.push(project);
  }
  return fitted;
}

class DurableProjectApprovalPolicy implements ProjectApprovalPolicy {
  private grants = new Set<string>();
  private readonly identity: ProjectIdentity;
  private readonly binding: ReturnType<typeof bindPrivateHaraStateFile>;
  private loadError: Error | null = null;

  constructor(cwd: string, home: string) {
    this.identity = projectIdentity(cwd, home);
    this.binding = bindPrivateHaraStateFile(home, [], "project-approvals.json");
    try {
      const snapshot = readPrivateStateFileSnapshotSync(this.binding.path, MAX_STORE_BYTES);
      if (!snapshot) return;
      const state = parseState(snapshot.text);
      const project = state.projects.find((entry) => sameProject(entry, this.identity));
      if (project) this.grants = new Set(project.grants.map((grant) => grant.key));
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
    }
  }

  has(key: string): boolean {
    return GRANT_KEY.test(key) && this.loadError === null && this.grants.has(key);
  }

  remember(key: string): void {
    if (!GRANT_KEY.test(key)) throw new Error("invalid project approval grant");
    if (this.loadError) {
      throw new Error("project approval store is unavailable; the action was allowed once", { cause: this.loadError });
    }
    if (this.grants.has(key)) return;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = readPrivateStateFileSnapshotSync(this.binding.path, MAX_STORE_BYTES);
      const state = snapshot ? parseState(snapshot.text) : emptyState();
      const now = new Date().toISOString();
      const retained = state.projects.filter((entry) => entry.rootKey !== this.identity.rootKey);
      const current = state.projects.find((entry) => sameProject(entry, this.identity));
      const grants = current?.grants.filter((grant) => GRANT_KEY.test(grant.key)) ?? [];
      if (!grants.some((grant) => grant.key === key)) {
        grants.push({ key, createdAt: now });
      }
      const nextProject: StoredProject = {
        rootKey: this.identity.rootKey,
        dev: this.identity.dev,
        ino: this.identity.ino,
        updatedAt: now,
        grants: grants.slice(-MAX_GRANTS_PER_PROJECT),
      };
      const next: ProjectApprovalState = {
        version: STORE_VERSION,
        projects: fitProjects(
          [
            nextProject,
            ...retained.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          ],
        ),
      };
      try {
        writePrivateStateFileSync(this.binding, serialized(next), {
          ...(snapshot ? { expectedText: snapshot.text } : {}),
        });
        this.grants = new Set(nextProject.grants.map((grant) => grant.key));
        return;
      } catch (error) {
        if (error instanceof PrivateStateConflictError && attempt < 2) continue;
        throw error;
      }
    }
  }
}

class UnavailableProjectApprovalPolicy implements ProjectApprovalPolicy {
  constructor(private readonly error: Error) {}
  has(): boolean {
    return false;
  }
  remember(): void {
    throw new Error("project approval store is unavailable; the action was allowed once", { cause: this.error });
  }
}

export function projectApprovalPolicy(cwd: string, home = homedir()): ProjectApprovalPolicy {
  try {
    return new DurableProjectApprovalPolicy(cwd, home);
  } catch (error) {
    return new UnavailableProjectApprovalPolicy(error instanceof Error ? error : new Error(String(error)));
  }
}

function stableValue(value: unknown, depth = 0, ancestors = new WeakSet<object>()): unknown {
  if (depth > 64) throw new Error("project approval scope is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "undefined") return { $undefined: true };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (!value || typeof value !== "object") throw new Error("project approval scope contains an unsupported value");
  if (ancestors.has(value)) throw new Error("project approval scope contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => stableValue(entry, depth + 1, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("project approval scope contains a non-JSON object");
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, stableValue(record[key], depth + 1, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function scopeKey(scope: unknown): string {
  const encoded = JSON.stringify(stableValue(scope));
  if (Buffer.byteLength(encoded, "utf8") > MAX_SCOPE_BYTES) {
    throw new Error("project approval scope is too large");
  }
  const digest = createHash("sha256").update(encoded).digest("hex");
  return `v1:${digest}`;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolvedInputPath(cwd: string, root: string, input: Record<string, unknown>): string | null {
  if (typeof input.path !== "string" || !input.path.trim() || input.path.includes("\0")) return null;
  if (!isAbsolute(input.path)) return resolve(realpathSync.native(cwd), input.path);
  const target = resolve(input.path);
  if (inside(root, target)) return target;
  // macOS commonly exposes /var through the /private/var real path. Preserve an explicitly absolute path,
  // but map the same lexical project tree onto its canonical root before deciding scratch-directory scope.
  const lexicalRoot = resolve(findProjectRoot(cwd));
  return inside(lexicalRoot, target) ? resolve(root, relative(lexicalRoot, target)) : target;
}

/**
 * Compute the narrow permission scope offered by “always”. Only the opaque key is persisted.
 * High-risk computer/external tools never call this function because they remain one-shot approvals.
 */
export function projectApprovalScope(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ProjectApprovalScope {
  const identity = projectIdentity(cwd);
  const root = identity.root;
  const project = { rootKey: identity.rootKey, dev: identity.dev, ino: identity.ino };
  if (toolName === "python") {
    return {
      key: scopeKey({ version: 1, project, kind: "python" }),
      summary: "Always grants Python execution for this project; protected-file and high-risk guards still apply.",
    };
  }
  if (toolName === "bash" && typeof input.command === "string") {
    return {
      key: scopeKey({
        version: 1,
        project,
        kind: "bash-command",
        command: input.command.trim(),
        background: input.background === true,
        registry: typeof input.registry === "string" ? input.registry : null,
      }),
      summary: "Always grants only this exact Bash command in this project.",
    };
  }
  if (toolName === "write_file" || toolName === "edit_file") {
    const target = resolvedInputPath(cwd, root, input);
    if (target) {
      for (const directory of SCRATCH_DIRECTORIES) {
        const boundary = resolve(root, directory);
        if (inside(boundary, target)) {
          return {
            key: scopeKey({ version: 1, project, kind: "scratch-write", boundary }),
            summary: `Always grants file changes under ${directory}/ in this project.`,
          };
        }
      }
      return {
        key: scopeKey({ version: 1, project, kind: "file-edit", target }),
        summary: "Always grants changes only to this exact file in this project.",
      };
    }
  }
  return {
    key: scopeKey({ version: 1, project, kind: "exact-tool-input", toolName, input }),
    summary: `Always grants only this exact ${toolName} action in this project.`,
  };
}
