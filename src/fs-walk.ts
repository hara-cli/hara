// Shared filesystem walker — powers @file completion and the grep/glob tools.
// Walks a directory tree, skipping noise dirs, capped so huge trees stay responsive.
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execSync } from "node:child_process";
import { fuzzyRank } from "./fuzzy.js";
import { isSensitiveFilePath } from "./security/sensitive-files.js";
import { toolSubprocessEnv } from "./security/subprocess-env.js";

export const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".cache",
  "coverage", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  "target", ".idea", ".vscode", ".hara", ".turbo", ".parcel-cache", "vendor",
]);

const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));

/** Relative POSIX file paths under `root`, skipping IGNORE_DIRS, capped at `cap` files. */
export function walkFiles(root: string, cap = 8000): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length && files.length < cap) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= cap) break;
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
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: root,
      env: toolSubprocessEnv(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      // Bound it: a hung git (credential-helper GUI, a slow/network filesystem, a giant repo) must not
      // freeze the "which files exist" probe — on timeout it throws → we fall through to the fs walk.
      timeout: 5000,
    })
      .split("\n")
      .map((s) => s.trim())
      .filter((path) => Boolean(path) && !isSensitiveFilePath(join(root, path)));
    if (out.length) return out.slice(0, cap);
  } catch {
    /* not a git repo — fall through to fs walk */
  }
  return walkFiles(root, cap);
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
