// @file mentions — expand `@path` references in user input into appended file contents,
// and provide fuzzy file candidates for REPL tab-completion.
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { listProjectFiles, dirPrefixes, walkFiles } from "../fs-walk.js";
import { fuzzyRank } from "../fuzzy.js";
import { mediaTypeFor } from "../images.js";

const MAX_FILE = 50_000;
// @ at start-of-string or after whitespace; capture a path with no spaces/@ (avoids emails like a@b.com)
const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;

/** A submitted line is a slash COMMAND only if it starts with '/' AND its first whitespace-delimited
 *  token has no *embedded* '/'. A dropped/pasted absolute file path (`/Users/…/doc.md`, possibly followed
 *  by text or `[Image #N]` tokens) has an embedded slash → it is NOT a command. Without this, dragging a
 *  file into the prompt errored with "Unknown command /Users/…". Exported pure for tests. */
export function isSlashCommand(line: string): boolean {
  return line.startsWith("/") && !line.slice(1).split(/\s+/)[0].includes("/");
}

/** If a message BEGINS with an absolute file path (a dragged/pasted file), rewrite that leading path into
 *  an `@`-mention so expandMentions inlines the file's content into the turn — the "read/interpret this
 *  file" the user meant. Space-free leading paths only (a mention can't contain spaces); a non-existent or
 *  spaced path is left untouched. `exists` is injected so this stays pure/testable. */
export function inlineLeadingPath(line: string, exists: (p: string) => boolean): string {
  if (!line.startsWith("/")) return line;
  const first = line.split(/\s+/)[0];
  return exists(first) ? "@" + line : line;
}

/** Expand `@path` references **in place** — the file/dir content lands where it's referenced, not
 *  dumped at the bottom (so "compare @a.ts with @b.ts" reads in context). A repeated mention keeps
 *  the bare `@path` the second time (no double-inlining), and a non-readable ref is left untouched. */
export function expandMentions(input: string, cwd: string): string {
  const seen = new Set<string>();
  MENTION_RE.lastIndex = 0;
  return input.replace(MENTION_RE, (whole: string, ref: string) => {
    const prefix = whole.slice(0, whole.length - ref.length - 1); // BOL "" or the captured leading whitespace
    if (seen.has(ref)) return whole; // already inlined above → leave this occurrence as the bare @ref
    const block = expandRef(ref, cwd);
    if (block === null) return whole; // not a readable file/dir → leave the token as typed
    seen.add(ref);
    return `${prefix}${block}`;
  });
}

/** Render one mention as an inline block, or null if it isn't a readable file/dir. */
function expandRef(ref: string, cwd: string): string | null {
  const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
  try {
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    if (st.isFile()) {
      // don't inline binary image bytes as text — paste with Ctrl+V (or drag the file in) to attach visually
      if (mediaTypeFor(abs)) return `Referenced \`${ref}\` is an image — paste it with Ctrl+V to attach it visually.`;
      let txt = readFileSync(abs, "utf8");
      if (txt.length > MAX_FILE) txt = txt.slice(0, MAX_FILE) + "\n…[truncated]";
      return `\nReferenced file \`${ref}\`:\n\`\`\`\n${txt}\n\`\`\`\n`;
    }
    if (st.isDirectory()) {
      // `@dir` loads a listing of the directory's files (the agent can then read specific ones)
      const files = walkFiles(abs, 300);
      return `\nReferenced directory \`${ref}\` (${files.length} files):\n\`\`\`\n${files.join("\n") || "(empty)"}\n\`\`\`\n`;
    }
  } catch {
    /* ignore unreadable mention */
  }
  return null;
}

// Short-lived per-cwd cache so Tab completion stays snappy without re-scanning every press.
const cache = new Map<string, { at: number; entries: string[] }>();
const CACHE_MS = 5000;

function projectEntries(cwd: string): string[] {
  const key = resolve(cwd);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.entries;
  const files = listProjectFiles(key);
  // files + their directory prefixes (so `@src/` drills into the subtree)
  const entries = [...dirPrefixes(files), ...files];
  cache.set(key, { at: now, entries });
  return entries;
}

/** Invalidate the derived @path inventory after a coding tool creates/deletes a file. */
export function invalidateFileCandidates(cwd?: string): void {
  if (cwd) cache.delete(resolve(cwd));
  else cache.clear();
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
