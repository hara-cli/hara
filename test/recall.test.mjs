import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchAssets, scaffoldAssets, assetsDir } from "../dist/recall.js";

test("recall: searchAssets ranks by query-word matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-assets-"));
  process.env.HARA_ASSETS = dir;
  try {
    assert.equal(assetsDir(), dir);
    mkdirSync(join(dir, "snippets"), { recursive: true });
    writeFileSync(join(dir, "snippets", "react-form.md"), "---\ntitle: React form validation\n---\nuse zod resolver for forms");
    writeFileSync(join(dir, "snippets", "sql.md"), "# SQL pagination\nLIMIT/OFFSET keyset pagination");
    const hits = searchAssets("form validation");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].path, "snippets/react-form.md");
    assert.equal(hits[0].title, "React form validation");
    assert.equal(searchAssets("nonexistentxyzzy").length, 0);
  } finally {
    delete process.env.HARA_ASSETS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: scaffoldAssets creates an example + README", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-assets2-"));
  process.env.HARA_ASSETS = dir;
  try {
    const w = scaffoldAssets();
    assert.ok(w.includes("README.md"));
    assert.ok(existsSync(join(dir, "snippets", "example.md")));
  } finally {
    delete process.env.HARA_ASSETS;
    rmSync(dir, { recursive: true, force: true });
  }
});
