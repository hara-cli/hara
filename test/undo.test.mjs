import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordEdit, undoLast, undoDepth } from "../dist/undo.js";
import { atomicWriteText } from "../dist/fs-write.js";

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

test("undo: refuses to delete a concurrent replacement of a tool-created file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-undo-cas-"));
  try {
    const f = join(dir, "new.txt");
    const committed = await atomicWriteText(f, "agent version", { expected: null });
    recordEdit([{ path: "new.txt", absPath: f, before: null, committed, after: "agent version" }]);
    const replacement = join(dir, "external.tmp");
    writeFileSync(replacement, "external version");
    renameSync(replacement, f);

    const result = await undoLast();
    assert.ok("error" in result);
    assert.match(result.error, /changed|safely undo/i);
    assert.equal(readFileSync(f, "utf8"), "external version", "undo never removes the replacement inode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo: rejects symlinks to the committed inode for both create and update", { skip: process.platform === "win32" }, async () => {
  for (const before of [null, "original"]) {
    const dir = mkdtempSync(join(tmpdir(), "hara-undo-link-cas-"));
    try {
      const f = join(dir, "work.txt");
      const alt = join(dir, "owned-alt.txt");
      if (before !== null) writeFileSync(f, before);
      const committed = await atomicWriteText(f, "agent version", { expected: before });
      recordEdit([{ path: "work.txt", absPath: f, before, committed, after: "agent version" }]);

      linkSync(f, alt);
      unlinkSync(f);
      symlinkSync("owned-alt.txt", f);
      const result = await undoLast();
      assert.ok("error" in result, `symlink replacement is refused for ${before === null ? "create" : "update"}`);
      assert.equal(lstatSync(f).isSymbolicLink(), true, "the concurrent symlink is restored, not deleted/replaced");
      assert.equal(readlinkSync(f), "owned-alt.txt");
      assert.equal(readFileSync(alt, "utf8"), "agent version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("undo: a retargeted parent symlink cannot redirect rollback into another tree", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-undo-parent-link-"));
  try {
    const first = join(dir, "first");
    const second = join(dir, "second");
    const alias = join(dir, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync("first", alias);
    const throughAlias = join(alias, "created.txt");
    const committed = await atomicWriteText(throughAlias, "agent", { expected: null });
    recordEdit([{ path: "alias/created.txt", absPath: throughAlias, before: null, committed, after: "agent" }]);
    assert.equal(committed.target, join(realpathSync(first), "created.txt"), "the transaction records the canonical parent target");

    unlinkSync(alias);
    symlinkSync("second", alias);
    assert.deepEqual(await undoLast(), { files: ["alias/created.txt"] });
    assert.equal(existsSync(join(first, "created.txt")), false, "undo removes the inode actually written");
    assert.equal(readlinkSync(alias), "second", "the external parent retarget is untouched");
    assert.equal(existsSync(join(second, "created.txt")), false, "the new target tree is never modified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo: removes canonical nested directories after their parent symlink is retargeted", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-undo-parent-created-link-"));
  try {
    const first = join(dir, "first");
    const second = join(dir, "second");
    const alias = join(dir, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync("first", alias);
    const throughAlias = join(alias, "new", "deep", "created.txt");
    const committed = await atomicWriteText(throughAlias, "agent", { expected: null });
    recordEdit([{ path: "alias/new/deep/created.txt", absPath: throughAlias, before: null, committed, after: "agent" }]);
    assert.ok(existsSync(join(first, "new", "deep", "created.txt")));

    unlinkSync(alias);
    symlinkSync("second", alias);
    assert.deepEqual(await undoLast(), { files: ["alias/new/deep/created.txt"] });
    assert.equal(existsSync(join(first, "new")), false, "canonical transaction-created directories are removed from the original tree");
    assert.equal(existsSync(join(second, "new")), false, "the retargeted tree is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
