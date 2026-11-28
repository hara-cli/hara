import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HaraStorageQuota } from "../dist/storage/quota.js";
import { createC0AgentHubStore, startC0AgentHubIngress } from "../dist/agent-hub/c0-adapter.js";

const agent = { agentId: "registered-idle", instanceId: "boot-idle", alias: "idle-agent", displayName: "Idle agent", engine: "codex" };
const body = (text = "display only") => ({ requestId: randomUUID(), from: agent.alias, text, attachments: [] });
async function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hub-idle-")));
  const clock = { now: Date.now() }, host = { current: true, generation: randomUUID() }, agents = new Map([[agent.agentId, { ...agent }]]);
  const quota = new HaraStorageQuota({ home, limitBytes: 64 * 1024 * 1024, now: () => clock.now });
  const options = { home, scopeKey: "a".repeat(64), generation: host.generation, globalQuota: quota,
    directory: { registeredAgent: id => agents.get(id) ?? null },
    assertCurrent() { if (!host.current || host.generation !== options.generation) throw new Error("Host fence closed"); } };
  const hub = createC0AgentHubStore(options), grant = hub.issueGrant(agent.agentId);
  const ingress = await startC0AgentHubIngress(hub);
  t.after(async () => { await ingress.close(); await quota.refreshUsage().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); });
  const send = (input = body(), token = grant.token, extra = {}) => fetch(ingress.endpoint + "/v1/agent-hub/messages", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(input), ...extra });
  return { home, clock, host, agents, quota, hub, grant, ingress, send, options };
}

test("N3: first HTTP message after six idle minutes is saved once without a retry", async t => {
  const f = await fixture(t), input = body(); f.clock.now += 6 * 60_000;
  const response = await f.send(input);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.kind, "hub-ingress-receipt"); assert.equal(receipt.status, "saved"); assert.equal(receipt.seq, 1);
  const lookup = await fetch(f.ingress.endpoint + "/v1/agent-hub/receipts", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.grant.token}` },
    body: JSON.stringify({ requestId: input.requestId }) });
  assert.equal(lookup.status, 200); assert.deepEqual(await lookup.json(), receipt);
  assert.equal(f.hub.messages(f.grant.connectionId).length, 1); assert.equal(f.hub.unread(f.grant.connectionId), 1);
});

// Pause real metadata IO, never a Store mutation or its authentication checks.
function censusGate(f, failure = false) {
  const original = fs.promises.realpath; let walks = 0, enter, release;
  const started = new Promise(resolve => { enter = resolve; }), paused = new Promise(resolve => { release = resolve; });
  fs.promises.realpath = async (path, ...args) => {
    if (String(path) === join(f.home, ".hara")) {
      walks++; enter(); assert.equal(fs.existsSync(join(f.home, ".hara", "storage-quota", "global.lock")), false);
      await paused;
      if (failure) throw new Error("private IO diagnostic must not reach the HTTP response");
    }
    return original(path, ...args);
  };
  return { started, release, get walks() { return walks; }, async restore() {
    fs.promises.realpath = original; release(); await f.quota.refreshUsage().catch(() => {});
  } };
}

test("N3: two concurrent idle HTTP messages share one real census and commit exactly once each", async t => {
  const f = await fixture(t), gate = censusGate(f); f.clock.now += 6 * 60_000;
  let prepared = 0, both; const waiting = new Promise(resolve => { both = resolve; });
  const prepare = f.hub.prepareReceive.bind(f.hub);
  f.hub.prepareReceive = (...args) => { if (++prepared === 2) both(); return prepare(...args); };
  try {
    const responses = Promise.all([f.send(body("one")), f.send(body("two"))]);
    await gate.started; await waiting; assert.equal(gate.walks, 1); gate.release();
    const replies = await responses; assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
    const receipts = await Promise.all(replies.map(reply => reply.json()));
    assert.deepEqual(receipts.map(receipt => receipt.seq).sort(), [1, 2]); assert.equal(gate.walks, 1);
    assert.equal(f.hub.messages(f.grant.connectionId).length, 2);
  } finally { await gate.restore(); }
});

for (const invalidation of ["revoke", "generation", "registered instance", "Host fence"]) {
  test(`N3: ${invalidation} during census blocks the waiting HTTP message`, async t => {
    const f = await fixture(t), gate = censusGate(f), input = body(); f.clock.now += 6 * 60_000;
    try {
      const pending = f.send(input); await gate.started;
      if (invalidation === "revoke") f.hub.revokeGrant(f.grant.connectionId);
      else if (invalidation === "generation") f.host.generation = randomUUID();
      else if (invalidation === "registered instance") f.agents.get(agent.agentId).instanceId = "different-boot";
      else f.host.current = false;
      gate.release(); const reply = await pending;
      assert.equal(reply.status, 401); assert.deepEqual(await reply.json(), { code: "unauthorized", retry: "none" });
      f.host.current = true; f.host.generation = f.options.generation;
      assert.equal(f.hub.messages(f.grant.connectionId).length, 0);
      assert.equal(fs.readdirSync(join(f.home, ".hara", "agent-hub", f.options.scopeKey)).some(name => name.startsWith("message-")), false);
    } finally { await gate.restore(); }
  });
}

for (const cancellation of ["listener close", "client disconnect"]) {
  test(`N3: ${cancellation} during census cannot publish after the wait`, async t => {
    const f = await fixture(t), gate = censusGate(f), controller = new AbortController(); f.clock.now += 6 * 60_000;
    try {
      const pending = f.send(body(), f.grant.token, { signal: controller.signal }).then(() => "response", () => "disconnected");
      await gate.started;
      if (cancellation === "listener close") await f.ingress.close(); else controller.abort();
      assert.equal(await pending, "disconnected"); gate.release(); await f.quota.refreshUsage();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.hub.messages(f.grant.connectionId).length, 0); assert.equal(f.hub.unread(f.grant.connectionId), 0);
    } finally { await gate.restore(); }
  });
}

test("N3: census IO failure is a redacted 503 with no receive or payload commit", async t => {
  const f = await fixture(t), gate = censusGate(f, true); f.clock.now += 6 * 60_000;
  let receives = 0; const receive = f.hub.receive.bind(f.hub);
  f.hub.receive = (...args) => { receives++; return receive(...args); };
  try {
    const pending = f.send(); await gate.started; gate.release(); const reply = await pending;
    assert.equal(reply.status, 503); assert.deepEqual(await reply.json(), { code: "store_unavailable", retry: "same_request_only" });
    assert.equal(receives, 0); assert.equal(f.hub.messages(f.grant.connectionId).length, 0);
  } finally { await gate.restore(); }
});

test("N3: fresh writes and unauthorized message/receipt ingress do not request a census", async t => {
  const f = await fixture(t), gate = censusGate(f);
  try {
    assert.equal((await f.send()).status, 200); assert.equal(gate.walks, 0);
    f.clock.now += 6 * 60_000;
    assert.equal((await f.send(body(), "0".repeat(64))).status, 401); assert.equal(gate.walks, 0);
    const query = await fetch(f.ingress.endpoint + "/v1/agent-hub/receipts", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${"0".repeat(64)}` },
      body: JSON.stringify({ requestId: randomUUID() }) });
    assert.equal(query.status, 401); assert.equal(gate.walks, 0);
  } finally { await gate.restore(); }
});

