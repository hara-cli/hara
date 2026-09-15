import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reportChangedDeclaredOutputs,
  snapshotDeclaredOutputs,
} from "../dist/tools/declared-outputs.js";

test("shell deliverable proof counts changed bytes once and rejects paths outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "hara-output-progress-"));
  const cwd = join(root, "work");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const receipts = [];
  const ctx = { cwd, verifiedChange: (digest) => receipts.push(digest) };
  try {
    const created = await snapshotDeclaredOutputs(["report.xlsx", "../outside/private.xlsx"], ctx);
    assert.equal(created.size, 1, "an outside path cannot become progress evidence");
    await writeFile(join(cwd, "report.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]));
    await reportChangedDeclaredOutputs(created, ctx);
    assert.equal(receipts.length, 1);
    assert.match(receipts[0], /^[a-f0-9]{64}$/);

    const unchanged = await snapshotDeclaredOutputs(["report.xlsx"], ctx);
    await reportChangedDeclaredOutputs(unchanged, ctx);
    assert.equal(receipts.length, 1, "rechecking unchanged bytes cannot launder a stalled task");

    await symlink(outside, join(cwd, "linked"));
    const escaped = await snapshotDeclaredOutputs(["linked/private.xlsx"], ctx);
    await writeFile(join(outside, "private.xlsx"), "secret test content");
    await reportChangedDeclaredOutputs(escaped, ctx);
    assert.equal(receipts.length, 1, "a symlink cannot make an outside file count as an output");

    const changed = await snapshotDeclaredOutputs(["report.xlsx"], ctx);
    await writeFile(join(cwd, "report.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]));
    await reportChangedDeclaredOutputs(changed, ctx);
    assert.equal(receipts.length, 2);
    assert.notEqual(receipts[0], receipts[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
