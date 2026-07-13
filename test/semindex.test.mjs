import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
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
    for (const chunk of chunks) writeFileSync(join(dir, chunk.file), `${chunk.text}\n`);
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

test("queryIndex never returns current-format text after its verified source changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-sem-freshness-"));
  const file = join(dir, "safe.ts");
  const marker = "STALE_FORMAT2_SECRET_MUST_NOT_RETURN";
  try {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(file, `export const old = '${marker}';\n`);
    await buildIndex("repo", collectRepoChunks(dir), mockEmbed, dir);
    writeFileSync(file, "export const current = 'ordinary';\n");

    const hits = await queryIndex("repo", "token", mockEmbed, dir, 20);
    assert.ok(!hits.some((hit) => hit.text.includes(marker)), "stale cached text is rejected by source hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildIndex creates owner-only state and repairs legacy index modes", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-sem-modes-"));
  const indexDir = join(dir, ".hara", "index");
  const ignore = join(indexDir, ".gitignore");
  const index = join(indexDir, "repo.json");
  try {
    mkdirSync(indexDir, { recursive: true });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, ".hara"), 0o755);
    writeFileSync(ignore, "!repo.json\n");
    writeFileSync(index, "{not-json");
    chmodSync(indexDir, 0o777);
    chmodSync(ignore, 0o666);
    chmodSync(index, 0o666);

    await buildIndex(
      "repo",
      [{ id: "safe#0", text: "ordinary indexed source text", file: "safe.ts", source: "repo" }],
      async () => [[1, 0, 0]],
      dir,
    );

    assert.equal(statSync(indexDir).mode & 0o777, 0o700);
    assert.equal(statSync(ignore).mode & 0o777, 0o600);
    assert.equal(statSync(index).mode & 0o777, 0o600);
    assert.equal(readFileSync(ignore, "utf8"), "*\n", "unsafe legacy ignore rules are repaired");
    assert.equal(statSync(dir).mode & 0o777, 0o755, "the project root mode is never changed");
    assert.equal(statSync(join(dir, ".hara")).mode & 0o777, 0o755, "user-authored project .hara content keeps its sharing mode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildIndex rejects symlink and hard-link aliases for every private index file", { skip: process.platform === "win32" }, async (t) => {
  for (const entry of ["repo.json", ".gitignore"]) {
    for (const alias of ["symlink", "hardlink"]) {
      await t.test(`${entry} ${alias}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "hara-sem-state-alias-"));
        const indexDir = join(dir, ".hara", "index");
        const outside = join(dir, `outside-${entry.replace(/[^a-z]/gi, "")}-${alias}`);
        const marker = `EXTERNAL_${entry}_${alias}`;
        try {
          mkdirSync(indexDir, { recursive: true });
          writeFileSync(outside, marker);
          chmodSync(outside, 0o664);
          const beforeMode = statSync(outside).mode & 0o777;
          if (alias === "symlink") symlinkSync(outside, join(indexDir, entry));
          else linkSync(outside, join(indexDir, entry));

          let embedded = false;
          await assert.rejects(
            buildIndex(
              "repo",
              [{ id: "safe#0", text: "ordinary indexed source text", file: "safe.ts", source: "repo" }],
              async () => {
                embedded = true;
                return [[1, 0, 0]];
              },
              dir,
            ),
            alias === "symlink" ? /not a regular file|symbolic/i : /multiple hard links/i,
          );
          assert.equal(embedded, false, "private state is validated before embedding work starts");
          assert.equal(readFileSync(outside, "utf8"), marker, "the aliased external inode is not overwritten");
          assert.equal(statSync(outside).mode & 0o777, beforeMode, "the aliased external inode is not chmod'd");
          assert.equal(indexExists("repo", dir), false, "an aliased cache never counts as an index");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

test("buildIndex rejects symlinked .hara/index directory components without touching their targets", { skip: process.platform === "win32" }, async (t) => {
  for (const component of [".hara", "index"]) {
    await t.test(component, async () => {
      const dir = mkdtempSync(join(tmpdir(), "hara-sem-state-dirlink-"));
      const external = join(dir, "external-state");
      const externalIndex = component === ".hara" ? join(external, "index") : external;
      const externalIndexFile = join(externalIndex, "repo.json");
      const externalIgnore = join(externalIndex, ".gitignore");
      try {
        mkdirSync(externalIndex, { recursive: true });
        writeFileSync(externalIndexFile, "EXTERNAL_INDEX_SENTINEL");
        writeFileSync(externalIgnore, "EXTERNAL_IGNORE_SENTINEL");
        chmodSync(externalIndexFile, 0o664);
        chmodSync(externalIgnore, 0o664);
        const indexMode = statSync(externalIndexFile).mode & 0o777;
        const ignoreMode = statSync(externalIgnore).mode & 0o777;
        if (component === ".hara") {
          symlinkSync(external, join(dir, ".hara"));
        } else {
          mkdirSync(join(dir, ".hara"));
          symlinkSync(external, join(dir, ".hara", "index"));
        }

        await assert.rejects(
          buildIndex(
            "repo",
            [{ id: "safe#0", text: "ordinary indexed source text", file: "safe.ts", source: "repo" }],
            async () => [[1, 0, 0]],
            dir,
          ),
          /symbolic-link component|not a real directory/i,
        );
        assert.equal(readFileSync(externalIndexFile, "utf8"), "EXTERNAL_INDEX_SENTINEL");
        assert.equal(readFileSync(externalIgnore, "utf8"), "EXTERNAL_IGNORE_SENTINEL");
        assert.equal(statSync(externalIndexFile).mode & 0o777, indexMode);
        assert.equal(statSync(externalIgnore).mode & 0o777, ignoreMode);
        assert.equal(indexExists("repo", dir), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test("buildIndex aborts if the private index parent is retargeted while embeddings are prepared", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-sem-state-retarget-"));
  const heldHara = join(dir, ".hara-held");
  const externalHara = join(dir, "external-hara");
  const externalIndex = join(externalHara, "index");
  const externalIndexFile = join(externalIndex, "repo.json");
  const externalIgnore = join(externalIndex, ".gitignore");
  try {
    await assert.rejects(
      buildIndex(
        "repo",
        [{ id: "safe#0", text: "ordinary indexed source text", file: "safe.ts", source: "repo" }],
        async () => {
          renameSync(join(dir, ".hara"), heldHara);
          mkdirSync(externalIndex, { recursive: true });
          writeFileSync(externalIndexFile, "EXTERNAL_INDEX_SENTINEL");
          writeFileSync(externalIgnore, "EXTERNAL_IGNORE_SENTINEL");
          symlinkSync(externalHara, join(dir, ".hara"));
          return [[1, 0, 0]];
        },
        dir,
      ),
      /changed/i,
    );
    assert.equal(readFileSync(externalIndexFile, "utf8"), "EXTERNAL_INDEX_SENTINEL");
    assert.equal(readFileSync(externalIgnore, "utf8"), "EXTERNAL_IGNORE_SENTINEL");
    assert.equal(indexExists("repo", dir), false);
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

test("queryIndex rotates a versionless legacy cache instead of returning historical text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-sem-legacy-"));
  const indexDir = join(dir, ".hara", "index");
  const index = join(indexDir, "repo.json");
  const zvec = join(indexDir, "repo.zvec");
  try {
    mkdirSync(zvec, { recursive: true });
    writeFileSync(join(dir, "safe.ts"), "export const safe = true;\n");
    writeFileSync(index, JSON.stringify({
      model: "embed",
      items: [{ id: "safe.ts#0", text: "HISTORICAL_SECRET_MUST_NOT_RETURN", file: "safe.ts", source: "repo", vec: [1, 0, 0] }],
    }));

    assert.deepEqual(await queryIndex("repo", "auth", mockEmbed, dir), []);
    assert.equal(indexExists("repo", dir), false, "versionless JSON is removed");
    assert.equal(statSync(indexDir).isDirectory(), true);
    assert.equal((await import("node:fs")).existsSync(zvec), false, "paired ANN cache is removed");
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

    // Preserve the same mtime while changing bytes: content identity, not timestamp alone, must decide reuse.
    const stableMtime = statSync(join(dir, "b.md")).mtime;
    writeFileSync(join(dir, "b.md"), "# Beta\nchanged bytes with the original timestamp\n");
    utimesSync(join(dir, "b.md"), stableMtime, stableMtime);
    const r4 = await buildIndex("repo", collectDirChunks(dir, "assets"), counting, dir);
    assert.ok(r4.embedded >= 1, "same-mtime content changes are re-embedded");
    const stored = JSON.parse(readFileSync(join(dir, ".hara", "index", "repo.json"), "utf8"));
    assert.equal(stored.format, 2, "protected cache format is explicit");
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
