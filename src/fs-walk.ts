// Shared filesystem walker — powers @file completion and the grep/glob tools.
// Walks a directory tree, skipping noise dirs, capped so huge trees stay responsive.
import { readdirSync, statSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execFile, execSync } from "node:child_process";
import { fuzzyRank } from "./fuzzy.js";
import { isSensitiveFilePath } from "./security/sensitive-files.js";
import { toolSubprocessEnv } from "./security/subprocess-env.js";
import { recursiveRootContainsHome } from "./context/workspace-scope.js";

export const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".cache",
  "coverage", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "target", ".idea", ".vscode", ".hara", ".turbo", ".parcel-cache", "vendor",
]);

const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));

export type FileWalkLimitReason = "file_limit" | "directory_limit" | "entry_limit" | "time_limit";

export interface FileWalkOptions {
  maxFiles?: number;
  maxDirectories?: number;
  maxEntries?: number;
  /** Total wall-clock budget, measured from entry to the public scan API. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Directories/entries processed before explicitly yielding to the event loop. */
  yieldEvery?: number;
}

export interface FileWalkResult {
  files: string[];
  truncated: boolean;
  reason?: FileWalkLimitReason;
  directoriesVisited: number;
  entriesVisited: number;
}

interface NormalizedWalkOptions {
  maxFiles: number;
  maxDirectories: number;
  maxEntries: number;
  timeoutMs: number;
  signal?: AbortSignal;
  yieldEvery: number;
}

const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_MAX_DIRECTORIES = 20_000;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_ASYNC_TIMEOUT_MS = 2_000;
// Compatibility-only synchronous callers (readline completion and legacy public APIs) cannot be made
// interruptible. Keep them on a much tighter wall budget; agent/tool paths use the async APIs below.
const DEFAULT_SYNC_TIMEOUT_MS = 250;
const DEFAULT_YIELD_EVERY = 128;

function finiteLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : fallback;
}

function normalizeOptions(options: FileWalkOptions | undefined, defaultTimeoutMs: number): NormalizedWalkOptions {
  return {
    maxFiles: finiteLimit(options?.maxFiles, DEFAULT_MAX_FILES),
    maxDirectories: finiteLimit(options?.maxDirectories, DEFAULT_MAX_DIRECTORIES),
    maxEntries: finiteLimit(options?.maxEntries, DEFAULT_MAX_ENTRIES),
    timeoutMs: finiteLimit(options?.timeoutMs, defaultTimeoutMs),
    signal: options?.signal,
    yieldEvery: Math.max(1, finiteLimit(options?.yieldEvery, DEFAULT_YIELD_EVERY)),
  };
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason ? reason : "file scan aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function result(
  files: string[],
  directoriesVisited: number,
  entriesVisited: number,
  reason?: FileWalkLimitReason,
): FileWalkResult {
  return { files, truncated: reason !== undefined, reason, directoriesVisited, entriesVisited };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Interruptible filesystem walk for agent/tool paths. It has independent file, directory, Dirent and
 * total wall-clock limits. Dirents are streamed with `opendir`, and explicit yields ensure an agent
 * deadline's timer can run even when a large tree is entirely cached in memory.
 */
export async function walkFilesAsync(root: string, options: FileWalkOptions = {}): Promise<FileWalkResult> {
  const cfg = normalizeOptions(options, DEFAULT_ASYNC_TIMEOUT_MS);
  const startedAt = Date.now();
  throwIfAborted(cfg.signal);
  if (recursiveRootContainsHome(root)) return result([], 0, 0);
  if (cfg.maxFiles === 0) return result([], 0, 0, "file_limit");
  if (cfg.maxDirectories === 0) return result([], 0, 0, "directory_limit");
  if (cfg.maxEntries === 0) return result([], 0, 0, "entry_limit");

  const files: string[] = [];
  const stack: string[] = [root];
  let directoriesVisited = 0;
  let entriesVisited = 0;
  let sinceYield = 0;
  const timedOut = (): boolean => Date.now() - startedAt >= cfg.timeoutMs;

  while (stack.length) {
    throwIfAborted(cfg.signal);
    if (timedOut()) return result(files, directoriesVisited, entriesVisited, "time_limit");
    if (directoriesVisited >= cfg.maxDirectories) {
      return result(files, directoriesVisited, entriesVisited, "directory_limit");
    }

    const dir = stack.pop()!;
    directoriesVisited++;
    if (recursiveRootContainsHome(dir)) continue;
    let directory;
    try {
      // Stream Dirents so maxEntries is an allocation boundary too; readdir() would first materialize a
      // million-entry directory and only then let us enforce the counter.
      directory = await opendir(dir);
    } catch {
      throwIfAborted(cfg.signal);
      continue;
    }
    try {
      throwIfAborted(cfg.signal);
      if (timedOut()) return result(files, directoriesVisited, entriesVisited, "time_limit");
      for await (const entry of directory) {
        throwIfAborted(cfg.signal);
        if (timedOut()) return result(files, directoriesVisited, entriesVisited, "time_limit");
        if (entriesVisited >= cfg.maxEntries) {
          return result(files, directoriesVisited, entriesVisited, "entry_limit");
        }
        entriesVisited++;
        sinceYield++;

        // Yield before filters/continues so a forest of ignored or sensitive entries remains cancellable.
        if (sinceYield >= cfg.yieldEvery) {
          sinceYield = 0;
          await yieldToEventLoop();
          throwIfAborted(cfg.signal);
          if (timedOut()) return result(files, directoriesVisited, entriesVisited, "time_limit");
        }

        if (entry.name.startsWith(".") && entry.name !== ".env" && entry.isDirectory() && IGNORE_DIRS.has(entry.name)) {
          continue;
        }
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          stack.push(join(dir, entry.name));
        } else if (entry.isFile()) {
          const absolute = join(dir, entry.name);
          if (isSensitiveFilePath(absolute)) continue;
          files.push(toPosix(relative(root, absolute)));
          if (files.length >= cfg.maxFiles) {
            return result(files, directoriesVisited, entriesVisited, "file_limit");
          }
        }
      }
    } catch {
      throwIfAborted(cfg.signal);
      // Directory vanished or became unreadable while streaming it; keep the best-effort inventory.
    } finally {
      // Node normally closes a fully consumed async Dir iterator itself. Early budget/cancellation exits
      // also pass here; ignore ERR_DIR_CLOSED when the iterator already performed the close.
      try {
        await directory.close();
      } catch {
        /* already closed */
      }
    }

    // Empty-directory forests do not increment the Dirent counter while they are being popped. Yield on
    // directory progress too, otherwise that exact shape can starve AbortSignal timers.
    sinceYield++;
    if (sinceYield >= cfg.yieldEvery) {
      sinceYield = 0;
      await yieldToEventLoop();
      throwIfAborted(cfg.signal);
      if (timedOut()) return result(files, directoriesVisited, entriesVisited, "time_limit");
    }
  }
  return result(files, directoriesVisited, entriesVisited);
}

