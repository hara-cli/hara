import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../dist/tools/registry.js";
import { InvalidUtf8FileError, readRegularFileText } from "../dist/fs-read.js";
import "../dist/tools/builtin.js";
import "../dist/tools/edit.js";
import "../dist/tools/patch.js";

const INVALID_UTF8 = Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x0a, 0xff, 0xfe, 0x0a]);
const NUL_TEXT = Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x74, 0x61, 0x69, 0x6c]);

async function expectEveryTextMutationRefused(bytes, errorPattern) {
  const dir = mkdtempSync(join(tmpdir(), "hara-file-encoding-"));
  const target = join(dir, "mixed.txt");
  try {
    for (const [name, run] of [
      ["edit_file", () => getTool("edit_file").run({ path: "mixed.txt", old_string: "alpha", new_string: "ALPHA" }, { cwd: dir })],
      ["write_file", () => getTool("write_file").run({ path: "mixed.txt", content: "replacement\n" }, { cwd: dir })],
      ["apply_patch edits", () => getTool("apply_patch").run({
        changes: [{ path: "mixed.txt", type: "update", edits: [{ old_string: "alpha", new_string: "ALPHA" }] }],
      }, { cwd: dir })],
      ["apply_patch content", () => getTool("apply_patch").run({
        changes: [{ path: "mixed.txt", type: "update", content: "replacement\n" }],
      }, { cwd: dir })],
    ]) {
      writeFileSync(target, bytes);
      const before = readFileSync(target);
      const result = await run();
      assert.match(result, errorPattern, `${name} explains why the text operation was refused`);
      assert.deepEqual(readFileSync(target), before, `${name} preserves every original byte`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("all coding mutations reject invalid UTF-8 without replacing untouched bytes", async () => {
  await expectEveryTextMutationRefused(INVALID_UTF8, /not valid UTF-8|lossy text/i);
});

test("all coding mutations continue to reject NUL-bearing binary text", async () => {
  await expectEveryTextMutationRefused(NUL_TEXT, /binary|NUL byte/i);
});

test("multi-file apply_patch rejects invalid UTF-8 during preflight and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-file-encoding-patch-"));
  const valid = join(dir, "valid.txt");
  const invalid = join(dir, "invalid.txt");
  try {
    writeFileSync(valid, "before\n");
    writeFileSync(invalid, INVALID_UTF8);
    const result = await getTool("apply_patch").run({
      changes: [
        { path: "valid.txt", type: "update", content: "after\n" },
        { path: "invalid.txt", type: "update", content: "replacement\n" },
      ],
    }, { cwd: dir });
    assert.match(result, /not valid UTF-8|lossy text/i);
    assert.equal(readFileSync(valid, "utf8"), "before\n");
    assert.deepEqual(readFileSync(invalid), INVALID_UTF8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict snapshots reject invalid UTF-8 and preserve a UTF-8 BOM during edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-file-encoding-bom-"));
  const invalid = join(dir, "invalid.txt");
  const bom = join(dir, "bom.txt");
  try {
    writeFileSync(invalid, INVALID_UTF8);
    await assert.rejects(() => readRegularFileText(invalid), (error) => error instanceof InvalidUtf8FileError);

    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("alpha\n")]);
    writeFileSync(bom, bomBytes);
    const result = await getTool("edit_file").run({ path: "bom.txt", old_string: "alpha", new_string: "ALPHA" }, { cwd: dir });
    assert.match(result, /Edited/);
    assert.deepEqual(readFileSync(bom), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("ALPHA\n")]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
