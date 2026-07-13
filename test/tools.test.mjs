import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capHeadTail, isPackageInstallCommand, isNgrokTunnelCommand, ngrokAuthConfigured } from "../dist/tools/builtin.js"; // also registers the built-ins (run `npm run build` first)
import { getTool, getTools } from "../dist/tools/registry.js";

test("capHeadTail: keeps head + tail of long output (errors live at the end)", () => {
  const s = "HEAD_START" + "x".repeat(200_000) + "TAIL_ERROR";
  const out = capHeadTail(s);
  assert.ok(out.startsWith("HEAD_START"), "keeps the head");
  assert.ok(out.endsWith("TAIL_ERROR"), "keeps the tail (where errors are)");
  assert.match(out, /chars truncated/);
  assert.ok(out.length < s.length);
  assert.equal(capHeadTail("short output"), "short output"); // under the cap → unchanged
});

test("long package installs and ngrok tunnel commands are classified for preflight/background handling", () => {
  for (const c of ["npm install", "npm i react", "npm ci", "pnpm add zod", "yarn install", "bun install"]) {
    assert.equal(isPackageInstallCommand(c), true, c);
  }
  for (const c of ["npm test", "pnpm check", "node install.js"]) assert.equal(isPackageInstallCommand(c), false, c);
  assert.equal(isNgrokTunnelCommand("ngrok http 3000"), true);
  assert.equal(isNgrokTunnelCommand("ngrok config check"), false);
  assert.equal(ngrokAuthConfigured({ NGROK_AUTHTOKEN: "present" }, "/no-home"), true);
  assert.equal(ngrokAuthConfigured({}, "/no-home"), false);
});

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
    assert.equal(r, "     1\thello hara"); // cat -n numbered since the long-file slicing change
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
    assert.equal(r, "     1\tx"); // cat -n numbered
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file streams a file larger than the in-memory threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const path = join(dir, "large.log");
    writeFileSync(path, (`${"x".repeat(1000)}\n`).repeat(5000)); // ~5 MB
    const out = await getTool("read_file").run({ path: "large.log", limit: 2 }, { cwd: dir });
    assert.match(out, /^\(lines 1–2; more lines follow — continue with offset:3\)/);
    assert.ok(out.includes("     2\t"), "requested line window is present");
    assert.ok(!out.includes("     3\t"), "the reader stops after proving more content exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file rejects binary content instead of injecting it into model context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    const out = await getTool("read_file").run({ path: "blob.bin" }, { cwd: dir });
    assert.match(out, /appears binary/i);
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
