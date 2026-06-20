import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkText, buildIndex, queryIndex, indexExists, collectRepoChunks } from "../dist/search/semindex.js";
import { getEmbedder } from "../dist/search/embed.js";

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
    const n = await buildIndex("repo", chunks, mockEmbed, dir);
    assert.equal(n, 3);
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

test("getEmbedder is off-by-default and pluggable", () => {
  assert.equal(getEmbedder({ embedProvider: "off" }), null, "off → null (lexical only)");
  assert.equal(getEmbedder({}), null, "unset → null");
  assert.equal(typeof getEmbedder({ embedProvider: "ollama" }), "function");
  assert.equal(typeof getEmbedder({ embedProvider: "qwen", apiKey: "k" }), "function");
});
