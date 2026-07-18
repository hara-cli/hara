// Search/listing tools — grep (regex across files), glob (path patterns), ls (one directory).
// All read-only (kind: "read"), so they never hit the approval gate and run in parallel.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, resolve, join, relative, sep } from "node:path";
import { registerTool } from "./registry.js";
import { IGNORE_DIRS, walkFilesAsync } from "../fs-walk.js";
import {
  isSensitiveFilePath,
  sensitiveFileError,
  sensitiveFilesAllowed,
  SENSITIVE_SEARCH_GLOBS,
} from "../security/sensitive-files.js";
import { toolSubprocessEnv } from "../security/subprocess-env.js";
import {
  homeWorkspaceDirectoryScanError,
  isHomeWorkspace,
  recursiveRootContainsHome,
  recursiveHomeSearchError,
} from "../context/workspace-scope.js";

const MAX_OUT = 60_000;
const MAX_MATCHES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_TIMEOUT_MS = 5_000;
const MAX_PATTERN_CHARS = 4_096;
const MAX_GLOB_CHARS = 256;
const GLOB_SCAN_BUDGET_MS = 1_000;
const GLOB_MATCH_BUDGET_MS = 250;
const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"));
const absOf = (p: string | undefined, cwd: string): string => (p ? (isAbsolute(p) ? p : resolve(cwd, p)) : cwd);

/** Match one path segment with *, ? using the classic greedy wildcard algorithm. No RegExp is built
 * from model input, so repeated wildcard constructs cannot trigger regex backtracking. */
function matchGlobSegment(pattern: string, value: string): boolean {
  let patternAt = 0;
  let valueAt = 0;
  let starAt = -1;
  let starValueAt = -1;
  while (valueAt < value.length) {
    if (patternAt < pattern.length && (pattern[patternAt] === "?" || pattern[patternAt] === value[valueAt])) {
      patternAt++;
      valueAt++;
    } else if (patternAt < pattern.length && pattern[patternAt] === "*") {
      while (pattern[patternAt] === "*") patternAt++;
      starAt = patternAt;
      starValueAt = valueAt;
    } else if (starAt >= 0) {
      patternAt = starAt;
      valueAt = ++starValueAt;
    } else {
      return false;
    }
  }
  while (pattern[patternAt] === "*") patternAt++;
  return patternAt === pattern.length;
}

/** Standard path glob semantics: ** as a whole segment crosses directories, while * and ? stay within
 * one segment. The greedy ** checkpoint consumes path segments monotonically and remains bounded. */
function matchesGlob(pattern: string, value: string): boolean {
  const patternParts = pattern.split("/");
  const valueParts = value.split("/");
  let patternAt = 0;
  let valueAt = 0;
  let globstarAt = -1;
  let globstarValueAt = -1;
  while (valueAt < valueParts.length) {
    if (patternAt < patternParts.length && patternParts[patternAt] !== "**" && matchGlobSegment(patternParts[patternAt], valueParts[valueAt])) {
      patternAt++;
      valueAt++;
    } else if (patternParts[patternAt] === "**") {
      while (patternParts[patternAt] === "**") patternAt++;
      globstarAt = patternAt;
      globstarValueAt = valueAt;
    } else if (globstarAt >= 0) {
      patternAt = globstarAt;
      valueAt = ++globstarValueAt;
    } else {
      return false;
    }
  }
  while (patternParts[patternAt] === "**") patternAt++;
  return patternAt === patternParts.length;
}

interface GrepResult {
  kind: "ok" | "missing" | "invalid" | "error" | "timeout";
  lines: string[];
  matches: number;
  scanned: number;
  truncated: boolean;
  error?: string;
}

/** Run regex matching outside the agent process in ripgrep's linear-time regex engine. The subprocess is
 * killed at a hard deadline and once enough output has arrived, so neither a pathological pattern nor a
 * huge repository can wedge the CLI/Serve event loop. */
