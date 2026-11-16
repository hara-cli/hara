import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MacKeychainCredentialVault, WORKSPACE_CREDENTIAL_SERVICE } from "../dist/workspace/credential-vault.js";
import { LegacyConnectionCatalog } from "../dist/workspace/legacy-connections.js";
import { WorkspaceSecureConnections } from "../dist/workspace/secure-connections.js";
import { WorkspaceLegacyConnectionImport } from "../dist/workspace/legacy-connection-import.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { withProcessPlatform } from "./helpers/process-platform.mjs";

const victimScope = "a".repeat(64), ambiguous = `vault.${victimScope}`;
const originalRef = "vault.original:connection:g1", fakeKey = "synthetic-account-collision-key";
const connection = { provider: "openai", baseURL: "https://fixture.invalid/v1", model: "fixture-model" };
const actions = {
  get: (vault, ref) => vault.get(ref),
  set: (vault, ref) => vault.set(ref, fakeKey),
  setMany: (vault, ref) => vault.setMany([{ ref, key: fakeKey }]),
  remove: (vault, ref) => vault.remove(ref),
};
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-vault-account-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const home = join(base, "vault-home"), source = join(base, "source"), target = join(base, "target");
  for (const directory of [source, target]) fs.mkdirSync(directory, { mode: 0o700 });
  const victim = JSON.stringify({ schemaVersion: 1, values: { [`${victimScope}:connection:g1`]: fakeKey } });
  const items = new Map([[ambiguous, victim]]), calls = [];
  const execute = (command, args, options) => {
    assert.equal(command, "/usr/bin/security");
    calls.push({ args: [...args] });
    if (args[0] === "-i") {
      const match = /^add-generic-password -U -s ([\w.:-]+) -a ([\w.:-]+) -w (.*)\n$/.exec(options.input);
      assert.ok(match); assert.equal(match[1], WORKSPACE_CREDENTIAL_SERVICE);
      const payload = JSON.parse(match[3]); assert.equal(typeof payload, "string");
      items.set(match[2], payload); return { status: 0 };
    }
    assert.equal(args[args.indexOf("-s") + 1], WORKSPACE_CREDENTIAL_SERVICE);
    const account = args[args.indexOf("-a") + 1];
    if (args[0] === "find-generic-password") return items.has(account) ? { status: 0, stdout: items.get(account) + "\n" } : { status: 44 };
    assert.equal(args[0], "delete-generic-password"); return { status: items.delete(account) ? 0 : 44 };
  };
  const native = new MacKeychainCredentialVault(home, execute);
  // Model only the Mac implementation at each synchronous vault boundary, including async callers.
  // Every command remains in execute's Map; no OS Keychain process or real home is used.
  const vault = Object.fromEntries(Object.keys(actions).map(name => [name, (...args) => withProcessPlatform("darwin", () => native[name](...args))]));
  const write = (relative, value) => {
    const path = join(source, relative); fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path;
  };
  const storage = () => {
    const state = new WorkspaceResourceStorage(target, { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`,
      authority: { kind: "local", localAuthorityId: randomUUID() } }); state.initialize(); return state;
  };
  const host = (legacy, credentialVault = vault) => new LocalWorkspaceHost(target, { mode: "workspace", hostHome: source,
    ...(legacy ? { legacySourceHome: source } : {}), credentialVault,
    providerFactory() { assert.fail("This regression must not invoke a model"); } });
  return { base, home, source, target, items, calls, vault, write, storage, host, victim };
}
const snapshot = items => [...items.entries()];
const unchanged = (f, before) => assert.deepEqual(snapshot(f.items), before);

for (const [name, action] of Object.entries(actions)) {
  test(`Mac vault ${name} rejects a bare vault account before item or lock IO`, t => {
    const f = fixture(t), before = snapshot(f.items);
    for (const ref of [ambiguous, "vault.scope", "vault.", "vault.vault.scope"]) {
      assert.throws(() => action(f.vault, ref), { message: "Invalid credential reference" });
      assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.home), false); unchanged(f, before);
    }
  });
}
test("Mac vault validates an entire batch before any item or lock IO", t => {
  const f = fixture(t), before = snapshot(f.items), good = { ref: `${ambiguous}:connection:g1`, key: fakeKey }, bad = { ref: ambiguous, key: fakeKey };
  for (const entries of [[bad, good], [good, bad], [good, bad, { ...good, ref: `${ambiguous}:other:g2` }]]) {
    assert.throws(() => f.vault.setMany(entries), { message: "Invalid credential reference" });
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.home), false); unchanged(f, before);
  }
});
for (const [name, action] of Object.entries(actions)) {
  test(`Mac vault ${name} preserves an existing group containing an ambiguous member`, t => {
    const f = fixture(t), qualified = `${ambiguous}:connection:g1`; fs.mkdirSync(f.home, { mode: 0o700 });
    f.items.set(`vault.${ambiguous}`, JSON.stringify({ schemaVersion: 1, values: { [qualified]: fakeKey, [ambiguous]: "synthetic-old-member" } }));
    const before = snapshot(f.items);
    assert.throws(() => action(f.vault, qualified), { message: "OS credential record unavailable; original settings preserved" });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args[0], "find-generic-password"); unchanged(f, before);
  });
}
test("Mac vault keeps qualified vault.* refs separate and preserves ordinary legacy credentials", t => {
  const f = fixture(t), qualified = `${ambiguous}:connection:g1`, sibling = `${ambiguous}:other:g2`;
  fs.mkdirSync(f.home, { mode: 0o700 });
  f.vault.setMany([{ ref: qualified, key: fakeKey }, { ref: sibling, key: "synthetic-sibling" }]);
  assert.equal(f.vault.get(qualified), fakeKey); f.vault.remove(qualified);
  assert.equal(f.vault.get(sibling), "synthetic-sibling"); assert.equal(f.vault.get(qualified), undefined);
  assert.equal(f.items.get(ambiguous), f.victim);
  f.items.set("ordinary-legacy", fakeKey);
  assert.equal(f.vault.get("ordinary-legacy"), fakeKey); f.vault.remove("ordinary-legacy");
  assert.equal(f.items.has("ordinary-legacy"), false); assert.equal(f.items.get(ambiguous), f.victim);
});

const legacySources = {
  personal: f => f.write(".hara/config.json", { ...connection, keyRef: ambiguous }),
  profile: f => f.write(".hara/profiles.json", { active: "old", profiles: [{ ...connection, id: "old", keyRef: ambiguous }] }),
  overlay: f => f.write(".hara/config.json", { ...connection, overlays: { old: { keyRef: ambiguous, label: "Old overlay" } } }),
  scoped: f => f.write(`.hara/workspaces-v1/home/.hara/workspace-data/v1/${"b".repeat(64)}/state/.hara/workspace-connections-v2.json`,
    { connections: [{ ...connection, id: "old", status: "active", keyRef: ambiguous }] }),
};
for (const [name, createSource] of Object.entries(legacySources)) {
  test(`legacy ${name} source cannot return another group as an API Key`, t => {
    const f = fixture(t), file = createSource(f), bytes = fs.readFileSync(file), before = snapshot(f.items);
    const catalog = new LegacyConnectionCatalog(f.source, f.vault), candidates = catalog.list().filter(row => row.keySaved);
    assert.equal(candidates.length, 1); assert.equal(f.calls.length, 0);
    assert.throws(() => catalog.resolve(candidates[0].id), { message: "Old credential unavailable; original preserved" });
    assert.equal(f.calls.length, 0); unchanged(f, before); assert.deepEqual(fs.readFileSync(file), bytes);
  });
}
test("Host confirmed old-connection import refuses the ambiguous credential without changing connections", async t => {
  const f = fixture(t), host = f.host(false);
  try {
    const created = host.createWorkspace("Fixture", host.list().revision);
    const file = legacySources.personal(f), bytes = fs.readFileSync(file), before = snapshot(f.items), state = host.snapshot(created.workspaceId).connections;
    const [source] = host.legacyConnections(created.workspaceId); assert.ok(source?.keySaved);
    assert.throws(() => host.importConnection(created.workspaceId, source.id, state.revision, true), { message: "Old credential unavailable; original preserved" });
    assert.deepEqual(host.snapshot(created.workspaceId).connections, state); assert.equal(f.calls.length, 0);
    unchanged(f, before); assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { await host.close(); }
});
test("Host old-connection migration retry stays pending without reading or copying an ambiguous credential", async t => {
  const f = fixture(t), file = legacySources.personal(f), bytes = fs.readFileSync(file), before = snapshot(f.items), host = f.host(false);
  try {
    const created = host.createWorkspace("Fixture", host.list().revision), state = created.connections;
    assert.equal(state.migrationPending, true); assert.equal(f.calls.length, 0);
    assert.throws(() => host.retryConnectionMigration(created.workspaceId, state.revision, true), { message: "Old credential unavailable; original preserved" });
    assert.deepEqual(host.snapshot(created.workspaceId).connections, state); assert.equal(f.calls.length, 0);
    unchanged(f, before); assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { await host.close(); }
});
test("Host startup inheritance remains pending and preserves the source and victim group", async t => {
  const f = fixture(t), file = legacySources.personal(f), bytes = fs.readFileSync(file), before = snapshot(f.items), host = f.host(true);
  try {
    const result = await host.initialize(); assert.equal(result.state, "pending"); assert.equal(result.reason, "legacy_inheritance_requires_review");
    assert.equal(f.calls.length, 0); unchanged(f, before); assert.deepEqual(fs.readFileSync(file), bytes);
    const [workspace] = host.list().workspaces;
    assert.equal(host.snapshot(workspace.workspaceId).connections.connections.some(row => row.keySaved), false);
  } finally { await host.close(); }
});
function originalSource(f) {
  fs.mkdirSync(f.home, { mode: 0o700 });
  f.vault.set(originalRef, fakeKey);
  const file = f.write(".hara/config.json", { ...connection, keyRef: originalRef });
  return { file, bytes: fs.readFileSync(file), items: snapshot(f.items), catalog: new LegacyConnectionCatalog(f.source, f.vault) };
}
test("secure cleanup deletes only its generated ref and retains the original legacy source", t => {
  const f = fixture(t), original = originalSource(f), storage = f.storage(), store = new WorkspaceSecureConnections(storage, f.vault);
  const [source] = original.catalog.personalSeeds(), resolved = original.catalog.resolve(source.id), added = store.importConnection(resolved.input, 0, resolved.importId);
  f.calls.length = 0; store.revoke(added.id, store.list().revision);
  const deletes = f.calls.filter(call => call.args[0] === "delete-generic-password"); assert.equal(deletes.length, 1);
  assert.equal(deletes.every(call => call.args[call.args.indexOf("-a") + 1].startsWith(`${storage.scopeKey}:`)), true);
  assert.equal(f.vault.get(originalRef), fakeKey); assert.equal(f.items.get(ambiguous), f.victim);
  for (const [account, value] of original.items) assert.equal(f.items.get(account), value);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes);
});
test("secure cleanup refuses a corrupted bare retired ref without touching either group", t => {
  const f = fixture(t), original = originalSource(f), storage = f.storage(), store = new WorkspaceSecureConnections(storage, f.vault);
  const added = store.add({ label: "Fixture", provider: "openai", baseURL: connection.baseURL, defaultModel: connection.model, apiKey: fakeKey }, 0);
  const file = storage.run(() => join(workspaceStateHome(), ".hara/workspace-connections-v2.json"));
  const state = JSON.parse(fs.readFileSync(file)); state.connections[0].retiredKeyRefs = [ambiguous]; fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  const before = snapshot(f.items), bytes = fs.readFileSync(file); f.calls.length = 0;
  assert.throws(() => store.cleanupCredentials(added.id, state.revision)); assert.equal(f.calls.length, 0); unchanged(f, before);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(fs.readFileSync(original.file), original.bytes);
});
test("inheritance rollback removes only generated refs and preserves original source credentials", async t => {
  const f = fixture(t), original = originalSource(f), storage = f.storage();
  const domain = new WorkspaceLegacyConnectionImport(storage, original.catalog, f.vault, "c".repeat(64));
  const applied = await domain.apply(); assert.equal(await domain.verify(applied), true);
  const refs = domain.connections.inheritanceMetadata().map(row => row.keyRef); assert.equal(refs.length, 1);
  f.calls.length = 0; await domain.rollback();
  const deletes = f.calls.filter(call => call.args[0] === "delete-generic-password"); assert.equal(deletes.length, refs.length);
  assert.equal(deletes.every(call => refs.includes(call.args[call.args.indexOf("-a") + 1])), true);
  assert.equal(f.vault.get(originalRef), fakeKey); assert.equal(f.items.get(ambiguous), f.victim);
  for (const [account, value] of original.items) assert.equal(f.items.get(account), value);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes); assert.equal(domain.connections.list().connections.length, 0);
});

// This backend deliberately has no Mac ref validation. Removing the legacy guard must fail these
// tests even while the real Mac vault boundary remains protected by the direct-entry tests above.
function unguardedVault(f) {
  const values = new Map([[ambiguous, f.victim]]), gets = [], writes = [], removes = [];
  const vault = {
    get(ref) { gets.push(ref); return values.get(ref); },
    set(ref, key) { writes.push(ref); values.set(ref, key); },
    setMany(entries) { for (const { ref, key } of entries) { writes.push(ref); values.set(ref, key); } },
    remove(ref) { removes.push(ref); values.delete(ref); },
  };
  return { vault, values, gets, writes, removes };
}
const unavailableLegacy = { message: "Old credential unavailable; original preserved" };
for (const [name, createSource] of Object.entries(legacySources)) {
  test(`legacy reader independent of Mac guard rejects the ${name} source before calling its vault`, t => {
    const f = fixture(t), backend = unguardedVault(f), file = createSource(f), bytes = fs.readFileSync(file);
    const before = snapshot(backend.values), catalog = new LegacyConnectionCatalog(f.source, backend.vault);
    const [row] = catalog.list().filter(item => item.keySaved); assert.ok(row);
    assert.throws(() => catalog.resolve(row.id), unavailableLegacy);
    assert.deepEqual(backend.gets, []); assert.deepEqual(backend.writes, []); assert.deepEqual(backend.removes, []);
    assert.deepEqual(snapshot(backend.values), before); assert.deepEqual(fs.readFileSync(file), bytes);
  });
}
test("legacy reader validates every declared keyRef before plaintext precedence or any vault call", t => {
  const f = fixture(t), backend = unguardedVault(f), catalog = new LegacyConnectionCatalog(f.source, backend.vault);
  for (const keyRef of [ambiguous, "", "bad/ref", "bad\nref", "x".repeat(241), null, 1, {}, []]) {
    const file = f.write(".hara/config.json", { ...connection, keyRef, apiKey: fakeKey }), bytes = fs.readFileSync(file);
    const [row] = catalog.list(); assert.ok(row?.keySaved);
    assert.throws(() => catalog.resolve(row.id), unavailableLegacy);
    assert.deepEqual(backend.gets, []); assert.deepEqual(backend.writes, []); assert.deepEqual(fs.readFileSync(file), bytes);
  }
});
test("legacy reader retains qualified refs, ordinary legacy refs, inline keys and keyless-source behavior", t => {
  const f = fixture(t), backend = unguardedVault(f), catalog = new LegacyConnectionCatalog(f.source, backend.vault);
  for (const keyRef of [originalRef, "ordinary-legacy", "x".repeat(240)]) {
    backend.values.set(keyRef, fakeKey); f.write(".hara/config.json", { ...connection, keyRef });
    const [row] = catalog.list(); assert.equal(catalog.resolve(row.id).input.apiKey, fakeKey); assert.equal(backend.gets.at(-1), keyRef);
  }
  const before = backend.gets.length;
  f.write(".hara/config.json", { ...connection, apiKey: fakeKey });
  assert.equal(catalog.resolve(catalog.list()[0].id).input.apiKey, fakeKey); assert.equal(backend.gets.length, before);
  f.write(".hara/config.json", connection);
  assert.throws(() => catalog.resolve(catalog.list()[0].id), unavailableLegacy); assert.equal(backend.gets.length, before);
});
async function oldEndpoint(t) {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++; response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests: () => requests };
}
async function probeOldConnection(host, workspaceId) {
  const view = host.snapshot(workspaceId); assert.ok(view.selectedAgentId);
  const id = view.connections.connections.find(row => row.status === "active")?.id ?? "mc_00000000-0000-4000-8000-000000000000";
  try { return await host.listConnectionModels(workspaceId, view.selectedAgentId, id); } catch { return null; }
}
for (const entry of ["import", "migration", "inheritance"]) for (const inline of [false, true]) {
  test(`old-endpoint ${entry} sends nothing for a bare ref with an unguarded vault${inline ? " even beside an inline key" : ""}`, async t => {
    const f = fixture(t), backend = unguardedVault(f), endpoint = await oldEndpoint(t);
    const row = { ...connection, baseURL: endpoint.baseURL, keyRef: ambiguous, ...(inline ? { apiKey: fakeKey } : {}) };
    if (entry !== "import") f.write(".hara/config.json", row);
    const host = f.host(entry === "inheritance", backend.vault), before = snapshot(backend.values);
    let workspaceId, failure, result, file;
    try {
      if (entry === "inheritance") {
        file = join(f.source, ".hara/config.json"); result = await host.initialize(); workspaceId = host.list().workspaces[0].workspaceId;
      } else {
        const created = host.createWorkspace("Fixture", host.list().revision); workspaceId = created.workspaceId;
        if (entry === "import") {
          file = f.write(".hara/config.json", row); const [source] = host.legacyConnections(workspaceId);
          try { host.importConnection(workspaceId, source.id, created.connections.revision, true); } catch (error) { failure = error; }
        } else {
          file = join(f.source, ".hara/config.json"); assert.equal(created.connections.migrationPending, true);
          try { host.retryConnectionMigration(workspaceId, created.connections.revision, true); } catch (error) { failure = error; }
        }
      }
      // Exercise the real model-list sink after the attempted operation. Without the reader guard,
      // the permissive backend enables a saved connection and this loopback endpoint sees its key.
      const probe = await probeOldConnection(host, workspaceId); assert.equal(endpoint.requests(), 0); assert.equal(probe, null);
      if (entry === "inheritance") { assert.equal(result.state, "pending"); assert.equal(result.reason, "legacy_inheritance_requires_review"); }
      else assert.equal(failure?.message, unavailableLegacy.message);
      assert.deepEqual(backend.gets, []); assert.deepEqual(backend.writes, []); assert.deepEqual(backend.removes, []);
      assert.deepEqual(snapshot(backend.values), before); assert.deepEqual(JSON.parse(fs.readFileSync(file)), row);
      assert.equal(host.snapshot(workspaceId).connections.connections.some(row => row.keySaved), false);
    } finally { await host.close(); }
  });
}
test("old-endpoint positive control accepts a qualified legacy ref and reaches only the fixture endpoint", async t => {
  const f = fixture(t), backend = unguardedVault(f), endpoint = await oldEndpoint(t), host = f.host(false, backend.vault);
  backend.values.set(originalRef, fakeKey);
  try {
    const created = host.createWorkspace("Fixture", host.list().revision);
    f.write(".hara/config.json", { ...connection, baseURL: endpoint.baseURL, keyRef: originalRef });
    const [source] = host.legacyConnections(created.workspaceId);
    host.importConnection(created.workspaceId, source.id, created.connections.revision, true);
    assert.equal((await probeOldConnection(host, created.workspaceId))?.source, "live"); assert.equal(endpoint.requests(), 1);
  } finally { await host.close(); }
});
