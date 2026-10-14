import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";
import { runAgent } from "../dist/agent/loop.js";
import { AgentRuntimeBindingStore } from "../dist/agent-runtime/bindings.js";

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const pending = new Map(); let nextId = 1;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)); const settle = pending.get(message.id);
      if (settle) { pending.delete(message.id); settle(message); }
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({
      call(method, params = {}) { return new Promise((settle) => {
        const id = nextId++; pending.set(id, settle); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }); }, close() { ws.close(); },
    }));
  });
}

async function fixture(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "hara-serve-runtime-")); const cwd = join(home, "repo"); mkdirSync(cwd);
  const previousHome = process.env.HOME; process.env.HOME = home;
  const saved = new Map();
  const store = { saved, load: (id) => structuredClone(saved.get(id) ?? null),
    save: (meta, history, task) => saved.set(meta.id, structuredClone({ meta, history, ...(task ? { task } : {}) })),
    list: () => [...saved.values()].map((entry) => entry.meta), acquire: () => ({ ok: true }), release() {}, delete: (id) => saved.delete(id) };
  let calls = 0; let spaceId = "personal";
  const provider = { id: "fixture", model: "fixture-model", async turn({ onText }) {
    calls++; onText?.("你好，收到。"); return { text: "你好，收到。", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
  } };
  const deps = { version: "test", providerId: "fixture", model: provider.model, buildSessionProvider: async () => provider,
    buildProviderFor: async () => provider, spawnSubagent: async () => "unused", sandbox: "off", approval: "suggest", store,
    quietDiscovery: true, agentRuntimeHome: home, agentTeamHome: home,
    runtimeInfo: () => ({ providerId: "fixture", model: provider.model, profileId: spaceId === "personal" ? "personal" : "company", spaceId }), ...extra };
  let handle, client;
  const open = async () => { handle = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd }, deps);
    client = await connect(handle.port); await client.call("initialize", { token: "fixture-token" }); return client; };
  await open();
  t.after(async () => { client?.close(); await handle?.close(); if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  return { home, cwd, store, provider, deps, get client() { return client; }, get calls() { return calls; }, setSpace: (value) => { spaceId = value; },
    restart: async () => { client.close(); await handle.close(); return open(); } };
}

test("real Serve exposes honest Runtime availability and refuses unavailable or privilege-bearing selections", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const catalog = (await f.client.call("agents.list")).result;
  const main = catalog.agents.find((agent) => agent.ref === "main");
  assert.equal(main.runtime.runtimeId, "hara"); assert.equal(main.runtime.revision, 0);
  assert.equal(catalog.runtimeOptions.find((option) => option.id === "pi").available, false);
  const params = { ref: "main", runtimeId: "pi", expectedRevision: 0, expectedAgentRevision: main.revision };
  for (const runtimeId of ["pi", "codex", "claude", "opencode"]) {
    assert.match((await f.client.call("agents.set-runtime", { ...params, runtimeId })).error.message, /not available.*no fallback/);
  }
  assert.match((await f.client.call("agents.set-runtime", { ...params, runtimeId: "hara", allowTools: ["bash"] })).error.message, /unsupported/);
  const changed = await f.client.call("agents.set-runtime", { ...params, runtimeId: "hara" }); assert.equal(changed.error, undefined);
  assert.equal(changed.result.binding.revision, 1);
  assert.match((await f.client.call("agents.set-runtime", { ...params, runtimeId: "hara" })).error.message, /changed/);
  f.setSpace("org:fixture");
  new AgentRuntimeBindingStore(f.home).set("org:fixture", "main", "pi", 0);
  assert.equal((await f.client.call("agents.list")).result.agents.find((entry) => entry.ref === "main").runtime.runtimeId, "hara",
    "local Personal state cannot select an organization engine");
  assert.match((await f.client.call("agents.set-runtime", { ...params, runtimeId: "hara", expectedRevision: 1 })).error.message, /organization administrators/);
  assert.equal(f.calls, 0);
});

