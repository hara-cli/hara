// hara serve end-to-end over a REAL WebSocket: auth, session lifecycle, streamed events, approval
// round-trip through the real agent loop (fake provider + hermetic in-memory store; write_file in a tmp
// dir under approval "suggest" forces the confirm gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";
import { createTaskExecution, finishTaskExecution } from "../dist/session/task.js";

/** Tiny JSON-RPC-over-ws test client: request/response correlation + notification capture. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const events = [];
    const waiters = [];
    let nextId = 1;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id !== undefined && m.id !== null && pending.has(m.id)) {
        const { res } = pending.get(m.id);
        pending.delete(m.id);
        res(m);
      } else if (m.method) {
        events.push(m);
        for (const w of waiters.splice(0)) w();
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        events,
        call: (method, params) =>
          new Promise((res) => {
            const id = nextId++;
            pending.set(id, { res });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
        waitEvent: (method, timeoutMs = 5000) =>
          new Promise((res, rej) => {
            const scan = () => events.find((e) => e.method === method);
            const hit = scan();
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs);
            const tick = () => {
              const h = scan();
              if (h) {
                clearTimeout(t);
                res(h);
              } else waiters.push(tick);
            };
            waiters.push(tick);
          }),
        close: () => ws.close(),
      }),
    );
    ws.on("error", reject);
  });
}

const memStore = () => {
  const files = new Map();
  return {
    saved: files,
    load: (id) => files.get(id) ?? null,
    save: (meta, history, task) => files.set(meta.id, {
      meta: { ...meta },
      history: structuredClone(history),
      ...(task ? { task: structuredClone(task) } : {}),
    }),
    list: () => [...files.values()].map((d) => d.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => files.delete(id),
  };
};

/** Fake provider: streams "hel"+"lo" and ends. */
const textProvider = {
  id: "fake",
  model: "fake-1",
  async turn({ onText }) {
    onText("hel");
    onText("lo");
    return { text: "hello", toolUses: [], stop: "end", usage: { input: 3, output: 2 } };
  },
};

/** Fake provider: first records its task understanding, then asks to write a file (forcing the approval
 * gate under "suggest"), then ends. This exercises the real understanding → execution boundary instead of
 * relying on the runtime to let a raw request jump directly into a side effect. */
