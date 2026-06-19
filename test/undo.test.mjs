import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEdit, undoLast, undoDepth } from "../dist/undo.js";

test("undo: restores prior content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-undo-"));
  try {
    const f = join(dir, "f.txt");
    writeFileSync(f, "orig");
    recordEdit([{ path: "f.txt", absPath: f, before: "orig" }]);
    writeFileSync(f, "changed");
    const r = await undoLast();
    assert.ok(!("error" in r));
    assert.deepEqual(r.files, ["f.txt"]);
    assert.equal(readFileSync(f, "utf8"), "orig");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo: deletes a file that didn't exist before (before=null)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-undo2-"));
  try {
    const f = join(dir, "new.txt");
    recordEdit([{ path: "new.txt", absPath: f, before: null }]);
    writeFileSync(f, "created");
    await undoLast();
    assert.ok(!existsSync(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo: error when nothing to undo", async () => {
  while (undoDepth() > 0) await undoLast();
  const r = await undoLast();
  assert.ok("error" in r);
});
