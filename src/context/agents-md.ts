// Project-context loading (AGENTS.md) — the cross-tool standard read by Codex/Claude Code/OpenClaw.
// Walks up from cwd to the project root, concatenates AGENTS.md files, caps total size.
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { readModelContextBytePrefixSync } from "../fs-read.js";

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
  let dir = resolve(cwd);
  for (;;) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd); // no marker found → treat cwd as root
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

export function hasAgentsMd(cwd: string): boolean {
  const root = findProjectRoot(cwd);
  return FILENAMES.some((n) => existsSync(join(root, n)));
}

/** Prompt hara runs against itself to analyze the repo and write AGENTS.md. */
export const INIT_PROMPT =
  "Explore this repository to understand it, then write a concise AGENTS.md at the project root.\n" +
  "Use read_file, bash (e.g. `ls`, `git ls-files`, `cat`), and write_file.\n" +
  "AGENTS.md should cover: what the project is (1-2 sentences), the directory structure, key commands " +
  "(build / test / run / lint), and important conventions. Keep it under ~150 lines.\n" +
  "Create it with write_file at path 'AGENTS.md', then reply with a one-line confirmation.";
