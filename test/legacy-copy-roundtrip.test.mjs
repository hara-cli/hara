import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rehearseLegacyCopies } from "./helpers/legacy-copy-roundtrip.mjs";
import { buildLegacyInheritancePlan } from "../dist/workspace/legacy-plan.js";
import { legacyAgentInputs } from "../dist/workspace/legacy-agents.js";

test("95 inert mixed-mode tasks and 17 personas survive actual process restart, repeat, guarded rollback and re-upgrade", { skip: process.platform === "win32" && "POSIX private copy acceptance" }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-legacy-copy-roundtrip-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = Array.from({ length: 95 }, (_, i) => ({ id: `copy-${i}`, name: `Copy fixture ${i}`, mode: i < 91 ? "command" : "print",
    task: i === 94 ? "command --api-key fake-do-not-copy" : i < 91 ? "DO_NOT_EXECUTE copied command fixture" : "Do not execute original instructions",
    cwd: `/copy/source/project-${i % 8}`, createdAt: 0, enabled: i < 62, schedule: i < 2 ? { kind: "once", runAt: 10, display: "expired once" } : { kind: "cron", expr: "* * * * *" },
    tz: i % 7 ? "Asia/Taipei" : "", consecutiveErrors: i % 3, alertAfter: 4 }));
  const sourceRoles = Array.from({ length: 17 }, (_, i) => ({ file: `copy-role-${i}.md`, content: `---\nname: copy-role-${i}\ndisplayName: Copy colleague ${i}\nallowTools: [read_file]\n---\nThese are inert fixture instructions ${i}.\n` }));
  const sourceFingerprint = "b".repeat(64), plan = buildLegacyInheritancePlan({ sourceFingerprint, now: 120000, jobs, roles: sourceRoles, config: {}, profiles: {}, flows: [], sessions: [] });
  const roles = legacyAgentInputs(sourceRoles, plan.roles); let sourceChecks = 0;
  const result = await rehearseLegacyCopies({ root, jobs, taskPlan: plan.tasks, roles, sourceFingerprint, legacyWorkspacePath: "/copy/source/workspace", assertSource: () => { sourceChecks++; } });
  assert.equal(result.tasks.length, 95); assert.equal(result.roles.length, 17); assert.equal(result.summary.childProcessProbes, 3);
  assert.equal(new Set(result.summary.independentProbePids).size, 3); assert.equal(result.summary.enabledAfter, 60);
  assert.equal(result.summary.activeRoles, 10); assert.equal(result.summary.archivedRoles, 7);
  assert.equal(result.summary.sourceMutationRejections, 112); assert.equal(result.summary.rollbackPreimagesExact, true);
  assert.equal(result.summary.originalCommandsExecuted, 0); assert.equal(result.summary.providerCalls, 0); assert.equal(result.summary.keychainCalls, 0);
  assert.equal(result.summary.real24hObserved, false); assert.equal(result.summary.nativeUpgradeVerified, false); assert.equal(result.summary.completeReleaseGatePassed, false);
  for (const row of [...result.tasks, ...result.roles]) for (const key of ["fidelity", "restart", "idempotent", "sourceMutationRejected", "rollback", "reupgrade"]) assert.equal(row[key], true);
  assert(sourceChecks >= 8);
});