function runRipgrep(
  pattern: string,
  root: string,
  isFile: boolean,
  cwd: string,
  glob: string | undefined,
  ignoreCase: boolean,
): Promise<GrepResult> {
  return new Promise((resolveResult) => {
    const runCwd = isFile ? dirname(root) : root;
    const target = isFile ? basename(root) : ".";
    const args = [
      "--json",
      "--line-number",
      "--color", "never",
      "--no-ignore",
      "--hidden",
      "--threads", "1",
      "--max-filesize", String(MAX_FILE_BYTES),
      // Never stream a multi-megabyte minified line through JSON merely to slice it to 300 chars below.
      "--max-columns", "1000",
      "--max-columns-preview",
    ];
    for (const ignored of IGNORE_DIRS) args.push("--glob", `!**/${ignored}/**`);
    if (glob) args.push("--glob", glob);
    // Keep protected exclusions last: ripgrep resolves overlapping globs in argument order, so a caller's
    // positive glob must not re-include a safe-looking .env template during a broad directory search.
    if (!isFile && !sensitiveFilesAllowed()) {
      for (const protectedGlob of SENSITIVE_SEARCH_GLOBS) args.push("--glob", `!${protectedGlob}`);
    }
    if (ignoreCase) args.push("--ignore-case");
    args.push("--", pattern, target);

    const child = spawn("rg", args, { cwd: runCwd, stdio: ["ignore", "pipe", "pipe"], env: toolSubprocessEnv() });
    const lines: string[] = [];
    let matches = 0;
    let scanned = 0;
    let outputChars = 0;
    let pending = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let truncated = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GrepResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const stopForLimit = (): void => {
      if (truncated) return;
      truncated = true;
      child.kill("SIGKILL");
    };
    const consume = (line: string): void => {
      if (!line) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "summary") {
        const searches = Number(event?.data?.stats?.searches);
        if (Number.isFinite(searches)) scanned = searches;
        return;
      }
      if (event?.type !== "match" || matches >= MAX_MATCHES) return;
      const pathText = event?.data?.path?.text;
      const lineNo = Number(event?.data?.line_number);
      const content = event?.data?.lines?.text;
      if (typeof pathText !== "string" || !Number.isFinite(lineNo) || typeof content !== "string") return;
      const absolute = resolve(runCwd, pathText);
      if (isSensitiveFilePath(absolute)) return; // defense if a user glob overrides rg's exclusion ordering
      const shown = toPosix(relative(cwd, absolute)) || toPosix(relative(root, absolute)) || basename(absolute);
      const rendered = `${shown}:${lineNo}: ${content.replace(/\r?\n$/, "").trim().slice(0, 300)}`;
      lines.push(rendered);
      matches++;
      outputChars += rendered.length + 1;
      if (matches >= MAX_MATCHES || outputChars >= MAX_OUT) stopForLimit();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      // JSON events are newline-delimited. max-columns keeps normal match events small; fail boundedly if
      // a future rg version emits an unexpectedly giant unterminated event.
      if (pending.length > 2 * 1024 * 1024 && !pending.includes("\n")) return stopForLimit();
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (truncated) break;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        kind: error.code === "ENOENT" ? "missing" : "error",
        lines,
        matches,
        scanned,
        truncated,
        error: error.message,
      });
    });
    child.once("close", (code) => {
      if (timedOut) return finish({ kind: "timeout", lines: [], matches: 0, scanned, truncated: false });
      if (truncated) return finish({ kind: "ok", lines, matches, scanned, truncated: true });
      if (code === 0 || code === 1) return finish({ kind: "ok", lines, matches, scanned, truncated: false });
      finish({ kind: "error", lines: [], matches: 0, scanned, truncated: false, error: stderr.trim() || `ripgrep exited ${code}` });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GREP_TIMEOUT_MS);
    timer.unref();
  });
}

