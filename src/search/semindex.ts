// Semantic index — a zero-dependency, JSON-backed vector store with brute-force cosine. Fine for the
// code-asset / repo / knowledge-base scale (hundreds–low-thousands of chunks); the optional zvec adapter is
// the scale-up path later. Markdown/code stays the SSOT; this index is a derived, rebuildable, gitignored
// artifact. The embedder is injected (see embed.ts) so the store + chunking are testable without a model.
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, isAbsolute, resolve } from "node:path";
import { findProjectRoot } from "../context/agents-md.js";
import {
  listProjectFiles,
  listProjectFilesAsync,
  walkFiles,
  walkFilesAsync,
  type FileWalkLimitReason,
  type FileWalkOptions,
} from "../fs-walk.js";
import { zvecBuild, zvecQueryIds, zvecRemove } from "./zvec-store.js";
import { isSensitiveFilePath } from "../security/sensitive-files.js";
import { readModelContextFileSync } from "../fs-read.js";
import { homeWorkspaceActionError, isHomeWorkspace } from "../context/workspace-scope.js";
import {
  ensurePrivateStateSubdirectory,
  readPrivateStateFileSnapshot,
  removePrivateStateFile,
  type PrivateStateDirectoryIdentity,
  type PrivateStateFileSnapshot,
} from "../security/private-state.js";
import {
  atomicWriteText,
  bindHaraPrivateStateWritePath,
  type AtomicWriteBoundary,
} from "../fs-write.js";

// Same code/text extensions codebase_search ranks lexically — keep the two walks in sync.
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|sh|bash|sql|md|mdx|json|ya?ml|toml|html|css|scss|less|vue|svelte|astro|tf|proto|graphql|gql|gradle|txt)$/i;

export type Embedder = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
export interface Chunk {
  id: string;
  text: string;
  file: string;
  source: string; // repo | code-assets | skills | memory
  mtime?: number; // source file's mtimeMs — lets `hara index` reuse unchanged files (incremental)
}
interface Item extends Chunk {
  contentHash: string;
  vec: number[];
}
interface IndexFile {
  format: number;
  model: string;
  items: Item[];
}
export interface SemHit {
  file: string;
  source: string;
  score: number;
  text: string;
}

// Version 2 is the first cache format built exclusively through the protected-file identity boundary and
// keyed by source content rather than mtime alone. Versionless/older caches may contain historical aliases
// of secret files and are never queried or reused.
const INDEX_FORMAT = 2;

/** Index location — repo index lives in the project (gitignore it); the rest are global. Derived/rebuildable. */
export function indexPath(name: string, cwd: string): string {
  if (name === "repo") return join(findProjectRoot(cwd), ".hara", "index", "repo.json");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new Error(`invalid semantic index name '${name}'`);
  return join(homedir(), ".hara", "index", `${name}.json`);
}

interface PrivateIndexState {
  dir: PrivateStateDirectoryIdentity;
  path: string;
  ignore: string;
  indexSnapshot: PrivateStateFileSnapshot | null;
  ignoreSnapshot: PrivateStateFileSnapshot | null;
  indexBoundary: AtomicWriteBoundary;
  ignoreBoundary: AtomicWriteBoundary;
}

function indexBase(name: string, cwd: string): string {
  return name === "repo" ? findProjectRoot(cwd) : homedir();
}

async function ensurePrivateIndexState(name: string, cwd: string): Promise<PrivateIndexState> {
  const requested = indexPath(name, cwd); // validates non-repo names before touching the filesystem
  // Project `.hara` also contains explicitly user-authored memory/roles and keeps its existing sharing
  // mode; only the private `index` child is repaired. The global ~/.hara control plane is private in full.
  const dir = ensurePrivateStateSubdirectory(indexBase(name, cwd), [".hara", "index"], name === "repo" ? 1 : 0);
  const path = join(dir.path, basename(requested));
  const ignore = join(dir.path, ".gitignore");
  const indexSnapshot = await readPrivateStateFileSnapshot(path);
  const ignoreSnapshot = await readPrivateStateFileSnapshot(ignore);
  return {
    dir,
    path,
    ignore,
    indexSnapshot,
    ignoreSnapshot,
    indexBoundary: bindHaraPrivateStateWritePath(path, dir.path, "write semantic index"),
    ignoreBoundary: bindHaraPrivateStateWritePath(ignore, dir.path, "write semantic index ignore rule"),
  };
}

