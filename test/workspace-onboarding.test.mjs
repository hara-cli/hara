import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspacePreferences } from "../dist/workspace/preferences.js";
import { SettingsMigrationPendingError } from "../dist/workspace/versioned-settings.js";
import { withPrivateStateLockSync } from "../dist/security/private-state.js";
import { WorkspaceAgentStore } from "../dist/workspace/agents.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { workspaceStateHome } from "../dist/workspace/resource-context.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";

function directory(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-onboarding-")));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3 })); return root;
}
function fixture(t, options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-onboarding-host-"))), host = new LocalWorkspaceHost(root, { credentialVault: new MemoryCredentialVault(), ...options });
  const snapshot = host.createWorkspace("New", host.list().revision), id = snapshot.workspaceId;
  host.select("client", id, host.list().revision); t.after(async () => { await host.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, host, id, snapshot, agents: host.context(id).resources.agents,
    path: name => host.context(id).storage.run(() => join(workspaceStateHome(), ".hara", name)) };
}
const row = (key, username = key, extra = {}) => ({ draftKey: key, username, profile: { displayName: username }, instructions: "Scoped helper", runtimeId: "pi", permissionTier: "controlled", ...extra });
const progress = value => Object.fromEntries(["runId", "step", "engineChoice", "thirdPartySkipped", "dismissed", "completedAt"].map(key => [key, value[key]]));

test("G1: pure legacy migration input preserves appearance bytes and global writes are refused", t => {
  const home = directory(t), prefs = new WorkspacePreferences(home);
  prefs.save("dark", 0); const file = join(home, ".hara", "ui-preferences-v1.json");
  const old = JSON.parse(fs.readFileSync(file)); old.defaultRuntimeId = "claude"; fs.writeFileSync(file, JSON.stringify(old));
  const before = fs.readFileSync(file); assert.equal(prefs.legacyDefaultRuntimeId(), "claude"); assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => prefs.save(undefined, 1, { defaultRuntimeId: "pi" }), /explicit Workspace/);
  assert.deepEqual(fs.readFileSync(file), before);
  prefs.save("light", 1); assert.equal(prefs.read().defaultRuntimeId, "claude");
  const future = { ...JSON.parse(fs.readFileSync(file)), schemaVersion: 99 }; fs.writeFileSync(file, JSON.stringify(future));
  const retained = fs.readFileSync(file); assert.throws(() => prefs.legacyDefaultRuntimeId(), /legacy/); assert.deepEqual(fs.readFileSync(file), retained);
});

