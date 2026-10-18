import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/scoped-connections.js";
import { WorkspaceSecureConnections } from "../dist/workspace/secure-connections.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { WorkspacePreferences } from "../dist/workspace/preferences.js";
import { LegacyConnectionCatalog } from "../dist/workspace/legacy-connections.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { detectInstalledRuntimes, boundedRuntimeCommand } from "../dist/workspace/runtime-detect.js";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { WebSocket } from "ws";
import { once } from "node:events";

const roots = [], fakeKey = "private-fixture-migration-key";
function dir() { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-settings-review-"))); roots.push(root); return root; }
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function storage(home = dir(), scope = { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }) {
  const result = new WorkspaceResourceStorage(home, scope); result.initialize(); return result;
}
const input = (label = "Fixture") => ({ label, provider: "openai", baseURL: "https://example.invalid/v1", defaultModel: "fixture-model", apiKey: fakeKey });
const path = (resource, backup = false) => resource.run(() => join(workspaceStateHome(), ".hara", backup ? "workspace-connections-v2-backup.json" : "workspace-connections-v2.json"));
function binary(file, body) { fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 }); return file; }

test("npm prefix discovery is offline/no-notifier and cannot create the host npm notifier cache", async () => {
  const home = dir(), npm = binary(join(home, ".nvm/versions/node/v22.23.1/bin/npm"),
    'if [ "$npm_config_update_notifier" != "false" ] || [ "$NO_UPDATE_NOTIFIER" != "1" ] || [ "$npm_config_offline" != "true" ] || [ "$npm_config_logs_max" != "0" ]; then mkdir -p "$HOME/.npm"; exit 1; fi\nprintf "%s\\n" "$HOME/prefix"');
  const executable = binary(join(home, "prefix/bin/opencode"), 'echo "opencode 1.2.3"');
  const calls = [], previousFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = () => { networkCalls++; throw new Error("network not allowed"); };
  try {
    const found = await detectInstalledRuntimes({ home, path: "/usr/bin:/bin", systemBins: [], run: async (command, args, env, timeout) => {
      if (args[0] === "-lc") return null;
      calls.push({ command, args, env }); return boundedRuntimeCommand(command, args, env, timeout);
    } });
    assert.equal(found.find(row => row.runtimeId === "opencode")?.path, executable);
    const probe = calls.find(row => row.command === npm); assert.ok(probe); assert.deepEqual(probe.args, ["config", "get", "prefix"]);
    assert.equal(probe.env.npm_config_update_notifier, "false"); assert.equal(probe.env.NO_UPDATE_NOTIFIER, "1"); assert.equal(probe.env.npm_config_offline, "true");
    assert.equal(fs.existsSync(join(home, ".npm")), false); assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

for (const reason of ["denied", "timeout", "non-darwin unavailable"]) test(`v2 migration ${reason} is pending/read-only, preserves source and never silently retries`, () => {
  const resource = storage(); new WorkspaceConnectionStoreV2(resource).add(input(), 0);
  const before = fs.readFileSync(path(resource)), memory = new MemoryCredentialVault(); let denied = true, writes = 0;
  const vault = { get: ref => memory.get(ref), remove: ref => memory.remove(ref), set(ref, key) { writes++; if (denied) throw new Error(`${reason} ${fakeKey}`); memory.set(ref, key); } };
  const store = new WorkspaceSecureConnections(resource, vault), value = store.list();
  assert.equal(value.readOnly, true); assert.equal(value.migrationPending, true); assert.equal(value.recovered, false); assert.deepEqual(value.connections, []); assert.equal(value.defaultConnectionId, null);
  assert.equal(JSON.stringify(value).includes(fakeKey), false); assert.equal(fs.readFileSync(path(resource)).equals(before), true); assert.equal(fs.existsSync(path(resource, true)), false);
  store.list(); assert.equal(writes, 1, "normal snapshot reads must not re-prompt a blocked migration");
  assert.throws(() => store.add(input(), value.revision)); assert.throws(() => store.select("missing", value.revision)); assert.throws(() => store.capture()); assert.equal(writes, 1);
  denied = false; const migrated = store.retryMigration(value.revision);
  assert.equal(migrated.readOnly, false); assert.equal(migrated.migrationPending, false); assert.equal(migrated.connections.length, 1);
  assert.equal(store.resolve(store.capture()).apiKey === fakeKey, true); assert.equal(fs.readFileSync(path(resource), "utf8").includes(fakeKey), false);
  store.list(); assert.equal(writes, 2);
});

test("invalid later v2 rows are validated before any migration credential side effects", () => {
  const resource = storage(), old = new WorkspaceConnectionStoreV2(resource); old.add(input("One"), 0); old.add(input("Two"), 1);
  const document = JSON.parse(fs.readFileSync(path(resource))); document.connections[1].status = "invalid"; fs.writeFileSync(path(resource), JSON.stringify(document));
  let writes = 0; const store = new WorkspaceSecureConnections(resource, { get() {}, remove() {}, set() { writes++; } });
  assert.throws(() => store.list(), /damaged/); assert.equal(writes, 0); assert.equal(fs.existsSync(path(resource, true)), false);
});
test("blocked migration does not silently select an older backup or duplicate partially stored credentials", () => {
  const resource = storage(), old = new WorkspaceConnectionStoreV2(resource); old.add(input("One"), 0); old.add(input("Two"), 1);
  const legacy = fs.readFileSync(path(resource)), memory = new MemoryCredentialVault();
  new WorkspaceSecureConnections(resource, memory).list(); const backup = fs.readFileSync(path(resource, true)); fs.writeFileSync(path(resource), legacy);
  let fail = true, writes = 0; const refs = new Set();
  const vault = { get: ref => memory.get(ref), remove: ref => memory.remove(ref), set(ref, key) { writes++; refs.add(ref); if (fail && writes === 2) throw new Error("fixture timeout"); memory.set(ref, key); } };
  const store = new WorkspaceSecureConnections(resource, vault), pending = store.list();
  assert.equal(pending.migrationPending, true); assert.equal(pending.recovered, false); assert.deepEqual(pending.connections, []);
  assert.equal(fs.readFileSync(path(resource)).equals(legacy), true); assert.equal(fs.readFileSync(path(resource, true)).equals(backup), true);
  store.list(); assert.equal(writes, 2); fail = false; assert.equal(store.retryMigration(pending.revision).connections.length, 2); assert.equal(refs.size, 2); assert.equal(writes, 4);
});

test("missing connection primary recovers its only good backup read-only without replacing it", () => {
  const resource = storage(), vault = new MemoryCredentialVault(), store = new WorkspaceSecureConnections(resource, vault);
  store.add(input(), 0); const before = fs.readFileSync(path(resource, true)); fs.unlinkSync(path(resource));
  const reopened = new WorkspaceSecureConnections(resource, vault), value = reopened.list();
  assert.equal(value.recovered, true); assert.equal(value.readOnly, true); assert.equal(value.connections.length, 1);
  assert.throws(() => reopened.add(input("New"), value.revision)); assert.throws(() => reopened.select(value.connections[0].id, value.revision));
  assert.equal(fs.existsSync(path(resource)), false); assert.equal(fs.readFileSync(path(resource, true)).equals(before), true);
});

test("missing appearance primary preserves stable theme from backup instead of initializing system", () => {
  const home = dir(), prefs = new WorkspacePreferences(home); prefs.save("dark", 0);
  const primary = join(home, ".hara/ui-preferences-v1.json"), backup = join(home, ".hara/ui-preferences-v1-backup.json"), before = fs.readFileSync(backup);
  fs.unlinkSync(primary); const reopened = new WorkspacePreferences(home), value = reopened.read();
  assert.equal(value.theme, "dark"); assert.equal(value.recovered, true); assert.equal(value.readOnly, true); assert.throws(() => reopened.save("light", value.revision));
  assert.equal(fs.existsSync(primary), false); assert.equal(fs.readFileSync(backup).equals(before), true);
});

test("a missing primary with damaged backup is not a fresh store and cannot erase the recovery file", () => {
  const home = dir(), prefs = new WorkspacePreferences(home); prefs.save("dark", 0);
  const primary = join(home, ".hara/ui-preferences-v1.json"), backup = join(home, ".hara/ui-preferences-v1-backup.json"); fs.unlinkSync(primary); fs.writeFileSync(backup, "fixture damaged backup");
  assert.throws(() => prefs.read(), /damaged/); assert.throws(() => prefs.save("light", 0)); assert.equal(fs.existsSync(primary), false); assert.equal(fs.readFileSync(backup, "utf8"), "fixture damaged backup");
});
test("an older pure-schema appearance backup is projected read-only without rewriting the sole copy", () => {
  const home = dir(), prefs = new WorkspacePreferences(home); prefs.save("dark", 0);
  const primary = join(home, ".hara/ui-preferences-v1.json"), backup = join(home, ".hara/ui-preferences-v1-backup.json");
  const raw = JSON.parse(fs.readFileSync(primary)); raw.schemaVersion = 1; delete raw.migratedFrom; fs.writeFileSync(backup, JSON.stringify(raw));
  const before = fs.readFileSync(backup); fs.unlinkSync(primary); const value = new WorkspacePreferences(home).read();
  assert.equal(value.theme, "dark"); assert.equal(value.schemaVersion, 2); assert.equal(value.readOnly, true); assert.equal(value.recovered, true);
  assert.equal(fs.existsSync(primary), false); assert.equal(fs.readFileSync(backup).equals(before), true);
});
test("a sole legacy credential backup is pending/read-only and never triggers vault migration side effects", () => {
  const resource = storage(); new WorkspaceConnectionStoreV2(resource).add(input(), 0);
  const original = fs.readFileSync(path(resource)); fs.writeFileSync(path(resource, true), original, { mode: 0o600 }); fs.unlinkSync(path(resource));
  let writes = 0; const store = new WorkspaceSecureConnections(resource, { get() {}, remove() {}, set() { writes++; } }), value = store.list();
  assert.equal(value.readOnly, true); assert.equal(value.recovered, true); assert.equal(value.migrationPending, true); assert.deepEqual(value.connections, []);
  assert.throws(() => store.retryMigration(value.revision)); assert.throws(() => store.add(input("New"), value.revision)); assert.equal(writes, 0);
  assert.equal(fs.existsSync(path(resource)), false); assert.equal(fs.readFileSync(path(resource, true)).equals(original), true);
});

test("legacy preview labels fit the 80-character import contract without truncating model IDs", () => {
  const home = dir(), keychain = new MemoryCredentialVault(), resource = storage(), store = new WorkspaceSecureConnections(resource, keychain);
  const config = join(home, ".hara/config.json"); fs.mkdirSync(dirname(config), { recursive: true, mode: 0o700 });
  const model = "m".repeat(100); fs.writeFileSync(config, JSON.stringify({ ...input("旧".repeat(180)), defaultModel: model }), { mode: 0o600 });
  const original = fs.readFileSync(config), catalog = new LegacyConnectionCatalog(home, keychain), preview = catalog.list();
  assert.equal(preview.length, 1); assert.equal(preview[0].label.length, 80); assert.equal(preview[0].defaultModel, model);
  const selected = catalog.resolve(preview[0].id); store.importConnection(selected.input, 0, selected.importId);
  assert.equal(store.list().connections[0].label.length, 80); assert.equal(fs.readFileSync(config).equals(original), true);
});

test("blocked migration leaves Workspace roster/history/features available with no model construction", async () => {
  const home = dir(); let writes = 0;
  const host = new LocalWorkspaceHost(home, { mode: "workspace", credentialVault: { get() {}, remove() {}, set() { writes++; throw new Error("denied"); } }, providerFactory() { assert.fail("must not construct a provider"); } });
  try {
    const created = host.createWorkspace("Fixture", host.list().revision), id = created.workspaceId, resource = storage(host.home, host.catalog.resolve(id).scope);
    new WorkspaceConnectionStoreV2(resource).add(input(), 0);
    const conversations = new WorkspaceConversationStore(resource, created.selectedAgentId), previous = conversations.read();
    conversations.save(previous.revision, { ...previous, history: [{ role: "user", content: "Retained fixture history" }, { role: "assistant", text: "Retained reply", toolUses: [] }] });
    const before = fs.readFileSync(path(resource)), view = host.snapshot(id);
    assert.equal(view.connections.migrationPending, true); assert.equal(view.connections.readOnly, true); assert.equal(view.agents.length, 1); assert.equal(view.runtimes.options.length, 3);
    assert.equal(view.conversation.history[0].content, "Retained fixture history"); assert.equal(view.conversation.usage.modelCalls, 0); assert.equal(host.workspaceFeatures(id).workspaceId, id);
    host.snapshot(id); assert.equal(writes, 1); assert.equal(fs.readFileSync(path(resource)).equals(before), true);
  } finally { await host.close(); }
});

test("unreadable connection JSON affects only connection settings, not the whole Workspace snapshot", async () => {
  const host = new LocalWorkspaceHost(dir(), { mode: "workspace", credentialVault: new MemoryCredentialVault(), providerFactory() { assert.fail("no provider"); } });
  try {
    const created = host.createWorkspace("Fixture", host.list().revision), resource = storage(host.home, host.catalog.resolve(created.workspaceId).scope);
    fs.writeFileSync(path(resource), "fixture damaged JSON", { mode: 0o600 });
    const view = host.snapshot(created.workspaceId); assert.equal(view.workspaceId, created.workspaceId); assert.equal(view.agents.length, 1);
    assert.equal(view.connections.readOnly, true); assert.equal(view.connections.unavailable, true); assert.equal(view.connections.defaultConnectionId, null); assert.deepEqual(view.connections.connections, []);
    assert.equal(fs.readFileSync(path(resource), "utf8"), "fixture damaged JSON"); assert.equal(view.conversation.usage.modelCalls, 0);
  } finally { await host.close(); }
});
test("formal RPC stays available during blocked migration; retries require auth, current generation and confirmation", async () => {
  const root = dir(), memory = new MemoryCredentialVault(); let denied = true, writes = 0;
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root, mode: "workspace", version: "fixture",
    credentialVault: { get: ref => memory.get(ref), remove: ref => memory.remove(ref), set(ref, key) { writes++; if (denied) throw new Error("fixture denied"); memory.set(ref, key); } },
    providerFactory() { assert.fail("no model may be constructed"); } });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); let serial = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("fixture RPC deadline")); }, 5000);
    function onMessage(raw) { const value = JSON.parse(String(raw)); if (value.id !== id) return; clearTimeout(timer); socket.off("message", onMessage); value.error ? reject(new Error(value.error.message)) : resolve(value.result); }
    socket.on("message", onMessage); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  try {
    await once(socket, "open"); await assert.rejects(request("workspace.snapshot", { workspaceId: "none", agentId: "none" }), /unauthorized/);
    const init = await request("initialize", { token: handle.token }); const created = await request("workspace.create", { label: "Fixture", expectedRevision: init.workspace.revision });
    const catalog = new LocalWorkspaceCatalog(join(root, "home")), resource = storage(join(root, "home"), catalog.resolve(created.workspaceId).scope);
    new WorkspaceConnectionStoreV2(resource).add(input(), 0);
    const selection = { workspaceId: created.workspaceId, agentId: created.selectedAgentId }, pending = await request("workspace.snapshot", selection);
    assert.equal(pending.connections.migrationPending, true); assert.equal(pending.agents.length, 1); assert.equal(writes, 1);
    const retry = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration, expectedRevision: pending.connections.revision, approved: true };
    await assert.rejects(request("workspace.connection.migration.retry", { ...retry, approved: false }), /approval/);
    await assert.rejects(request("workspace.connection.migration.retry", { ...retry, expectedGeneration: "stale" }), /generation/);
    await assert.rejects(request("workspace.connection.migration.retry", { ...retry, apiKey: "not-used" }), /unsupported/); assert.equal(writes, 1);
    denied = false; const migrated = await request("workspace.connection.migration.retry", retry); assert.equal(migrated.migrationPending, false); assert.equal(migrated.connections.length, 1);
    const view = await request("workspace.snapshot", selection); assert.equal(view.connections.readOnly, false); assert.equal(view.conversation.usage.modelCalls, 0);
    assert.equal(JSON.stringify(view).includes(fakeKey), false); assert.equal(writes, 2);
  } finally { socket.terminate(); await handle.close(); }
});