/**
 * Synchronous compatibility API. New agent/tool code must use `walkFilesAsync` so cancellation can run.
 * This legacy path is nevertheless bounded by directory count, Dirent count and a short wall budget.
 */
export function walkFiles(root: string, cap = DEFAULT_MAX_FILES, options: Omit<FileWalkOptions, "maxFiles" | "signal"> = {}): string[] {
  // Defense in depth: callers that need an explicitly selected child directory pass that child as root.
  // No generic inventory helper may silently turn the user's entire home into a project corpus.
  if (recursiveRootContainsHome(root)) return [];
  const cfg = normalizeOptions({ ...options, maxFiles: cap }, DEFAULT_SYNC_TIMEOUT_MS);
  const startedAt = Date.now();
  const files: string[] = [];
  const stack: string[] = [root];
  let directoriesVisited = 0;
  let entriesVisited = 0;
  while (stack.length && files.length < cfg.maxFiles) {
    if (Date.now() - startedAt >= cfg.timeoutMs) break;
    if (directoriesVisited >= cfg.maxDirectories || entriesVisited >= cfg.maxEntries) break;
    const dir = stack.pop()!;
    directoriesVisited++;
    if (recursiveRootContainsHome(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= cfg.maxFiles || entriesVisited >= cfg.maxEntries) break;
      if (Date.now() - startedAt >= cfg.timeoutMs) break;
      entriesVisited++;
      if (e.name.startsWith(".") && e.name !== ".env" && e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
      }
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        const absolute = join(dir, e.name);
        if (isSensitiveFilePath(absolute)) continue;
        files.push(toPosix(relative(root, absolute)));
      }
    }
  }
  return files;
}

/**
 * Non-ignored files for `root`. In a git repo: tracked + untracked (respects .gitignore).
 * Otherwise: a filesystem walk. POSIX-relative paths.
 */
