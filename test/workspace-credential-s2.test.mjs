import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { CredentialVaultError } from "../dist/workspace/credential-vault.js";
import { createHostCredentialStorage, QueuedCredentialVault } from "../dist/workspace/credential-vault-host.js";
import { AsyncWindowsDpapiCredentialVault } from "../dist/workspace/windows-credential-vault.js";
import { CREDENTIAL_INTENTS_FILE } from "../dist/workspace/credential-write-intents.js";
import { WorkspaceSecureConnections } from "../dist/workspace/secure-connections.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";

const keyA = "fake-s2-key-A", keyB = "fake-s2-key-B", keyC = "fake-s2-key-C";
const input = (apiKey, label = "Fixture") => ({
  label, provider: "openai", baseURL: "https://example.invalid/v1", defaultModel: "fixture-model", apiKey,
});
function directory(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-vault-s2-")));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return root;
}
function resource(t) {
  const home = directory(t), storage = new WorkspaceResourceStorage(home, {
    schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() },
  });
  storage.initialize();
  return { home, storage, journal: storage.run(() => join(workspaceStateHome(), ".hara", CREDENTIAL_INTENTS_FILE)) };
}
function fake() {
  const values = new Map(), writes = [], removals = [];
  const vault = {
    async get(ref) { return values.get(ref); },
    async set(ref, key) { assert.equal(values.has(ref), false, "a fresh ref may never overwrite an existing value"); writes.push(ref); values.set(ref, key); },
    async setMany(entries, call) { for (const { ref, key } of entries) await this.set(ref, key, call); },
    async remove(ref) { removals.push(ref); values.delete(ref); },
  };
  return { vault, values, writes, removals };
}

test("Host factory chooses the async Windows backend and starts with a side effect free snapshot", async t => {
  const home = directory(t), backend = fake();
  let factories = 0, reads = 0;
  const binding = createHostCredentialStorage({ home, hostPlatform: "win32", arch: "x64", windows: supplied => {
    assert.equal(supplied, home); factories++;
    return { ...backend.vault, async get() { reads++; return undefined; } };
  } });
  t.after(() => binding.vault.close());
  assert.equal(factories, 1);
  assert.deepEqual(binding.descriptor(), { schemaVersion: 1, hostPlatform: "win32", arch: "x64", backend: "windows-dpapi", supported: true, state: "not_checked", reason: null });
  const copy = binding.descriptor(); copy.state = "ready";
  assert.equal(binding.descriptor().state, "not_checked");
  assert.equal(reads, 0);
  await binding.vault.get("fixture", {});
  assert.equal(reads, 1);
  assert.equal(binding.descriptor().state, "ready");
});

for (const [platform, arch, reason] of [
  ["linux", "x64", "platform_unsupported"],
  ["win32", "arm64", "architecture_unsupported"],
]) test("Host reports unsupported on " + platform + "/" + arch + " without creating a backend", async t => {
  const selected = createHostCredentialStorage({ home: directory(t), hostPlatform: platform, arch, windows: () => assert.fail("unexpected Windows factory") });
  t.after(() => selected.vault.close());
  assert.deepEqual(selected.descriptor(), { schemaVersion: 1, hostPlatform: platform, arch, backend: "none", supported: false, state: "unsupported", reason });
  await assert.rejects(selected.vault.set("fixture", keyA), error => error.code === "unsupported" && error.retry === "none" && !error.message.includes(keyA));
});

test("namespace queue serializes get, set, setMany and remove, and drops an expired waiter", async t => {
  const first = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
  const queue = new QueuedCredentialVault({
    async get(ref) { calls.push("get:" + ref); first.resolve(); await release.promise; return keyA; },
    async set(ref) { calls.push("set:" + ref); },
    async setMany(entries) { calls.push("batch:" + entries[0].ref); },
    async remove(ref) { calls.push("remove:" + ref); },
  });
  t.after(() => queue.close());
  const read = queue.get("first"); await first.promise;
  const controller = new AbortController();
  const expired = assert.rejects(queue.set("expired", keyA, { signal: controller.signal }), error => error.code === "unavailable");
  const set = queue.set("new", keyA), batch = queue.setMany([{ ref: "batch", key: keyB }]), remove = queue.remove("original");
  controller.abort(); await expired;
  assert.deepEqual(calls, ["get:first"]);
  release.resolve(); assert.equal(await read, keyA);
  await Promise.all([set, batch, remove]);
  assert.deepEqual(calls, ["get:first", "set:new", "batch:batch", "remove:original"]);
});

