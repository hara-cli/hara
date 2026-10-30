import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceFeatures } from "../dist/workspace/features.js";
import { WorkspaceScheduler } from "../dist/workspace/scheduler.js";
import { LegacyScheduleMigration, legacySchedulerGate } from "../dist/workspace/schedule-migration.js";
import { WorkspacePreferences } from "../dist/workspace/preferences.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
const roots = [], dir = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-scheduler-settings-"))); roots.push(root); return root; };
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(executor) {
  const storage = new WorkspaceResourceStorage(dir(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const features = new WorkspaceFeatures(storage, dir(), storage.scope.workspaceId), calls = [];
  const execute = executor ?? { available: () => true, async execute(agent, task, requestId) { calls.push({ agent, task, requestId }); return { runId: randomUUID(), completed: true }; } };
  const scheduler = new WorkspaceScheduler(storage, features, execute);
  return { storage, features, scheduler, calls, execute };
}
const task = (id, extra = {}) => ({ id, name: id, schedule: { kind: "cron", expr: "* * * * *" }, task: "Use fixture data only", agentId: "fixture-main", enabled: true, ...extra });
test("v1 scheduler really executes a due task once per occurrence and keeps receipts after restart", async () => {
  const f = fixture(); f.features.saveSchedule(task("one"), 0);
  await f.scheduler.tick("fallback-main", 120000); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].agent, "fixture-main");
  assert.equal(f.scheduler.list(120000).runs[0].state, "completed"); await f.scheduler.tick("fallback-main", 121000); assert.equal(f.calls.length, 1);
  const restarted = new WorkspaceScheduler(f.storage, f.features, f.execute); await restarted.tick("fallback-main", 121000); assert.equal(f.calls.length, 1);
  await restarted.tick("fallback-main", 180000); assert.equal(f.calls.length, 2);
});
test("disabled schedules, disabled scheduler and paused/unavailable colleagues never run", async () => {
  const f = fixture({ available: () => false, execute() { assert.fail("unavailable colleague"); } }); f.features.saveSchedule(task("one"), 0);
  await f.scheduler.tick("main", 120000); assert.equal(f.scheduler.list().runs.length, 0);
  f.features.setScheduleEnabled("one", false, 1); await f.scheduler.tick("main", 120000); assert.equal(f.scheduler.list().runs.length, 0);
  f.scheduler.configure(false, false); assert.equal(f.scheduler.list().enabled, false);
});
test("durable active/outcome-unknown claims survive restart without replay or unsafe rollback", async () => {
  let finish, executions = 0;
  const executor = { available: () => true, execute() { executions++; return new Promise(resolve => { finish = resolve; }); } }, f = fixture(executor);
  f.features.saveSchedule(task("one"), 0); const running = f.scheduler.tick("main", 120000);
  const restarted = new WorkspaceScheduler(f.storage, f.features, executor); await restarted.tick("main", 180000); assert.equal(executions, 1);
  assert.throws(() => restarted.configure(false, false), /unknown/); finish({ runId: randomUUID(), completed: true }); await running;
  const failing = fixture({ available: () => true, async execute() { throw new Error("fixture transport unknown"); } }); failing.features.saveSchedule(task("one"), 0);
  await failing.scheduler.tick("main", 120000); await failing.scheduler.tick("main", 180000); assert.equal(failing.scheduler.list().runs.length, 1); assert.equal(failing.scheduler.list().runs[0].state, "unknown");
});
test("99 legacy schedules preserve 66 enabled flags, staged execution stays off, cutover and rollback are explicit/idempotent", async () => {
  const home = dir(), f = fixture(), jobs = Array.from({ length: 99 }, (_, index) => ({ id: `old-${index}`, name: `Fixture ${index}`, mode: "print", task: "Fixture only", createdAt: 0,
    enabled: index < 66, schedule: { kind: "cron", expr: "* * * * *" } }));
  fs.mkdirSync(join(home, ".hara/cron"), { recursive: true, mode: 0o700 }); const source = join(home, ".hara/cron/jobs.json"); fs.writeFileSync(source, JSON.stringify(jobs), { mode: 0o600 });
  const original = fs.readFileSync(source), migration = new LegacyScheduleMigration(home, f.storage.scope.workspaceId, new Map([[f.storage.scope.workspaceId, f]])), preview = migration.preview();
  assert.equal(preview.count, 99); assert.equal(preview.enabled, 66); assert.throws(() => migration.stage(false, preview.sourceHash));
  assert.equal(migration.stage(true, preview.sourceHash).imported, 99); assert.equal(migration.stage(true, preview.sourceHash).imported, 0);
  assert.equal(fs.readFileSync(preview.backup).equals(original), true); assert.equal(f.features.list().schedules.filter(row => row.enabled).length, 66);
  await f.scheduler.tick("main", 120000); assert.equal(f.calls.length, 0); assert.equal(legacySchedulerGate(home), "enabled");
  assert.throws(() => migration.cutover({ approved: true, oldSchedulerStopped: false, expectedSourceHash: preview.sourceHash }));
  const lock = join(home, ".hara/cron/tick.lock"); fs.writeFileSync(lock, "fixture owned tick", { mode: 0o600 });
  assert.throws(() => migration.cutover({ approved: true, oldSchedulerStopped: true, expectedSourceHash: preview.sourceHash })); fs.unlinkSync(lock);
  assert.equal(migration.cutover({ approved: true, oldSchedulerStopped: true, expectedSourceHash: preview.sourceHash }).state, "active");
  assert.equal(legacySchedulerGate(home), "disabled"); await f.scheduler.tick("main", 120000); assert.equal(f.calls.length, 66);
  const updated = JSON.stringify(jobs.map(row => ({ ...row, lastRunAt: 42 }))); fs.writeFileSync(source, updated);
  assert.equal(migration.rollback(true).state, "rolled_back"); assert.equal(f.features.list().schedules.length, 0); assert.equal(legacySchedulerGate(home), "enabled");
  assert.equal(fs.readFileSync(source, "utf8") === updated, true); assert.equal(fs.readFileSync(preview.backup).equals(original), true);
});
test("unsupported legacy shell/external delivery stays visible but cannot silently become Pi authority", async () => {
  const f = fixture(); f.features.importLegacy([{ id: "shell", name: "Shell", schedule: { kind: "cron", expr: "* * * * *" }, enabled: true,
    workspaceId: f.storage.scope.workspaceId, migrationId: "fixture", source: "fixture-old", definition: { task: "echo fixture", mode: "command" } }]);
  f.scheduler.configure(true, true); await f.scheduler.tick("main", 120000); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.list().runs[0].reason, "legacy_execution_review_required");
});
test("mixed-mode migration cannot retire the old scheduler before compatible execution/delivery adapters exist", () => {
  const home = dir(), f = fixture(); fs.mkdirSync(join(home, ".hara/cron"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(home, ".hara/cron/jobs.json"), JSON.stringify([{ ...task("shell"), mode: "command", deliver: "feishu:fixture" }]), { mode: 0o600 });
  const migration = new LegacyScheduleMigration(home, f.storage.scope.workspaceId, new Map([[f.storage.scope.workspaceId, f]])), preview = migration.preview();
  migration.stage(true, preview.sourceHash); assert.throws(() => migration.cutover({ approved: true, oldSchedulerStopped: true, expectedSourceHash: preview.sourceHash }), /adapters are not ready/);
  assert.equal(legacySchedulerGate(home), "enabled"); assert.equal(f.scheduler.list().migratedEnabled, false);
});
test("corrupt handoff gate fails closed and unmapped schedules do not produce backup or imports", () => {
  const home = dir(); fs.mkdirSync(join(home, ".hara/cron"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(home, ".hara/cron/workspace-cutover-v1.json"), "{", { mode: 0o600 }); assert.equal(legacySchedulerGate(home), "invalid");
  fs.writeFileSync(join(home, ".hara/cron/jobs.json"), JSON.stringify([{ ...task("one"), workspaceId: "unmapped" }]), { mode: 0o600 });
  const migration = new LegacyScheduleMigration(home, "personal", new Map()); assert.throws(() => migration.preview()); assert.equal(fs.existsSync(join(home, ".hara/cron/workspace-migration-source-v1.json")), false);
});
test("settings scope selection does not move foreground/catalog workspace; update lease closes model admission atomically", async () => {
  const host = new LocalWorkspaceHost(dir(), { mode: "workspace", credentialVault: new MemoryCredentialVault(), providerFactory() { assert.fail("no model call"); } });
  try {
    const a = host.createWorkspace("A", host.list().revision), b = host.createWorkspace("B", host.list().revision);
    host.select("chat", a.workspaceId, host.list().revision); const before = host.list();
    host.select("settings", b.workspaceId, before.revision, true); assert.equal(host.list().activeWorkspaceId, a.workspaceId); assert.equal(host.list().revision, before.revision);
    const lease = host.prepareUpdate("chat"); assert.throws(() => host.start("chat", a.workspaceId, a.selectedAgentId, "hello", randomUUID()), /updating/);
    assert.throws(() => host.releaseUpdate("other", lease.id)); host.disconnect("chat"); assert.doesNotThrow(() => host.prepareUpdate("new-chat"));
  } finally { await host.close(); }
});
test("device display/update settings persist with theme across restart and have no cross-space secret fields", () => {
  const home = dir(), prefs = new WorkspacePreferences(home, undefined, () => "dark");
  prefs.save("dark", 0, { executionDetails: "detailed", collapseDetails: false, updates: { autoCheck: false, skippedVersion: "0.1.189", lastChecked: 123, snooze: null } });
  const restarted = new WorkspacePreferences(home, undefined, () => "light").read(); assert.equal(restarted.theme, "dark"); assert.equal(restarted.executionDetails, "detailed"); assert.equal(restarted.collapseDetails, false);
  assert.equal(restarted.updates.skippedVersion, "0.1.189"); assert.equal(restarted.updates.autoCheck, false);
  assert.throws(() => prefs.save("dark", restarted.revision, { updates: { autoCheck: "yes" } }));
});
test("colleague schedule list exposes only its scoped owner and safe editable fields", () => {
  const f = fixture();
  f.features.saveSchedule(task("owned", { agentId: "colleague-1", tz: "Asia/Taipei" }), 0);
  const [owned] = f.features.list().schedules;
  assert.equal(owned.agentId, "colleague-1");
  assert.equal(owned.task, "Use fixture data only");
  assert.equal(owned.tz, "Asia/Taipei");
  assert.equal(Object.hasOwn(owned, "definition"), false);
  assert.throws(() => f.features.saveSchedule(task("owned", { agentId: "colleague-2" }), 1), /owner cannot change/);
  assert.throws(() => f.features.saveSchedule(task("bad", { agentId: "colleague-1", tz: "Invalid/Zone" }), 1), /Invalid scheduled task/);
  f.features.importLegacy([{ id: "legacy", name: "Legacy", schedule: { kind: "cron", expr: "* * * * *" }, enabled: false,
    workspaceId: f.storage.scope.workspaceId, migrationId: "legacy", source: "legacy", definition: { task: "private legacy task", agentId: "colleague-1" } }]);
  const legacy = f.features.list().schedules.find(row => row.id === "legacy");
  assert.equal(Object.hasOwn(legacy, "task"), false);
  assert.equal(Object.hasOwn(legacy, "agentId"), false);
});