export function listProjectFiles(root: string, cap = 8000): string[] {
  if (recursiveRootContainsHome(root)) return [];
  const startedAt = Date.now();
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: root,
      env: toolSubprocessEnv(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      // Bound it: a hung git (credential-helper GUI, a slow/network filesystem, a giant repo) must not
      // freeze the "which files exist" probe — on timeout it throws → we fall through to the fs walk.
      timeout: DEFAULT_SYNC_TIMEOUT_MS,
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((path) => Boolean(path) && !isSensitiveFilePath(join(root, path)));
    if (out.length) return out.slice(0, cap);
  } catch {
    /* not a git repo — fall through to fs walk */
  }
  return walkFiles(root, cap, { timeoutMs: Math.max(0, DEFAULT_SYNC_TIMEOUT_MS - (Date.now() - startedAt)) });
}

function gitProjectFiles(
  root: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    try {
      execFile(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        {
          cwd: root,
          env: toolSubprocessEnv(),
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: Math.max(1, timeoutMs),
          signal,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) rejectOutput(error);
          else resolveOutput(stdout);
        },
      );
    } catch (error) {
      rejectOutput(error);
    }
  });
}

/**
 * Interruptible project inventory. The git probe and filesystem fallback share one total wall budget;
 * an unavailable or slow git process can never grant the fallback a fresh timeout.
 */
export async function listProjectFilesAsync(root: string, options: FileWalkOptions = {}): Promise<FileWalkResult> {
  const cfg = normalizeOptions(options, DEFAULT_ASYNC_TIMEOUT_MS);
  const startedAt = Date.now();
  throwIfAborted(cfg.signal);
  if (recursiveRootContainsHome(root)) return result([], 0, 0);
  if (cfg.maxFiles === 0) return result([], 0, 0, "file_limit");
  if (cfg.maxEntries === 0) return result([], 0, 0, "entry_limit");

  const remaining = (): number => cfg.timeoutMs - (Date.now() - startedAt);
  try {
    if (remaining() <= 0) return result([], 0, 0, "time_limit");
    const stdout = await gitProjectFiles(root, remaining(), cfg.signal);
    throwIfAborted(cfg.signal);
    if (remaining() <= 0) return result([], 0, 0, "time_limit");

    const files: string[] = [];
    let entriesVisited = 0;
    for (const rawPath of stdout.split("\n")) {
      throwIfAborted(cfg.signal);
      if (remaining() <= 0) return result(files, 0, entriesVisited, "time_limit");
      const projectPath = rawPath.trim();
      if (!projectPath) continue;
      if (entriesVisited >= cfg.maxEntries) return result(files, 0, entriesVisited, "entry_limit");
      entriesVisited++;
      if (!isSensitiveFilePath(join(root, projectPath))) files.push(toPosix(projectPath));
      if (files.length >= cfg.maxFiles) return result(files, 0, entriesVisited, "file_limit");
      if (entriesVisited % cfg.yieldEvery === 0) {
        await yieldToEventLoop();
        throwIfAborted(cfg.signal);
      }
    }
    // A successful empty result is authoritative (empty repo, everything ignored, or only protected
    // paths). Falling back would violate .gitignore/protected-file semantics.
    return result(files, 0, entriesVisited);
  } catch {
    throwIfAborted(cfg.signal);
    // Not a git repo, git unavailable, or its bounded probe expired: fall through with only the budget
    // that remains. A timeout is intentionally not reset for the filesystem traversal.
  }

  const timeoutMs = remaining();
  if (timeoutMs <= 0) return result([], 0, 0, "time_limit");
  return walkFilesAsync(root, {
    maxFiles: cfg.maxFiles,
    maxDirectories: cfg.maxDirectories,
    maxEntries: cfg.maxEntries,
    timeoutMs,
    signal: cfg.signal,
    yieldEvery: cfg.yieldEvery,
  });
}

/** Directory prefixes implied by a set of file paths, e.g. "a/b/c.ts" → "a/", "a/b/". */
export function dirPrefixes(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc += parts[i] + "/";
      dirs.add(acc);
    }
  }
  return [...dirs];
}

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Up to `n` project files most similar to a (possibly mistyped) path — for did-you-mean. */
export function nearestPaths(cwd: string, p: string, n = 3): string[] {
  if (!p) return [];
  return fuzzyRank(p, listProjectFiles(cwd), (f) => f)
    .slice(0, n)
    .map((r) => r.item);
}

/** Interruptible did-you-mean helper for agent tools. */
export async function nearestPathsAsync(
  cwd: string,
  p: string,
  n = 3,
  options: FileWalkOptions = {},
): Promise<string[]> {
  if (!p) return [];
  const inventory = await listProjectFilesAsync(cwd, options);
  return fuzzyRank(p, inventory.files, (f) => f)
    .slice(0, n)
    .map((ranked) => ranked.item);
}