test("G1: two Workspaces independently migrate the old Host value once, retain null and survive restart", async t => {
  const f = fixture(t); f.host.getPreferences();
  const legacy = join(f.host.home, ".hara", "ui-preferences-v1.json");
  const old = JSON.parse(fs.readFileSync(legacy)); old.defaultRuntimeId = "codex"; fs.writeFileSync(legacy, JSON.stringify(old));
  const before = fs.readFileSync(legacy), a = f.host.getDefaultRuntime(f.id);
  const second = f.host.createWorkspace("Other", f.host.list().revision), b = f.host.getDefaultRuntime(second.workspaceId);
  assert.equal(a.workspaceId, f.id); assert.equal(b.workspaceId, second.workspaceId); assert.equal(a.defaultRuntimeId, "codex"); assert.equal(b.defaultRuntimeId, "codex");
  assert.deepEqual(fs.readFileSync(legacy), before); assert.equal(Object.hasOwn(f.host.getPreferences(), "defaultRuntimeId"), false);
  f.host.select("client", f.id, f.host.list().revision);
  const aNext = f.host.setDefaultRuntime("client", f.id, null, a.revision);
  assert.equal(aNext.defaultRuntimeId, null); assert.equal(f.host.getDefaultRuntime(second.workspaceId).defaultRuntimeId, "codex");
  assert.throws(() => f.host.setDefaultRuntime("client", f.id, "pi", a.revision), /changed/);
  assert.throws(() => f.host.setDefaultRuntime("client", second.workspaceId, "pi", b.revision), /view changed/);
  const appearance = f.host.getPreferences(); f.host.setPreferences("dark", appearance.revision);
  assert.equal(f.host.getDefaultRuntime(f.id).revision, aNext.revision); assert.equal(f.host.getDefaultRuntime(second.workspaceId).revision, b.revision);
  const changedLegacy = JSON.parse(fs.readFileSync(legacy)); changedLegacy.defaultRuntimeId = "agy"; fs.writeFileSync(legacy, JSON.stringify(changedLegacy));
  const noLegacyRead = t.mock.method(WorkspacePreferences.prototype, "legacyDefaultRuntimeId", () => assert.fail("a migrated Workspace must not reread the Host default"));
  const reopened = new LocalWorkspaceHost(f.root); t.after(() => reopened.close());
  assert.equal(reopened.getDefaultRuntime(f.id).defaultRuntimeId, null); assert.equal(reopened.getDefaultRuntime(second.workspaceId).defaultRuntimeId, "codex");
  noLegacyRead.mock.restore();
  f.host.select("client", second.workspaceId, f.host.list().revision);
  const bNext = f.host.setDefaultRuntime("client", second.workspaceId, "claude", b.revision);
  assert.equal(f.host.getDefaultRuntime(f.id).defaultRuntimeId, null); assert.equal(bNext.defaultRuntimeId, "claude");
  assert.throws(() => f.host.setDefaultRuntime("client", second.workspaceId, "unknown", bNext.revision), /Runtime/);
});

test("G1: a Host publication claim cannot permanently migrate an empty default", t => {
  const f = fixture(t); f.host.getPreferences();
  const primary = join(f.host.home, ".hara", "ui-preferences-v1.json"), backup = primary.replace(".json", "-backup.json");
  const raw = JSON.parse(fs.readFileSync(primary)); raw.defaultRuntimeId = "codex"; fs.writeFileSync(primary, JSON.stringify(raw)); fs.writeFileSync(backup, JSON.stringify(raw));
  const before = fs.readFileSync(primary), claimed = primary + ".claimed-fixture", claimedBackup = backup + ".claimed-fixture";
  const scoped = f.path("workspace-default-runtime-v1.json");
  withPrivateStateLockSync(f.host.home, [], "ui-preferences-v1", () => {
    fs.renameSync(primary, claimed); fs.renameSync(backup, claimedBackup);
    try {
      assert.throws(() => f.host.getDefaultRuntime(f.id), error => error instanceof SettingsMigrationPendingError);
      assert.equal(fs.existsSync(scoped), false); assert.equal(fs.existsSync(scoped.replace(".json", "-backup.json")), false);
    } finally { fs.renameSync(claimed, primary); fs.renameSync(claimedBackup, backup); }
  });
  assert.equal(f.host.getDefaultRuntime(f.id).defaultRuntimeId, "codex"); assert.deepEqual(fs.readFileSync(primary), before);
  const retainedBackup = fs.readFileSync(backup); fs.unlinkSync(primary);
  const second = f.host.createWorkspace("Backup migration", f.host.list().revision);
  assert.equal(f.host.getDefaultRuntime(second.workspaceId).defaultRuntimeId, "codex");
  assert.equal(fs.existsSync(primary), false); assert.deepEqual(fs.readFileSync(backup), retainedBackup);
});

test("G1: an invalid old document stays preserved and Workspace writes remain independent", t => {
  const f = fixture(t); f.host.getPreferences(); const legacy = join(f.host.home, ".hara", "ui-preferences-v1.json");
  fs.writeFileSync(legacy, "{"); const initial = f.host.getDefaultRuntime(f.id);
  assert.equal(initial.defaultRuntimeId, null); assert.equal(fs.readFileSync(legacy, "utf8"), "{");
  assert.equal(f.host.setDefaultRuntime("client", f.id, "claude", initial.revision).defaultRuntimeId, "claude");
  assert.equal(fs.readFileSync(legacy, "utf8"), "{");
});

