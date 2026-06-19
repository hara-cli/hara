import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, fuzzyRank, nearest } from "../dist/fuzzy.js";
import { fileCandidates } from "../dist/context/mentions.js";
import { nearestPaths } from "../dist/fs-walk.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/builtin.js";

test("fuzzyScore: subsequence matches, non-subsequence is null", () => {
  assert.ok(fuzzyScore("abc", "xaxbxc") !== null);
  assert.equal(fuzzyScore("abc", "acb"), null); // c before b → not a subsequence
  assert.equal(fuzzyScore("", "anything"), 0);
  // a clean consecutive run scores higher than a spread-out match
  assert.ok(fuzzyScore("abc", "abc") > fuzzyScore("abc", "axbxc"));
});

test("fuzzyRank: best match first, drops non-matches", () => {
  const ranked = fuzzyRank("idx", ["src/index.ts", "lib/widget.ts", "README.md"], (s) => s).map((r) => r.item);
  assert.equal(ranked[0], "src/index.ts");
  assert.ok(!ranked.includes("README.md")); // no i-d-x subsequence
});

test("nearest: did-you-mean for mistyped commands", () => {
  assert.ok(nearest("modl", ["model", "mode", "help", "exit", "reset"]).includes("model"));
  assert.equal(nearest("aprovl", ["approval", "model", "usage"])[0], "approval");
  assert.deepEqual(nearest("zzzzz", ["model", "help"]), []); // nothing close
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hara-fuzzy-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  return dir;
}

test("@ completion: fuzzy subsequence finds nested file (@idx → src/index.ts)", () => {
  const dir = fixture();
  try {
    assert.ok(fileCandidates(dir, "idx").includes("src/index.ts"));
    assert.ok(fileCandidates(dir, "sc").some((c) => c.startsWith("src"))); // subsequence (not transposition)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nearestPaths + read_file did-you-mean on a typo'd path", async () => {
  const dir = fixture();
  try {
    assert.ok(nearestPaths(dir, "src/indx.ts").includes("src/index.ts"));
    const out = await getTool("read_file").run({ path: "src/indx.ts" }, { cwd: dir });
    assert.match(out, /Did you mean/);
    assert.match(out, /src\/index\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
