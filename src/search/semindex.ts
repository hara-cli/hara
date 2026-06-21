// Semantic index — a zero-dependency, JSON-backed vector store with brute-force cosine. Fine for the
// code-asset / repo / knowledge-base scale (hundreds–low-thousands of chunks); the optional zvec adapter is
// the scale-up path later. Markdown/code stays the SSOT; this index is a derived, rebuildable, gitignored
// artifact. The embedder is injected (see embed.ts) so the store + chunking are testable without a model.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { findProjectRoot } from "../context/agents-md.js";
import { listProjectFiles, walkFiles, isProbablyBinary, fileSize } from "../fs-walk.js";

// Same code/text extensions codebase_search ranks lexically — keep the two walks in sync.
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|sql|md|mdx|json|ya?ml|toml|html|css|scss|less|vue|svelte|astro|tf|proto|graphql|gql|gradle|txt)$/i;

export type Embedder = (texts: string[]) => Promise<number[][]>;
export interface Chunk {
  id: string;
  text: string;
  file: string;
  source: string; // repo | code-assets | skills | memory
  mtime?: number; // source file's mtimeMs — lets `hara index` reuse unchanged files (incremental)
}
interface Item extends Chunk {
  vec: number[];
}
interface IndexFile {
  model: string;
  items: Item[];
}
export interface SemHit {
  file: string;
  source: string;
  score: number;
  text: string;
}

/** Index location — repo index lives in the project (gitignore it); the rest are global. Derived/rebuildable. */
export function indexPath(name: string, cwd: string): string {
  if (name === "repo") return join(findProjectRoot(cwd), ".hara", "index", "repo.json");
  return join(homedir(), ".hara", "index", `${name}.json`);
}

function statMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Split a file into chunks: Markdown by `#` headings, code by ~40-line windows. Heuristic, zero-dep —
 *  also the substrate embeddings reuse. `mtime` (when given) is stamped on every chunk for incremental reuse. */
export function chunkText(text: string, file: string, source: string, mtime?: number): Chunk[] {
  const out: Chunk[] = [];
  const push = (body: string, n: number): void => {
    const t = body.trim();
    if (t.length >= 12) out.push({ id: `${file}#${n}`, text: t.slice(0, 2000), file, source, mtime });
  };
  if (/\.(md|mdx)$/i.test(file)) {
    const parts = text.split(/^(?=#{1,6}\s)/m);
    parts.forEach((p, i) => push(p, i));
  } else {
    const lines = text.split("\n");
    const W = 40;
    const STEP = 30; // overlap so a function spanning a boundary still lands in one chunk
    for (let i = 0, n = 0; i < lines.length; i += STEP, n++) push(lines.slice(i, i + W).join("\n"), n);
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Build/refresh the index. **Incremental**: files whose mtime is unchanged since the last build keep their
 *  existing vectors (no re-embed); only new/changed files are embedded, and deleted files drop out. A changed
 *  embedding model forces a full rebuild (old vectors aren't comparable). Returns counts. */
export async function buildIndex(name: string, chunks: Chunk[], embed: Embedder, cwd: string, model = "embed"): Promise<{ total: number; embedded: number; reused: number }> {
  const p = indexPath(name, cwd);

  // Load the previous index → reuse vectors for unchanged files.
  const prevByFile = new Map<string, Item[]>();
  let prevModel = "";
  if (existsSync(p)) {
    try {
      const old = JSON.parse(readFileSync(p, "utf8")) as IndexFile;
      prevModel = old.model;
      for (const it of old.items ?? []) {
        const arr = prevByFile.get(it.file);
        if (arr) arr.push(it);
        else prevByFile.set(it.file, [it]);
      }
    } catch {
      /* corrupt index → full rebuild */
    }
  }
  const sameModel = prevModel === model;

  const byFile = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const arr = byFile.get(c.file);
    if (arr) arr.push(c);
    else byFile.set(c.file, [c]);
  }

  const items: Item[] = [];
  const toEmbed: Chunk[] = [];
  let reused = 0;
  for (const [file, fchunks] of byFile) {
    const mtime = fchunks[0].mtime ?? 0;
    const prev = prevByFile.get(file);
    if (sameModel && prev?.length && mtime > 0 && prev.every((it) => it.mtime === mtime)) {
      items.push(...prev); // file unchanged → keep its vectors
      reused += prev.length;
    } else {
      toEmbed.push(...fchunks);
    }
  }

  const B = 64;
  for (let i = 0; i < toEmbed.length; i += B) {
    const batch = toEmbed.slice(i, i + B);
    const vecs = await embed(batch.map((c) => c.text));
    batch.forEach((c, j) => vecs[j] && items.push({ ...c, vec: vecs[j] }));
  }

  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  // The index is derived + rebuildable (and may embed file contents) — never let it be committed.
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n", "utf8");
  writeFileSync(p, JSON.stringify({ model, items } satisfies IndexFile), "utf8");
  return { total: items.length, embedded: toEmbed.length, reused };
}

export function indexExists(name: string, cwd: string): boolean {
  return existsSync(indexPath(name, cwd));
}

// Never embed (and POST to an embedding provider, then persist in the index) a secret-bearing file —
// the asset/skill/memory dirs aren't .gitignore-filtered, so a stray credentials.json/secrets.yaml/.env
// there would otherwise leak. Defense-in-depth (the repo walk already respects .gitignore).
const SECRET_FILE = /(^\.?env(\.|$)|secret|credential|password|apikey|api[_-]?key|\btoken|\.(pem|key|p12|pfx|keystore|crt)$|^\.netrc$|^\.npmrc$|id_(rsa|ed25519|ecdsa))/i;
function looksSecret(rel: string): boolean {
  return SECRET_FILE.test(rel.split("/").pop() ?? rel);
}

/** Walk one knowledge directory (code-assets / skills / memory) and chunk its files. Files come back as
 *  absolute paths so recall/memory_search can read or open them directly. */
export function collectDirChunks(dir: string, source: string): Chunk[] {
  if (!existsSync(dir)) return [];
  const chunks: Chunk[] = [];
  for (const rel of walkFiles(dir)) {
    if (!CODE_RE.test(rel) || looksSecret(rel)) continue;
    const abs = join(dir, rel);
    if (fileSize(abs) > 200_000) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    chunks.push(...chunkText(buf.toString("utf8"), abs, source, statMtime(abs)));
  }
  return chunks;
}

/** Walk the repo (respecting .gitignore) and chunk every code/text file — the corpus `hara index` embeds. */
export function collectRepoChunks(root: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const rel of listProjectFiles(root)) {
    if (!CODE_RE.test(rel) || looksSecret(rel)) continue;
    const abs = join(root, rel);
    if (fileSize(abs) > 200_000) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    chunks.push(...chunkText(buf.toString("utf8"), rel, "repo", statMtime(abs)));
  }
  return chunks;
}

/** Cosine-rank the index against the query embedding. Returns top-k hits (empty if no index). */
export async function queryIndex(name: string, query: string, embed: Embedder, cwd: string, k = 6): Promise<SemHit[]> {
  const p = indexPath(name, cwd);
  if (!existsSync(p)) return [];
  let idx: IndexFile;
  try {
    idx = JSON.parse(readFileSync(p, "utf8")) as IndexFile;
  } catch {
    return [];
  }
  if (!idx.items?.length) return [];
  const [qv] = await embed([query]);
  if (!qv) return [];
  return idx.items
    .map((it) => ({ file: it.file, source: it.source, text: it.text, score: cosine(qv, it.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
