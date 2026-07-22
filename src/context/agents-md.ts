// Project-context loading (AGENTS.md) — the cross-tool standard read by Codex/Claude Code/OpenClaw.
// Walks up from cwd to the project root, concatenates AGENTS.md files, caps total size.
import { existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { readModelContextBytePrefixSync } from "../fs-read.js";
import { homeWorkspaceGuidance, isHomeWorkspace } from "./workspace-scope.js";

const FILENAMES = ["AGENTS.override.md", "AGENTS.md"];
const ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];
const MAX_BYTES = 32 * 1024;
const SEPARATOR = "\n\n--- project-doc ---\n\n";
const TRUNCATED = "\n…[truncated to project-context budget]";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Retain only whole Unicode code points whose UTF-8 encoding fits the remaining byte budget. */
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
  return utf8Prefix(value, MAX_BYTES - byteLength(TRUNCATED)) + TRUNCATED;
}

export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  // Home is a control/personal-data scope even when it happens to contain a package.json/.git marker.
  // Resolve this before the marker check so `hara` launched at ~/ cannot inherit a parent repository
  // through a symlinked/nested HOME used by managed development environments.
  if (isHomeWorkspace(start)) return start;
  let dir = start;
  for (;;) {
    // A marker accidentally placed at ~/ (for example a personal package.json) must not make every
    // unmarked child directory inherit the entire home as its project root. Explicit child scope stays local.
    if (dir !== start && isHomeWorkspace(dir)) return start;
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // no marker found → treat cwd as root
    dir = parent;
  }
}

/** Concatenate AGENTS.md files from project root down to cwd (root first), capped at 32 KiB. */
export function loadAgentsMd(cwd: string): string {
  const root = findProjectRoot(cwd);
  const chain: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    chain.unshift(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  let combined = "";
  for (const d of chain) {
    for (const name of FILENAMES) {
      const p = join(d, name);
      if (existsSync(p)) {
        try {
          const separator = combined ? SEPARATOR : "";
          const header = `<!-- ${name} @ ${d} -->\n`;
          const fixedBytes = byteLength(separator + header);
          const remaining = MAX_BYTES - byteLength(combined) - fixedBytes;
          if (remaining <= byteLength(TRUNCATED)) return markBudgetTruncation(combined);

          const read = readModelContextBytePrefixSync(p, remaining);
          if (read.binary) continue;
          let txt = read.text.trim();
          if (!txt) continue;
          if (read.truncated) {
            txt = utf8Prefix(txt, Math.max(0, remaining - byteLength(TRUNCATED))) + TRUNCATED;
          }
          combined += separator + header + utf8Prefix(txt, remaining);
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }
  return combined;
}

/** Model context is project AGENTS.md plus a built-in scope note when cwd is the user's home. Keeping the
 *  built-in note separate from loadAgentsMd() preserves that function's file-loading semantics and lets the
 *  UI accurately say whether an AGENTS.md file was actually loaded. */
export function loadAgentContext(cwd: string): string {
  const guidance = homeWorkspaceGuidance(cwd);
  const agents = loadAgentsMd(cwd);
  return [guidance, agents].filter(Boolean).join("\n\n--- workspace-context ---\n\n");
}

export function hasAgentsMd(cwd: string): boolean {
  const root = findProjectRoot(cwd);
  return FILENAMES.some((n) => existsSync(join(root, n)));
}

/** An empty directory has nothing useful for the init agent to analyze. Do not interrupt first launch with
 * an AGENTS.md offer until the user has created a project marker or at least one visible project file. */
export function hasProjectContent(cwd: string): boolean {
  const root = findProjectRoot(cwd);
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => {
      if (ROOT_MARKERS.includes(entry.name)) return true;
      if (entry.name === ".DS_Store" || entry.name === ".gitkeep") return false;
      return !entry.name.startsWith(".");
    });
  } catch {
    return false;
  }
}

/** Prompt hara runs against itself to analyze the repo and write AGENTS.md. */
export const INIT_PROMPT =
  "Explore this repository to understand it, then write a concise AGENTS.md at the project root.\n" +
  "Use read_file, bash (e.g. `ls`, `git ls-files`, `cat`), and write_file.\n" +
  "AGENTS.md should cover: what the project is (1-2 sentences), the directory structure, key commands " +
  "(build / test / run / lint), and important conventions. Keep it under ~150 lines.\n" +
  "Create it with write_file at path 'AGENTS.md', then reply with a one-line confirmation.";
