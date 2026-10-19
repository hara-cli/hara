// Copy-only acceptance harness. Never imports a Provider, launcher, credential vault or gateway.
// Source bodies stay in the caller's private snapshot/home; output is hashes and status only.
import fs from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { canonical } from "../../dist/workspace/local-state.js";
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage, workspaceStateHome, inspectWorkspaceResourceFile } from "../../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { WorkspaceAgentStore } from "../../dist/workspace/agents.js";
import { WorkspaceFeatures } from "../../dist/workspace/features.js";
import { WorkspaceScheduler } from "../../dist/workspace/scheduler.js";
import { LegacyOwnerFileDomain } from "../../dist/workspace/legacy-file-domain.js";
import { WorkspaceLegacyResources, planLegacyResources } from "../../dist/workspace/legacy-resources.js";
import { legacyScheduleRows, legacySchedulesDomain } from "../../dist/workspace/legacy-schedules.js";

const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const roleFiles = [".hara/workspace-agents.json", ".hara/workspace-agents-owner.json"];
const featureFile = ".hara/workspace-features-v1.json";
function open(home) {
  const catalog = new LocalWorkspaceCatalog(home), record = catalog.resolvePersonalWorkspace();
  const storage = new WorkspaceResourceStorage(home, record.scope), resources = new WorkspaceResources(home, record.scope);
  storage.initialize(); resources.initialize();
  return { home, catalog, record, storage, resources, features: new WorkspaceFeatures(storage, home, record.scope.workspaceId), folders: new WorkspaceLegacyResources(storage) };
}
function rawRoster(f) {
  return f.storage.run(() => JSON.parse(inspectWorkspaceResourceFile(join(workspaceStateHome(), roleFiles[0]), 2 * 1024 * 1024).snapshot.text));
}
function fileHashes(f, files) {
  return f.storage.run(() => files.map(file => {
    const snapshot = inspectWorkspaceResourceFile(join(workspaceStateHome(), file), 4 * 1024 * 1024).snapshot;
    return [file, snapshot ? hash(snapshot.text) : null];
  }));
}
function projection(f) {
  const roster = rawRoster(f);
  return { mainAgentId: roster.mainAgentId, rosterRevision: roster.revision,
    agents: roster.agents.map(row => ({ agentId: row.agentId, username: row.username, state: row.state, kind: row.kind,
      configHash: row.configurations.at(-1).hash, legacy: row.legacy ?? null })),
    schedules: f.features.schedules().map(row => ({ id: row.id, migrationId: row.migrationId, hash: hash(row) })),
    folders: f.folders.list().map(row => ({ id: row.id, hash: hash(row) })) };
}
function childProbe(home) {
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--probe", home], {
    env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", NO_COLOR: "1" },
    cwd: home, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.notEqual(result.pid, process.pid);
  return result;
}
function inspectRole(f, input) {
  const raw = rawRoster(f).agents.find(row => row.username === input.username), config = raw?.configurations[0];
  assert(raw); assert(config); assert.equal(raw.legacy.importId, input.importId); assert.equal(raw.legacy.sourceHash, input.sourceHash);
  assert.equal(raw.state, input.state); assert.equal(config.instructions, input.instructions); assert.equal(config.runtimeId, "pi");
  assert.deepEqual(config.toolPolicy, input.toolPolicy);
  for (const [key, value] of Object.entries(input.profile)) assert.deepEqual(config.identity[key], value);
  // Resolve only a frozen private configuration, not a Host run or permission grant.
  const store = new WorkspaceAgentStore(f.record.scope);
  if (raw.state === "active") {
    const binding = f.storage.run(() => store.freezeTask(randomUUID(), raw.agentId, 1, raw.epoch));
    const resolved = f.storage.run(() => store.resolveTask(binding)); assert.equal(resolved.hash, config.hash);
  } else assert.throws(() => f.storage.run(() => store.freezeTask(randomUUID(), raw.agentId, 1, raw.epoch)), /changed/);
  return { username: raw.username, agentId: raw.agentId, sourceHash: input.sourceHash, importId: input.importId,
    state: raw.state, runtime: config.runtimeId, instructionsHash: hash(config.instructions), policyHash: hash(config.toolPolicy),
    configHash: config.hash, identityHash: hash(config.identity), fidelity: true, configurationBinding: raw.state === "active" ? "resolved_without_execution" : "archived_rejected",
    businessExecution: "not_run", runtimeHostAcceptance: "pending" };
}
function inspectSchedule(f, old, review) {
  const row = f.features.schedules().find(row => row.id === old.id); assert(row);
  assert.equal(row.definition.legacy.sourceHash, review.definitionHash); assert.equal(hash(old), review.definitionHash);
  assert.equal(row.definition.mode, old.mode); assert.equal(row.definition.cwd, old.cwd); assert.deepEqual(row.schedule, old.schedule);
  assert.equal(row.definition.createdAt, old.createdAt); assert.equal(row.definition.tz, review.timezone);
  assert.equal(row.definition.legacy.originalEnabled, old.enabled);
  const quarantined = row.definition.legacy.quarantined;
  assert.equal(row.enabled, review.importEnabled && !quarantined);
  assert.equal(row.definition.task, quarantined ? "" : old.task);
  assert.equal(row.definition.agentId, f.resources.agents.list().mainAgentId);
  for (const key of ["lastRunAt", "scheduleRevision", "lastRunScheduleRevision", "scheduleUpdatedAt", "definitionRevision", "alertAfter", "consecutiveErrors", "lastAlertAt"]) {
    assert.deepEqual(row.definition[key], old[key]);
  }
  if (!quarantined) for (const key of ["deliver", "deliverMode"]) assert.deepEqual(row.definition[key], old[key]);
  const folder = f.folders.sourceForHost(row.definition.legacy.resourceId);
  assert.equal(folder.originalPath, old.cwd); assert.equal(folder.access, "catalog_only");
  return { id: old.id, sourceHash: review.definitionHash, commandHash: review.taskHash, migrationId: row.migrationId,
    schedule: old.schedule, mode: old.mode, enabledBefore: old.enabled, enabledAfter: row.enabled, timezone: review.timezone,
    timezoneDefaulted: review.timezoneDefaulted, expiredOnce: review.expiredOnce, quarantined, haraCli: review.haraCli,
    deliveryRequired: review.structuredDeliver, alertAfter: review.alertAfter, consecutiveErrors: review.consecutiveErrors,
    fidelity: true, transformation: quarantined ? "quarantined_body_omitted" : review.expiredOnce ? "expired_once_disabled" : review.timezoneDefaulted ? "missing_timezone_to_Asia_Shanghai" : "none",
    resourceAccess: "catalog_only", businessExecution: "not_run", liveHandoff: "pending", live24h: "not_observed", nativeUpgrade: "not_run" };
}