// Dependency-free grep worker for npm/Windows installations that do not have rg. Untrusted JavaScript
// RegExp evaluation happens only in this disposable process; the parent applies a hard wall-clock kill.
// The worker opens each candidate O_NONBLOCK, fstats that SAME fd, and performs a positional bounded read,
// so a path exchanged for a FIFO/device cannot wedge either process.
const NODE_GREP_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
let input = "";
let inputRejected = false;
function execute() {
  function emit(value) { process.stdout.write(JSON.stringify(value)); }
  if (inputRejected) return emit({ kind: "error", error: "grep worker input exceeded its safety limit" });
  let cfg;
  try { cfg = JSON.parse(input); }
  catch (error) { return emit({ kind: "error", error: "invalid grep worker input" }); }

  let expression;
  try { expression = new RegExp(cfg.pattern, cfg.ignoreCase ? "i" : ""); }
  catch (error) { return emit({ kind: "invalid", error: String(error && error.message || error) }); }

  function matchGlobSegment(pattern, value) {
    let patternAt = 0;
    let valueAt = 0;
    let starAt = -1;
    let starValueAt = -1;
    while (valueAt < value.length) {
      if (patternAt < pattern.length && (pattern[patternAt] === "?" || pattern[patternAt] === value[valueAt])) {
        patternAt++;
        valueAt++;
      } else if (patternAt < pattern.length && pattern[patternAt] === "*") {
        while (pattern[patternAt] === "*") patternAt++;
        starAt = patternAt;
        starValueAt = valueAt;
      } else if (starAt >= 0) {
        patternAt = starAt;
        valueAt = ++starValueAt;
      } else return false;
    }
    while (pattern[patternAt] === "*") patternAt++;
    return patternAt === pattern.length;
  }

  function matchesGlob(pattern, value) {
    const patternParts = pattern.split("/");
    const valueParts = value.split("/");
    let patternAt = 0;
    let valueAt = 0;
    let globstarAt = -1;
    let globstarValueAt = -1;
    while (valueAt < valueParts.length) {
      if (patternAt < patternParts.length && patternParts[patternAt] !== "**" && matchGlobSegment(patternParts[patternAt], valueParts[valueAt])) {
        patternAt++;
        valueAt++;
      } else if (patternParts[patternAt] === "**") {
        while (patternParts[patternAt] === "**") patternAt++;
        globstarAt = patternAt;
        globstarValueAt = valueAt;
      } else if (globstarAt >= 0) {
        patternAt = globstarAt;
        valueAt = ++globstarValueAt;
      } else return false;
    }
    while (patternParts[patternAt] === "**") patternAt++;
    return patternAt === patternParts.length;
  }

  // Candidate discovery and the complete protected-file policy run in the parent process. The worker gets
  // only paths whose exact identity was already approved, then verifies that identity again on the opened fd.
  const files = Array.isArray(cfg.files) ? cfg.files : [];

  const readBuffer = Buffer.allocUnsafe(cfg.maxFileBytes + 1);
  function sameIdentity(info, candidate) {
    return String(info.ino) === candidate.ino
      && (process.platform === "win32" || String(info.dev) === candidate.dev);
  }
  function safeReadText(candidate) {
    const absolute = candidate.path;
    let fd;
    try {
      const before = fs.lstatSync(absolute, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || !sameIdentity(before, candidate)) return null;
      const posixFlags = process.platform === "win32"
        ? 0
        : (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
      fd = fs.openSync(absolute, fs.constants.O_RDONLY | posixFlags);
      const info = fs.fstatSync(fd, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || !sameIdentity(info, candidate) || info.size > BigInt(cfg.maxFileBytes)) return null;
      let total = 0;
      while (total <= cfg.maxFileBytes) {
        const count = fs.readSync(fd, readBuffer, total, cfg.maxFileBytes + 1 - total, total);
        if (count === 0) break;
        total += count;
      }
      if (total > cfg.maxFileBytes) return null;
      const latest = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(absolute, { bigint: true });
      if (!latest.isFile() || latest.nlink !== 1n || !sameIdentity(latest, candidate) || !sameIdentity(current, candidate)) return null;
      if (latest.size !== info.size || latest.mtimeNs !== info.mtimeNs || latest.ctimeNs !== info.ctimeNs) return null;
      const bytes = readBuffer.subarray(0, total);
      if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0)) return null;
      return bytes.toString("utf8");
    } catch (error) {
      return null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (error) {}
    }
  }

  const lines = [];
  let matches = 0;
  let scanned = 0;
  let outputChars = 0;
  let truncated = cfg.candidatesTruncated === true;
  for (const candidate of files) {
    const absolute = candidate.path;
    if (matches >= cfg.maxMatches || outputChars >= cfg.maxOutputChars) { truncated = true; break; }
    const relativeForGlob = path.relative(cfg.isFile ? cfg.cwd : cfg.root, absolute).split(path.sep).join("/");
    if (cfg.glob && !matchesGlob(cfg.glob, relativeForGlob)) continue;
    const text = safeReadText(candidate);
    if (text === null) continue;
    scanned++;
    const fileLines = text.split("\n");
    for (let lineNumber = 0; lineNumber < fileLines.length; lineNumber++) {
      if (!expression.test(fileLines[lineNumber])) continue;
      let shown = path.relative(cfg.cwd, absolute).split(path.sep).join("/") || path.basename(absolute);
      if (shown.length > 1000) shown = "…/" + shown.slice(-996);
      const rendered = shown + ":" + (lineNumber + 1) + ": " + fileLines[lineNumber].trim().slice(0, 300);
      if (outputChars + rendered.length + 1 > cfg.maxOutputChars) { truncated = true; break; }
      lines.push(rendered);
      matches++;
      outputChars += rendered.length + 1;
      if (matches >= cfg.maxMatches) { truncated = true; break; }
    }
  }
  emit({ kind: "ok", lines: lines, matches: matches, scanned: scanned, truncated: truncated });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  if (inputRejected) return;
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) inputRejected = true;
});
process.stdin.on("end", execute);
`;

function normalizeGrepWorkerResult(parsed: any): GrepResult {
  if (!parsed || !["ok", "invalid", "error"].includes(String(parsed.kind))) throw new Error("invalid worker response");
  return {
    kind: parsed.kind as GrepResult["kind"],
    lines: Array.isArray(parsed.lines) ? parsed.lines.slice(0, MAX_MATCHES).map(String) : [],
    matches: Number.isFinite(parsed.matches) ? Number(parsed.matches) : 0,
    scanned: Number.isFinite(parsed.scanned) ? Number(parsed.scanned) : 0,
    truncated: parsed.truncated === true,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  };
}

async function runNodeGrep(
  pattern: string,
  root: string,
  isFile: boolean,
  cwd: string,
  glob: string | undefined,
  ignoreCase: boolean,
  signal?: AbortSignal,
): Promise<GrepResult> {
  const allowSensitive = sensitiveFilesAllowed();
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("grep cancelled");
  const inventory = isFile
    ? undefined
    : await walkFilesAsync(root, {
        maxFiles: 8_001,
        maxDirectories: 20_000,
        maxEntries: 100_000,
        timeoutMs: GREP_TIMEOUT_MS,
        signal,
        yieldEvery: 64,
      });
  const discovered = isFile ? [root] : inventory!.files.map((path) => join(root, path));
  const candidatesTruncated = !isFile && (inventory!.truncated || discovered.length > 8_000);
  const files: { path: string; dev: string; ino: string }[] = [];
  let candidateIndex = 0;
  for (const path of discovered.slice(0, 8_000)) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("grep cancelled");
    if (candidateIndex++ > 0 && candidateIndex % 64 === 0) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("grep cancelled");
    }
    // Broad searches intentionally omit every .env variant, including safe templates. Explicitly searching
    // one safe template remains supported, matching the ripgrep branch.
    const securityBase = basename(path).replace(/:.*$/u, "").replace(/[. ]+$/u, "").toLowerCase();
    if (!allowSensitive && !isFile && (securityBase === ".env" || securityBase.startsWith(".env."))) continue;
    if (sensitiveFileError(path, "search")) continue;
    try {
      const info = lstatSync(path, { bigint: true });
      // A hard-linked safe alias cannot prove where its other name lives. Reject every multi-link candidate
      // before it can cross into the isolated regex worker.
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(MAX_FILE_BYTES)) continue;
      files.push({ path, dev: String(info.dev), ino: String(info.ino) });
    } catch {
      // Raced, unreadable, symlink, FIFO, or device: omit it rather than weakening the read boundary.
    }
  }
  const payload = JSON.stringify({
    pattern,
    root,
    isFile,
    cwd,
    glob,
    ignoreCase,
    files,
    candidatesTruncated,
    maxFiles: 8_000,
    maxFileBytes: MAX_FILE_BYTES,
    maxMatches: MAX_MATCHES,
    maxOutputChars: MAX_OUT,
  });
  if (Buffer.byteLength(payload, "utf8") > 16 * 1024 * 1024) {
    return Promise.resolve({ kind: "error", lines: [], matches: 0, scanned: 0, truncated: false, error: "grep input exceeds its safety limit" });
  }
  return new Promise((resolveResult, rejectResult) => {
    const isBun = typeof (process.versions as Record<string, string | undefined>).bun === "string";
    const args = isBun ? ["-e", NODE_GREP_SOURCE] : ["--max-old-space-size=128", "-e", NODE_GREP_SOURCE];
    // In a Bun --compile build process.execPath is the hara executable. BUN_BE_BUN makes that embedded
    // runtime act as the Bun CLI for this isolated eval subprocess instead of recursively launching hara.
    const env = toolSubprocessEnv(process.env, isBun ? { BUN_BE_BUN: "1" } : {});
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      child.kill("SIGKILL");
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectResult(signal?.reason instanceof Error ? signal.reason : new Error("grep cancelled"));
    };
    const finish = (result: GrepResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 256 * 1024) {
        child.kill("SIGKILL");
        finish({ kind: "error", lines: [], matches: 0, scanned: 0, truncated: false, error: "grep worker output exceeded its safety limit" });
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      finish({ kind: "error", lines: [], matches: 0, scanned: 0, truncated: false, error: error.message });
    });
    child.once("close", (code) => {
      if (timedOut) return finish({ kind: "timeout", lines: [], matches: 0, scanned: 0, truncated: false });
      if (settled) return;
      if (code !== 0) return finish({ kind: "error", lines: [], matches: 0, scanned: 0, truncated: false, error: stderr.trim() || `grep worker exited ${code}` });
      try {
        finish(normalizeGrepWorkerResult(JSON.parse(stdout)));
      } catch (error: any) {
        finish({ kind: "error", lines: [], matches: 0, scanned: 0, truncated: false, error: error?.message ?? "invalid grep worker response" });
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GREP_TIMEOUT_MS);
    timer.unref();
    child.stdin.end(payload);
  });
}

registerTool({
  name: "grep",
  description:
    "Search file contents by regular expression. Returns matching `path:line: text`. " +
    "Scopes to `path` (dir or file, default cwd); optional `glob` filters which files; `ignore_case`.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "regular expression (executed in a bounded search subprocess)" },
      path: { type: "string", description: "directory or file to search (default: cwd)" },
      glob: { type: "string", description: "only search files whose path matches this glob (e.g. **/*.ts)" },
      ignore_case: { type: "boolean" },
    },
    required: ["pattern"],
  },
  kind: "read",
  concurrencySafe: true,
  async run(input, ctx) {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (pattern.length > MAX_PATTERN_CHARS) return `Error: grep pattern exceeds ${MAX_PATTERN_CHARS} characters.`;
    if (typeof input.glob === "string" && input.glob.length > MAX_GLOB_CHARS) return `Error: grep glob exceeds ${MAX_GLOB_CHARS} characters.`;
    const root = absOf(input.path, ctx.cwd);
    const denied = sensitiveFileError(root, "search");
    if (denied) return denied;
    let isFile = false;
    try {
      const info = statSync(root);
      if (!info.isFile() && !info.isDirectory()) return `Error: grep path is not a regular file or directory: ${input.path ?? "."}`;
      isFile = info.isFile();
    } catch {
      return `Error: no such path: ${input.path ?? "."}`;
    }
    if (!isFile && isHomeWorkspace(ctx.cwd)) return homeWorkspaceDirectoryScanError("grep");
    if (!isFile && recursiveRootContainsHome(root)) return recursiveHomeSearchError("grep");
    const searchArgs = [
      pattern,
      root,
      isFile,
      ctx.cwd,
      typeof input.glob === "string" ? input.glob : undefined,
      input.ignore_case === true,
    ] as const;
    // ripgrep opens pathnames itself, so a cooperating background process could exchange a candidate after
    // discovery and restore it before the post-filter. While the protected-file policy is active, use the
    // hardened worker that binds device+inode and reads through O_NOFOLLOW fds. The faster rg path is safe to
    // opt back into only with the explicit one-process sensitive-file waiver.
    const primary = sensitiveFilesAllowed()
      ? await runRipgrep(...searchArgs)
      : await runNodeGrep(...searchArgs, ctx.signal);
    if (primary.kind === "timeout") return `Error: grep exceeded its ${GREP_TIMEOUT_MS}ms safety timeout and was stopped.`;
    if (primary.kind === "invalid") return `Error: invalid regex: ${primary.error ?? "invalid pattern"}`;

    let { lines, matches, scanned } = primary;
    let truncated = primary.truncated;
    if (sensitiveFilesAllowed() && (primary.kind === "missing" || primary.kind === "error")) {
      const fallback = await runNodeGrep(pattern, root, isFile, ctx.cwd, typeof input.glob === "string" ? input.glob : undefined, input.ignore_case === true, ctx.signal);
      if (fallback.kind === "timeout") return `Error: grep exceeded its ${GREP_TIMEOUT_MS}ms safety timeout and was stopped.`;
      if (fallback.kind === "invalid") return `Error: invalid regex: ${fallback.error ?? "invalid pattern"}`;
      if (fallback.kind !== "ok") {
        const rgDetail = primary.kind === "error" && primary.error ? `; ripgrep: ${primary.error}` : "";
        return `Error: grep regex failed safely: ${fallback.error ?? "unknown worker error"}${rgDetail}`;
      }
      lines = fallback.lines;
      matches = fallback.matches;
      scanned = fallback.scanned;
      truncated = fallback.truncated;
    } else if (primary.kind !== "ok") {
      return `Error: grep regex failed safely: ${primary.error ?? "unknown worker error"}`;
    }
    if (!lines.length) return `No matches for /${input.pattern}/ (scanned ${scanned} files).`;
    let body = lines.join("\n");
    if (body.length > MAX_OUT) body = body.slice(0, MAX_OUT) + "\n…[truncated]";
    const head = truncated || matches >= MAX_MATCHES ? `(showing first ${Math.min(matches, MAX_MATCHES)} matches)\n` : "";
    return head + body;
  },
});

registerTool({
  name: "glob",
  description: "List files whose path matches a glob pattern (supports **, *, ?). Scopes to `path` (default cwd).",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "e.g. **/*.ts, src/**/index.*" },
      path: { type: "string", description: "base directory (default: cwd)" },
    },
    required: ["pattern"],
  },
  kind: "read",
  concurrencySafe: true,
  async run(input, ctx) {
    const root = absOf(input.path, ctx.cwd);
    const denied = sensitiveFileError(root, "search");
    if (denied) return denied;
    if (isHomeWorkspace(ctx.cwd)) return homeWorkspaceDirectoryScanError("glob");
    if (recursiveRootContainsHome(root)) return recursiveHomeSearchError("glob");
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (pattern.length > MAX_GLOB_CHARS) return `Error: glob pattern exceeds ${MAX_GLOB_CHARS} characters.`;
    const inventory = await walkFilesAsync(root, {
      maxFiles: 8_000,
      maxDirectories: 20_000,
      maxEntries: 100_000,
      timeoutMs: GLOB_SCAN_BUDGET_MS,
      signal: ctx.signal,
      yieldEvery: 64,
    });
    const files = inventory.files;
    const hits: string[] = [];
    const started = Date.now();
    let examined = 0;
    let budgetReached = false;
    for (const file of files) {
      if ((examined & 31) === 0) {
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        if (ctx.signal?.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("glob cancelled");
      }
      if ((examined & 31) === 0 && Date.now() - started >= GLOB_MATCH_BUDGET_MS) {
        budgetReached = true;
        break;
      }
      examined++;
      if (matchesGlob(pattern, file)) hits.push(file);
    }
    const scanNote = inventory.truncated
      ? `scan stopped at its ${inventory.reason?.replace("_", " ") ?? "safety limit"}`
      : "";
    if (!hits.length) {
      if (scanNote) return `No files matched ${pattern}; ${scanNote}. Narrow \`path\` and retry.`;
      return budgetReached
        ? `No files matched ${pattern} before the ${GLOB_MATCH_BUDGET_MS}ms safety budget; narrow \`path\` or simplify the glob.`
        : `No files match ${pattern}.`;
    }
    const shown = hits.slice(0, 400);
    const head = budgetReached
      ? `(showing ${shown.length} matches found before the ${GLOB_MATCH_BUDGET_MS}ms safety budget; examined ${examined}/${files.length} files)\n`
      : scanNote
        ? `(showing ${shown.length} matches; ${scanNote})\n`
        : hits.length > shown.length ? `(${hits.length} matches, showing 400)\n` : "";
    return head + shown.join("\n");
  },
});

