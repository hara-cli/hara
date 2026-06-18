// Project-context loading (AGENTS.md) — the cross-tool standard read by Codex/Claude Code/OpenClaw.
// Walks up from cwd to the project root, concatenates AGENTS.md files, caps total size.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const FILENAMES = ["AGENTS.override.md", "AGENTS.md"];
const ROOT_MARKERS = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".hg"];
const MAX_BYTES = 32 * 1024;

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

  const parts: string[] = [];
  for (const d of chain) {
    for (const name of FILENAMES) {
      const p = join(d, name);
      if (existsSync(p)) {
        try {
          const txt = readFileSync(p, "utf8").trim();
          if (txt) parts.push(`<!-- ${name} @ ${d} -->\n${txt}`);
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }

  let combined = parts.join("\n\n--- project-doc ---\n\n");
  if (Buffer.byteLength(combined, "utf8") > MAX_BYTES) {
    combined = Buffer.from(combined, "utf8").subarray(0, MAX_BYTES).toString("utf8") + "\n…[truncated]";
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