function existingPrivateIndexPath(name: string, cwd: string): string | null {
  try {
    if (name === "repo" && isHomeWorkspace(cwd)) return null;
    const requested = indexPath(name, cwd);
    const base = realpathSync.native(indexBase(name, cwd));
    const hara = join(base, ".hara");
    const dir = join(hara, "index");
    for (const component of [hara, dir]) {
      const info = lstatSync(component);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(component) !== component) return null;
    }
    const path = join(dir, basename(requested));
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 ? path : null;
  } catch {
    return null;
  }
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

function contentHash(chunks: readonly Chunk[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    const encoded = JSON.stringify([chunk.file, chunk.source, chunk.text]);
    hash.update(String(Buffer.byteLength(encoded, "utf8"))).update(":").update(encoded);
  }
  return hash.digest("hex");
}

async function rotateLegacyIndex(name: string, cwd: string, state: PrivateIndexState): Promise<void> {
  if (state.indexSnapshot) removePrivateStateFile(state.path, state.indexSnapshot, state.dir);
  await zvecRemove(name, cwd);
}

/** Build/refresh the index. **Incremental**: files whose content hash is unchanged keep their existing
 *  vectors (no re-embed); only new/changed files are embedded, and deleted files drop out. A changed
 *  embedding model forces a full rebuild (old vectors aren't comparable). Returns counts. */
export async function buildIndex(name: string, chunks: Chunk[], embed: Embedder, cwd: string, model = "embed", signal?: AbortSignal): Promise<{ total: number; embedded: number; reused: number }> {
  if (signal?.aborted) throw new Error("semantic index build interrupted");
  if (name === "repo" && isHomeWorkspace(cwd)) throw new Error(homeWorkspaceActionError("build a repository index"));
  const state = await ensurePrivateIndexState(name, cwd);
  const p = state.path;

  // Load the previous index → reuse vectors for unchanged files.
  const prevByFile = new Map<string, Item[]>();
  let prevModel = "";
  let legacy = false;
  if (state.indexSnapshot) {
    try {
      const old = JSON.parse(state.indexSnapshot.text) as IndexFile;
      if (old.format !== INDEX_FORMAT) {
        legacy = true;
      } else {
        prevModel = old.model;
        for (const it of old.items ?? []) {
          const arr = prevByFile.get(it.file);
          if (arr) arr.push(it);
          else prevByFile.set(it.file, [it]);
        }
      }
    } catch {
      legacy = true; // corrupt/unknown cache → full rebuild and ANN rotation
    }
  }
  if (legacy) await zvecRemove(name, cwd);
  const sameModel = prevModel === model;

  const byFile = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const arr = byFile.get(c.file);
    if (arr) arr.push(c);
    else byFile.set(c.file, [c]);
  }

  const items: Item[] = [];
  const toEmbed: Array<Chunk & { contentHash: string }> = [];
  let reused = 0;
  for (const [file, fchunks] of byFile) {
    if (signal?.aborted) throw new Error("semantic index build interrupted");
    const currentHash = contentHash(fchunks);
    const prev = prevByFile.get(file);
    if (
      sameModel
      && prev?.length === fchunks.length
      && prev.every((it) => it.contentHash === currentHash)
    ) {
      items.push(...prev); // file unchanged → keep its vectors
      reused += prev.length;
    } else {
      toEmbed.push(...fchunks.map((chunk) => ({ ...chunk, contentHash: currentHash })));
    }
  }

  const B = 64;
  for (let i = 0; i < toEmbed.length; i += B) {
    if (signal?.aborted) throw new Error("semantic index build interrupted");
    const batch = toEmbed.slice(i, i + B);
    const vecs = await embed(batch.map((c) => c.text), signal);
    if (signal?.aborted) throw new Error("semantic index build interrupted");
    batch.forEach((c, j) => vecs[j] && items.push({ ...c, vec: vecs[j] }));
  }

  // The index is derived + rebuildable (and may embed file contents) — never let it be committed.
  if (signal?.aborted) throw new Error("semantic index build interrupted");
  if (!state.ignoreSnapshot || state.ignoreSnapshot.text !== "*\n") {
    await atomicWriteText(state.ignoreBoundary.target, "*\n", {
      expected: state.ignoreSnapshot?.text ?? null,
      expectedIdentity: state.ignoreSnapshot ?? undefined,
      mode: 0o600,
      boundary: state.ignoreBoundary,
    });
  }
  await atomicWriteText(p, JSON.stringify({ format: INDEX_FORMAT, model, items } satisfies IndexFile), {
    expected: state.indexSnapshot?.text ?? null,
    expectedIdentity: state.indexSnapshot ?? undefined,
    mode: 0o600,
    boundary: state.indexBoundary,
  });
  // Build a zvec ANN index alongside the JSON cache (best-effort; queryIndex prefers it for retrieval).
  await zvecBuild(name, items.map((it) => ({ id: it.id, vec: it.vec })), cwd);
  return { total: items.length, embedded: toEmbed.length, reused };
}

