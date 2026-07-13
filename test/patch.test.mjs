import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits } from "../dist/tools/apply-core.js";
import { getTool } from "../dist/tools/registry.js";
import { undoLast } from "../dist/undo.js";
import "../dist/tools/patch.js";

async function settleWithin(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("apply_patch: invalid destination is rejected in preflight — never leaves a half-patched tree", async () => {
  const d = mkdtempSync(join(tmpdir(), "hara-patch-rb-"));
  try {
    const a = join(d, "a.txt");
    writeFileSync(a, "original A\n");
    // A file cannot be used as a parent directory. Preflight now catches that before Phase 2, so the
    // otherwise-valid first change must remain untouched.
    const res = await getTool("apply_patch").run(
      {
        changes: [
          { type: "update", path: "a.txt", content: "CHANGED A\n" },
          { type: "create", path: "a.txt/b.txt", content: "B\n" },
        ],
      },
      { cwd: d },
    );
    assert.match(res, /nothing written/i, "reports the preflight failure");
    assert.equal(readFileSync(a, "utf8"), "original A\n", "A is never changed");
    assert.ok(!existsSync(join(d, "a.txt", "b.txt")), "B was not created");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("applyEdits: sequential edits + replace_all", () => {
  const r = applyEdits("a b a", [{ old_string: "a", new_string: "X", replace_all: true }]);
  assert.ok(!("error" in r));
  assert.equal(r.text, "X b X");
  assert.equal(r.total, 2);
  const r2 = applyEdits("a\nb", [{ old_string: "a", new_string: "1" }, { old_string: "b", new_string: "2" }]);
  assert.equal(r2.text, "1\n2");
});

test("applyEdits: errors on not-found / identical / empty", () => {
  assert.ok("error" in applyEdits("hello", [{ old_string: "x", new_string: "y" }]));
  assert.ok("error" in applyEdits("ab", [{ old_string: "a", new_string: "a" }]));
  assert.ok("error" in applyEdits("ab", []));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-"));
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  return dir;
}

test("apply_patch: atomic — one bad change writes nothing", async () => {
  const dir = fixture();
  try {
    const out = await getTool("apply_patch").run(
      {
        changes: [
          { path: "a.txt", edits: [{ old_string: "alpha", new_string: "X" }] },
          { path: "b.txt", edits: [{ old_string: "NOPE", new_string: "Y" }] }, // fails
        ],
      },
      { cwd: dir },
    );
    assert.match(out, /Error/);
    assert.match(out, /Nothing written/);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha"); // unchanged despite being valid
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "beta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch: multi-file update + create + delete", async () => {
  const dir = fixture();
  try {
    const out = await getTool("apply_patch").run(
      {
        changes: [
          { path: "a.txt", edits: [{ old_string: "alpha", new_string: "ALPHA" }] },
          { path: "c.txt", type: "create", content: "gamma" },
          { path: "b.txt", type: "delete" },
        ],
      },
      { cwd: dir },
    );
    assert.match(out, /3 file/);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "ALPHA");
    assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "gamma");
    assert.ok(!existsSync(join(dir, "b.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch: rejects duplicate aliases for one path instead of losing an edit", async () => {
  const dir = fixture();
  try {
    const out = await getTool("apply_patch").run(
      {
        changes: [
          { path: "a.txt", edits: [{ old_string: "alpha", new_string: "first" }] },
          { path: "./a.txt", edits: [{ old_string: "alpha", new_string: "second" }] },
        ],
      },
      { cwd: dir },
    );
    assert.match(out, /repeats path/i);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha", "neither overlapping change is written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch: explicit create never overwrites an existing file", async () => {
  const dir = fixture();
  try {
    const out = await getTool("apply_patch").run(
      { changes: [{ path: "a.txt", type: "create", content: "replacement" }] },
      { cwd: dir },
    );
    assert.match(out, /already exists/i);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch rejects FIFO update/delete pre-reads without blocking", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-fifo-"));
  try {
    const fifo = join(dir, "generated.pipe");
    execFileSync("mkfifo", [fifo]);
    const update = await settleWithin(getTool("apply_patch").run(
      { changes: [{ path: fifo, type: "update", content: "replacement" }] },
      { cwd: dir },
    ));
    assert.match(update, /not a regular file/i);
    const deletion = await settleWithin(getTool("apply_patch").run(
      { changes: [{ path: fifo, type: "delete" }] },
      { cwd: dir },
    ));
    assert.match(deletion, /not a regular file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch rollback CAS preserves an external edit made during a failed commit", { timeout: 10000 }, async () => {
  const dir = fixture();
  const a = join(dir, "a.txt");
  const b = join(dir, "b.txt");
  const patchA = "patch A";
  const externalA = patchA; // Same bytes deliberately: rollback must compare the committed inode too.
  const externalB = "external B";
  let externalEditObserved = false;
  let externalInode;
  let watcher;
  try {
    watcher = setInterval(() => {
      try {
        if (readFileSync(a, "utf8") !== patchA) return;
        const replacement = join(dir, "external-a.tmp");
        writeFileSync(replacement, externalA);
        renameSync(replacement, a);
        externalInode = statSync(a).ino;
        writeFileSync(b, externalB);
        externalEditObserved = true;
        clearInterval(watcher);
      } catch {
        // A transient rename gap is harmless; poll again until the first patch commit is visible.
      }
    }, 0);
    const out = await getTool("apply_patch").run(
      {
        changes: [
          { path: "a.txt", type: "update", content: patchA },
          { path: "b.txt", type: "update", content: "patch B" },
        ],
      },
      { cwd: dir },
    );
    assert.equal(externalEditObserved, true, "external edit lands between the two commit steps");
    assert.match(out, /rollback was INCOMPLETE/i);
    assert.equal(readFileSync(a, "utf8"), externalA, "rollback preserves the newer same-content A file");
    assert.equal(statSync(a).ino, externalInode, "rollback never deletes a replacement inode just because its bytes match");
    assert.equal(readFileSync(b, "utf8"), externalB, "the write that forced failure is preserved");
  } finally {
    clearInterval(watcher);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch rollback restores executable mode after a later commit fails", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-mode-rb-"));
  try {
    const script = join(dir, "run.sh");
    writeFileSync(script, "#!/bin/sh\necho old\n");
    chmodSync(script, 0o775); // group-write is commonly masked by umask, so this catches approximate restores
    const out = await getTool("apply_patch").run(
      { changes: [
        { path: "run.sh", type: "update", content: "#!/bin/sh\necho new\n" },
        { path: "blocker", type: "create", content: "not a directory\n" },
        { path: "blocker/child", type: "create", content: "cannot be created\n" },
      ] },
      { cwd: dir },
    );
    assert.match(out, /rolled back, nothing left changed/i);
    assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\necho old\n");
    assert.equal(statSync(script).mode & 0o777, 0o775, "rollback preserves exact executable permission bits");
    assert.equal(existsSync(join(dir, "blocker")), false, "earlier create is also rolled back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch rollback removes only the nested parent directories it created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-dir-rb-"));
  try {
    const out = await getTool("apply_patch").run(
      { changes: [
        { path: "new/deep/a.txt", type: "create", content: "temporary\n" },
        { path: "blocker", type: "create", content: "not a directory\n" },
        { path: "blocker/child", type: "create", content: "cannot be created\n" },
      ] },
      { cwd: dir },
    );
    assert.match(out, /rolled back, nothing left changed/i);
    assert.equal(existsSync(join(dir, "new")), false, "transaction-created empty directory tree is removed");
    assert.equal(existsSync(join(dir, "blocker")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch rollback updates a symlink target without replacing the symlink", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-link-rb-"));
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "old target\n");
    symlinkSync("target.txt", link);
    const out = await getTool("apply_patch").run(
      { changes: [
        { path: "link.txt", type: "update", content: "new target\n" },
        { path: "blocker", type: "create", content: "not a directory\n" },
        { path: "blocker/child", type: "create", content: "cannot be created\n" },
      ] },
      { cwd: dir },
    );
    assert.match(out, /rolled back, nothing left changed/i);
    assert.equal(lstatSync(link).isSymbolicLink(), true, "rollback keeps the original symlink inode/path");
    assert.equal(readlinkSync(link), "target.txt");
    assert.equal(readFileSync(target, "utf8"), "old target\n", "rollback restores the actual target content");
    assert.equal(readFileSync(link, "utf8"), "old target\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch delete + undo restores a symlink topology exactly", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-link-undo-"));
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "target stays\n");
    symlinkSync("target.txt", link);
    const out = await getTool("apply_patch").run(
      { changes: [{ path: "link.txt", type: "delete" }] },
      { cwd: dir },
    );
    assert.match(out, /deleted link\.txt/);
    assert.equal(existsSync(link), false);
    assert.equal(readFileSync(target, "utf8"), "target stays\n");

    const undone = await undoLast();
    assert.deepEqual(undone, { files: ["link.txt"] });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), "target.txt");
    assert.equal(readFileSync(target, "utf8"), "target stays\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch delete cleanup never unlinks a concurrently substituted quarantine inode", { timeout: 15000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-delete-cas-"));
  const deleted = join(dir, "delete.txt");
  const victim = join(dir, "victim.txt");
  const savedDelete = join(dir, "saved-delete.txt");
  writeFileSync(deleted, "original delete\n");
  writeFileSync(victim, "external victim\n");
  let swapped = false;
  const watcher = setInterval(() => {
    if (swapped) return;
    try {
      const name = readdirSync(dir).find((entry) => entry.startsWith(".hara-delete-") && entry.endsWith(".tmp"));
      if (!name) return;
      const quarantine = join(dir, name);
      renameSync(quarantine, savedDelete);
      renameSync(victim, quarantine);
      swapped = true;
    } catch {
      // Keep polling across the short rename/staging windows.
    }
  }, 0);
  try {
    const out = await getTool("apply_patch").run(
      { changes: [
        { path: "delete.txt", type: "delete" },
        { path: "large.txt", type: "create", content: "x".repeat(48 * 1024 * 1024) },
      ] },
      { cwd: dir },
    );
    assert.equal(swapped, true, "fixture replaced the known quarantine during the later commit");
    assert.match(out, /Warning:.*cleanup was refused/i, "the unverified inode is preserved and reported");
    assert.equal(readFileSync(savedDelete, "utf8"), "original delete\n");
    const preserved = readdirSync(dir).find((entry) => entry.startsWith(".hara-delete-") && entry.endsWith(".tmp"));
    assert.ok(preserved, "unexpected replacement remains recoverable at the warned quarantine path");
    assert.equal(readFileSync(join(dir, preserved), "utf8"), "external victim\n", "Hara never unlinks the substituted victim inode");
  } finally {
    clearInterval(watcher);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch preserves and warns when delete staging is substituted during verification", { timeout: 15000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-delete-stage-cas-"));
  const deleted = join(dir, "delete.txt");
  const victim = join(dir, "victim.txt");
  const savedDelete = join(dir, "saved-delete.txt");
  writeFileSync(deleted, Buffer.alloc(60 * 1024 * 1024, 65));
  writeFileSync(victim, "external victim\n");
  let swapped = false;
  const watcher = setInterval(() => {
    if (swapped) return;
    try {
      const name = readdirSync(dir).find((entry) => entry.startsWith(".hara-stage-delete-") && entry.endsWith(".tmp"));
      if (!name) return;
      const staging = join(dir, name);
      renameSync(staging, savedDelete);
      renameSync(victim, staging);
      swapped = true;
    } catch {
      // Keep polling while the staged descriptor is being validated.
    }
  }, 0);
  try {
    const out = await getTool("apply_patch").run(
      { changes: [{ path: "delete.txt", type: "delete" }] },
      { cwd: dir },
    );
    assert.equal(swapped, true, "fixture stole the unverified staging name");
    assert.match(out, /(?:Warning:.*cleanup was refused|rollback was INCOMPLETE)/i, "the substituted inode is retained and reported for either safe race outcome");
    assert.equal(existsSync(deleted), false, "an unrelated replacement is never placed at the visible target");
    assert.equal(statSync(savedDelete).size, 60 * 1024 * 1024, "the externally moved original remains recoverable");
    const retained = readdirSync(dir).find((entry) =>
      (entry.startsWith(".hara-delete-") || entry.startsWith(".hara-stage-delete-")) && entry.endsWith(".tmp"));
    assert.ok(retained, "the unexpected staging replacement remains in a warned quarantine");
    assert.equal(readFileSync(join(dir, retained), "utf8"), "external victim\n");
  } finally {
    clearInterval(watcher);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch delete cleanup preserves a replacement inserted during claimed-file verification", { timeout: 15000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-claimed-delete-cas-"));
  const deleted = join(dir, "delete.txt");
  const victim = join(dir, "victim.txt");
  const savedDelete = join(dir, "saved-delete.txt");
  // The large original keeps the no-follow descriptor read active long enough for a deterministic swap.
  writeFileSync(deleted, Buffer.alloc(60 * 1024 * 1024, 65));
  writeFileSync(victim, "external victim\n");
  let scheduled = false;
  let swapped = false;
  const watcher = setInterval(() => {
    if (scheduled) return;
    const name = readdirSync(dir).find((entry) => entry.startsWith(".hara-cleanup-") && entry.endsWith(".tmp"));
    if (!name) return;
    scheduled = true;
    setTimeout(() => {
      try {
        const claimed = join(dir, name);
        renameSync(claimed, savedDelete);
        renameSync(victim, claimed);
        swapped = true;
      } catch {
        // A failed fixture swap is asserted below rather than hiding a product failure.
      }
    }, 2);
  }, 0);
  try {
    const out = await getTool("apply_patch").run(
      { changes: [{ path: "delete.txt", type: "delete" }] },
      { cwd: dir },
    );
    assert.equal(swapped, true, "fixture replaces the claimed path after its old inode has been opened");
    assert.match(out, /Warning:.*claimed entry is preserved at/i);
    assert.equal(existsSync(savedDelete), true, "the intended deleted inode remains with the external mover");
    const retained = readdirSync(dir).find((entry) => entry.startsWith(".hara-discard-") && entry.endsWith(".tmp"));
    assert.ok(retained, "the replacement is retained under the warning's recovery name");
    assert.equal(readFileSync(join(dir, retained), "utf8"), "external victim\n", "cleanup never unlinks the unrelated replacement");
  } finally {
    clearInterval(watcher);
    rmSync(dir, { recursive: true, force: true });
  }
});