test("a trusted fixture driver change affects the next task, not an in-flight run or resumed task", { timeout: 20000 }, async (t) => {
  const observed = []; let release; let enter;
  const entered = new Promise((resolve) => { enter = resolve; }); const held = new Promise((resolve) => { release = resolve; });
  // These are routing fixtures, NOT a claimed Pi SDK integration. The Pi fixture has its own response;
  // it must not call the Hara compatibility loop with Pi provenance and conceal an implicit fallback.
  const driver = (id) => ({ id, async run(history, options, binding) {
    observed.push({ ...binding }); if (observed.length === 1) { enter(); await held; }
    if (id === "hara") return runAgent(history, options);
    history.push({ role: "assistant", text: "Synthetic fixture Runtime reply.", toolUses: [] });
    return { status: "completed" };
  } });
  const f = await fixture(t, { agentRuntimeDrivers: [driver("hara"), driver("pi")] });
  const session = (await f.client.call("session.create", { cwd: f.cwd })).result.sessionId;
  const catalog = (await f.client.call("agents.list")).result; const main = catalog.agents.find((agent) => agent.ref === "main");
  const sent = f.client.call("session.send", { sessionId: session, text: "你好" }); await entered;
  const updated = await f.client.call("agents.set-runtime", { ref: "main", runtimeId: "pi", expectedRevision: 0, expectedAgentRevision: main.revision });
  assert.equal(updated.error, undefined); release(); assert.equal((await sent).error, undefined);
  const first = f.store.saved.get(session); assert.equal(first.task.runtimeBinding.runtimeId, "hara");
  // Simulate restart of unfinished work using the persisted snapshot, not the live foreground preference.
  first.task.status = "paused"; first.task.lastOutcome = "interrupted"; f.store.saved.set(session, first);
  await f.restart(); assert.equal((await f.client.call("session.resume", { sessionId: session })).error, undefined);
  assert.equal((await f.client.call("session.send", { sessionId: session, text: "/continue" })).error, undefined);
  assert.equal(observed[1].runtimeId, "hara"); assert.equal(observed[1].taskId, observed[0].taskId);
  assert.equal((await f.client.call("session.send", { sessionId: session, text: "hello, a separate greeting" })).error, undefined);
  assert.equal(observed[2].runtimeId, "pi"); assert.equal(observed[2].revision, 1);
  assert.notEqual(observed[2].taskId, observed[0].taskId);
  assert.equal(f.store.saved.get(session).task.runtimeBinding.runtimeId, "pi");
  const fork = await f.client.call("session.fork", { sessionId: session }); assert.equal(fork.error, undefined);
  const forked = f.store.saved.get(fork.result.sessionId);
  assert.equal(forked.task.runtimeBinding.runtimeId, "pi");
  assert.notEqual(forked.task.runtimeBinding.taskId, observed[2].taskId);
  assert.equal(forked.meta.codingSessionLink, undefined);
});

test("imported persona Runtime fields cannot choose an engine and an unavailable new binding preserves old work", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); mkdirSync(join(f.home, ".hara", "roles"), { recursive: true });
  writeFileSync(join(f.home, ".hara", "roles", "coder.md"), "---\nname: coder\nruntime: codex\n---\nPersona only, not execution authority.\n");
  const created = await f.client.call("session.create", { cwd: f.cwd, agentRef: "global:coder" }); assert.equal(created.error, undefined);
  const session = created.result.sessionId;
  assert.equal((await f.client.call("session.send", { sessionId: session, text: "hello" })).error, undefined);
  const before = structuredClone(f.store.saved.get(session)); const count = f.calls;
  assert.equal(before.task.runtimeBinding.runtimeId, "hara");
  new AgentRuntimeBindingStore(f.home).set("personal", "global:coder", "pi", 0);
  const rejected = await f.client.call("session.send", { sessionId: session, text: "hello, another task" });
  assert.match(rejected.error.message, /not available.*no fallback/);
  assert.equal(f.calls, count); assert.deepEqual(f.store.saved.get(session), before);
  assert.match((await f.client.call("session.create", { cwd: f.cwd, agentRef: "global:coder" })).error.message, /not available/);
  const state = JSON.parse(readFileSync(join(f.home, ".hara", "agent-runtime-bindings.json"), "utf8"));
  assert.equal(state.bindings[0].runtimeId, "pi");
});
