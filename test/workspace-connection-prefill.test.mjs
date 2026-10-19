import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault, MacKeychainCredentialVault } from "../dist/workspace/credential-vault.js";
import { LegacyConnectionCatalog } from "../dist/workspace/legacy-connections.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceSecureConnections } from "../dist/workspace/secure-connections.js";
import { withProcessPlatform } from "./helpers/process-platform.mjs";

const roots = [], secret = "fixture-only-prefill-credential";
const directory = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-prefill-"))); roots.push(root); return root; };
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const row = (id, label = id) => ({ id, label, provider: "openai", baseURL: "https://example.invalid/v1", model: "fixture-model", apiKey: secret });
function fixture() {
  const root = directory(), home = directory(), file = join(home, ".hara/profiles.json"); fs.mkdirSync(dirname(file), { mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ active: "two", profiles: [row("one", "  "), row("two", "Two\u0000\u001f")] }), { mode: 0o600 });
  const vault = new MemoryCredentialVault(); let batchWrites = 0, denied = false;
  const batch = vault.setMany.bind(vault); vault.setMany = entries => { batchWrites++; if (denied) throw new Error("fixture authorization denied"); batch(entries); };
  const options = { mode: "workspace", hostHome: home, credentialVault: vault, providerFactory() { assert.fail("no provider request allowed"); } };
  return { root, home, file, vault, options, writes: () => batchWrites, deny: value => { denied = value; } };
}
test("personal connection prefill is metadata-only, retains old active provider and requires one batch approval", async () => {
  const f = fixture(), before = fs.readFileSync(f.file), host = new LocalWorkspaceHost(f.root, f.options);
  try {
    const created = host.createWorkspace("Personal", host.list().revision), view = created.connections;
    assert.equal(view.connections.length, 2); assert.equal(view.migrationPending, true); assert.equal(view.readOnly, true);
    assert.equal(view.defaultConnectionId, null); assert.equal(view.connections.find(item => item.id === view.activeConnectionId).label, "Two");
    assert.equal(view.connections[0].label, "openai"); assert.equal(view.connections.every(item => !item.keySaved), true); assert.equal(f.writes(), 0);
    assert.equal(JSON.stringify(created).includes(secret), false); assert.equal(JSON.stringify(created).includes("keyRef"), false);
    assert.throws(() => host.retryConnectionMigration(created.workspaceId, view.revision, false)); assert.equal(f.writes(), 0);
    const result = host.retryConnectionMigration(created.workspaceId, view.revision, true);
    assert.equal(f.writes(), 1); assert.equal(result.migrationPending, false); assert.equal(result.defaultConnectionId, view.activeConnectionId);
    assert.equal(result.connections.every(item => item.keySaved), true); assert.equal(fs.readFileSync(f.file).equals(before), true);
    host.snapshot(created.workspaceId); assert.equal(f.writes(), 1);
    assert.throws(() => host.retryConnectionMigration(created.workspaceId, view.revision, true)); assert.equal(f.writes(), 1);
  } finally { await host.close(); }
});
test("denial remains pending through polling/restart, stale revisions cannot retry, no connection is half-enabled", async () => {
  const f = fixture(); let host = new LocalWorkspaceHost(f.root, f.options);
  const created = host.createWorkspace("Personal", host.list().revision); f.deny(true);
  assert.throws(() => host.retryConnectionMigration(created.workspaceId, created.connections.revision, true), /entire batch/);
  for (let i = 0; i < 3; i++) assert.equal(host.snapshot(created.workspaceId).connections.defaultConnectionId, null);
  assert.equal(f.writes(), 1); await host.close(); host = new LocalWorkspaceHost(f.root, f.options);
  try {
    const view = host.snapshot(created.workspaceId); assert.equal(view.connections.migrationPending, true); assert.equal(f.writes(), 1);
    assert.throws(() => host.retryConnectionMigration(created.workspaceId, view.connections.revision + 1, true)); assert.equal(f.writes(), 1);
    f.deny(false); assert.equal(host.retryConnectionMigration(created.workspaceId, view.connections.revision, true).migrationPending, false); assert.equal(f.writes(), 2);
  } finally { await host.close(); }
});
test("once marker survives removal/restart; another Workspace never receives personal keys", async () => {
  const f = fixture(); let host = new LocalWorkspaceHost(f.root, f.options);
  const one = host.createWorkspace("Personal", host.list().revision);
  host.retryConnectionMigration(one.workspaceId, one.connections.revision, true);
  let view = host.snapshot(one.workspaceId); host.revokeConnection(one.workspaceId, view.connections.activeConnectionId, view.connections.revision);
  const two = host.createWorkspace("Other", host.list().revision); assert.equal(two.connections.connections.length, 0);
  await host.close(); host = new LocalWorkspaceHost(f.root, f.options);
  try { view = host.snapshot(one.workspaceId); assert.equal(view.connections.connections.filter(item => item.status === "active").length, 1);
    assert.equal(view.connections.connections.length, 2); assert.equal(view.connections.migrationPending, false); assert.equal(f.writes(), 1);
    assert.equal(host.snapshot(two.workspaceId).connections.connections.length, 0);
  } finally { await host.close(); }
});
test("batch source drift preserves pending metadata and never writes any credential", async () => {
  const f = fixture(), host = new LocalWorkspaceHost(f.root, f.options);
  try { const one = host.createWorkspace("Personal", host.list().revision);
    fs.writeFileSync(f.file, JSON.stringify({ active: "two", profiles: [row("one"), row("two", "Changed")] }), { mode: 0o600 });
    assert.throws(() => host.retryConnectionMigration(one.workspaceId, one.connections.revision, true)); assert.equal(f.writes(), 0);
    assert.equal(host.snapshot(one.workspaceId).connections.migrationPending, true);
  } finally { await host.close(); }
});
test("labels containing controls or whitespace preview exactly as the import accepts", () => {
  const f = fixture(), catalog = new LegacyConnectionCatalog(f.home, f.vault), preview = catalog.personalSeeds();
  const storage = new WorkspaceResourceStorage(directory(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const store = new WorkspaceSecureConnections(storage, f.vault);
  for (const source of preview) { const resolved = catalog.resolve(source.id); store.importConnection(resolved.input, store.list().revision, resolved.importId); }
  assert.deepEqual(store.list().connections.map(item => item.label), ["openai", "Two"]);
  const text = storage.run(() => fs.readFileSync(join(workspaceStateHome(), ".hara/workspace-connections-v2.json"), "utf8")); assert.equal(text.includes(secret), false);
});
test("OS vault batch uses one item write, stdin-only payload, one readback, and isolated scope accounts", () => withProcessPlatform("darwin", () => {
  const entries = new Map(), calls = [];
  const execute = (_command, args, options) => {
    calls.push({ args, input: options.input });
    if (args[0] === "-i") { const match = /-a ([\w.:-]+) -w (.*)\n/.exec(options.input); entries.set(match[1], JSON.parse(match[2])); return { status: 0 }; }
    const value = entries.get(args[args.indexOf("-a") + 1]); return value === undefined ? { status: 44 } : { status: 0, stdout: value + "\n" };
  };
  const vault = new MacKeychainCredentialVault(directory(), execute);
  vault.setMany([{ ref: "scope:one:g1", key: secret }, { ref: "scope:two:g2", key: secret }]);
  assert.equal(calls.filter(call => call.args[0] === "-i").length, 1); assert.equal(calls.length, 3);
  assert.equal(calls.some(call => call.args.join(" ").includes(secret)), false); assert.equal(vault.get("scope:two:g2") === secret, true);
  assert.throws(() => vault.setMany([{ ref: "scope:one:g1", key: secret }, { ref: "other:two:g2", key: secret }]));
}));
test("observed authentication rejection marks only the frozen credential generation invalid, without probing or revealing it", () => {
  const storage = new WorkspaceResourceStorage(directory(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const store = new WorkspaceSecureConnections(storage, new MemoryCredentialVault()), input = { label: "Fixture", provider: "openai", baseURL: "https://example.invalid/v1", defaultModel: "fixture", apiKey: secret };
  const added = store.add(input, 0), binding = store.capture(); store.markCredentialInvalid(binding);
  assert.equal(store.list().defaultConnectionId, null); assert.equal(store.list().connections[0].keyState, "invalid"); assert.throws(() => store.capture());
  store.edit(added.id, { ...input, apiKey: "" }, store.list().revision); assert.equal(store.list().connections[0].keyState, "saved");
  store.markCredentialInvalid(binding); assert.equal(store.list().connections[0].keyState, "saved"); assert.equal(JSON.stringify(store.list()).includes(secret), false);
});