test("an uncertain reply leaves its lane occupied until the worker is drained", async t => {
  const drained = Promise.withResolvers();
  const calls = [];
  const queue = new QueuedCredentialVault({
    async set(_ref, _key, call) {
      call.retainUntilDrained(drained.promise);
      throw new CredentialVaultError("write_unconfirmed");
    },
    async get() { calls.push("started after drain"); },
  });
  t.after(() => queue.close());
  await assert.rejects(queue.set("first", keyA), error => error.code === "write_unconfirmed");
  const next = queue.get("second");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  drained.resolve(); await next;
  assert.deepEqual(calls, ["started after drain"]);
});

test("waited write intent precedes IO, and a stale save cleans only its own unpublished generation", async t => {
  const f = resource(t), backend = fake(), a = new WorkspaceSecureConnections(f.storage, backend.vault);
  const published = await a.add(input(keyA), 0);
  const before = a.capture();
  const start = Promise.withResolvers(), release = Promise.withResolvers();
  const slower = new WorkspaceSecureConnections(f.storage, { ...backend.vault, async set(ref, key) {
    const text = fs.readFileSync(f.journal, "utf8");
    const saved = JSON.parse(text).intents.find(intent => intent.refs.includes(ref));
    assert.equal(saved.state, "pending"); assert.equal(saved.ownerPid, process.pid);
    assert.equal(text.includes(key), false);
    await backend.vault.set(ref, key);
    start.resolve(ref);
    await release.promise;
  } });
  const refused = assert.rejects(slower.edit(published.id, input(keyB, "Stale"), a.list().revision), /Settings changed/);
  const staleRef = await start.promise;
  assert.equal((await a.resolve(before)).apiKey, keyA);
  await a.edit(published.id, input(keyC, "Published"), a.list().revision);
  const winner = a.inheritanceMetadata()[0].keyRef;
  assert.notEqual(staleRef, winner);
  release.resolve(); await refused;
  assert.equal(backend.values.get(winner), keyC);
  assert.equal(backend.values.has(staleRef), false);
  assert.equal(a.list().connections[0].label, "Published");
  assert.equal(a.list().cleanupPending, false);
  assert.equal(backend.removals.includes(winner), false);
});

test("reopen marks a dead owner's orphan and keeps it while its recorded worker is live", async t => {
  const f = resource(t), backend = fake();
  const store = new WorkspaceSecureConnections(f.storage, backend.vault), published = await store.add(input(keyA), 0);
  const ref = store.inheritanceMetadata()[0].keyRef;
  const orphan = f.storage.scopeKey + ":mc_" + randomUUID() + ":gen_" + randomUUID();
  const intent = JSON.parse(fs.readFileSync(f.journal, "utf8"));
  const candidatePid = 2_147_483_600;
  assert.throws(() => process.kill(candidatePid, 0), { code: "ESRCH" });
  intent.intents = [{ id: randomUUID(), refs: [orphan], ownerPid: candidatePid, workerPid: process.pid, state: "pending", writeSettled: false }];
  fs.writeFileSync(f.journal, JSON.stringify(intent));
  backend.values.set(orphan, keyB);
  const reopened = new WorkspaceSecureConnections(f.storage, backend.vault);
  reopened.intents.reconcile();
  assert.equal(reopened.list().cleanupPending, true);
  assert.equal(JSON.parse(fs.readFileSync(f.journal, "utf8")).intents[0].state, "cleanupPending");
  assert.deepEqual(backend.removals, []);
  await assert.rejects(reopened.cleanupCredentials(undefined, reopened.list().revision), error => error.code === "cleanup_unconfirmed");
  assert.equal(backend.values.get(ref), keyA);
  const idle = JSON.parse(fs.readFileSync(f.journal, "utf8"));
  idle.intents[0].workerPid = candidatePid;
  fs.writeFileSync(f.journal, JSON.stringify(idle));
  await reopened.cleanupCredentials(undefined, reopened.list().revision);
  assert.deepEqual(backend.removals, [orphan]);
  assert.equal((await reopened.resolve(reopened.capture(published.id))).apiKey, keyA);
  assert.equal(reopened.list().cleanupPending, false);
});

