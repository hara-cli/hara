import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BinaryFileError, readTextPrefixSync, streamFileSlice } from "../dist/fs-read.js";

const fixture = () => mkdtempSync(join(tmpdir(), "hara-stream-read-"));

test("streamFileSlice returns a bounded window and a continuation offset without reading to EOF", async () => {
  const dir = fixture();
  try {
    const path = join(dir, "large.log");
    writeFileSync(path, Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const out = await streamFileSlice(path, 101, 3);
    assert.ok(out.startsWith("(lines 101–103; more lines follow — continue with offset:104)\n"));
    assert.ok(out.includes("   101\tline 101") && out.includes("   103\tline 103"));
    assert.ok(!out.includes("line 104"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamFileSlice reaches EOF for an exact total and ignores a trailing phantom line", async () => {
  const dir = fixture();
  try {
    const path = join(dir, "tail.txt");
    writeFileSync(path, "a\nb\n");
    assert.equal(await streamFileSlice(path, 1, 10), "     1\ta\n     2\tb");
    assert.equal(await streamFileSlice(path, 9, 10), "(file has 2 lines — offset 9 is past the end)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamFileSlice bounds a giant single line and rejects sampled binary content", async () => {
  const dir = fixture();
  try {
    const huge = join(dir, "huge.txt");
    writeFileSync(huge, "x".repeat(1000));
    const out = await streamFileSlice(huge, 1, 3, { lineCap: 10, maxScanChars: 100 });
    assert.match(out, /large file scan stopped/);
    assert.match(out, /line continues/);
    assert.ok(out.length < 300, "only a bounded prefix is retained");

    const binary = join(dir, "binary.dat");
    writeFileSync(binary, Buffer.from([1, 2, 0, 3]));
    await assert.rejects(streamFileSlice(binary), (error) => error instanceof BinaryFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTextPrefixSync reads a UTF-8 prefix without loading the whole file", () => {
  const dir = fixture();
  try {
    const path = join(dir, "mention.txt");
    writeFileSync(path, "界".repeat(100_000));
    const prefix = readTextPrefixSync(path, 50_000);
    assert.equal(prefix.text, "界".repeat(50_000));
    assert.equal(prefix.truncated, true);
    assert.equal(prefix.binary, false);

    const binary = join(dir, "mention.bin");
    writeFileSync(binary, Buffer.from([1, 0, 2]));
    assert.equal(readTextPrefixSync(binary, 50_000).binary, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
