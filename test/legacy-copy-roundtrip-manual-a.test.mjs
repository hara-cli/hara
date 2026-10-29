import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { legacyCopyFixture, phaseMarks, rehearseLegacyManualGate } from "./helpers/legacy-copy-roundtrip.mjs";

// Split from legacy-copy-roundtrip.test.mjs: every manual tick scans all 96 schedules durably, so the
// 95 per-row checks are shared across two files to fit the strict 120s native deadline on Intel.
test("manual run-now on the first 48 inherited copies stays inert before handoff", { skip: process.platform === "win32" && "POSIX private copy acceptance" }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-legacy-copy-manual-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = legacyCopyFixture(), ids = fixture.jobs.slice(0, 48).map(job => job.id);
  let sourceChecks = 0;
  const result = await rehearseLegacyManualGate({ root, ...fixture, ids, assertSource: () => { sourceChecks++; }, phase: phaseMarks(t, "legacy copy manual gate a") });
  assert.equal(result.manualDefaultOffChecks, ids.length); assert.equal(result.schedulerClaims, 0); assert.equal(result.originalCommandsExecuted, 0);
  assert(sourceChecks >= 2);
});