test("G1: unknown/corrupt scoped settings and links cannot overwrite retained Workspace state", t => {
  const f = fixture(t), initial = f.host.getDefaultRuntime(f.id), file = f.path("workspace-default-runtime-v1.json");
  const saved = f.host.setDefaultRuntime("client", f.id, "codex", initial.revision);
  const future = { ...JSON.parse(fs.readFileSync(file)), schemaVersion: 99, futureField: true }; fs.writeFileSync(file, JSON.stringify(future));
  const before = fs.readFileSync(file), read = f.host.getDefaultRuntime(f.id); assert.equal(read.readOnly, true);
  assert.throws(() => f.host.setDefaultRuntime("client", f.id, "pi", saved.revision), /read-only/); assert.deepEqual(fs.readFileSync(file), before);
  fs.writeFileSync(file, "{"); assert.equal(f.host.getDefaultRuntime(f.id).recovered, true);
  assert.throws(() => f.host.setDefaultRuntime("client", f.id, "pi", saved.revision), /read-only/); assert.equal(fs.readFileSync(file, "utf8"), "{");
  const outside = join(f.root, "retained-default-runtime.json"); fs.writeFileSync(outside, "retained"); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => f.host.getDefaultRuntime(f.id)); assert.throws(() => f.host.setDefaultRuntime("client", f.id, "pi", saved.revision));
  assert.equal(fs.readFileSync(outside, "utf8"), "retained");
});

