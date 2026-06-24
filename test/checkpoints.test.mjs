import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, listCheckpoints, restoreCheckpoint } from "../dist/checkpoints.js";

test("shadow-git: checkpoint → edit → restore reverts the file, undoably (isolated HOME)", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-ckpt-home-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-ckpt-proj-"));
  const prev = process.env.HOME;
  process.env.HOME = home; // shadow repo lives under ~/.hara → keep it off the real home
  try {
    writeFileSync(join(proj, "package.json"), "{}"); // project-root marker
    writeFileSync(join(proj, "app.js"), "v1");
    const sha = checkpoint(proj, "first");
    assert.match(sha ?? "", /^[0-9a-f]{7,}$/, "checkpoint returns a short sha");

    writeFileSync(join(proj, "app.js"), "v2-BROKEN"); // the agent "breaks" the file
    checkpoint(proj, "second");
    assert.equal(readFileSync(join(proj, "app.js"), "utf8"), "v2-BROKEN");

    const n = restoreCheckpoint(proj, sha); // roll back to the first checkpoint
    assert.ok(n >= 1, "reports ≥1 file restored");
    assert.equal(readFileSync(join(proj, "app.js"), "utf8"), "v1", "file reverted to the checkpoint");

    const cps = listCheckpoints(proj);
    assert.ok(cps.length >= 3, "first + second + the pre-restore snapshot");
    assert.ok(cps[0].label.startsWith("before restore"), "restore made an undo checkpoint (newest)");

    // a file created AFTER the checkpoint is NOT deleted by restore (safe)
    writeFileSync(join(proj, "new.txt"), "added later");
    restoreCheckpoint(proj, sha);
    assert.ok(existsSync(join(proj, "new.txt")), "files created since the checkpoint are left in place");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("listCheckpoints: empty for a project with no checkpoints yet", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-ckpt-home2-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-ckpt-proj2-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    writeFileSync(join(proj, "package.json"), "{}");
    assert.deepEqual(listCheckpoints(proj), []);
    assert.equal(restoreCheckpoint(proj, "deadbeef"), null); // nothing to restore from
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
