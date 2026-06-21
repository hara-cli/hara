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

test("recall: a frontmatter tag/title match outranks a body-only match at equal base score", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-assets-facet-"));
  process.env.HARA_ASSETS = dir;
  try {
    mkdirSync(join(dir, "snippets"), { recursive: true });
    // both mention "retry" exactly once — but A declares it in tags, B only in prose. A should win.
    writeFileSync(join(dir, "snippets", "a-tagged.md"), "---\ntitle: HTTP client\ntags: [retry, backoff]\nlang: ts\n---\n# HTTP client\nfetch wrapper");
    writeFileSync(join(dir, "snippets", "b-body.md"), "# Misc notes\nsometimes you retry a thing once in a while");
    const hits = searchAssets("retry");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].path, "snippets/a-tagged.md", "the tagged asset ranks first");
    assert.equal(hits[0].score, hits[1].score, "same base relevance score (one 'retry' each) — the boost broke the tie");
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