test("G1: the actual proposal card honors an available preference, falls back from unavailable and keeps existing Agents", async t => {
  const f = fixture(t); f.host.configureSynthetic(f.id, 0);
  const options = AgentRuntimeRegistry.prototype.options;
  t.mock.method(AgentRuntimeRegistry.prototype, "options", function() { return options.call(this).map(option => option.id === "codex" ? { ...option, available: true, selectable: true } : option); });
  const second = f.host.createWorkspace("Other proposal", f.host.list().revision); f.host.configureSynthetic(second.workspaceId, 0);
  for (const [workspaceId, agentId, preferred, expected] of [[f.id, f.snapshot.selectedAgentId, "codex", "codex"], [second.workspaceId, second.selectedAgentId, "agy", "pi"]]) {
    f.host.select("client", workspaceId, f.host.list().revision);
    const pref = f.host.getDefaultRuntime(workspaceId); f.host.setDefaultRuntime("client", workspaceId, preferred, pref.revision);
    const run = f.host.start("client", workspaceId, agentId, "建立一位测试同事", randomUUID());
    const deadline = Date.now() + 10000; let card;
    while (!(card = f.host.snapshot(workspaceId, agentId, "client").approvals[0]) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(card); assert.equal(card.draft.runtimeId, expected);
    f.host.answerApproval("client", workspaceId, card.id, false); await f.host.wait(run.runId);
  }
  assert.equal(f.host.getDefaultRuntime(f.id).defaultRuntimeId, "codex");
  assert.equal(f.agents.list().agents.length, 1); assert.equal(f.agents.list().agents[0].runtime.id, "pi");
});

test("G2: mixed results retain slots, retries only fill the failed row and successful input never edits the original", t => {
  const f = fixture(t), runId = randomUUID(), revision = f.agents.list().revision;
  const input = { runId, rows: [row("one", "one"), row("two", "one")] };
  const first = f.host.createAgentBatch("client", f.id, input, revision);
  assert.deepEqual(first.results.map(value => [value.index, value.status, value.reason]), [[0, "created", undefined], [1, "failed", "username_taken"]]);
  const savedId = first.results[0].agent.agentId;
  const stale = f.host.createAgentBatch("client", f.id, { runId, rows: [row("one", "do-not-rename"), row("two", "two")] }, revision);
  assert.deepEqual(stale.results.map(value => value.status), ["exists", "failed"]); assert.equal(stale.results[1].reason, "catalog_changed");
  const retried = f.host.createAgentBatch("client", f.id, { runId, rows: [row("one", "do-not-rename"), row("two", "two")] }, first.revision);
  assert.deepEqual(retried.results.map(value => value.status), ["exists", "created"]);
  assert.equal(retried.results[0].agent.agentId, savedId); assert.equal(retried.results[0].agent.username, "one");
  assert.equal(f.agents.list().agents.length, 3); assert.equal(first.revision, revision + 1);
  const all = f.host.createAgentBatch("client", f.id, input, revision);
  assert.deepEqual(all.results.map(value => value.status), ["exists", "exists"]); assert.equal(all.revision, retried.revision);
});

test("G2: one shared catalog publication survives a lost ACK and reopen without creating another Agent", t => {
  const f = fixture(t), input = { runId: randomUUID(), rows: [row("one"), row("two")] }, revision = f.agents.list().revision;
  const persist = WorkspaceAgentStore.prototype.persist;
  const mock = t.mock.method(WorkspaceAgentStore.prototype, "persist", function(...args) { persist.apply(this, args); throw new Error("ACK lost after one catalog publication"); });
  assert.throws(() => f.agents.createBatch(input, revision), /ACK lost/); mock.mock.restore();
  const peer = new LocalWorkspaceHost(f.root, { credentialVault: new MemoryCredentialVault() }); t.after(() => peer.close());
  peer.select("peer", f.id, peer.list().revision);
  const receipt = peer.createAgentBatch("peer", f.id, input, revision);
  assert.deepEqual(receipt.results.map(value => value.status), ["exists", "exists"]); assert.equal(receipt.revision, revision + 1);
  assert.equal(peer.snapshot(f.id).agents.length, 3);
});

test("G2: prepublication failure preserves both roster and idempotency, so the original request can create once", t => {
  const f = fixture(t), input = { runId: randomUUID(), rows: [row("one")] }, revision = f.agents.list().revision;
  const path = f.path("workspace-agents.json"), before = fs.readFileSync(path);
  const mock = t.mock.method(WorkspaceAgentStore.prototype, "persist", () => { throw new Error("failed before shared CAS"); });
  assert.throws(() => f.agents.createBatch(input, revision), /before shared/); mock.mock.restore(); assert.deepEqual(fs.readFileSync(path), before);
  assert.equal(f.agents.createBatch(input, revision).results[0].status, "created"); assert.equal(f.agents.list().agents.length, 2);
});

test("G2: envelope and per-run eight-slot limits reject overflow; invalid rows have stable reasons and no authority", t => {
  const f = fixture(t), runId = randomUUID(), revision = f.agents.list().revision;
  assert.throws(() => f.agents.createBatch({ runId, rows: Array.from({ length: 9 }, (_, i) => row("k" + i)) }, revision), /batch/);
  assert.throws(() => f.agents.createBatch({ runId, rows: [row("same"), row("same")] }, revision), /draft key/);
  const invalid = f.agents.createBatch({ runId, rows: [row("bad", "bad", { actor: "human" }), row("runtime", "runtime", { runtimeId: "agy" }), row("tier", "tier", { permissionTier: "root" })] }, revision);
  assert.deepEqual(invalid.results.map(value => value.reason), ["invalid_request", "runtime_unavailable", "invalid_request"]);
  assert.equal(invalid.revision, revision);
  const eight = f.agents.createBatch({ runId, rows: Array.from({ length: 8 }, (_, i) => row("k" + i)) }, revision);
  assert.equal(eight.results.every(value => value.status === "created"), true);
  assert.equal(f.agents.createBatch({ runId, rows: [row("ninth")] }, eight.revision).results[0].reason, "batch_limit");
});

test("G2: archived success remains exists; separate Workspaces do not share successful keys", t => {
  const f = fixture(t), runId = randomUUID(), input = { runId, rows: [row("one")] };
  const first = f.agents.createBatch(input, f.agents.list().revision), agent = first.results[0].agent;
  f.agents.setArchived(agent.agentId, true, agent.configRevision, agent.agentEpoch);
  const retried = f.agents.createBatch(input, first.revision); assert.equal(retried.results[0].status, "exists"); assert.equal(retried.results[0].agent.state, "archived");
  const second = f.host.createWorkspace("Other", f.host.list().revision), other = f.host.context(second.workspaceId).resources.agents;
  assert.equal(other.createBatch(input, other.list().revision).results[0].status, "created");
});

test("G2: an omitted runtime uses the new preference fallback, while explicit unavailable runtime never falls back", t => {
  const f = fixture(t), pref = f.host.getDefaultRuntime(f.id);
  const { draftKey: _key, ...retainedInput } = row("retained");
  const retained = f.agents.create(retainedInput, f.agents.list().revision);
  f.host.setDefaultRuntime("client", f.id, "agy", pref.revision);
  assert.equal(f.agents.get(retained.agentId).runtime.id, retained.runtime.id);
  assert.equal(f.agents.get(retained.agentId).configRevision, retained.configRevision);
  const omitted = row("fallback"); delete omitted.runtimeId;
  const reply = f.host.createAgentBatch("client", f.id, { runId: randomUUID(), rows: [omitted, row("explicit", "explicit", { runtimeId: "agy" })] }, f.agents.list().revision);
  assert.equal(reply.results[0].agent.runtime.id, "pi"); assert.equal(reply.results[1].reason, "runtime_unavailable");
});

test("G4: new workspaces persist fresh progress; a missing pre-upgrade record stays dismissed even with only Hara", async t => {
  const f = fixture(t), fresh = f.host.getOnboarding(f.id); assert.equal(fresh.dismissed, false); assert.equal(fresh.step, 1);
  let saved = f.host.setOnboarding("client", f.id, { ...progress(fresh), step: 2, engineChoice: "pi", thirdPartySkipped: true }, fresh.revision);
  const restarted = new LocalWorkspaceHost(f.root); t.after(() => restarted.close());
  assert.deepEqual(restarted.getOnboarding(f.id), saved);
  assert.throws(() => f.host.setOnboarding("client", f.id, progress(fresh), fresh.revision), /changed/);
  const file = f.path("workspace-onboarding-v1.json"); fs.unlinkSync(file); fs.unlinkSync(file.replace(".json", "-backup.json"));
  const old = new LocalWorkspaceHost(f.root); t.after(() => old.close()); const closed = old.getOnboarding(f.id);
  assert.equal(closed.dismissed, true); assert.equal(old.snapshot(f.id).agents.length, 1);
  assert.deepEqual(new LocalWorkspaceHost(f.root).getOnboarding(f.id), closed);
  const other = f.host.createWorkspace("New second", f.host.list().revision); assert.equal(f.host.getOnboarding(other.workspaceId).dismissed, false);
});

test("G4: explicit rerun has a new ID and CAS; unknown fields, invalid completion and foreign views do not mutate", t => {
  const f = fixture(t), first = f.host.getOnboarding(f.id), file = f.path("workspace-onboarding-v1.json");
  const before = fs.readFileSync(file);
  assert.throws(() => f.host.setOnboarding("other-client", f.id, progress(first), first.revision), /view changed/);
  assert.throws(() => f.host.setOnboarding("client", f.id, { ...progress(first), answers: {} }, first.revision), /Invalid onboarding/);
  assert.throws(() => f.host.setOnboarding("client", f.id, { ...progress(first), completedAt: new Date().toISOString() }, first.revision), /Invalid onboarding/);
  assert.deepEqual(fs.readFileSync(file), before);
  const complete = f.host.setOnboarding("client", f.id, { ...progress(first), step: 3, completedAt: new Date().toISOString() }, first.revision);
  const next = f.host.setOnboarding("client", f.id, { ...progress(first), runId: randomUUID() }, complete.revision);
  assert.notEqual(next.runId, first.runId); assert.equal(next.step, 1); assert.equal(next.completedAt, null);
  assert.throws(() => f.host.setOnboarding("client", f.id, progress(complete), complete.revision), /changed/);
});

test("RPC: authenticated capability-gated preferences, progress and batch keep generation, fields and selection fences", async t => {
  let role = "OWNER";
  const root = directory(t), handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root, version: "fixture", credentialVault: new MemoryCredentialVault(), defaultRuntimeRole: () => role,
    providerFactory() { throw new Error("onboarding RPC must not dispatch a model"); } });
  const socket = new WebSocket("ws://127.0.0.1:" + handle.port), pending = new Map(); let serial = 0;
  socket.on("message", raw => { const value = JSON.parse(raw), waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(value.error.message)) : waiter.resolve(value.result); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => reject(new Error("RPC fixture deadline")), 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  try {
    await once(socket, "open"); await assert.rejects(rpc("workspace.preferences.get", {}), /unauthorized/);
    const init = await rpc("initialize", { token: handle.token }); assert.ok(init.capabilities.includes("workspace.onboarding.v1")); assert.ok(init.capabilities.includes("workspace.agents.create-batch.v1"));
    assert.ok(init.capabilities.includes("workspace.default-runtime.v1"));
    assert.equal(init.capabilities.includes("workspace.preferences.default-runtime.v1"), false);
    const workspace = await rpc("workspace.create", { label: "RPC", expectedRevision: init.workspace.revision });
    await rpc("workspace.select", { workspaceId: workspace.workspaceId, expectedRevision: (await rpc("workspace.list", {})).revision });
    const binding = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
    assert.equal(Object.hasOwn(await rpc("workspace.preferences.get", {}), "defaultRuntimeId"), false);
    let pref = await rpc("workspace.defaultRuntime.get", binding);
    pref = await rpc("workspace.defaultRuntime.set", { ...binding, defaultRuntimeId: "pi", expectedRevision: pref.revision }); assert.equal(pref.defaultRuntimeId, "pi");
    assert.equal(pref.workspaceId, binding.workspaceId);
    await assert.rejects(rpc("workspace.preferences.defaultRuntime.get", binding), /unsupported|unknown/i);
    await assert.rejects(rpc("workspace.preferences.defaultRuntime.set", { ...binding, defaultRuntimeId: "codex", expectedRevision: pref.revision }), /unsupported|unknown/i);
    role = "MEMBER";
    assert.equal((await rpc("workspace.defaultRuntime.get", binding)).readOnly, true);
    await assert.rejects(rpc("workspace.defaultRuntime.set", { ...binding, defaultRuntimeId: "claude", expectedRevision: pref.revision }), /read-only/);
    await assert.rejects(rpc("workspace.defaultRuntime.set", { ...binding, defaultRuntimeId: "claude", expectedRevision: pref.revision, role: "OWNER" }), /unsupported/);
    role = "ADMIN";
    pref = await rpc("workspace.defaultRuntime.set", { ...binding, defaultRuntimeId: "pi", expectedRevision: pref.revision });
    assert.equal(pref.readOnly, false);
    role = "OWNER";
    await assert.rejects(rpc("workspace.preferences.set", { defaultRuntimeId: "codex", expectedRevision: 1 }), /unsupported/);
    await assert.rejects(rpc("workspace.defaultRuntime.get", {}), /explicit/);
    await assert.rejects(rpc("workspace.defaultRuntime.set", { ...binding, expectedGeneration: randomUUID(), defaultRuntimeId: "codex", expectedRevision: pref.revision }), /generation|changed/i);
    await assert.rejects(rpc("workspace.defaultRuntime.set", { ...binding, defaultRuntimeId: "codex", expectedRevision: pref.revision, actor: "human" }), /unsupported/);
    const second = await rpc("workspace.create", { label: "RPC other", expectedRevision: (await rpc("workspace.list", {})).revision });
    const secondBinding = { workspaceId: second.workspaceId, expectedGeneration: second.resourceGeneration };
    const otherPref = await rpc("workspace.defaultRuntime.get", secondBinding); assert.equal(otherPref.defaultRuntimeId, null);
    await assert.rejects(rpc("workspace.defaultRuntime.set", { ...secondBinding, defaultRuntimeId: "claude", expectedRevision: otherPref.revision }), /view changed/);
    assert.equal((await rpc("workspace.defaultRuntime.get", binding)).defaultRuntimeId, "pi");
    const current = await rpc("workspace.onboarding.get", binding);
    const updated = await rpc("workspace.onboarding.set", { ...binding, ...progress(current), step: 2, expectedRevision: current.revision }); assert.equal(updated.step, 2);
    await assert.rejects(rpc("workspace.onboarding.get", { ...binding, expectedGeneration: randomUUID() }), /generation|changed/i);
    await assert.rejects(rpc("workspace.onboarding.set", { ...binding, ...progress(updated), expectedRevision: updated.revision, actor: "human" }), /unsupported/);
    const runId = randomUUID(), input = { ...binding, runId, rows: [row("rpc")], expectedCatalogRevision: workspace.agentRevision };
    assert.equal((await rpc("workspace.agents.createBatch", input)).results[0].status, "created");
    assert.equal((await rpc("workspace.agents.createBatch", input)).results[0].status, "exists");
    await assert.rejects(rpc("workspace.agents.createBatch", { ...input, approved: true }), /unsupported/);
  } finally { socket.close(); await once(socket, "close"); await handle.close(); }
});


