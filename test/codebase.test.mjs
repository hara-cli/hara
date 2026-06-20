import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/codebase.js";

function tmpProject() {
  const dir = join(tmpdir(), "hara-cb-" + Math.random().toString(36).slice(2));
  mkdirSync(join(dir, ".git"), { recursive: true }); // anchors findProjectRoot; git ls-files fails → walkFiles
  return dir;
}

test("codebase_search: ranks repo files by relevance, returns file:line + snippet", async () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "auth.ts"), "export function loginUser(token) {\n  // verify the auth token and refresh the session\n  return validateToken(token);\n}\n");
  writeFileSync(join(proj, "src", "math.ts"), "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
  try {
    const r = await getTool("codebase_search").run({ query: "verify auth token refresh" }, { cwd: proj });
    assert.match(r, /src\/auth\.ts:\d+/, "finds the relevant file with a line number");
    assert.match(r, /verify the auth token/, "returns the relevant snippet");
    assert.doesNotMatch(r, /math\.ts/, "irrelevant file excluded (too few query words)");
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("codebase_search: empty query + no-match give friendly messages", async () => {
  const proj = tmpProject();
  writeFileSync(join(proj, "a.ts"), "const x = 1;\n");
  try {
    assert.match(await getTool("codebase_search").run({ query: "" }, { cwd: proj }), /empty query/);
    assert.match(await getTool("codebase_search").run({ query: "nonexistent zzzzz qqqqq" }, { cwd: proj }), /no relevant code/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});