test("recovery of a write interrupted after metadata commit preserves the referenced generation", async t => {
  const f = resource(t), backend = fake(), store = new WorkspaceSecureConnections(f.storage, backend.vault);
  await store.add(input(keyA), 0);
  const ref = store.inheritanceMetadata()[0].keyRef;
  const intent = JSON.parse(fs.readFileSync(f.journal, "utf8"));
  intent.intents = [{ id: randomUUID(), refs: [ref], ownerPid: process.pid, workerPid: null, state: "pending", writeSettled: false }];
  fs.writeFileSync(f.journal, JSON.stringify(intent));
  await store.cleanupCredentials(undefined, store.list().revision);
  assert.deepEqual(backend.removals, []);
  assert.equal((await store.resolve(store.capture())).apiKey, keyA);
  assert.equal(store.list().cleanupPending, false);
});

test("a resolve that overlapped rotation cannot use the original readback or silently select the new key", async t => {
  const f = resource(t), backend = fake(), store = new WorkspaceSecureConnections(f.storage, backend.vault);
  const row = await store.add(input(keyA), 0), binding = store.capture(row.id);
  const got = Promise.withResolvers(), release = Promise.withResolvers();
  const reader = new WorkspaceSecureConnections(f.storage, { ...backend.vault, async get(ref) {
    const key = await backend.vault.get(ref); got.resolve(); await release.promise; return key;
  } });
  assert.equal(reader.providerForBinding(binding), "openai");
  const blocked = assert.rejects(reader.resolve(binding), /generation unavailable/);
  await got.promise; await store.edit(row.id, input(keyB), store.list().revision);
  release.resolve(); await blocked;
  assert.throws(() => reader.providerForBinding(binding), /generation unavailable/);
  assert.equal((await store.resolve(store.capture())).apiKey, keyB);
});

test("Host refuses provider admission when the resource fence fails during vault read", async t => {
  const root = directory(t), got = Promise.withResolvers(), release = Promise.withResolvers(), backend = fake();
  let started = 0;
  const host = new LocalWorkspaceHost(root, { mode: "workspace",
    asyncCredentialVault: { ...backend.vault, async get(ref) { got.resolve(); await release.promise; return backend.values.get(ref); } },
    providerFactory() { started++; throw new Error("no provider permitted"); },
  });
  t.after(() => host.close());
  const w = host.createWorkspace("Fixture", host.list().revision);
  await host.configureConnection(w.workspaceId, input(keyA), 0);
  let authenticated = true;
  const attempt = assert.rejects(host.start("fixture", w.workspaceId, w.selectedAgentId, "Synthetic", randomUUID(), false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => {
      if (!authenticated) throw new Error("transport revoked");
    }), /transport revoked/);
  await got.promise; authenticated = false; release.resolve(); await attempt;
  assert.equal(started, 0);
});

