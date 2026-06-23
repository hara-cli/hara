import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../dist/tools/builtin.js"; // registers built-ins (run `npm run build` first)
import { getTool, getTools } from "../dist/tools/registry.js";

test("registry contains the built-in tools", () => {
  const names = getTools().map((t) => t.name).sort();
  assert.deepEqual(names, ["bash", "job", "read_file", "write_file"]);
});

test("write_file → read_file round-trips in cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const ctx = { cwd: dir };
    const w = await getTool("write_file").run({ path: "a.txt", content: "hello hara" }, ctx);
    assert.match(w, /Wrote 10 chars/);
    const r = await getTool("read_file").run({ path: "a.txt" }, ctx);
    assert.equal(r, "hello hara");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file creates nested parent directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const ctx = { cwd: dir };
    await getTool("write_file").run({ path: "deep/nested/b.txt", content: "x" }, ctx);
    const r = await getTool("read_file").run({ path: "deep/nested/b.txt" }, ctx);
    assert.equal(r, "x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash runs in cwd and returns combined output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const o = await getTool("bash").run({ command: "echo hi" }, { cwd: dir });
    assert.match(o, /hi/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash reports failures without throwing", async () => {
  const o = await getTool("bash").run({ command: "exit 7" }, { cwd: process.cwd() });
  assert.match(o, /failed/i);
});
