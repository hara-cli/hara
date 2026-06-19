// @file mentions — expand `@path` references in user input into appended file contents,
// and provide fuzzy file candidates for REPL tab-completion.
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { listProjectFiles, dirPrefixes, walkFiles } from "../fs-walk.js";
import { fuzzyRank } from "../fuzzy.js";

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
      if (existsSync(abs)) {
        const st = statSync(abs);
        if (st.isFile()) {
          let txt = readFileSync(abs, "utf8");
          if (txt.length > MAX_FILE) txt = txt.slice(0, MAX_FILE) + "\n…[truncated]";
          blocks.push(`Referenced file \`${ref}\`:\n\`\`\`\n${txt}\n\`\`\``);
        } else if (st.isDirectory()) {
          // `@dir` loads a listing of the directory's files (the agent can then read specific ones)
          const files = walkFiles(abs, 300);
          blocks.push(`Referenced directory \`${ref}\` (${files.length} files):\n\`\`\`\n${files.join("\n") || "(empty)"}\n\`\`\``);
        }
      }
    } catch {
      /* ignore unreadable mention */
    }
  }
  return blocks.length ? `${input}\n\n${blocks.join("\n\n")}` : input;
}

// Short-lived per-cwd cache so Tab completion stays snappy without re-scanning every press.
const cache = new Map<string, { at: number; entries: string[] }>();
const CACHE_MS = 5000;

function projectEntries(cwd: string): string[] {
  const hit = cache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.entries;
  const files = listProjectFiles(cwd);
  // files + their directory prefixes (so `@src/` drills into the subtree)
  const entries = [...dirPrefixes(files), ...files];
  cache.set(cwd, { at: now, entries });
  return entries;
}

/**
 * File/dir candidates whose path matches `query`, for @ autocomplete.
 * Recurses subdirectories (git-tracked + untracked, or a filesystem walk outside git),
 * ranks path-prefix and basename matches first. Directories carry a trailing `/`.
 */
export function fileCandidates(cwd: string, query: string, limit = 25): string[] {
  const entries = projectEntries(cwd);
  if (!query) {
    // bare `@`: top-level entries, directories first
    const top = entries.filter((e) => !e.replace(/\/$/, "").includes("/"));
    top.sort((a, b) => (b.endsWith("/") ? 1 : 0) - (a.endsWith("/") ? 1 : 0) || a.localeCompare(b));
    return top.slice(0, limit);
  }
  // drilling: `@src/` → the immediate children of src/ (directories first), like a file picker
  if (query.endsWith("/")) {
    const kids = entries.filter((e) => e.startsWith(query) && e !== query && !e.slice(query.length).replace(/\/$/, "").includes("/"));
    if (kids.length) {
      kids.sort((a, b) => (b.endsWith("/") ? 1 : 0) - (a.endsWith("/") ? 1 : 0) || a.localeCompare(b));
      return kids.slice(0, limit);
    }
  }
  // fuzzy subsequence ranking — `@scr` finds `src/`, `@idx` finds `src/index.ts`
  return fuzzyRank(query, entries, (e) => e)
    .slice(0, limit)
    .map((r) => r.item);
}
