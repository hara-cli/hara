import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsMd, hasAgentsMd, findProjectRoot } from "../dist/context/agents-md.js";
import { expandMentions } from "../dist/context/mentions.js";
import { needsConfirm } from "../dist/agent/loop.js";
import "../dist/tools/edit.js";
import { getTool } from "../dist/tools/registry.js";

test("approval gate: needsConfirm per mode/kind", () => {
  // read is never gated
  assert.equal(needsConfirm("read", "suggest"), false);
  // suggest: confirm edit + exec
  assert.equal(needsConfirm("edit", "suggest"), true);
  assert.equal(needsConfirm("exec", "suggest"), true);
  // auto-edit: auto file edits, still confirm exec
  assert.equal(needsConfirm("edit", "auto-edit"), false);
  assert.equal(needsConfirm("exec", "auto-edit"), true);
  // full-auto: nothing prompts
  assert.equal(needsConfirm("edit", "full-auto"), false);
  assert.equal(needsConfirm("exec", "full-auto"), false);
});

test("agents-md: finds root via .git and loads AGENTS.md from an ancestor", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "AGENTS.md"), "# Test Project\nbuild: npm run build");
    const sub = join(dir, "src");
    mkdirSync(sub);
    assert.equal(findProjectRoot(sub), dir);
    assert.ok(hasAgentsMd(sub));
    const ctx = loadAgentsMd(sub);
    assert.match(ctx, /Test Project/);
    assert.match(ctx, /npm run build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents-md: no file → empty string + hasAgentsMd false", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    mkdirSync(join(dir, ".git"));
    assert.equal(hasAgentsMd(dir), false);
    assert.equal(loadAgentsMd(dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mentions: @path expands to fenced file contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    writeFileSync(join(dir, "note.txt"), "hello-from-file");
    const o = expandMentions("please read @note.txt now", dir);
    assert.match(o, /Referenced file `note\.txt`/);
    assert.match(o, /hello-from-file/);
    // expanded INLINE at the @ position, not appended at the bottom: content lands before "now"
    assert.ok(o.indexOf("hello-from-file") < o.lastIndexOf("now"), "file content is inline, before the trailing text");
    assert.ok(o.startsWith("please read "), "text before the mention is preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mentions: email-like a@b.com is NOT treated as a file mention", () => {
  const o = expandMentions("mail me at a@b.com please", process.cwd());
  assert.equal(o, "mail me at a@b.com please");
});

test("edit_file: single unique replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    const p = join(dir, "f.txt");
    writeFileSync(p, "alpha beta gamma");
    const r = await getTool("edit_file").run({ path: "f.txt", old_string: "beta", new_string: "BETA" }, { cwd: dir });
    assert.match(r, /1 replacement/);
    assert.equal(readFileSync(p, "utf8"), "alpha BETA gamma");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file: ambiguous match errors unless replace_all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ctx-"));
  try {
    const p = join(dir, "f.txt");
    writeFileSync(p, "x x x");
    const err = await getTool("edit_file").run({ path: "f.txt", old_string: "x", new_string: "y" }, { cwd: dir });
    assert.match(err, /appears 3/);
    const ok = await getTool("edit_file").run({ path: "f.txt", old_string: "x", new_string: "y", replace_all: true }, { cwd: dir });
    assert.match(ok, /3 replacements/);
    assert.equal(readFileSync(p, "utf8"), "y y y");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