test("G2: a detected but unconfirmed engine returns runtime_unconfirmed without a fallback or Agent", t => {
  const f = fixture(t), options = AgentRuntimeRegistry.prototype.options;
  t.mock.method(AgentRuntimeRegistry.prototype, "options", function() { return options.call(this).map(option => option.id === "codex" ? { ...option, available: false, confirmation: "first_use" } : option); });
  const revision = f.agents.list().revision;
  const receipt = f.agents.createBatch({ runId: randomUUID(), rows: [row("pending", "pending", { runtimeId: "codex" })] }, revision);
  assert.equal(receipt.results[0].reason, "runtime_unconfirmed"); assert.equal(receipt.revision, revision); assert.equal(f.agents.list().agents.length, 1);
});

test("G4: newer/corrupt progress is read-only and a symlink cannot redirect its writes", t => {
  const f = fixture(t), file = f.path("workspace-onboarding-v1.json"), initial = f.host.getOnboarding(f.id);
  const future = { ...progress(initial), schemaVersion: 2, revision: initial.revision, futureField: true };
  fs.writeFileSync(file, JSON.stringify(future)); const before = fs.readFileSync(file);
  const read = f.host.getOnboarding(f.id); assert.equal(read.readOnly, true);
  assert.throws(() => f.host.setOnboarding("client", f.id, progress(initial), initial.revision), /read-only/); assert.deepEqual(fs.readFileSync(file), before);
  const outside = join(f.root, "retained-private.txt"); fs.writeFileSync(outside, "preserved"); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => f.host.setOnboarding("client", f.id, progress(initial), initial.revision)); assert.equal(fs.readFileSync(outside, "utf8"), "preserved");
});


