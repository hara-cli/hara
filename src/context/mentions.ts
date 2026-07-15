// @file mentions — expand `@path` references in user input into appended file contents,
// and provide fuzzy file candidates for REPL tab-completion.
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { listProjectFiles, dirPrefixes, walkFiles, walkFilesAsync, type FileWalkOptions } from "../fs-walk.js";
import { fuzzyRank } from "../fuzzy.js";
import { mediaTypeFor } from "../images.js";
import { readModelContextPrefixSync } from "../fs-read.js";
import { sensitiveFileError } from "../security/sensitive-files.js";
import {
  homeWorkspaceDirectoryScanError,
  isHomeWorkspace,
  recursiveRootContainsHome,
  recursiveHomeSearchError,
} from "./workspace-scope.js";

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

/**
 * Interruptible production variant. In particular, `@dir` uses the streaming async walker so mention
 * expansion cannot block the event loop before an agent run's own deadline starts.
 */
export async function expandMentionsAsync(
  input: string,
  cwd: string,
  options: FileWalkOptions = {},
): Promise<string> {
  const seen = new Set<string>();
  const mentionRe = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs!)) : 2_000;
  const startedAt = Date.now();
  let output = "";
  let copiedThrough = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(input)) !== null) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("mention expansion cancelled");
    }
    output += input.slice(copiedThrough, match.index);
    copiedThrough = match.index + match[0].length;
    const whole = match[0];
    const ref = match[1];
    const prefix = whole.slice(0, whole.length - ref.length - 1);
    if (seen.has(ref)) {
      output += whole;
      continue;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      output += `${prefix}\nReferenced \`${ref}\` was not inserted because the ${timeoutMs}ms attachment budget was exhausted.\n`;
      continue;
    }
    const block = await expandRefAsync(ref, cwd, {
      ...options,
      timeoutMs: remainingMs,
      maxFiles: Math.min(options.maxFiles ?? 300, 300),
    });
    if (block === null) output += whole;
    else {
      seen.add(ref);
      output += `${prefix}${block}`;
    }
  }
  return output + input.slice(copiedThrough);
}

async function expandRefAsync(ref: string, cwd: string, options: FileWalkOptions): Promise<string | null> {
  const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const denied = sensitiveFileError(abs, "attach");
  if (denied) return `\nProtected file \`${ref}\` was not inserted into model context. ${denied}\n`;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `Referenced \`${ref}\` is a symbolic link — it was not inserted into model context.`;
    if (st.isFile()) {
      if (mediaTypeFor(abs)) return `Referenced \`${ref}\` is an image — paste it with Ctrl+V to attach it visually.`;
      const prefix = readModelContextPrefixSync(abs, MAX_FILE);
      if (prefix.binary) return `Referenced \`${ref}\` appears to be binary — it was not inserted into the model context.`;
      const txt = prefix.text + (prefix.truncated ? "\n…[truncated]" : "");
      return `\nReferenced file \`${ref}\`:\n\`\`\`\n${txt}\n\`\`\`\n`;
    }
    if (st.isDirectory()) {
      if (isHomeWorkspace(cwd)) return homeWorkspaceDirectoryScanError("directory attachment");
      if (recursiveRootContainsHome(abs)) return recursiveHomeSearchError("directory attachment");
      const inventory = await walkFilesAsync(abs, options);
      const bounded = inventory.truncated
        ? `; listing stopped at its ${inventory.reason?.replace("_", " ") ?? "safety limit"}`
        : "";
      return `\nReferenced directory \`${ref}\` (${inventory.files.length} files${bounded}):\n\`\`\`\n${inventory.files.join("\n") || "(empty)"}\n\`\`\`\n`;
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("mention expansion cancelled");
    }
    /* ignore unreadable mention */
  }
  return null;
}

/** Render one mention as an inline block, or null if it isn't a readable file/dir. */
function expandRef(ref: string, cwd: string): string | null {
  const abs = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const denied = sensitiveFileError(abs, "attach");
  if (denied) return `\nProtected file \`${ref}\` was not inserted into model context. ${denied}\n`;
  try {
    if (!existsSync(abs)) return null;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `Referenced \`${ref}\` is a symbolic link — it was not inserted into model context.`;
    if (st.isFile()) {
      // don't inline binary image bytes as text — paste with Ctrl+V (or drag the file in) to attach visually
      if (mediaTypeFor(abs)) return `Referenced \`${ref}\` is an image — paste it with Ctrl+V to attach it visually.`;
      const prefix = readModelContextPrefixSync(abs, MAX_FILE);
      if (prefix.binary) return `Referenced \`${ref}\` appears to be binary — it was not inserted into the model context.`;
      const txt = prefix.text + (prefix.truncated ? "\n…[truncated]" : "");
      return `\nReferenced file \`${ref}\`:\n\`\`\`\n${txt}\n\`\`\`\n`;
    }
    if (st.isDirectory()) {
      if (isHomeWorkspace(cwd)) return homeWorkspaceDirectoryScanError("directory attachment");
      if (recursiveRootContainsHome(abs)) return recursiveHomeSearchError("directory attachment");
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
  // Autocomplete is also directory discovery. Do not populate the cache or expose even top-level
  // names when the user launched Hara at Home; the user establishes project scope by starting in a
  // concrete child directory. Canonical comparison closes symlink aliases of Home.
  if (isHomeWorkspace(cwd)) return [];
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