export function indexExists(name: string, cwd: string): boolean {
  return existingPrivateIndexPath(name, cwd) !== null;
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
    let text: string;
    try {
      text = readModelContextFileSync(abs, 200_000);
    } catch {
      continue;
    }
    chunks.push(...chunkText(text, abs, source, statMtime(abs)));
  }
  return chunks;
}

/** Walk the repo (respecting .gitignore) and chunk every code/text file — the corpus `hara index` embeds. */
export function collectRepoChunks(root: string): Chunk[] {
  if (isHomeWorkspace(root)) throw new Error(homeWorkspaceActionError("scan the home directory for a repository index"));
  const chunks: Chunk[] = [];
  for (const rel of listProjectFiles(root)) {
    if (!CODE_RE.test(rel) || looksSecret(rel)) continue;
    const abs = join(root, rel);
    let text: string;
    try {
      text = readModelContextFileSync(abs, 200_000);
    } catch {
      continue;
    }
    chunks.push(...chunkText(text, rel, "repo", statMtime(abs)));
  }
  return chunks;
}

export interface ChunkCollectionResult {
  chunks: Chunk[];
  truncated: boolean;
  reason?: FileWalkLimitReason;
}

async function chunksFromInventory(
  root: string,
  files: string[],
  source: string,
  absolutePaths: boolean,
  startedAt: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ChunkCollectionResult> {
  const chunks: Chunk[] = [];
  let fileIndex = 0;
  for (const rel of files) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("index collection cancelled");
    if (Date.now() - startedAt >= timeoutMs) return { chunks, truncated: true, reason: "time_limit" };
    if (fileIndex++ > 0 && fileIndex % 32 === 0) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("index collection cancelled");
    }
    if (!CODE_RE.test(rel) || looksSecret(rel)) continue;
    const abs = join(root, rel);
    let text: string;
    try {
      text = readModelContextFileSync(abs, 200_000);
    } catch {
      continue;
    }
    chunks.push(...chunkText(text, absolutePaths ? abs : rel, source, statMtime(abs)));
  }
  return { chunks, truncated: false };
}

/** Interruptible knowledge-directory collection for the explicit index command and background callers. */
export async function collectDirChunksAsync(
  dir: string,
  source: string,
  options: FileWalkOptions = {},
): Promise<ChunkCollectionResult> {
  if (!existsSync(dir)) return { chunks: [], truncated: false };
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs!)) : 30_000;
  const startedAt = Date.now();
  const inventory = await walkFilesAsync(dir, { ...options, timeoutMs });
  const collected = await chunksFromInventory(
    dir,
    inventory.files,
    source,
    true,
    startedAt,
    timeoutMs,
    options.signal,
  );
  return collected.truncated ? collected : {
    chunks: collected.chunks,
    truncated: inventory.truncated,
    reason: inventory.reason,
  };
}

