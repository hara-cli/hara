// Code-asset recall — a personal, git-versionable library of snippets/playbooks the agent can
// reference. Lexical search over `~/.hara/code-assets/**/*.md` (override with HARA_ASSETS).
// Phase-C v0: lexical-first (no embeddings); reuses the shared filesystem walker.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { walkFiles, walkFilesAsync, type FileWalkOptions } from "./fs-walk.js";
import { skillsDirs } from "./skills/skills.js";
import { readModelContextFileSync } from "./fs-read.js";

const MAX_RECALL_SOURCE_BYTES = 256 * 1024;

export function assetsDir(): string {
  return process.env.HARA_ASSETS || join(homedir(), ".hara", "code-assets");
}

/** Every lexical-search root for "assets": the skills (project + global + plugin) and the code-asset
 *  library — one corpus so `recall` and dedup-before-save see the same things. */
export function assetSearchRoots(cwd: string): string[] {
  return [...skillsDirs(cwd), assetsDir()];
}

export interface Recalled {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export function titleOf(text: string, path: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const t = /(?:^|\n)title:\s*(.+)/i.exec(fm[1]);
    if (t) return t[1].trim();
  }
  const h = /^#\s+(.+)$/m.exec(text);
  return h ? h[1].trim() : (path.split("/").pop() ?? path);
}

/** A ranking boost from the asset's declared dimensions: a query word in the title or the frontmatter
 *  tags/lang matters more than one buried in the body. Used to order results, NOT the base relevance
 *  score (which the dedup threshold relies on). */
export function metaBoost(text: string, title: string, words: string[]): number {
  const titleL = title.toLowerCase();
  let b = words.filter((w) => titleL.includes(w)).length * 3;
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const tags = (/(?:^|\n)tags:\s*(.+)/i.exec(fm[1])?.[1] ?? "").toLowerCase();
    const lang = (/(?:^|\n)lang:\s*(.+)/i.exec(fm[1])?.[1] ?? "").toLowerCase();
    b += words.filter((w) => `${tags} ${lang}`.includes(w)).length * 2;
  }
  return b;
}

/**
 * Lexical search: rank .md files by how many query words appear in path+content.
 * Default searches the code-asset library (relative paths). Pass `roots` to search other dirs
 * (e.g. the memory store) — then paths come back absolute so callers can read them directly.
 */
export function searchAssets(query: string, limit = 5, roots?: string[]): Recalled[] {
  const dirs = roots ?? [assetsDir()];
  const abs = roots !== undefined;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: (Recalled & { boost: number })[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const rel of walkFiles(dir).filter((f) => f.endsWith(".md"))) {
      let text: string;
      try {
        text = readModelContextFileSync(join(dir, rel), MAX_RECALL_SOURCE_BYTES);
      } catch {
        continue;
      }
      const hay = (rel + "\n" + text).toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length; // distinct query words present (dedup threshold uses this)
      if (!score) continue;
      const title = titleOf(text, rel);
      hits.push({ path: abs ? join(dir, rel) : rel, title, snippet: text.slice(0, 800), score, boost: metaBoost(text, title, words) });
    }
  }
  // rank by relevance, then by the declared-dimension boost (title/tags/lang), then prefer the shorter path
  hits.sort((a, b) => b.score - a.score || b.boost - a.boost || a.path.length - b.path.length);
  return hits.slice(0, limit).map(({ boost, ...r }) => r);
}

/** Interruptible lexical search for agent/CLI paths. All roots and file reads share one wall budget. */
export async function searchAssetsAsync(
  query: string,
  limit = 5,
  roots?: string[],
  options: FileWalkOptions = {},
): Promise<Recalled[]> {
  const dirs = roots ?? [assetsDir()];
  const abs = roots !== undefined;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs!)) : 2_000;
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(0, Math.floor(options.maxFiles!)) : 8_000;
  const maxDirectories = Number.isFinite(options.maxDirectories) ? Math.max(0, Math.floor(options.maxDirectories!)) : 20_000;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(0, Math.floor(options.maxEntries!)) : 100_000;
  const startedAt = Date.now();
  let filesLeft = maxFiles;
  let directoriesLeft = maxDirectories;
  let entriesLeft = maxEntries;
  const hits: (Recalled & { boost: number })[] = [];

  for (const dir of dirs) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("asset search cancelled");
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0 || filesLeft <= 0 || directoriesLeft <= 0 || entriesLeft <= 0) break;
    if (!existsSync(dir)) continue;
    const inventory = await walkFilesAsync(dir, {
      maxFiles: filesLeft,
      maxDirectories: directoriesLeft,
      maxEntries: entriesLeft,
      timeoutMs: remainingMs,
      signal: options.signal,
      yieldEvery: options.yieldEvery,
    });
    filesLeft = Math.max(0, filesLeft - inventory.files.length);
    directoriesLeft = Math.max(0, directoriesLeft - inventory.directoriesVisited);
    entriesLeft = Math.max(0, entriesLeft - inventory.entriesVisited);

    let fileIndex = 0;
    for (const rel of inventory.files) {
      if (!rel.endsWith(".md")) continue;
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("asset search cancelled");
      if (Date.now() - startedAt >= timeoutMs) break;
      if (fileIndex++ > 0 && fileIndex % 32 === 0) {
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("asset search cancelled");
      }
      let text: string;
      try {
        text = readModelContextFileSync(join(dir, rel), MAX_RECALL_SOURCE_BYTES);
      } catch {
        continue;
      }
      const hay = (rel + "\n" + text).toLowerCase();
      const score = words.filter((word) => hay.includes(word)).length;
      if (!score) continue;
      const title = titleOf(text, rel);
      hits.push({ path: abs ? join(dir, rel) : rel, title, snippet: text.slice(0, 800), score, boost: metaBoost(text, title, words) });
    }
    if (Date.now() - startedAt >= timeoutMs || inventory.truncated) break;
  }

  hits.sort((a, b) => b.score - a.score || b.boost - a.boost || a.path.length - b.path.length);
  return hits.slice(0, limit).map(({ boost, ...recalled }) => recalled);
}

/** Create the assets dir with an example snippet + README. Returns files written. */
export function scaffoldAssets(): string[] {
  const dir = assetsDir();
  mkdirSync(join(dir, "snippets"), { recursive: true });
  const written: string[] = [];
  const ex = join(dir, "snippets", "example.md");
  if (!existsSync(ex)) {
    writeFileSync(
      ex,
      "---\ntitle: Example snippet\ntags: [example]\nlang: ts\n---\n\n# Example snippet\n\nDescribe a reusable pattern, then the code:\n\n```ts\nexport const example = 1;\n```\n",
    );
    written.push("snippets/example.md");
  }
  const rd = join(dir, "README.md");
  if (!existsSync(rd)) {
    writeFileSync(
      rd,
      '# hara code-assets\n\nDrop `*.md` files here (snippets, playbooks). `hara recall "<query>"` searches them;\nin the REPL, `/recall <query>` pulls the best matches into your next message. A personal,\ngit-versionable library of code/patterns you want to reuse.\n',
    );
    written.push("README.md");
  }
  return written;
}
