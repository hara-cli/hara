import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchAssets, searchAssetsAsync, scaffoldAssets, assetsDir } from "../dist/recall.js";

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

test("recall: async asset search preserves ranking and propagates cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-assets-async-"));
  try {
    mkdirSync(join(dir, "snippets"), { recursive: true });
    writeFileSync(join(dir, "snippets", "ranked.md"), "---\ntitle: Retry backoff\ntags: [retry]\n---\nHTTP helper\n");
    writeFileSync(join(dir, "snippets", "body.md"), "# Notes\nretry appears only in the body\n");
    const hits = await searchAssetsAsync("retry", 5, [dir], { timeoutMs: 5_000 });
    assert.equal(hits[0].path, join(dir, "snippets", "ranked.md"));

    const controller = new AbortController();
    const reason = new Error("recall deadline");
    controller.abort(reason);
    await assert.rejects(
      searchAssetsAsync("retry", 5, [dir], { signal: controller.signal }),
      (error) => error === reason,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: CJK queries return a match-centered snippet from a long memory file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-assets-cjk-"));
  try {
    mkdirSync(join(dir, "memory"), { recursive: true });
    const prefix = Array.from({ length: 120 }, (_, index) => `- unrelated historical fact ${index}`).join("\n");
    writeFileSync(
      join(dir, "memory", "MEMORY.md"),
      `${prefix}\n- 讨论过马斯克的维基百科资料，结论保存在上一段会话。\n`,
    );

    const hits = await searchAssetsAsync("之前讨论的马斯克维基百科", 5, [dir], { timeoutMs: 5_000 });
    assert.equal(hits.length, 1);
    assert.match(hits[0].snippet, /马斯克的维基百科资料/);
    assert.doesNotMatch(hits[0].snippet, /historical fact 0\b/, "snippet is anchored at the match, not the file header");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall: technical single-letter and punctuation terms remain searchable", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-assets-technical-"));
  process.env.HARA_ASSETS = dir;
  try {
    writeFileSync(join(dir, "native.md"), "# Native notes\nC++ interop and R bindings\n");
    assert.equal(searchAssets("C++")[0]?.path, "native.md");
    assert.equal(searchAssets("R bindings")[0]?.path, "native.md");
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
