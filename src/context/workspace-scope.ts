import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { effectiveHomeDir } from "../runtime.js";

/** Resolve existing paths through symlinks before comparing security/workspace scopes. Falling back to
 *  resolve() keeps messages deterministic for a path that disappears during startup; normal cwd/home paths
 *  exist and therefore take the realpath branch. */
export function canonicalWorkspacePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** The user's home directory is a control/personal-data scope, not an implicit project workspace. */
export function isHomeWorkspace(cwd: string, home = effectiveHomeDir()): boolean {
  return canonicalWorkspacePath(cwd) === canonicalWorkspacePath(home);
}

/** A recursive root is unsafe when it is Home itself OR an ancestor that would descend into Home. This
 * closes `path: ".."`, filesystem-root, and symlink-alias bypasses while keeping an explicitly selected
 * project child under Home usable. */
export function recursiveRootContainsHome(root: string, home = effectiveHomeDir()): boolean {
  const canonicalRoot = canonicalWorkspacePath(root);
  const canonicalHome = canonicalWorkspacePath(home);
  const rel = relative(canonicalRoot, canonicalHome);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Project-scoped execution from Home OR one of its ancestors can implicitly reach private user state. */
export function isUnsafeProjectWorkspace(cwd: string, home = effectiveHomeDir()): boolean {
  return recursiveRootContainsHome(cwd, home);
}

export function homeWorkspaceActionError(action: string): string {
  return (
    `Refusing to ${action} from a workspace that is the home directory or contains it: it is not an implicit project workspace. ` +
    "Use `/cd /path/to/project`, run `cd /path/to/project` first, or launch with `hara --cwd /path/to/project`."
  );
}

export function recursiveHomeSearchError(tool: string): string {
  return (
    `Error: ${tool} will not recursively scan the home directory. ` +
    "Run Hara from a project (`cd /path/to/project` or `hara --cwd /path/to/project`). Explicit single-file reads remain available."
  );
}

/** A model rooted at Home must not discover a child and silently promote it into the project scope. The
 * user establishes that scope by launching Hara from the concrete project directory. */
export function homeWorkspaceDirectoryScanError(tool: string): string {
  return (
    `Error: ${tool} will not enumerate or recursively scan directories while Hara is rooted at the home directory. ` +
    "Run `cd /path/to/project` or relaunch with `hara --cwd /path/to/project`. Explicit single-file reads remain available."
  );
}

/** Injected into model context when Hara was intentionally launched at ~/. Runtime checks enforce the same
 *  policy, but guidance avoids wasting turns on calls that are guaranteed to be rejected. */
export function homeWorkspaceGuidance(cwd: string): string {
  if (!isUnsafeProjectWorkspace(cwd)) return "";
  return (
    "# Home-directory workspace boundary\n" +
    "The working directory resolves to the user's home directory or an ancestor that contains it, which is not an implicit project. " +
    "Do not initialize a project, create or modify files, build a repository index, run shell/external " +
    "executable tools, enumerate directories, or grep/glob/search Home or one of its child directories. " +
    "Ask the user to switch with `/cd /path/to/project`, run `cd /path/to/project`, or launch with " +
    "`hara --cwd /path/to/project` for project work. Only explicitly named single-file reads remain available."
  );
}

export type WorkspaceSwitchResult =
  | { ok: true; cwd: string }
  | { ok: false; error: string };

/** Pick the first existing project directory from an already-authorized candidate list. This deliberately
 * does not enumerate Home: callers supply recent-session or registered-project paths, and the user still
 * confirms the handoff before Hara changes process.cwd(). */
export function suggestedProjectWorkspace(
  candidates: readonly string[],
  home = effectiveHomeDir(),
): string | undefined {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const target = realpathSync.native(resolve(candidate));
      if (seen.has(target)) continue;
      seen.add(target);
      if (!statSync(target).isDirectory() || isUnsafeProjectWorkspace(target, home)) continue;
      return target;
    } catch {
      // Stale session/project registrations are ordinary; skip them without weakening the boundary.
    }
  }
  return undefined;
}

