import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { withPrivateStateLockSync } from "../dist/security/private-state.js";
import { WorkspaceExecutionAudit, WORKSPACE_EXECUTION_AUDIT_TTL_MS as TTL, pruneWorkspaceExecutionAudits } from "../dist/workspace/execution-audit.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-audit-retention-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = new LocalWorkspaceCatalog(root), scope = catalog.create("Synthetic", 1).scope;
  const storage = new WorkspaceResourceStorage(root, scope); storage.initialize();
  const runId = randomUUID(), audit = new WorkspaceExecutionAudit(storage, runId, `wa-${randomUUID()}`);
  const file = storage.run(() => join(workspaceStateHome(), ".hara", `execution-${runId}.json`));
  return { root, storage, audit, file };
}

test("TTL uses the last physical finish, preserves unrelated state and expires exactly at seven days", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const a = fixture(t), first = a.audit.start("model", 1, "provider");
  t.mock.timers.setTime(1_000_010); a.audit.finish(first, 10, "completed", null);
  const second = a.audit.start("tool", 1, "workspace_read");
  t.mock.timers.setTime(1_000_100); a.audit.finish(second, 90, "completed", null);
  const budget = join(a.file, "..", "tree-budget-synthetic.json");
  fs.writeFileSync(budget, "synthetic governor state\n");
  fs.utimesSync(a.file, new Date(0), new Date(0));
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, 1_000_010 + TTL), { removed: 0, held: 0 });
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, 1_000_100 + TTL - 1), { removed: 0, held: 0 });
  assert.ok(fs.existsSync(a.file));
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, 1_000_100 + TTL), { removed: 1, held: 0 });
  assert.equal(fs.existsSync(a.file), false);
  assert.equal(fs.readFileSync(budget, "utf8"), "synthetic governor state\n");
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, 1_000_100 + TTL), { removed: 0, held: 0 });
});

test("unfinished work stays unknown across reopen and cancellation starts TTL only after physical settlement", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const a = fixture(t), index = a.audit.start("model", 1, "provider"), before = fs.readFileSync(a.file, "utf8");
  t.mock.timers.setTime(1_000_000 + 30 * TTL);
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage), { removed: 0, held: 1 });
  assert.equal(fs.readFileSync(a.file, "utf8"), before);
  a.audit.finish(index, 30 * TTL, "cancelled", "cancelled");
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage), { removed: 0, held: 0 });
  assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, Date.now() + TTL), { removed: 1, held: 0 });
});

test("cleanup shares the writer lock and never removes a busy diagnostic", t => {
  const a = fixture(t), index = a.audit.start("tool", 1, "workspace_read"); a.audit.finish(index, 1, "completed", null);
  const endedAt = a.audit.read().operations[0].endedAt, before = fs.readFileSync(a.file, "utf8");
  a.storage.run(() => withPrivateStateLockSync(workspaceStateHome(), [], basename(a.file).slice(0, -5), () => {
    assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, endedAt + TTL), { removed: 0, held: 1 });
  }));
  assert.equal(fs.readFileSync(a.file, "utf8"), before);
  assert.equal(pruneWorkspaceExecutionAudits(a.storage, endedAt + TTL).removed, 1);
});

for (const variant of ["generation", "corrupt", "symlink", "hardlink", "empty"]) {
  test(`cleanup retains ${variant} records without touching a target`, t => {
    const a = fixture(t), index = a.audit.start("tool", 1, "workspace_read"); a.audit.finish(index, 1, "error", "tool_error");
    const record = JSON.parse(fs.readFileSync(a.file, "utf8")), target = join(a.root, `synthetic-${variant}.txt`);
    fs.writeFileSync(target, "synthetic target\n");
    if (variant === "generation") { record.resourceBinding.generation = randomUUID(); fs.writeFileSync(a.file, JSON.stringify(record)); }
    if (variant === "empty") { record.operations = []; fs.writeFileSync(a.file, JSON.stringify(record)); }
    if (variant === "corrupt") fs.writeFileSync(a.file, "{not-json");
    if (variant === "symlink" || variant === "hardlink") {
      fs.unlinkSync(a.file);
      if (variant === "symlink") {
        try { fs.symlinkSync(target, a.file); }
        catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows account cannot create a file symlink"); return; } throw error; }
      } else fs.linkSync(target, a.file);
    }
    const before = fs.readFileSync(a.file, "utf8");
    assert.deepEqual(pruneWorkspaceExecutionAudits(a.storage, Date.now() + 100 * TTL), { removed: 0, held: 1 }, variant);
    assert.equal(fs.readFileSync(a.file, "utf8"), before, variant);
    assert.equal(fs.readFileSync(target, "utf8"), "synthetic target\n", variant);
  });
}

