import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { legacyCopyFixture, phaseMarks, rehearseLegacyCopies } from "./helpers/legacy-copy-roundtrip.mjs";

// Per-row manual "run now" default-off checks live in legacy-copy-roundtrip-manual-{a,b}.test.mjs
// so each file fits the strict 120s native deadline on the Intel runner.
test("95 inert mixed-mode tasks and 17 personas survive actual process restart, repeat, guarded rollback and re-upgrade", { skip: process.platform === "win32" && "POSIX private copy acceptance" }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-legacy-copy-roundtrip-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sourceChecks = 0;
  const result = await rehearseLegacyCopies({ root, ...legacyCopyFixture(), assertSource: () => { sourceChecks++; }, phase: phaseMarks(t, "legacy copy roundtrip") });
  assert.equal(result.tasks.length, 95); assert.equal(result.roles.length, 17); assert.equal(result.summary.childProcessProbes, 3);
  assert.equal(new Set(result.summary.independentProbePids).size, 3); assert.equal(result.summary.enabledAfter, 60);
  assert.equal(result.summary.activeRoles, 10); assert.equal(result.summary.archivedRoles, 7);
  assert.equal(result.summary.sourceMutationRejections, 112); assert.equal(result.summary.rollbackPreimagesExact, true);
  assert.equal(result.summary.originalCommandsExecuted, 0); assert.equal(result.summary.providerCalls, 0); assert.equal(result.summary.keychainCalls, 0);
  assert.equal(result.summary.real24hObserved, false); assert.equal(result.summary.nativeUpgradeVerified, false); assert.equal(result.summary.completeReleaseGatePassed, false);
  for (const row of [...result.tasks, ...result.roles]) for (const key of ["fidelity", "restart", "idempotent", "sourceMutationRejected", "rollback", "reupgrade"]) assert.equal(row[key], true);
  assert(sourceChecks >= 8);
});
