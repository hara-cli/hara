// zvec-backed ANN index for local semantic search. zvec (@zvec/zvec) is an OPTIONAL native dependency:
// if it's absent or fails to load (no prebuilt for the platform), every function here returns
// null/false and the caller falls back to the JSON brute-force store in semindex.ts — so installs
// without the native binding keep working (lexical/JSON floor preserved).
//
// Design: zvec stores only vector→id (a pure ANN index). The JSON store stays the durable embedding
// cache + SSOT for hit text/score. So zvec is used for fast candidate retrieval, but the SCORE is
// recomputed from the JSON vectors (in semindex.queryIndex) — identical score semantics, zero risk
// to hybrid.ts's thresholds.
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { findProjectRoot } from "../context/agents-md.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let cached: any = null;
let attempted = false;
async function zvec(): Promise<any> {
  if (attempted) return cached;
  attempted = true;
  try {
    cached = await import("@zvec/zvec");
  } catch {
    cached = null; // optional dep / no native prebuilt → callers fall back to brute-force
  }
  return cached;
}

export async function zvecAvailable(): Promise<boolean> {
  return (await zvec()) !== null;
}

function zvecDir(name: string, cwd: string): string {
  if (name === "repo") return join(findProjectRoot(cwd), ".hara", "index", "repo.zvec");
  return join(homedir(), ".hara", "index", `${name}.zvec`);
}

const VEC = "v";

/** (Re)build a fresh zvec collection from already-embedded items. Best-effort — false on any failure. */
export async function zvecBuild(name: string, items: { id: string; vec: number[] }[], cwd: string): Promise<boolean> {
  const z = await zvec();
  if (!z || items.length === 0) return false;
  try {
    const dim = items[0].vec.length;
    const path = zvecDir(name, cwd);
    rmSync(path, { recursive: true, force: true }); // rebuild from the JSON cache (vectors already computed)
    const schema = new z.ZVecCollectionSchema({
      name,
      vectors: [{ name: VEC, dataType: z.ZVecDataType.VECTOR_FP32, dimension: dim, indexParams: { indexType: z.ZVecIndexType.FLAT, metricType: z.ZVecMetricType.COSINE } }],
    });
    const col = z.ZVecCreateAndOpen(path, schema);
    col.insertSync(items.map((it) => ({ id: it.id, vectors: { [VEC]: it.vec } })));
    col.closeSync?.(); // closeSync flushes + releases the LOCK so a later (read-only) open succeeds
    return true;
  } catch {
    return false;
  }
}

/** ANN candidate ids (best first) from the zvec index. null if unavailable/error → caller brute-forces. */
export async function zvecQueryIds(name: string, qv: number[], cwd: string, k: number): Promise<string[] | null> {
  const z = await zvec();
  if (!z) return null;
  if (!existsSync(zvecDir(name, cwd))) return null;
  try {
    const col = z.ZVecOpen(zvecDir(name, cwd), { readOnly: true }); // read-only → no write-lock contention
    // over-fetch, then semindex re-ranks the candidates by exact cosine from the JSON store
    const docs: { id: string }[] = await col.query({ fieldName: VEC, vector: qv, topk: Math.max(k * 4, 24) });
    col.closeSync?.();
    return docs.map((d) => d.id);
  } catch {
    return null;
  }
}