registerTool({
  name: "ls",
  description: "List the entries of one directory (name, type, size). Non-recursive; use glob/grep to search deeper.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "directory (default: cwd)" } },
  },
  kind: "read",
  concurrencySafe: true,
  async run(input, ctx) {
    if (isHomeWorkspace(ctx.cwd)) return homeWorkspaceDirectoryScanError("ls");
    const dir = absOf(input.path, ctx.cwd);
    const denied = sensitiveFileError(dir, "list");
    if (denied) return denied;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e: any) {
      return `Error: cannot list ${input.path ?? "."}: ${e.message}`;
    }
    const protectedCount = entries.filter((entry) => !entry.isDirectory() && isSensitiveFilePath(join(dir, entry.name))).length;
    const rows = entries
      .filter((e) => !(e.isDirectory() && e.name === ".git") && (e.isDirectory() || !isSensitiveFilePath(join(dir, e.name))))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => {
        if (e.isDirectory()) return `  ${e.name}/`;
        let size = 0;
        try {
          size = statSync(join(dir, e.name)).size;
        } catch {
          /* ignore */
        }
        return `  ${e.name}  ${c_size(size)}`;
      });
    const note = protectedCount ? `(${protectedCount} protected file${protectedCount === 1 ? "" : "s"} hidden)` : "";
    return rows.length ? rows.join("\n") + (note ? `\n${note}` : "") : note || "(empty directory)";
  },
});

function c_size(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