test("an invalid cleanup clock or revoked Workspace cannot authorize deletion", t => {
  const a = fixture(t), index = a.audit.start("model", 1, "provider"); a.audit.finish(index, 0, "completed", null);
  const before = fs.readFileSync(a.file, "utf8");
  for (const now of [-1, NaN, Infinity]) assert.throws(() => pruneWorkspaceExecutionAudits(a.storage, now), /cleanup time/);
  const scopeFile = join(a.file, "..", "..", "..", "scope.json"), marker = JSON.parse(fs.readFileSync(scopeFile, "utf8"));
  marker.generation = randomUUID(); fs.writeFileSync(scopeFile, JSON.stringify(marker));
  assert.throws(() => pruneWorkspaceExecutionAudits(a.storage, Date.now() + 2 * TTL), /marker|binding|generation/);
  assert.equal(fs.readFileSync(a.file, "utf8"), before);
});

test("Host snapshot cleanup runs for the authorized Workspace and leaves unfinished rows intact", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-host-audit-retention-")));
  const host = new LocalWorkspaceHost(root);
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = host.createWorkspace("Synthetic", host.list().revision);
  const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(workspace.workspaceId).scope); storage.initialize();
  const finishedId = randomUUID(), unfinishedId = randomUUID();
  const finished = new WorkspaceExecutionAudit(storage, finishedId, workspace.selectedAgentId);
  const unfinished = new WorkspaceExecutionAudit(storage, unfinishedId, workspace.selectedAgentId);
  finished.finish(finished.start("model", 1, "provider"), 0, "completed", null);
  unfinished.start("model", 1, "provider");
  const file = id => storage.run(() => join(workspaceStateHome(), ".hara", `execution-${id}.json`));
  t.mock.timers.setTime(Date.now() + TTL);
  host.snapshot(workspace.workspaceId, workspace.selectedAgentId);
  assert.equal(fs.existsSync(file(finishedId)), false);
  assert.equal(fs.existsSync(file(unfinishedId)), true);
});


test("Host keeps expired diagnostics while an accepted job owns the Workspace, then prunes after reopen", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-host-active-audit-")));
  const host = new LocalWorkspaceHost(root);
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = host.createWorkspace("Synthetic", host.list().revision);
  host.configureSynthetic(workspace.workspaceId, 0); host.select("client", workspace.workspaceId, host.list().revision);
  host.start("client", workspace.workspaceId, workspace.selectedAgentId, "hello", randomUUID());
  const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(workspace.workspaceId).scope); storage.initialize();
  const runId = randomUUID(), audit = new WorkspaceExecutionAudit(storage, runId, workspace.selectedAgentId);
  audit.finish(audit.start("tool", 1, "workspace_read"), 0, "completed", null);
  const file = storage.run(() => join(workspaceStateHome(), ".hara", `execution-${runId}.json`));
  t.mock.timers.setTime(Date.now() + TTL);
  host.snapshot(workspace.workspaceId, workspace.selectedAgentId);
  assert.equal(fs.existsSync(file), true, "an accepted or draining job prevents cleanup between physical calls");
  await host.close();
  const reopened = new LocalWorkspaceHost(root);
  try { reopened.snapshot(workspace.workspaceId, workspace.selectedAgentId); assert.equal(fs.existsSync(file), false); }
  finally { await reopened.close(); }
});


test("Host opens despite cleanup failure, logs no raw error and retries after the cooldown", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-host-audit-failure-")));
  const host = new LocalWorkspaceHost(root);
  let reopened;
  t.after(async () => { await reopened?.close(); await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = host.createWorkspace("Synthetic", host.list().revision);
  const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(workspace.workspaceId).scope); storage.initialize();
  const runId = randomUUID(), audit = new WorkspaceExecutionAudit(storage, runId, workspace.selectedAgentId);
  audit.finish(audit.start("tool", 1, "workspace_read"), 0, "completed", null);
  const file = storage.run(() => join(workspaceStateHome(), ".hara", `execution-${runId}.json`));
  await host.close();
  t.mock.timers.setTime(Date.now() + TTL);
  const originalRead = fs.readdirSync, warnings = [];
  let fail = true, scans = 0;
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (directory === join(file, "..")) {
      scans++;
      if (fail) throw new Error("synthetic-private-error: do not log this path or credential");
    }
    return originalRead(directory, ...args);
  });
  t.mock.method(process.stderr, "write", line => {
    warnings.push(String(line));
    throw new Error("synthetic log sink failure");
  });
  syncBuiltinESMExports();
  try {
    reopened = new LocalWorkspaceHost(root);
    assert.equal(reopened.snapshot(workspace.workspaceId, workspace.selectedAgentId).workspaceId, workspace.workspaceId);
    assert.equal(scans, 1);
    assert.deepEqual(warnings, ["hara: Workspace execution audit cleanup failed; retrying later.\n"]);
    assert.ok(fs.existsSync(file), "failed cleanup preserves the diagnostic");
    fail = false;
    reopened.snapshot(workspace.workspaceId, workspace.selectedAgentId);
    assert.equal(scans, 1, "failed cleanup is throttled too");
    t.mock.timers.setTime(Date.now() + 60_000);
    reopened.snapshot(workspace.workspaceId, workspace.selectedAgentId);
    assert.equal(scans, 2);
    assert.equal(fs.existsSync(file), false, "cleanup can recover on a later access");
    assert.equal(warnings.length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