/** Caller makes root with mkdtemp inside its authorized copy area. No filesystem source discovery. */
export async function rehearseLegacyCopies({ root, jobs, taskPlan, roles, sourceFingerprint, legacyWorkspacePath, assertSource = () => {} }) {
  const info = fs.lstatSync(root);
  assert.equal(fs.realpathSync(root), root); assert(info.isDirectory()); assert.equal(info.mode & 0o077, 0); assert.equal(info.uid, process.getuid());
  const home = join(root, "home"); fs.mkdirSync(home, { mode: 0o700 });
  const catalog = new LocalWorkspaceCatalog(home), personal = catalog.create("Jeff Personal copy acceptance", 1); catalog.resolvePersonalWorkspace();
  const f = open(home), main = f.resources.agents.initializeMain();
  // Existing destination data must survive rollback byte-for-byte, not merely remain nonempty.
  const kept = f.resources.agents.create({ username: "copy-existing", profile: { displayName: "Existing fixture colleague" }, runtimeId: "pi" }, f.resources.agents.list().revision);
  f.resources.agents.setArchived(kept.agentId, true, kept.configRevision, kept.agentEpoch);
  f.features.saveSchedule({ id: "copy-existing", name: "Existing destination fixture", schedule: { kind: "cron", expr: "* * * * *" },
    enabled: false, task: "Fixture only, never execute", agentId: main.agentId }, 0);
  const paths = [...roleFiles, featureFile, ".hara/workspace-legacy-resources-v1.json"], beforeFiles = fileHashes(f, paths), before = projection(f);
  const rolesDomain = () => new LegacyOwnerFileDomain(f.storage, "roles", sourceFingerprint, roleFiles, roles.length,
    () => { f.resources.agents.importLegacy(roles, f.resources.agents.list().revision); });
  const resourceRows = planLegacyResources({ jobs, projects: [], legacyWorkspacePath });
  const foldersDomain = () => f.folders.domain(sourceFingerprint, resourceRows);
  assertSource(); await rolesDomain().apply(); await foldersDomain().apply();
  const rows = legacyScheduleRows({ jobs, plan: taskPlan, sourceFingerprint, workspaceId: personal.scope.workspaceId,
    mainAgentId: main.agentId, resources: f.folders });
  const scheduleDomain = () => legacySchedulesDomain(f.storage, f.features, sourceFingerprint, rows);
  const domains = () => [rolesDomain(), foldersDomain(), scheduleDomain()];
  const receipt = await scheduleDomain().apply(); assert.equal(await scheduleDomain().verify(receipt), true);
  const tasks = jobs.map(old => inspectSchedule(f, old, taskPlan.find(row => row.id === old.id)));
  const roleResults = roles.map(input => inspectRole(f, input)), applied = projection(f);
  for (let round = 0; round < 3; round++) {
    assertSource(); assert.equal(f.features.importLegacy(rows), 0);
    assert.equal(f.resources.agents.importLegacy(roles, f.resources.agents.list().revision).imported, 0);
    for (const domain of domains()) await domain.apply();
    assert.deepEqual(projection(f), applied);
  }
  const restarted = childProbe(home); assert.deepEqual(restarted.state, applied);
  for (const row of rows) {
    const changed = { ...row, definition: { ...row.definition, task: "changed-copy-only-definition" } };
    assert.throws(() => f.features.importLegacy([changed]), /source changed|edited/);
  }
  for (const role of roles) {
    assert.throws(() => f.resources.agents.importLegacy([{ ...role, sourceHash: hash("changed-source:" + role.sourceHash) }], f.resources.agents.list().revision), /source changed/);
  }
  assert.deepEqual(projection(f), applied); assertSource();
  let executions = 0;
  const executor = { available: () => true, async execute() { executions++; assert.fail("Copied business work must remain inert"); } };
  const scheduler = () => new WorkspaceScheduler(f.storage, f.features, executor);
  await scheduler().tick(main.agentId); await scheduler().tick(main.agentId, Date.now() + 24 * 60 * 60 * 1000);
  // Synthetic clock is ONLY a default-off test, never evidence of a real 24-hour soak or cutover.
  for (const row of rows) await scheduler().tick(main.agentId, Date.now(), row.id);
  const gate = scheduler().list(); assert.equal(gate.migratedEnabled, false); assert.equal(gate.runs.length, 0); assert.equal(executions, 0);
  assert(gate.schedules.filter(row => row.id !== "copy-existing").every(row => row.awaitingHandoff));
  // All domains preflight before the first deletion, just like the production coordinator.
  const reverse = domains().reverse(); for (const domain of reverse) await domain.preflightRollback();
  assertSource(); for (const domain of reverse) await domain.rollback();
  assert.deepEqual(fileHashes(f, paths), beforeFiles); assert.deepEqual(projection(f), before);
  const rolledBack = childProbe(home); assert.deepEqual(rolledBack.state, before);
  for (const domain of domains().reverse()) await domain.rollback(); assert.deepEqual(projection(f), before);
  // A fresh domain instance reads durable journals. It cannot rely on the old object's memory.
  assertSource(); for (const domain of domains()) await domain.apply();
  const afterTasks = jobs.map(old => inspectSchedule(f, old, taskPlan.find(row => row.id === old.id)));
  const afterRoles = roles.map(input => inspectRole(f, input));
  assert.deepEqual(afterTasks, tasks);
  for (const original of roleResults) {
    const upgraded = afterRoles.find(row => row.username === original.username);
    const { agentId: _beforeId, ...expected } = original, { agentId: _afterId, ...actual } = upgraded;
    assert.deepEqual(actual, expected); original.reupgradedAgentId = upgraded.agentId;
  }
  assert.equal(f.resources.agents.list().mainAgentId, main.agentId);
  const final = childProbe(home); assert.deepEqual(final.state, projection(f));
  const other = catalog.create("Other copy Workspace", catalog.read().revision), otherResources = new WorkspaceResources(home, other.scope);
  otherResources.initialize(); otherResources.agents.initializeMain();
  const otherStorage = new WorkspaceResourceStorage(home, other.scope); otherStorage.initialize();
  assert.equal(otherResources.agents.list().agents.length, 1);
  assert.equal(new WorkspaceFeatures(otherStorage, home, other.scope.workspaceId).schedules().length, 0); assertSource();
  for (const row of [...tasks, ...roleResults]) Object.assign(row, { restart: true, idempotent: true, sourceMutationRejected: true, rollback: true, reupgrade: true });
  return { tasks, roles: roleResults, summary: { tasks: tasks.length, roles: roleResults.length,
    enabledAfter: tasks.filter(row => row.enabledAfter).length, quarantined: tasks.filter(row => row.quarantined).length,
    activeRoles: roleResults.filter(row => row.state === "active").length, archivedRoles: roleResults.filter(row => row.state === "archived").length,
    childProcessProbes: 3, independentProbePids: [restarted.pid, rolledBack.pid, final.pid], parentPid: process.pid,
    repeatRounds: 3, sourceMutationRejections: tasks.length + roleResults.length, rollbackPreimagesExact: true,
    existingDestinationObjectsPreserved: true, mainAgentIdUnchanged: true, otherWorkspaceInherited: 0,
    automaticTicks: 2, manualDefaultOffChecks: tasks.length, schedulerClaims: 0, migratedEnabled: false,
    originalCommandsExecuted: 0, providerCalls: 0, keychainCalls: 0, messagesSent: 0,
    liveHandoffPerformed: false, real24hObserved: false, nativeUpgradeVerified: false, completeReleaseGatePassed: false } };
}

if (process.argv[2] === "--probe") {
  try {
    const home = process.argv[3], info = fs.lstatSync(home);
    assert.equal(fs.realpathSync(home), home); assert(info.isDirectory()); assert.equal(info.mode & 0o077, 0); assert.equal(info.uid, process.getuid());
    process.stdout.write(JSON.stringify({ pid: process.pid, state: projection(open(home)) }) + "\n");
  } catch { process.stderr.write("Private copy restart probe failed; no source content emitted\n"); process.exitCode = 1; }
}