test("N3: a timed-out waiter leaves the shared census usable by another caller", async t => {
  const f = await fixture(t), gate = censusGate(f); f.clock.now += 6 * 60_000;
  try {
    const long = f.quota.prepareWrite({ timeoutMs: 1000 }), at = performance.now();
    await assert.rejects(f.quota.prepareWrite({ timeoutMs: 25 }), error => error.code === "unavailable");
    assert.ok(performance.now() - at < 750); assert.equal(gate.walks, 1);
    gate.release(); await long; assert.equal(gate.walks, 1);
    assert.equal((await f.send()).status, 200); assert.equal(f.hub.messages(f.grant.connectionId).length, 1);
  } finally { await gate.restore(); }
});

test("N3: persistent revision races stop after two censuses without replaying receive", async t => {
  const f = await fixture(t), original = fs.promises.realpath; let walks = 0, receives = 0;
  const receive = f.hub.receive.bind(f.hub); f.hub.receive = (...args) => { receives++; return receive(...args); };
  fs.promises.realpath = async (path, ...args) => {
    if (String(path) === join(f.home, ".hara")) {
      walks++; const policy = f.quota.policy();
      f.quota.changeLimit({ expectedRevision: policy.revision, expectedLimitBytes: policy.limitBytes, limitBytes: policy.limitBytes }, () => {});
    }
    return original(path, ...args);
  };
  f.clock.now += 6 * 60_000;
  try {
    const reply = await f.send(); assert.equal(reply.status, 503);
    assert.deepEqual(await reply.json(), { code: "store_unavailable", retry: "same_request_only" });
    assert.equal(walks, 2); assert.equal(receives, 0); assert.equal(f.hub.messages(f.grant.connectionId).length, 0);
  } finally { fs.promises.realpath = original; await f.quota.refreshUsage(); }
});


test("N3: a fresh but uncertain snapshot is reconciled before the first HTTP write", async t => {
  const f = await fixture(t), retained = join(f.home, ".hara", "uncertain.bin");
  f.quota.run(() => { f.quota.admitGrowth(1024); fs.writeFileSync(retained, Buffer.alloc(512)); f.quota.uncertainMutation(); });
  const gate = censusGate(f);
  try {
    const pending = f.send(); await gate.started; gate.release();
    const reply = await pending; assert.equal(reply.status, 200); assert.equal((await reply.json()).seq, 1);
    assert.equal(gate.walks, 1); assert.equal(fs.statSync(retained).size, 512);
    const state = JSON.parse(fs.readFileSync(join(f.home, ".hara", "storage-quota", "policy.json"), "utf8"));
    assert.equal(state.reservations.length, 0); assert.equal(state.sampledAt, f.clock.now);
  } finally { await gate.restore(); }
});

test("N3: a peer's successful census permits admission after the original census loses its CAS", async t => {
  const f = await fixture(t), original = fs.promises.realpath; let enter, release, walks = 0;
  const started = new Promise(resolve => { enter = resolve; }), paused = new Promise(resolve => { release = resolve; });
  fs.promises.realpath = async (path, ...args) => {
    if (String(path) === join(f.home, ".hara") && ++walks === 1) { enter(); await paused; }
    return original(path, ...args);
  };
  f.clock.now += 6 * 60_000;
  const peer = new HaraStorageQuota({ home: f.home, limitBytes: 64 * 1024 * 1024, now: () => f.clock.now });
  try {
    const pending = f.send(); await started;
    assert.equal(await peer.refreshUsage(), true); release();
    const reply = await pending; assert.equal(reply.status, 200); assert.equal((await reply.json()).seq, 1);
    assert.equal(walks, 2, "one census per controller, with no redundant third scan");
    assert.equal(f.hub.messages(f.grant.connectionId).length, 1);
  } finally { fs.promises.realpath = original; release(); await f.quota.refreshUsage(); }
});