/** Interruptible repository collection. Git discovery and file reads share one total wall budget. */
export async function collectRepoChunksAsync(
  root: string,
  options: FileWalkOptions = {},
): Promise<ChunkCollectionResult> {
  if (isHomeWorkspace(root)) throw new Error(homeWorkspaceActionError("scan the home directory for a repository index"));
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs!)) : 30_000;
  const startedAt = Date.now();
  const inventory = await listProjectFilesAsync(root, { ...options, timeoutMs });
  const collected = await chunksFromInventory(
    root,
    inventory.files,
    "repo",
    false,
    startedAt,
    timeoutMs,
    options.signal,
  );
  return collected.truncated ? collected : {
    chunks: collected.chunks,
    truncated: inventory.truncated,
    reason: inventory.reason,
  };
}

/** Cosine-rank the index against the query embedding. Returns top-k hits (empty if no index). */
export async function queryIndex(name: string, query: string, embed: Embedder, cwd: string, k = 6, signal?: AbortSignal): Promise<SemHit[]> {
  if (signal?.aborted) throw new Error("semantic query interrupted");
  if (!existingPrivateIndexPath(name, cwd)) return [];
  let state: PrivateIndexState;
  try {
    state = await ensurePrivateIndexState(name, cwd);
  } catch {
    return [];
  }
  const p = state.path;
  if (!state.indexSnapshot) return [];
  let idx: IndexFile;
  try {
    idx = JSON.parse(state.indexSnapshot.text) as IndexFile;
  } catch {
    return [];
  }
  if (idx.format !== INDEX_FORMAT) {
    await rotateLegacyIndex(name, cwd, state);
    return [];
  }
  if (!idx.items?.length) return [];
  // Old indexes may predate the sensitive-file boundary. Filter at query time as well as build time so a
  // stale JSON/zvec cache can never resurrect protected content into model context.
  const root = findProjectRoot(cwd);
  const safeItems = idx.items.filter((item) => {
    const path = isAbsolute(item.file) ? item.file : resolve(root, item.file);
    return !looksSecret(item.file) && !isSensitiveFilePath(path);
  });
  if (!safeItems.length) return [];
  const [qv] = await embed([query], signal);
  if (signal?.aborted) throw new Error("semantic query interrupted");
  if (!qv) return [];

  // A format marker proves which writer created the cache, not that its source still has the same bytes.
  // Validate only ranked candidate files (cached per path) before returning their historical text. Missing,
  // replaced, hard-linked, protected, oversized, or changed sources fail closed without making every query
  // reread the entire corpus.
  const freshness = new Map<string, boolean>();
  const isFresh = (item: Item): boolean => {
    const path = isAbsolute(item.file) ? item.file : resolve(root, item.file);
    const cached = freshness.get(path);
    if (cached !== undefined) return cached;
    let fresh = false;
    try {
      const text = readModelContextFileSync(path, 200_000);
      fresh = contentHash(chunkText(text, item.file, item.source)) === item.contentHash;
    } catch {
      fresh = false;
    }
    freshness.set(path, fresh);
    return fresh;
  };

  const rankFresh = (candidates: Item[]): SemHit[] => {
    const ranked = candidates
      .map((it) => ({ item: it, score: cosine(qv, it.vec) }))
      .sort((a, b) => b.score - a.score);
    const hits: SemHit[] = [];
    for (const { item, score } of ranked) {
      if (signal?.aborted) break;
      if (!isFresh(item)) continue;
      hits.push({ file: item.file, source: item.source, text: item.text, score });
      if (hits.length >= k) break;
    }
    return hits;
  };

  // Prefer the zvec ANN index for candidate retrieval; re-rank candidates by EXACT cosine from the JSON
  // store (identical score semantics to the brute-force path). Fall back to full brute-force if zvec is
  // unavailable / has no index / errors.
  if (signal?.aborted) throw new Error("semantic query interrupted");
  const ids = await zvecQueryIds(name, qv, cwd, k);
  if (signal?.aborted) throw new Error("semantic query interrupted");
  if (ids?.length) {
    const byId = new Map(safeItems.map((it) => [it.id, it]));
    const candidates = ids
      .map((id) => byId.get(id))
      .filter((it): it is Item => Boolean(it));
    const hits = rankFresh(candidates);
    if (hits.length) return hits;
  }
  return rankFresh(safeItems);
}