test("G1: trusted member policy cannot initialize a missing preference or read its legacy seed", t => {
  let role = "MEMBER";
  const seen = [], f = fixture(t, { defaultRuntimeRole: workspaceId => { seen.push(workspaceId); return role; } });
  const file = f.path("workspace-default-runtime-v1.json"), backup = f.path("workspace-default-runtime-v1-backup.json");
  const legacy = t.mock.method(f.host.preferences, "legacyDefaultRuntimeId", () => "claude");
  const first = f.host.getDefaultRuntime(f.id);
  assert.equal(first.readOnly, true); assert.equal(first.revision, 0); assert.equal(first.defaultRuntimeId, null);
  assert.equal(legacy.mock.callCount(), 0); assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(backup), false);
  assert.throws(() => f.host.setDefaultRuntime("client", f.id, "pi", first.revision), /read-only/);
  assert.equal(fs.existsSync(file), false);
  role = "OWNER";
  const seeded = f.host.getDefaultRuntime(f.id); assert.equal(seeded.defaultRuntimeId, "claude"); assert.equal(seeded.revision, 1); assert.equal(seeded.readOnly, false);
  assert.equal(legacy.mock.callCount(), 1);
  role = "ADMIN";
  const saved = f.host.setDefaultRuntime("client", f.id, "codex", seeded.revision); assert.equal(saved.defaultRuntimeId, "codex");
  const before = fs.readFileSync(file);
  role = "MEMBER";
  assert.equal(f.host.getDefaultRuntime(f.id).defaultRuntimeId, "codex"); assert.equal(f.host.getDefaultRuntime(f.id).readOnly, true);
  assert.throws(() => f.host.setDefaultRuntime("client", f.id, null, saved.revision), /read-only/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(legacy.mock.callCount(), 1); assert.ok(seen.length > 0 && seen.every(id => id === f.id));
});

