import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, buildIndex, queryIndex, indexExists, collectRepoChunks, collectDirChunks } from "../dist/search/semindex.js";
import { getEmbedder } from "../dist/search/embed.js";
import { searchHybrid } from "../dist/search/hybrid.js";

// Deterministic mock embedder: bag-of-words over a tiny vocab → vector. Stands in for a real embedding
// model so the index → cosine → rank pipeline is testable without a network/model.
const VOCAB = ["auth", "login", "token", "retry", "error", "database", "render", "button"];
const mockEmbed = async (texts) =>
  texts.map((t) => {
    const lc = t.toLowerCase();
    return VOCAB.map((w) => (lc.match(new RegExp(w, "g")) || []).length);
  });

test("chunkText splits markdown by heading and code by windows", () => {
  const md = chunkText("# A\nintro paragraph here\n## B\nmore text in section b\n## C\nlast section content", "doc.md", "repo");
  assert.ok(md.length >= 3, "markdown splits into heading sections");
  assert.ok(md.every((ch) => ch.file === "doc.md" && ch.source === "repo"));

  const code = chunkText(Array.from({ length: 100 }, (_, i) => `const line${i} = ${i};`).join("\n"), "a.ts", "repo");
  assert.ok(code.length >= 3, "long code file makes multiple overlapping windows");
});

test("buildIndex + queryIndex round-trips and ranks by cosine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-sem-"));
  try {
    const chunks = [
      { id: "1", text: "function handleAuth(login, token) { return token }", file: "auth.ts", source: "repo" },
      { id: "2", text: "function renderButton() { return button }", file: "ui.ts", source: "repo" },
      { id: "3", text: "function connectDatabase() { retry on error }", file: "db.ts", source: "repo" },
    ];
    assert.equal(indexExists("repo", dir), false);
    const r = await buildIndex("repo", chunks, mockEmbed, dir);
    assert.equal(r.total, 3);
    assert.equal(indexExists("repo", dir), true);

    const hits = await queryIndex("repo", "auth login token", mockEmbed, dir, 3);
    assert.equal(hits[0].file, "auth.ts", "auth query ranks the auth chunk first");
    assert.ok(hits[0].score > 0);

    const dbHits = await queryIndex("repo", "database retry error", mockEmbed, dir, 1);
    assert.equal(dbHits[0].file, "db.ts", "db query ranks the db chunk first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryIndex returns empty when no index exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-sem-"));
  try {
    assert.deepEqual(await queryIndex("repo", "anything", mockEmbed, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRepoChunks walks code + markdown in a project root", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-repo-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}"); // marks the project root
    writeFileSync(join(dir, "main.ts"), "export function auth() { return 1 }\n");
    writeFileSync(join(dir, "notes.md"), "# Title\nsome notes worth indexing\n");
    const chunks = collectRepoChunks(dir);
    assert.ok(chunks.some((ch) => ch.file === "main.ts"), "indexes code");
    assert.ok(chunks.some((ch) => ch.file === "notes.md"), "indexes markdown");
    assert.ok(chunks.every((ch) => ch.source === "repo"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildIndex is incremental — unchanged files keep their vectors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-inc-"));
  try {
    writeFileSync(join(dir, "package.json"), "{}"); // anchor findProjectRoot to this dir → index stays here
    writeFileSync(join(dir, "a.md"), "# Alpha\nfirst doc about authentication flows\n");
    writeFileSync(join(dir, "b.md"), "# Beta\nsecond doc about rendering buttons\n");
    let calls = 0;
    const counting = async (texts) => {
      calls += texts.length;
      return texts.map(() => [1, 0, 0]);
    };

    // first build: everything embedded (name="repo" keeps the index inside the temp dir)
    const r1 = await buildIndex("repo", collectDirChunks(dir, "assets"), counting, dir);
    assert.ok(r1.embedded >= 2 && r1.reused === 0, "first build embeds all");
    const afterFirst = calls;

    // rebuild, nothing changed → 0 embedded, all reused, embedder untouched
    const r2 = await buildIndex("repo", collectDirChunks(dir, "assets"), counting, dir);
    assert.equal(r2.embedded, 0, "unchanged rebuild embeds nothing");
    assert.equal(r2.reused, r1.total, "everything reused");
    assert.equal(calls, afterFirst, "embedder not called on an unchanged rebuild");

    // change one file (force a newer mtime) → only that file re-embedded, the other reused
    writeFileSync(join(dir, "a.md"), "# Alpha\nrewritten — now about caching tokens\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, "a.md"), later, later);
    const r3 = await buildIndex("repo", collectDirChunks(dir, "assets"), counting, dir);
    assert.ok(r3.embedded >= 1, "changed file re-embedded");
    assert.ok(r3.reused >= 1, "unchanged file reused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectDirChunks walks a knowledge dir with absolute file paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-kb-"));
  try {
    writeFileSync(join(dir, "note.md"), "# Note\nsomething reusable worth remembering\n");
    const chunks = collectDirChunks(dir, "memory");
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((ch) => ch.source === "memory"));
    assert.ok(chunks[0].file.startsWith(dir), "file path is absolute (under the dir)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchHybrid falls back to lexical when embeddings are off", async () => {
  const prev = process.env.HARA_EMBED_PROVIDER;
  process.env.HARA_EMBED_PROVIDER = "off"; // force lexical regardless of the user's real config
  const dir = mkdtempSync(join(tmpdir(), "hara-assets-"));
  try {
    writeFileSync(join(dir, "retry.md"), "# Retry helper\nexponential backoff retry logic for fetch\n");
    writeFileSync(join(dir, "auth.md"), "# Auth\nlogin and token handling\n");
    const hits = await searchHybrid("retry backoff", dir, { indexName: "assets", roots: [dir], limit: 5 });
    assert.ok(hits.length >= 1, "lexical hits returned with embeddings off");
    assert.ok(hits[0].path.endsWith("retry.md"), "ranks the retry doc first");
  } finally {
    if (prev === undefined) delete process.env.HARA_EMBED_PROVIDER;
    else process.env.HARA_EMBED_PROVIDER = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getEmbedder is off-by-default and pluggable", () => {
  assert.equal(getEmbedder({ embedProvider: "off" }), null, "off → null (lexical only)");
  assert.equal(getEmbedder({}), null, "unset → null");
  assert.equal(typeof getEmbedder({ embedProvider: "ollama" }), "function");
  assert.equal(typeof getEmbedder({ embedProvider: "qwen", apiKey: "k" }), "function");
});