test("RPC strictly negotiates a metadata-only credential descriptor and preserves the numeric error shell", async t => {
  const root = directory(t), keyCalls = [];
  const descriptor = { schemaVersion: 1, hostPlatform: "win32", arch: "x64", backend: "windows-dpapi", supported: true, state: "not_checked", reason: null };
  const fail = async () => { keyCalls.push("attempt"); throw new CredentialVaultError("access_denied", "access_denied", true); };
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, {
    root, mode: "workspace", version: "fixture", credentialStorageDescriptor: descriptor,
    asyncCredentialVault: { get: fail, set: fail, setMany: fail, remove: fail },
  });
  const ws = new WebSocket("ws://127.0.0.1:" + handle.port);
  t.after(async () => { ws.terminate(); await handle.close(); });
  await once(ws, "open");
  let sequence = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const onMessage = data => {
      const response = JSON.parse(data.toString());
      if (response.id !== id) return;
      clearTimeout(timer); ws.off("message", onMessage); resolve(response);
    };
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error("RPC fixture failed to reply")); }, 3000);
    ws.on("message", onMessage); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  assert.equal((await rpc("workspace.credentialStorage.get", {})).error.code, -32001);
  const initialized = (await rpc("initialize", { token: handle.token })).result;
  assert.ok(initialized.capabilities.includes("workspace.credential-storage.v1"));
  assert.deepEqual(initialized.credentialStorage, descriptor);
  assert.deepEqual((await rpc("workspace.credentialStorage.get", {})).result, descriptor);
  assert.equal((await rpc("workspace.credentialStorage.get", { backend: "memory" })).error.code, -32602);
  assert.deepEqual(keyCalls, []);
  const w = (await rpc("workspace.create", { label: "Fixture", expectedRevision: initialized.workspace.revision })).result;
  const result = await rpc("workspace.connection.add", { workspaceId: w.workspaceId, expectedGeneration: w.resourceGeneration,
    expectedRevision: 0, input: input(keyA) });
  assert.equal(result.error.code, -32602);
  assert.equal(result.error.data.domain, "credential-vault");
  assert.equal(result.error.data.code, "access_denied");
  assert.equal(result.error.data.retry, "explicit_user_only");
  assert.equal(JSON.stringify(result).includes(keyA), false);
  assert.deepEqual(keyCalls, ["attempt"]);
  assert.equal((await rpc("workspace.credentialStorage.get", {})).result.reason, "access_denied");
});

// Exercise the real async framing and child-process close path with a local executable
// that returns only synthetic protocol frames. The separate Windows canary uses DPAPI itself.
function fakeWorker(t, responseStatuses, successDelayMs = 0) {
  const home = directory(t), helper = join(home, "hara-credential-worker.exe"), counter = helper + ".calls";
  const script = "#!" + process.execPath + "\n" + [
    'const fs = require("node:fs");',
    'const path = process.argv[1] + ".calls";',
    'const calls = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) + 1 : 1;',
    'fs.writeFileSync(path, String(calls));',
    'const frame = fs.readFileSync(0);',
    'if (frame.toString("ascii", 4, 8) !== "HVQ2" || frame[8] !== 2) process.exit(65);',
    'const reply = Buffer.alloc(27); reply.writeUInt32LE(23); reply.write("HVR2", 4);',
    'frame.copy(reply, 8, 9, 25); frame.fill(0);',
    'const status = ' + JSON.stringify(responseStatuses) + '[calls - 1];',
    'if (status === undefined) process.exit(65);',
    'reply[24] = status;',
    'if (status === 0) setTimeout(() => process.stdout.write(reply), ' + successDelayMs + ');',
    'else process.stdout.write(reply);',
    '// ' + 'f'.repeat(1024),
  ].join("\n") + "\n";
  fs.writeFileSync(helper, script, { mode: 0o700 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform"), arch = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    Object.defineProperty(process, "arch", { ...arch, value: "x64" });
    const vault = new AsyncWindowsDpapiCredentialVault(home, { path: helper, sha256: createHash("sha256").update(script).digest("hex"), protocolVersion: 2 });
    return { vault, calls: () => Number(fs.readFileSync(counter, "utf8")) };
  } finally {
    Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch);
  }
}

test("async Windows framing retries only confirmed failure before store.lock", { skip: process.platform === "win32" }, async t => {
  const busy = fakeWorker(t, [7, 7, 0]);
  const children = [];
  await busy.vault.set("fixture:connection:gen", keyA, { recordWorker(pid) { assert.ok(pid > 0); children.push(pid); } });
  assert.equal(busy.calls(), 3);
  assert.equal(new Set(children).size, 3);
  for (const [status, code] of [[2, "unavailable"], [5, "write_unconfirmed"]]) {
    const failed = fakeWorker(t, [status]);
    await assert.rejects(failed.vault.set("fixture:connection:gen", keyA), error => error.code === code);
    assert.equal(failed.calls(), 1);
  }
});

test("async Windows retry allows a successful write to finish beyond the backoff window", { skip: process.platform === "win32" }, async t => {
  const worker = fakeWorker(t, [7, 0], 1250);
  await worker.vault.set("fixture:connection:gen", keyA);
  assert.equal(worker.calls(), 2);
});
