import { createHash } from "node:crypto";
import { homedir } from "node:os";
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

function scopeKey(scope: unknown): string {
  const encoded = JSON.stringify(scope);
  const digest = createHash("sha256").update(encoded).digest("hex");
  return `v1:${digest}`;
}

/**
 * Compute the project + operation-family scope offered by “always”. Concrete commands, request IDs,
 * paths, and tool arguments are deliberately excluded: the UI says "for this project", so repeating the
 * same category must hit the remembered grant. Protected-file, permission, guardian, computer, and
 * external-action boundaries are evaluated separately and cannot be bypassed by this scope.
 */
export function projectApprovalScope(
  toolName: string,
  _input: Record<string, unknown>,
  cwd: string,
): ProjectApprovalScope {
  const identity = projectIdentity(cwd);
  const project = { rootKey: identity.rootKey, dev: identity.dev, ino: identity.ino };
  if (toolName === "python") {
    return {
      key: scopeKey({ version: 2, project, kind: "python" }),
      summary: "Always grants Python execution for this project; protected-file and high-risk guards still apply.",
    };
  }
  if (toolName === "bash") {
    return {
      key: scopeKey({ version: 2, project, kind: "bash" }),
      summary: "Always grants Bash commands for this project; protected-file, permission, and high-risk guards still apply.",
    };
  }
  if (toolName === "write_file" || toolName === "edit_file" || toolName === "apply_patch") {
    return {
      key: scopeKey({ version: 2, project, kind: "file-change" }),
      summary: "Always grants file changes inside this project; project and protected-file boundaries still apply.",
    };
  }
  const safeToolName = toolName.replace(/[^a-z0-9_.:-]/giu, "").slice(0, 80) || "this tool";
  return {
    key: scopeKey({ version: 2, project, kind: "tool-family", toolName }),
    summary: `Always grants ${safeToolName} actions for this project; independent safety boundaries still apply.`,
  };
}
