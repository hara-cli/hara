// Lazy per-directory project docs — when a tool touches a directory we haven't seen yet, surface that dir's
// AGENTS.md / CLAUDE.md (the local conventions for that package) by appending it to the tool result, so a
// monorepo's per-package rules reach the model exactly when work moves into that package. Startup already
// loads root→cwd (agents-md.ts); this covers the subdirs the agent navigates INTO. Each dir loaded once.
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { findProjectRoot } from "./agents-md.js";
import { readModelContextBytePrefixSync } from "../fs-read.js";

const FILENAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const MAX = 8 * 1024;
const TRUNCATED = "\n…[truncated to subdirectory-context budget]";
const loaded = new Set<string>(); // dirs whose local doc we've already injected (per process / session)

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  let used = 0;
  let out = "";
  for (const char of value) {
    const bytes = byteLength(char);
    if (used + bytes > maxBytes) break;
    out += char;
    used += bytes;
  }
  return out;
}

function markBudgetTruncation(value: string): string {
  return utf8Prefix(value, MAX - byteLength(TRUNCATED)) + TRUNCATED;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Candidate file/dir paths referenced by a tool call (its `path`, or path-like tokens in a shell command). */
function pathsFrom(input: any): string[] {
  const out: string[] = [];
  if (typeof input?.path === "string") out.push(input.path);
  if (typeof input?.command === "string") for (const m of input.command.matchAll(/[\w.@~+-]*\/[\w./@+-]+/g)) out.push(m[0]);
  return out;
}

/** Project docs for any NEW directory (strictly under cwd) this tool call touches — appendable to the tool
 *  result. Returns "" when nothing new. Each directory is checked/loaded at most once per session. */
export function subdirHint(input: unknown, cwd: string): string {
  const base = resolve(cwd);
  const root = findProjectRoot(cwd);
  let hint = "";
  for (const raw of pathsFrom(input)) {
    const absPath = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    const startDir = isDir(absPath) ? absPath : dirname(absPath);
    const rel = relative(base, startDir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue; // not strictly under cwd → startup already covered it
    // collect unseen dirs from startDir up to (but excluding) cwd
    const chain: string[] = [];
    let d = startDir;
    while (d.startsWith(base) && d !== base) {
      if (!loaded.has(d)) chain.unshift(d);
      if (d === root) break;
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
    for (const cd of chain) {
      loaded.add(cd); // mark checked even if no doc here, so we don't re-scan it
      for (const name of FILENAMES) {
        const fp = join(cd, name);
        if (!existsSync(fp)) continue;
        try {
          const separator = "\n\n";
          const header = `<!-- ${name} @ ${cd} — local conventions for this directory -->\n`;
          const remaining = MAX - byteLength(hint) - byteLength(separator + header);
          if (remaining <= byteLength(TRUNCATED)) return markBudgetTruncation(hint);
          const read = readModelContextBytePrefixSync(fp, remaining);
          if (read.binary) break;
          let txt = read.text.trim();
          if (!txt) break;
          if (read.truncated) {
            txt = utf8Prefix(txt, Math.max(0, remaining - byteLength(TRUNCATED))) + TRUNCATED;
          }
          hint += separator + header + utf8Prefix(txt, remaining);
        } catch {
          /* ignore unreadable */
        }
        break; // first filename match per dir
      }
    }
  }
  return hint;
}
