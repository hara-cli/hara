// @file mentions — expand `@path` references in user input into appended file contents,
// and provide fuzzy file candidates for REPL tab-completion.
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execSync } from "node:child_process";

const MAX_FILE = 50_000;
// @ at start-of-string or after whitespace; capture a path with no spaces/@ (avoids emails like a@b.com)
const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;

/** Append the contents of any @mentioned files to the input as fenced blocks. */
export function expandMentions(input: string, cwd: string): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(input)) !== null) {
    const ref = m[1];
    if (seen.has(ref)) continue;
    seen.add(ref);
    const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        let txt = readFileSync(abs, "utf8");
        if (txt.length > MAX_FILE) txt = txt.slice(0, MAX_FILE) + "\n…[truncated]";
        blocks.push(`Referenced file \`${ref}\`:\n\`\`\`\n${txt}\n\`\`\``);
      }
    } catch {
      /* ignore unreadable mention */
    }
  }
  return blocks.length ? `${input}\n\n${blocks.join("\n\n")}` : input;
}

/** Tracked files whose path contains `query` (for @ autocomplete). git ls-files; [] if not a repo. */
export function fileCandidates(cwd: string, query: string, limit = 20): string[] {
  let files: string[];
  try {
    files = execSync("git ls-files", { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  const q = query.toLowerCase();
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, limit);
}
