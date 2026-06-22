// zvec local vector store — build + ANN query. Skips gracefully if the native binding isn't present
// (then the JSON brute-force floor covers it). node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zvecAvailable, zvecBuild, zvecQueryIds } from "../dist/search/zvec-store.js";

const tmpProject = () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-zvec-"));
  writeFileSync(join(cwd, "package.json"), "{}"); // a marker so findProjectRoot anchors here (repo index → cwd/.hara)
  return cwd;
};

test("zvec store: build + ANN query orders candidates by cosine similarity", async () => {
  if (!(await zvecAvailable())) {
    console.log("zvec native binding not available — skipping (JSON brute-force floor covers retrieval)");
    return;
  }
  const cwd = tmpProject();
  try {
    const items = [
      { id: "a", vec: [1, 0, 0] },
      { id: "b", vec: [0, 1, 0] },
      { id: "c", vec: [0.9, 0.1, 0] },
    ];
    assert.equal(await zvecBuild("repo", items, cwd), true, "build succeeds");
    const ids = await zvecQueryIds("repo", [1, 0, 0], cwd, 3);
    assert.ok(ids && ids.length >= 2, "got candidate ids");
    assert.equal(ids[0], "a", "nearest candidate is a ([1,0,0])");
    assert.equal(ids[1], "c", "second is c ([0.9,0.1,0]) — closer than b ([0,1,0])");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("zvec store: no index yet → null (caller falls back to brute-force)", async () => {
  if (!(await zvecAvailable())) return;
  const cwd = tmpProject();
  try {
    assert.equal(await zvecQueryIds("repo", [1, 0, 0], cwd, 3), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