test("G1: absent, unknown and failed trusted role results fail closed without a scoped document", t => {
  let current = null;
  const f = fixture(t, { defaultRuntimeRole: () => { if (current instanceof Error) throw current; return current; } });
  for (const role of [null, undefined, "owner", "UNKNOWN", new Error("private policy failure")]) {
    current = role;
    const result = f.host.getDefaultRuntime(f.id); assert.equal(result.readOnly, true); assert.equal(result.revision, 0);
    assert.throws(() => f.host.setDefaultRuntime("client", f.id, "pi", 1), /read-only/);
    assert.equal(fs.existsSync(f.path("workspace-default-runtime-v1.json")), false);
  }
});

test("G1: role revocation during backup publication cannot publish a new primary", t => {
  let role = "OWNER";
  const f = fixture(t, { defaultRuntimeRole: () => role });
  const initial = f.host.getDefaultRuntime(f.id), file = f.path("workspace-default-runtime-v1.json"), backup = f.path("workspace-default-runtime-v1-backup.json");
  const before = fs.readFileSync(file), original = fs.linkSync; let revoked = false;
  fs.linkSync = function(from, to) { const result = original.apply(this, arguments); if (to === backup) { role = "MEMBER"; revoked = true; } return result; };
  syncBuiltinESMExports();
  try { assert.throws(() => f.host.setDefaultRuntime("client", f.id, "codex", initial.revision), /read-only/); }
  finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert.equal(revoked, true); assert.deepEqual(fs.readFileSync(file), before);
  const read = f.host.getDefaultRuntime(f.id); assert.equal(read.readOnly, true); assert.equal(read.defaultRuntimeId, initial.defaultRuntimeId);
});