const toolProvider = () => {
  let n = 0;
  return {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      if (n++ === 0) {
        return {
          text: "",
          toolUses: [{
            id: "brief1",
            name: "task_intake",
            input: {
              intent: "change",
              goal: "write approved.txt with the requested content",
              constraints: ["write only inside the test workspace"],
              acceptance: ["approved.txt contains hi"],
              steps: ["record the task brief", "request approval and write the file", "report completion"],
            },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (n === 2) {
        return { text: "", toolUses: [{ id: "t1", name: "write_file", input: { path: "approved.txt", content: "hi" } }], stop: "tool_use", usage: { input: 1, output: 1 } };
      }
      onText("done");
      return { text: "done", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
};

const baseDeps = (provider, store, approval = "full-auto") => ({
  version: "0.0.0-test",
  providerId: "fake",
  model: "fake-1",
  buildSessionProvider: async () => provider,
  spawnSubagent: async () => "(subagents disabled in test)",
  sandbox: "off",
  approval,
  store,
  quietDiscovery: true,
});

const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const assertPortCanListen = (port) => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
});

const hangingCompactProvider = () => {
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let compactSignal;
  return {
    provider: {
      id: "fake",
      model: "fake-1",
      turn({ onText, signal }) {
        if (calls++ === 0) {
          onText("ready");
          return Promise.resolve({ text: "ready", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
        }
        compactSignal = signal;
        markStarted();
        return new Promise(() => {}); // intentionally ignores abort: serve must settle its own operation
      },
    },
    started,
    signal: () => compactSignal,
  };
};

test("serve discovery: private atomic replacement, symlink safety, and instance-owned cleanup", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-serve-home-"));
  const haraDir = join(home, ".hara");
  const discoveryPath = join(haraDir, "serve.json");
  const victimPath = join(home, "victim.txt");
  mkdirSync(haraDir, { mode: 0o777 });
  chmodSync(haraDir, 0o777);
  writeFileSync(discoveryPath, "legacy", { mode: 0o644 });
  chmodSync(discoveryPath, 0o644);
  const deps = { ...baseDeps(textProvider, memStore()), quietDiscovery: false, discoveryHome: home };
  let legacy;
  let older;
  let newer;
  try {
    legacy = await startServe({ host: "127.0.0.1", port: 0, token: "legacy-token", cwd: home }, deps);
    assert.equal(statSync(haraDir).mode & 0o777, 0o700, "legacy ~/.hara mode is tightened");
    assert.equal(statSync(discoveryPath).mode & 0o777, 0o600, "legacy 0644 discovery is replaced privately");
    assert.equal(JSON.parse(readFileSync(discoveryPath, "utf8")).token, "legacy-token");
    await legacy.close();
    legacy = undefined;

    writeFileSync(victimPath, "do not follow me", { mode: 0o644 });
    symlinkSync(victimPath, discoveryPath);
    older = await startServe({ host: "127.0.0.1", port: 0, token: "older-token", cwd: home }, deps);
    const olderRecord = JSON.parse(readFileSync(discoveryPath, "utf8"));
    assert.equal(lstatSync(discoveryPath).isSymbolicLink(), false, "serve.json symlink inode was replaced");
    assert.equal(readFileSync(victimPath, "utf8"), "do not follow me", "symlink target was untouched");
    assert.ok(olderRecord.instanceId, "discovery is stamped with an instance nonce");

    newer = await startServe({ host: "127.0.0.1", port: 0, token: "newer-token", cwd: home }, deps);
    const newerRecord = JSON.parse(readFileSync(discoveryPath, "utf8"));
    assert.notEqual(newerRecord.instanceId, olderRecord.instanceId);
    await older.close();
    older = undefined;
    assert.equal(JSON.parse(readFileSync(discoveryPath, "utf8")).instanceId, newerRecord.instanceId, "old close preserved newer discovery");
    await newer.close();
    newer = undefined;
    assert.equal(existsSync(discoveryPath), false, "owning instance removes its discovery on close");
  } finally {
    await legacy?.close();
    await older?.close();
    await newer?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve discovery: a write failure closes the already-listening socket", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-serve-bad-home-"));
  writeFileSync(join(home, ".hara"), "not a directory");
  const port = await reservePort();
  try {
    await assert.rejects(
      startServe(
        { host: "127.0.0.1", port, token: "tok", cwd: home },
        { ...baseDeps(textProvider, memStore()), quietDiscovery: false, discoveryHome: home },
      ),
      /EEXIST|ENOTDIR|directory/i,
    );
    await assertPortCanListen(port);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("serve e2e: auth gate → create → send streams text events and returns the reply", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(textProvider, store));
  const c = await connect(srv.port);
  try {
    // unauthenticated calls bounce; bad token bounces
    const denied = await c.call("session.list", {});
    assert.equal(denied.error.code, -32001);
    const badTok = await c.call("initialize", { token: "wrong" });
    assert.equal(badTok.error.code, -32001);
    const init = await c.call("initialize", { token: "tok" });
    assert.equal(init.result.protocol, 1);
    assert.equal(init.result.model, "fake-1");
    assert.ok(init.result.capabilities.methods.includes("automation.list"), "capabilities advertised");
    assert.ok(init.result.capabilities.methods.includes("session.steer"), "expected-turn steering advertised");

    const created = await c.call("session.create", {});
    const sid = created.result.sessionId;
    assert.ok(sid, "got a session id");

    const sent = await c.call("session.send", { sessionId: sid, text: "hi there" });
    assert.equal(sent.result.reply, "hello");
    assert.equal(sent.result.usage.input, 3);
    const deltas = c.events.filter((e) => e.method === "event.text").map((e) => e.params.delta).join("");
    assert.equal(deltas, "hello", "text streamed as events");
    await c.waitEvent("event.turn_end");

    // persisted through the (injected) store + listed
    assert.ok(store.saved.get(sid), "session persisted after the turn");
    const listed = await c.call("session.list", {});
    assert.equal(listed.result.sessions.length, 1);

    // unknown session / busy / params errors
    const nosess = await c.call("session.send", { sessionId: "nope", text: "x" });
    assert.equal(nosess.error.code, -32003);
    const badParams = await c.call("session.send", { sessionId: sid });
    assert.equal(badParams.error.code, -32602);

    // plugins/skills surface (P2): shape-only — contents depend on the machine's ~/.hara
    const plugins = await c.call("plugins.list", {});
    assert.ok(Array.isArray(plugins.result.plugins), "plugins.list returns an array");
    const badSet = await c.call("plugins.set", { name: "definitely-not-installed-xyz", enabled: false });
    assert.equal(badSet.error.code, -32602, "plugins.set on unknown plugin → params error (never writes config)");
    const skills = await c.call("skills.list", {});
    assert.ok(Array.isArray(skills.result.skills), "skills.list returns an array");
    const auto = await c.call("automation.list", {});
    assert.ok(Array.isArray(auto.result.jobs) && Array.isArray(auto.result.sessions), "automation.list returns jobs + sessions");
    // sessions created through serve are stamped interactive → never leak into the automation timeline
    assert.equal(auto.result.sessions.some((s) => s.id === sid), false, "serve session not in automation list");
    const listed2 = await c.call("session.list", {});
    assert.equal(listed2.result.sessions[0].source, "interactive", "session.list carries source");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: models.list derives reasoning controls from the session-pinned model", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-model-controls-"));
  const store = memStore();
  const runtimeRequests = [];
  const deps = {
    ...baseDeps(textProvider, store),
    buildProviderFor: async (model) => ({
      ...textProvider,
      model,
    }),
    listModels: async () => ["qwen3.7-plus", "qwen3-coder-next"],
    runtimeInfo: (cwd, model) => {
      runtimeRequests.push({ cwd, model });
      const selected = model ?? "qwen3.7-plus";
      return {
        providerId: "qwen",
        model: selected,
        effortLevels: selected === "qwen3-coder-next" ? [] : ["low", "medium", "high"],
      };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    const switched = await c.call("session.set-model", { sessionId: sid, model: "qwen3-coder-next" });
    assert.equal(switched.result.model, "qwen3-coder-next");

    const listed = await c.call("models.list", { sessionId: sid });
    assert.equal(listed.result.current, "qwen3-coder-next");
    assert.deepEqual(listed.result.effortLevels, [], "a coder model without thinking controls must not inherit the configured default model's dial");
    assert.ok(runtimeRequests.some((request) => request.model === "qwen3-coder-next"));
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: provider settings are capability-advertised, redacted, tested, and saved without echoing credentials", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-provider-settings-"));
  const state = {
    current: {
      provider: "ollama",
      model: "qwen3",
      baseURL: "http://127.0.0.1:11434/v1",
      location: "local",
      auth: "none",
      keyConfigured: true,
      authenticated: true,
      profileId: "personal",
      profileKind: "byok",
      profileSource: "default",
      editable: true,
    },
    providers: [{
      id: "ollama",
      label: "Ollama",
      location: "local",
      auth: "none",
      defaultModel: "qwen3",
      defaultBaseURL: "http://127.0.0.1:11434/v1",
      customBaseURL: true,
    }],
  };
  let savedInput;
  const deps = {
    ...baseDeps(textProvider, memStore()),
    providerSettings: () => state,
    testProviderSettings: async (input) => ({
      ok: false,
      models: ["qwen3"],
      error: `upstream rejected apiKey=${input.apiKey}`,
    }),
    saveProviderSettings: async (input) => {
      savedInput = input;
      return { ...state, accidentalApiKey: input.apiKey };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    const init = await c.call("initialize", { token: "tok" });
    assert.ok(init.result.capabilities.methods.includes("settings.providers.list"));
    assert.ok(init.result.capabilities.methods.includes("settings.providers.test"));
    assert.ok(init.result.capabilities.methods.includes("settings.providers.save"));

    const listed = await c.call("settings.providers.list", {});
    assert.equal(listed.result.current.provider, "ollama");
    assert.equal(JSON.stringify(listed.result).includes("apiKey"), false);

    const secret = "sk-testsecret-1234567890";
    const tested = await c.call("settings.providers.test", { provider: "openai", model: "gpt-test", apiKey: secret });
    assert.equal(tested.result.ok, false);
    assert.equal(JSON.stringify(tested.result).includes(secret), false, "test errors must never echo a submitted key");

    const saved = await c.call("settings.providers.save", { provider: "openai", model: "gpt-test", apiKey: secret, activatePersonal: true });
    assert.equal(savedInput.apiKey, secret, "the authenticated callback receives the ephemeral credential");
    assert.equal(JSON.stringify(saved.result).includes(secret), false, "save results must never echo a submitted key");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: an unconfigured engine still initializes so Desktop can open System Settings", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-provider-onboarding-"));
  const state = {
    current: {
      provider: "openai",
      model: "gpt-test",
      location: "cloud",
      auth: "api-key",
      keyConfigured: false,
      authenticated: false,
      profileId: "personal",
      profileKind: "byok",
      profileSource: "default",
      editable: true,
    },
    providers: [],
  };
  const deps = { ...baseDeps(null, memStore()), providerSettings: () => state };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    const init = await c.call("initialize", { token: "tok" });
    assert.equal(init.result.setupState, "needs-credentials");
    const settings = await c.call("settings.providers.list", {});
    assert.equal(settings.result.current.authenticated, false);
    const create = await c.call("session.create", {});
    assert.equal(create.error.code, -32603, "only task creation is blocked while settings remain available");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: live metadata and resume are serialized with an active turn", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-busy-"));
  const store = memStore();
  let markStarted;
  let finishTurn;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn() {
      markStarted();
      return new Promise((resolve) => {
        finishTurn = () => resolve({ text: "finished", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
      });
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "hold this turn" });
    await started;

    for (const [method, params] of [
      ["session.resume", { sessionId: result.sessionId }],
      ["session.rename", { sessionId: result.sessionId, title: "racy title" }],
      ["session.archive", { sessionId: result.sessionId, archived: true }],
    ]) {
      const response = await c.call(method, params);
      assert.equal(response.error.code, -32002, `${method} rejects while the turn is active`);
    }
    assert.equal(store.saved.get(result.sessionId).meta.title, "", "busy rename did not persist");
    assert.equal(store.saved.get(result.sessionId).meta.archived, undefined, "busy archive did not persist");

    finishTurn();
    const sent = await sending;
    assert.equal(sent.result.reply, "finished");
    assert.equal((await c.call("session.rename", { sessionId: result.sessionId, title: "settled title" })).result.title, "settled title");
    assert.equal((await c.call("session.archive", { sessionId: result.sessionId, archived: true })).result.archived, true);
  } finally {
    finishTurn?.();
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: session.steer targets the live turn and stays in the same task", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-steer-"));
  const store = memStore();
  let releaseFirst;
  let calls = 0;
  const providerHistories = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history, onText }) {
      calls++;
      providerHistories.push(structuredClone(history));
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        onText("first");
        return { text: "first", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
      }
      onText("steered");
      return { text: "steered", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "primary objective" });
    const started = await c.waitEvent("event.turn_start");

    const stale = await c.call("session.steer", { sessionId: result.sessionId, text: "wrong", expectedTurnId: "stale-turn" });
    assert.equal(stale.error.code, -32002, "stale expectedTurnId is rejected");
    const steered = await c.call("session.steer", {
      sessionId: result.sessionId,
      text: "also cover the edge case",
      expectedTurnId: started.params.turnId,
    });
    assert.equal(steered.result.accepted, true);
    assert.equal(steered.result.taskId, started.params.taskId, "steering does not replace task identity");
    const acceptedSnapshot = store.saved.get(result.sessionId);
    assert.equal(acceptedSnapshot.task.steering[0].deliveryState, "pending", "ACK happens only after executable input is durable");
    assert.ok(!acceptedSnapshot.history.some((message) => message.role === "user" && message.content.includes("also cover the edge case")), "write-ahead inbox has not pretended the model consumed it yet");

    releaseFirst();
    const sent = await sending;
    assert.equal(sent.result.reply, "steered");
    assert.equal(sent.result.taskId, started.params.taskId);
    assert.equal(calls, 2, "late steering causes another provider round in the same logical task");
    assert.ok(providerHistories[1].some((message) => message.role === "user" && message.content.includes("also cover the edge case")));
    const saved = store.saved.get(result.sessionId);
    assert.equal(saved.task.objective, "primary objective", "original objective remains authoritative");
    assert.equal(saved.task.steering.length, 1, "accepted steer has a bounded durable audit entry");
    assert.equal(saved.task.steering[0].deliveryState, "consumed", "transcript delivery commits exactly once");
  } finally {
    releaseFirst?.();
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: interrupt after steer cannot overwrite the write-ahead transcript", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-steer-interrupt-"));
  const store = memStore();
  let releaseFirst;
  let calls = 0;
  const providerHistories = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ history, onText }) {
      calls++;
      providerHistories.push(structuredClone(history));
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; }); // deliberately ignores AbortSignal
        return { text: "late", toolUses: [], stop: "end" };
      }
      onText("recovered");
      return { text: "recovered", toolUses: [], stop: "end" };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "primary" });
    const started = await c.waitEvent("event.turn_start");
    const steer = await c.call("session.steer", { sessionId: result.sessionId, text: "must survive interrupt", expectedTurnId: started.params.turnId });
    assert.equal(steer.result.accepted, true);
    await c.call("session.interrupt", { sessionId: result.sessionId });
    const interrupted = await sending;
    assert.ok(interrupted.error, "owning send ends as interrupted");

    const afterInterrupt = store.saved.get(result.sessionId);
    assert.equal(afterInterrupt.task.steering[0].deliveryState, "consumed");
    assert.equal(afterInterrupt.history.filter((message) => message.role === "user" && message.content.includes("must survive interrupt")).length, 1);

    const resumed = await c.call("session.send", { sessionId: result.sessionId, text: "继续" });
    assert.equal(resumed.result.reply, "recovered");
    assert.equal(providerHistories[1].filter((message) => message.role === "user" && message.content.includes("must survive interrupt")).length, 1, "recovery sees the accepted steer exactly once");
  } finally {
    releaseFirst?.();
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: only an explicit continuation resumes an unfinished task", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-resume-task-"));
  const store = memStore();
  const sessionId = randomUUID();
  const created = createTaskExecution("finish the original migration", randomUUID(), "2026-07-15T00:00:00.000Z");
  const paused = finishTaskExecution(created, { status: "completed" }, [{ text: "verify migration", status: "pending" }], false, "2026-07-15T00:01:00.000Z");
  store.saved.set(sessionId, {
    meta: {
      id: sessionId,
      cwd: dir,
      provider: "fake",
      model: "fake-1",
      title: "migration",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      source: "interactive",
    },
    history: [{ role: "user", content: "finish the original migration" }],
    task: paused,
  });
  const systems = [];
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ system, onText }) {
      systems.push(system);
      const text = systems.length === 1 ? "continued" : "fresh";
      onText(text);
      return { text, toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const resumed = await c.call("session.resume", { sessionId });
    assert.equal(resumed.result.task.id, paused.id);

    const continued = await c.call("session.send", { sessionId, text: "continue and verify" });
    assert.equal(continued.result.taskId, paused.id, "an explicit continuation keeps the recovered task identity");
    assert.match(systems[0], /Objective: finish the original migration/);
    assert.doesNotMatch(systems[0], /Objective: continue and verify/);

    const fresh = await c.call("session.send", { sessionId, text: "start a separate audit" });
    assert.notEqual(fresh.result.taskId, paused.id, "an ordinary idle message starts a separate task by default");
    assert.match(systems[1], /Objective: start a separate audit/);
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: failed and empty turns never replay an earlier assistant reply", { timeout: 20000 }, async () => {
  for (const mode of ["error", "empty"]) {
    const dir = mkdtempSync(join(tmpdir(), `hara-serve-${mode}-`));
    let calls = 0;
    const provider = {
      id: "fake",
      model: "fake-1",
      async turn({ onText }) {
        calls++;
        if (calls === 1) {
          onText("previous success");
          return { text: "previous success", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
        }
        if (mode === "error") {
          return { text: "", toolUses: [], stop: "error", errorMsg: "upstream exploded", usage: { input: 1, output: 0 } };
        }
        return { text: "", toolUses: [], stop: "end", usage: { input: 1, output: 0 } };
      },
    };
    const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, memStore()));
    const c = await connect(srv.port);
    try {
      await c.call("initialize", { token: "tok" });
      const { result } = await c.call("session.create", {});
      assert.equal((await c.call("session.send", { sessionId: result.sessionId, text: "first" })).result.reply, "previous success");

      const failed = await c.call("session.send", { sessionId: result.sessionId, text: "now fail" });
      assert.equal(failed.error.code, -32603, `${mode} is an explicit RPC failure`);
      assert.doesNotMatch(failed.error.message, /previous success/, `${mode} did not reuse old assistant text`);
      assert.match(failed.error.message, mode === "error" ? /upstream exploded/ : /empty response/);
      const turnEnd = c.events.filter((event) => event.method === "event.turn_end").at(-1);
      assert.equal(turnEnd.params.status, mode);
      assert.equal(turnEnd.params.reply, "", `${mode} event has no stale reply`);
    } finally {
      c.close();
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("serve e2e: graceful close aborts turns, closes clients, releases settled locks, and is idempotent", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-close-"));
  const store = memStore();
  const released = [];
  store.release = (id) => released.push(id);
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let aborted = false;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ signal }) {
      markStarted();
      return new Promise((resolve) => {
        const interrupt = () => {
          aborted = true;
          resolve({ text: "", toolUses: [], stop: "error", errorMsg: "interrupted", usage: { input: 0, output: 0 } });
        };
        if (signal?.aborted) interrupt();
        else signal?.addEventListener("abort", interrupt, { once: true });
      });
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(provider, store));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    void c.call("session.send", { sessionId: result.sessionId, text: "keep running" });
    await started;
    const socketClosed = new Promise((resolve) => c.ws.once("close", resolve));
    const outcome = await Promise.race([
      srv.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ]);
    assert.equal(outcome, "closed", "close is bounded even with a connected WebSocket");
    await socketClosed;
    assert.equal(aborted, true, "active provider received the shutdown abort");
    assert.ok(released.includes(result.sessionId), "a settled turn's session lock was released");
    await srv.close(); // repeat callers share the completed close promise
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: operations settling after shutdown grace release their retained locks", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-late-close-"));
  const store = memStore();
  const released = [];
  store.release = (id) => released.push(id);
  let markTurnStarted;
  let finishTurn;
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const slowTurnProvider = {
    id: "fake",
    model: "fake-1",
    async turn() {
      markTurnStarted();
      return new Promise((resolve) => {
        finishTurn = () => resolve({ text: "late finish", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
      });
    },
  };
  let markFactoryStarted;
  let finishFactory;
  const factoryStarted = new Promise((resolve) => { markFactoryStarted = resolve; });
  const switchedProvider = { id: "fake", model: "fake-2", async turn() { throw new Error("unused"); } };
  const deps = {
    ...baseDeps(slowTurnProvider, store),
    buildProviderFor: async (model) => {
      if (model !== "fake-2") return slowTurnProvider;
      markFactoryStarted();
      return new Promise((resolve) => { finishFactory = () => resolve(switchedProvider); });
    },
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const turnSession = (await c.call("session.create", {})).result.sessionId;
    const configSession = (await c.call("session.create", {})).result.sessionId;
    void c.call("session.send", { sessionId: turnSession, text: "ignore shutdown abort" });
    void c.call("session.set-model", { sessionId: configSession, model: "fake-2" });
    await Promise.all([turnStarted, factoryStarted]);

    const outcome = await Promise.race([
      srv.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_500)),
    ]);
    assert.equal(outcome, "closed", "shutdown returns after its bounded grace period");
    assert.equal(released.includes(turnSession), false, "busy turn lock remained held at the timeout boundary");
    assert.equal(released.includes(configSession), false, "configuring lock remained held at the timeout boundary");

    finishTurn();
    finishFactory();
    const cleanupDeadline = Date.now() + 1_000;
    while ((!released.includes(turnSession) || !released.includes(configSession)) && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(released.includes(turnSession), "late turn completion released its lock");
    assert.ok(released.includes(configSession), "late provider factory completion released its lock");
  } finally {
    finishTurn?.();
    finishFactory?.();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: session.interrupt settles a compaction even when its provider ignores abort", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-compact-interrupt-"));
  const store = memStore();
  const hanging = hangingCompactProvider();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(hanging.provider, store));
  const c = await connect(srv.port);
  let compacting;
  try {
    await c.call("initialize", { token: "tok" });
    const sid = (await c.call("session.create", {})).result.sessionId;
    await c.call("session.send", { sessionId: sid, text: "make history" });
    compacting = c.call("session.compact", { sessionId: sid });
    await hanging.started;
    assert.equal(hanging.signal()?.aborted, false);
    assert.deepEqual((await c.call("session.interrupt", { sessionId: sid })).result, {});
    const result = await Promise.race([
      compacting,
      new Promise((_, reject) => setTimeout(() => reject(new Error("interrupted compact did not settle")), 1_000)),
    ]);
    assert.equal(result.error.code, -32603);
    assert.match(result.error.message, /compaction interrupted/);
    assert.equal(hanging.signal()?.aborted, true, "compact provider receives the interrupt signal");
    assert.equal((await c.call("session.rename", { sessionId: sid, title: "idle again" })).result.title, "idle again", "busy clears after interruption");
  } finally {
    if (compacting) await compacting.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: compaction has a hard timeout and close releases its lock", { timeout: 10000 }, async () => {
  for (const mode of ["timeout", "close"]) {
    const dir = mkdtempSync(join(tmpdir(), `hara-serve-compact-${mode}-`));
    const store = memStore();
    const released = [];
    store.release = (id) => released.push(id);
    const hanging = hangingCompactProvider();
    const deps = { ...baseDeps(hanging.provider, store), compactTimeoutMs: mode === "timeout" ? 40 : 5_000 };
    const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
    const c = await connect(srv.port);
    let compacting;
    try {
      await c.call("initialize", { token: "tok" });
      const sid = (await c.call("session.create", {})).result.sessionId;
      await c.call("session.send", { sessionId: sid, text: "make history" });
      compacting = c.call("session.compact", { sessionId: sid });
      await hanging.started;
      if (mode === "timeout") {
        const result = await Promise.race([
          compacting,
          new Promise((_, reject) => setTimeout(() => reject(new Error("compact hard timeout did not settle")), 1_000)),
        ]);
        assert.equal(result.error.code, -32603);
        assert.match(result.error.message, /compaction timed out/);
        assert.equal(hanging.signal()?.aborted, true, "hard timeout also aborts provider work");
        assert.equal((await c.call("session.rename", { sessionId: sid, title: "after timeout" })).result.title, "after timeout");
        c.close();
        await srv.close();
      } else {
        await srv.close();
        assert.equal(hanging.signal()?.aborted, true, "shutdown interrupts compact");
      }
      assert.ok(released.includes(sid), `${mode} shutdown released the attached session lock`);
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("serve e2e: files.search + session.context + compact + rewind (codex desktop parity set)", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "alpha.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "beta.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "readme.md"), "# hi\n");
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(textProvider, store));
  const c = await connect(srv.port);
  try {
    const init = await c.call("initialize", { token: "tok" });
    for (const m of ["files.search", "session.context", "session.compact", "session.rewind"]) {
      assert.ok(init.result.capabilities.methods.includes(m), `capability ${m} advertised`);
    }

    // files.search: fuzzy match + browse-all on empty query (relative POSIX paths)
    const hit = await c.call("files.search", { cwd: dir, query: "alpha" });
    assert.ok(hit.result.files.includes("src/alpha.ts"), `fuzzy hit, got ${JSON.stringify(hit.result.files)}`);
    const all = await c.call("files.search", { cwd: dir, query: "" });
    assert.ok(all.result.files.length >= 3, "empty query lists files");

    const { result } = await c.call("session.create", {});
    const sid = result.sessionId;

    // session.context resolves the session's cwd when cwd is omitted from files.search
    const viaSession = await c.call("files.search", { sessionId: sid, query: "beta" });
    assert.ok(viaSession.result.files.includes("src/beta.ts"), "files.search resolves cwd from sessionId");

    // two turns → history u,a,u,a; turn_end carries the ctx watermark
    const sent1 = await c.call("session.send", { sessionId: sid, text: "one" });
    assert.ok(sent1.result.ctx && typeof sent1.result.ctx.pct === "number" && sent1.result.ctx.window > 0, "send returns ctx watermark");
    await c.call("session.send", { sessionId: sid, text: "two" });
    const te = c.events.find((e) => e.method === "event.turn_end");
    assert.ok(te.params.ctx && typeof te.params.ctx.pct === "number", "turn_end event carries ctx");

    // session.context: watermark + spend breakdown
    const ctx = await c.call("session.context", { sessionId: sid });
    assert.ok(ctx.result.window > 0 && Array.isArray(ctx.result.rows) && ctx.result.total > 0, "context report shape");

    // session.rewind n=1 → drops the last exchange (4 → 2 entries client-side)
    const rew = await c.call("session.rewind", { sessionId: sid, n: 1 });
    assert.equal(rew.result.history.length, 2, "rewind dropped the last exchange");
    assert.equal(rew.result.history[0].text, "one", "the first exchange survived");
    const oor = await c.call("session.rewind", { sessionId: sid, n: 99 });
    assert.equal(oor.error.code, -32602, "out-of-range n → params error");

    // session.compact: bounded checkpoint + recent turn anchor (fake provider's weak "hello" is normalized)
    const comp = await c.call("session.compact", { sessionId: sid });
    assert.ok(comp.result.history[0].text.startsWith("Execution checkpoint"), "history begins with a structured checkpoint");
    assert.ok(comp.result.history.some((message) => message.text === "one"), "recent exact turn survives compaction");
    assert.ok(comp.result.notes >= 1, "working notes distilled");
    assert.ok(comp.result.ctx && typeof comp.result.ctx.pct === "number", "compact returns fresh ctx");
    const notices = c.events.filter((e) => e.method === "event.notice").map((e) => e.params.text);
    assert.ok(notices.some((t) => t.includes("Compacting")), "compaction announced");
    assert.equal(store.saved.get(sid).history.length, comp.result.history.length, "checkpoint and recent anchor persisted together");
    // compacting an (effectively) empty session refuses politely
    const { result: fresh } = await c.call("session.create", {});
    const nothing = await c.call("session.compact", { sessionId: fresh.sessionId });
    assert.equal(nothing.error.code, -32602, "nothing to compact → params error");

    // session.fork: duplicate history into a NEW live session; original untouched
    const fk = await c.call("session.fork", { sessionId: sid });
    assert.ok(fk.result.sessionId && fk.result.sessionId !== sid, "fork got a fresh id");
    assert.equal(fk.result.history.length, comp.result.history.length, "fork copied the compacted checkpoint plus recent anchor");
    assert.ok(store.saved.has(fk.result.sessionId), "fork persisted immediately");
    const fsend = await c.call("session.send", { sessionId: fk.result.sessionId, text: "diverge" });
    assert.equal(fsend.result.reply, "hello", "fork is a working session");
    assert.equal(store.saved.get(sid).history.length, comp.result.history.length, "original unchanged by fork's turn");
    const nofork = await c.call("session.fork", { sessionId: "nope" });
    assert.equal(nofork.error.code, -32003, "fork of unknown session errors");

    // session.delete: permanent — gone from the store and from session.list
    const del = await c.call("session.delete", { sessionId: sid });
    assert.equal(del.result.deleted, true, "delete acked");
    assert.equal(store.saved.has(sid), false, "session file removed");
    const after = await c.call("session.list", {});
    assert.equal(after.result.sessions.some((s) => s.id === sid), false, "deleted session not listed");
    const again = await c.call("session.delete", { sessionId: sid });
    assert.equal(again.error.code, -32003, "double delete → no-session error");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: approval round-trip — suggest mode write_file waits for approval.reply, then completes", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), store, "suggest"));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    // answer the approval as soon as it arrives (concurrently with the running send)
    const approver = c.waitEvent("approval.request").then((ev) => c.call("approval.reply", { approvalId: ev.params.approvalId, allow: true }));
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    await approver;
    assert.equal(sent.result.reply, "done");
    assert.equal(c.events.filter((e) => e.method === "approval.request").length, 1, "exactly one approval asked");
    assert.equal(readFileSync(join(dir, "approved.txt"), "utf8"), "hi", "the approved tool actually ran");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: denied approval blocks the tool", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-"));
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), memStore(), "suggest"));
  const c = await connect(srv.port);
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    const denier = c.waitEvent("approval.request").then((ev) => c.call("approval.reply", { approvalId: ev.params.approvalId, allow: false }));
    const sent = await c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    await denier;
    assert.equal(sent.result.reply, "done", "turn still completes (model told of the denial)");
    assert.equal(existsSync(join(dir, "approved.txt")), false, "denied tool did NOT run");
  } finally {
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: interrupt settles a pending approval immediately and leaves valid history", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-interrupt-approval-"));
  const store = memStore();
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, baseDeps(toolProvider(), store, "suggest"));
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "write it" });
    const approval = await c.waitEvent("approval.request");

    const interrupted = await c.call("session.interrupt", { sessionId: result.sessionId });
    assert.deepEqual(interrupted.result, {});
    const failed = await Promise.race([
      sending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn stayed blocked on approval after interrupt")), 1_000)),
    ]);
    assert.equal(failed.error.code, -32603, "interrupted send fails instead of reporting success");
    assert.match(failed.error.message, /interrupted/);
    assert.equal(existsSync(join(dir, "approved.txt")), false, "interrupted approval never runs the tool");

    const saved = store.saved.get(result.sessionId);
    assert.deepEqual(saved.history.slice(-2).map((message) => message.role), ["assistant", "tool"]);
    assert.equal(saved.history.at(-1).results[0].id, "t1");
    assert.equal(saved.history.at(-1).results[0].isError, true);
    // A reply racing in after cancellation is idempotent and cannot revive the old call.
    assert.deepEqual((await c.call("approval.reply", { approvalId: approval.params.approvalId, allow: true })).result, {});

    // The session is no longer busy immediately after the interrupted turn settles.
    const renamed = await c.call("session.rename", { sessionId: result.sessionId, title: "interrupt settled" });
    assert.equal(renamed.result.title, "interrupt settled");
  } finally {
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve e2e: run deadline dismisses its approval and leaves no executable stale prompt", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-serve-deadline-approval-"));
  const store = memStore();
  const deps = {
    ...baseDeps(toolProvider(), store, "suggest"),
    runLimits: () => ({ timeoutMs: 1_000, maxRounds: 10 }),
  };
  const srv = await startServe({ host: "127.0.0.1", port: 0, token: "tok", cwd: dir }, deps);
  const c = await connect(srv.port);
  let sending;
  try {
    await c.call("initialize", { token: "tok" });
    const { result } = await c.call("session.create", {});
    sending = c.call("session.send", { sessionId: result.sessionId, text: "wait forever for approval" });
    const approval = await c.waitEvent("approval.request");
    const failed = await Promise.race([
      sending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("run deadline did not settle approval")), 2_500)),
    ]);
    assert.equal(failed.error.code, -32603);
    assert.match(failed.error.message, /total deadline 1s reached/);
    assert.equal(existsSync(join(dir, "approved.txt")), false);

    const saved = store.saved.get(result.sessionId);
    assert.deepEqual(saved.history.slice(-2).map((message) => message.role), ["assistant", "tool"]);
    assert.match(saved.history.at(-1).results[0].content, /run deadline 1s reached/);

    // A late UI reply is idempotent and cannot resurrect the abandoned call after its map entry was removed.
    assert.deepEqual((await c.call("approval.reply", { approvalId: approval.params.approvalId, allow: true })).result, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(join(dir, "approved.txt")), false);
  } finally {
    if (sending) await sending.catch(() => {});
    c.close();
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