const DEFAULT_PROJECT_CONTAINERS = [
  "Projects",
  "projects",
  "Developer",
  "developer",
  "work",
  "workspace",
  "src",
  "code",
  "dev",
  "repos",
] as const;
const SKIP_PROJECT_DIRECTORY = new Set([
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

interface ProjectDiscoveryOptions {
  containers?: readonly string[];
  maxDepth?: number;
  maxDirectories?: number;
}

interface DiscoveredProject {
  path: string;
  activityMs: number;
}

function projectEvidence(path: string): { activityMs: number } | null {
  let activityMs = 0;
  const git = resolve(path, ".git");
  try {
    const stat = lstatSync(git);
    if (stat.isDirectory() || stat.isFile()) {
      activityMs = Math.max(activityMs, stat.mtimeMs);
    }
  } catch {
    // No Git marker.
  }
  for (const manifest of ["package.json", "pyproject.toml"]) {
    try {
      const stat = lstatSync(resolve(path, manifest));
      if (stat.isFile()) activityMs = Math.max(activityMs, stat.mtimeMs);
    } catch {
      // Language manifests are optional; .git alone remains a valid project marker.
    }
  }
  return activityMs > 0 ? { activityMs } : null;
}

/** Bounded fallback discovery for an interactive launch at Home. This is intentionally NOT a recursive
 * Home scan: only conventional project containers are inspected, symlink directories are never followed,
 * build/vendor trees are skipped, and hard depth/count caps bound both latency and disclosure. Only .git,
 * package.json, and pyproject.toml mtimes rank filesystem candidates; AGENTS.md alone is not project evidence. */
export function discoverProjectWorkspaces(
  home = effectiveHomeDir(),
  options: ProjectDiscoveryOptions = {},
): string[] {
  const canonicalHome = canonicalWorkspacePath(home);
  const containers = options.containers ?? DEFAULT_PROJECT_CONTAINERS;
  const maxDepth = Math.max(0, Math.min(6, options.maxDepth ?? 3));
  const maxDirectories = Math.max(1, Math.min(2_000, options.maxDirectories ?? 400));
  const queue: { path: string; root: string; depth: number }[] = [];
  const queued = new Set<string>();
  for (const name of containers) {
    if (!/^[^/\\]+$/u.test(name) || name === "." || name === "..") continue;
    const root = resolve(canonicalHome, name);
    try {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const canonical = realpathSync.native(root);
      if (queued.has(canonical)) continue;
      queued.add(canonical);
      queue.push({ path: canonical, root: canonical, depth: 0 });
    } catch {
      // Conventional roots are optional.
    }
  }

  const discovered: DiscoveredProject[] = [];
  const visited = new Set<string>();
  while (queue.length && visited.size < maxDirectories) {
    const current = queue.shift()!;
    let canonical: string;
    try {
      const lexical = lstatSync(current.path);
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) continue;
      canonical = realpathSync.native(current.path);
    } catch {
      continue;
    }
    const fromRoot = relative(current.root, canonical);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) continue;
    if (visited.has(canonical) || isUnsafeProjectWorkspace(canonical, canonicalHome)) continue;
    visited.add(canonical);
    const evidence = projectEvidence(canonical);
    if (evidence) {
      discovered.push({ path: canonical, ...evidence });
      continue;
    }
    if (current.depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(canonical, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (queued.size >= maxDirectories) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || SKIP_PROJECT_DIRECTORY.has(entry.name.toLowerCase())) continue;
      const path = resolve(canonical, entry.name);
      if (queued.has(path)) continue;
      queued.add(path);
      queue.push({ path, root: current.root, depth: current.depth + 1 });
    }
  }
  return discovered
    .sort((a, b) => b.activityMs - a.activityMs || a.path.localeCompare(b.path))
    .map((project) => project.path);
}

/** Resolve an explicit interactive workspace handoff without accepting Home/ancestor scopes. */
export function resolveWorkspaceSwitch(
  input: string,
  currentCwd: string,
  home = effectiveHomeDir(),
): WorkspaceSwitchResult {
  let requested = input.trim();
  if (!requested) return { ok: false, error: "usage: /cd <project-directory>" };
  if (
    requested.length >= 2
    && ((requested.startsWith('"') && requested.endsWith('"')) || (requested.startsWith("'") && requested.endsWith("'")))
  ) requested = requested.slice(1, -1).trim();
  if (!requested) return { ok: false, error: "usage: /cd <project-directory>" };

  if (requested === "~") requested = home;
  else if (/^~[\\/]/u.test(requested)) {
    const parts = requested.slice(2).split(/[\\/]+/u).filter(Boolean);
    requested = resolve(home, ...parts);
  }

  try {
    const target = realpathSync.native(resolve(currentCwd, requested));
    if (!statSync(target).isDirectory()) return { ok: false, error: `not a directory: ${requested}` };
    if (isUnsafeProjectWorkspace(target, home)) {
      return { ok: false, error: homeWorkspaceActionError("switch project scope") };
    }
    return { ok: true, cwd: target };
  } catch (error) {
    return {
      ok: false,
      error: `cannot switch to '${requested}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