test("G1: trusted metadata policy is evaluated for the exact Workspace, not the last selected one", t => {
  const roles = new Map(), f = fixture(t, { defaultRuntimeRole: id => roles.get(id) ?? null });
  roles.set(f.id, "OWNER");
  const first = f.host.getDefaultRuntime(f.id);
  f.host.setDefaultRuntime("client", f.id, "codex", first.revision);
  const other = f.host.createWorkspace("Read only", f.host.list().revision);
  const member = f.host.getDefaultRuntime(other.workspaceId);
  assert.equal(member.readOnly, true); assert.equal(member.revision, 0);
  f.host.select("client", other.workspaceId, f.host.list().revision);
  assert.throws(() => f.host.setDefaultRuntime("client", other.workspaceId, "pi", 1), /read-only/);
  assert.equal(f.host.getDefaultRuntime(f.id).defaultRuntimeId, "codex");
  roles.set(other.workspaceId, "ADMIN");
  const admin = f.host.getDefaultRuntime(other.workspaceId);
  const saved = f.host.setDefaultRuntime("client", other.workspaceId, "claude", admin.revision);
  assert.equal(saved.readOnly, false); assert.equal(saved.defaultRuntimeId, "claude");
  assert.equal(f.host.getDefaultRuntime(f.id).defaultRuntimeId, "codex");
});
