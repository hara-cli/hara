// zvec-backed ANN index for local semantic search. zvec (@zvec/zvec) is an OPTIONAL native dependency:
// if it's absent or fails to load (no prebuilt for the platform), every function here returns
// null/false and the caller falls back to the JSON brute-force store in semindex.ts — so installs
// without the native binding keep working (lexical/JSON floor preserved).
//
// Design: zvec stores vector→internal-id plus the original semantic id (a retrieval-only ANN index).
// The JSON store stays the durable embedding cache + SSOT for hit text/score. So zvec is used for fast
// candidate retrieval, but the SCORE is recomputed from the JSON vectors (in semindex.queryIndex) —
// identical score semantics, zero risk
// to hybrid.ts's thresholds.
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { findProjectRoot } from "../context/agents-md.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let loadPromise: Promise<any | null> | null = null;
async function zvec(): Promise<any> {
  // Share the in-flight import as well as its result. Returning a still-null cache to a concurrent first
  // caller would make availability depend on timing and unnecessarily drop that operation to JSON search.
  loadPromise ??= import("@zvec/zvec").catch(() => null);
  return loadPromise;
}

export async function zvecAvailable(): Promise<boolean> {
  return (await zvec()) !== null;
}

function zvecDir(name: string, cwd: string): string {
  if (name === "repo") return join(findProjectRoot(cwd), ".hara", "index", "repo.zvec");
  return join(homedir(), ".hara", "index", `${name}.zvec`);
}

/** Remove a derived ANN cache without loading the optional native binding. Used when the JSON format is
 * rotated so an old candidate store can never outlive the policy/version that produced it. */
export async function zvecRemove(name: string, cwd: string): Promise<void> {
  const path = zvecDir(name, cwd);
  await withPathLock(path, () => {
    rmSync(path, { recursive: true, force: true });
  });
}

const VEC = "v";
const SOURCE_ID = "source_id";

// zvec document ids are limited to a small ASCII character set and 64 bytes, while semantic-index ids are
// intentionally path-like (and may be absolute or Unicode). Keep the original id in a scalar field and use
// a fixed-width digest only as zvec's internal primary key.
function zvecId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

// A collection owns native RocksDB resources. closeSync() is the documented @zvec/zvec 0.5 API; making
// cleanup explicit and unconditional prevents a failed insert/query from retaining the process-local LOCK.
function closeCollection(col: any): boolean {
  if (!col) return true;
  try {
    if (typeof col.closeSync !== "function") return false;
    col.closeSync();
    return true;
  } catch {
    return false;
  }
}

// zvec permits concurrent readers but only one writer. More importantly, rebuilding removes and recreates
// the collection directory, so every operation on one path must be ordered in this process (readers too).
const pathTails = new Map<string, Promise<void>>();
async function withPathLock<T>(path: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = pathTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  pathTails.set(path, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pathTails.get(path) === tail) pathTails.delete(path);
  }
}

/** (Re)build a fresh zvec collection from already-embedded items. Best-effort — false on any failure. */
export async function zvecBuild(name: string, items: { id: string; vec: number[] }[], cwd: string): Promise<boolean> {
  const z = await zvec();
  if (!z || items.length === 0) return false;
  const path = zvecDir(name, cwd);
  return withPathLock(path, () => {
    let col: any = null;
    let success = false;
    try {
      const dim = items[0].vec.length;
      rmSync(path, { recursive: true, force: true }); // rebuild from the JSON cache (vectors already computed)
      const schema = new z.ZVecCollectionSchema({
        name,
        fields: [{ name: SOURCE_ID, dataType: z.ZVecDataType.STRING }],
        vectors: [{ name: VEC, dataType: z.ZVecDataType.VECTOR_FP32, dimension: dim, indexParams: { indexType: z.ZVecIndexType.FLAT, metricType: z.ZVecMetricType.COSINE } }],
      });
      col = z.ZVecCreateAndOpen(path, schema);
      col.insertSync(items.map((it) => ({ id: zvecId(it.id), fields: { [SOURCE_ID]: it.id }, vectors: { [VEC]: it.vec } })));
      success = true;
    } catch {
      success = false;
    } finally {
      if (!closeCollection(col)) success = false;
    }
    // Never leave a partially inserted ANN index visible: semindex treats any non-empty candidate set as
    // authoritative for candidate selection, so an incomplete native store would be worse than JSON fallback.
    if (!success) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* best-effort optional index cleanup */
      }
    }
    return success;
  });
}

/** ANN candidate ids (best first) from the zvec index. null if unavailable/error → caller brute-forces. */
export async function zvecQueryIds(name: string, qv: number[], cwd: string, k: number): Promise<string[] | null> {
  const z = await zvec();
  if (!z) return null;
  const path = zvecDir(name, cwd);
  return withPathLock(path, async () => {
    if (!existsSync(path)) return null;
    let col: any = null;
    let docs: { id: string; fields?: Record<string, unknown> }[] | null = null;
    let closed = false;
    try {
      col = z.ZVecOpen(path, { readOnly: true });
      // over-fetch, then semindex re-ranks the candidates by exact cosine from the JSON store
      // Omitting outputFields returns every scalar field (only source_id in current indexes) and also lets
      // pre-source_id collections answer with their original native id during a rolling upgrade.
      docs = await col.query({ fieldName: VEC, vector: qv, topk: Math.max(k * 4, 24) });
    } catch {
      docs = null;
    } finally {
      closed = closeCollection(col);
    }
    if (!docs || !closed) return null;
    // Old collections did not have source_id and used their JSON id directly; retain that best-effort read
    // compatibility even though normal index builds replace them with the current schema.
    return docs.map((doc) => (typeof doc.fields?.[SOURCE_ID] === "string" ? doc.fields[SOURCE_ID] : doc.id));
  });
}
