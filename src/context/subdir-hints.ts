// Lazy per-directory project docs — when a tool touches a directory we haven't seen yet, surface that dir's
// AGENTS.md / CLAUDE.md (the local conventions for that package) by appending it to the tool result, so a
// monorepo's per-package rules reach the model exactly when work moves into that package. Startup already
// loads root→cwd (agents-md.ts); this covers the subdirs the agent navigates INTO. Each dir loaded once.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { findProjectRoot } from "./agents-md.js";

const FILENAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const MAX = 8 * 1024;
const loaded = new Set<string>(); // dirs whose local doc we've already injected (per process / session)

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
  const parts: string[] = [];
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
          let txt = readFileSync(fp, "utf8").trim();
          if (!txt) break;
          if (Buffer.byteLength(txt, "utf8") > MAX) txt = txt.slice(0, MAX) + "\n…[truncated]";
          parts.push(`<!-- ${name} @ ${cd} — local conventions for this directory -->\n${txt}`);
        } catch {
          /* ignore unreadable */
        }
        break; // first filename match per dir
      }
    }
  }
  return parts.length ? "\n\n" + parts.join("\n\n") : "";
}
