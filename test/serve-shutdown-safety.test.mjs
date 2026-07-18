import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const events = [];
    const waiters = [];
    let nextId = 1;
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
        const complete = pending.get(message.id);
        pending.delete(message.id);
        complete(message);
        return;
      }
      if (!message.method) return;
      events.push(message);
      for (const wake of waiters.splice(0)) wake();
    });
    ws.once("open", () => resolve({
      ws,
      call(method, params = {}) {
        return new Promise((complete) => {
          const id = nextId++;
          pending.set(id, complete);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      waitEvent(method, timeoutMs = 5_000) {
        return new Promise((complete, rejectEvent) => {
          const scan = () => events.find((event) => event.method === method);
          const existing = scan();
          if (existing) return complete(existing);
          const timer = setTimeout(() => rejectEvent(new Error(`timeout waiting for ${method}`)), timeoutMs);
          const wake = () => {
            const event = scan();
            if (event) {
              clearTimeout(timer);
              complete(event);
            } else {
              waiters.push(wake);
            }
          };
          waiters.push(wake);
        });
      },
      close() {
        ws.close();
      },
    }));
    ws.once("error", reject);
  });
}

function memStore() {
  const files = new Map();
  return {
    load: (id) => files.get(id) ?? null,
    save: (meta, history, task) => files.set(meta.id, {
      meta: { ...meta },
      history: structuredClone(history),
      ...(task ? { task: structuredClone(task) } : {}),
    }),
    list: () => [...files.values()].map((entry) => entry.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => files.delete(id),
  };
}

function deps(provider, store, approval = "full-auto") {
  return {
    version: "0.0.0-test",
    providerId: provider.id,
    model: provider.model,
    buildSessionProvider: async () => provider,
    spawnSubagent: async () => "(subagents disabled in test)",
    sandbox: "off",
    approval,
    store,
    quietDiscovery: true,
  };
}

async function initialize(client) {
  const response = await client.call("initialize", { token: "tok" });
  assert.equal(response.result.protocol, 1);
}

const busyMessage = "server has active work — retry shutdown after all sessions and approvals are idle";

test("server.shutdown refuses an active turn without aborting another client", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shutdown-turn-"));
  let releaseTurn;
  let markStarted;
  let aborted = false;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const provider = {
    id: "fake",
    model: "fake-1",
    turn({ signal, onText }) {
      markStarted();
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise((resolve) => {
        releaseTurn = () => {
          onText("finished");
          resolve({ text: "finished", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
        };
      });
    },
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    deps(provider, memStore()),
  );
  const owner = await connect(server.port);
  const updater = await connect(server.port);
  let sending;
  try {
    await Promise.all([initialize(owner), initialize(updater)]);
    const sessionId = (await owner.call("session.create")).result.sessionId;
    sending = owner.call("session.send", { sessionId, text: "keep this turn alive" });
    await started;

    const refused = await updater.call("server.shutdown");
    assert.equal(refused.error.code, -32002);
    assert.equal(refused.error.message, busyMessage);
    assert.equal(aborted, false, "a refused updater shutdown did not cancel the owner's provider");
    assert.equal((await updater.call("session.list")).result.sessions.length, 1, "the server remains usable");

    releaseTurn();
    assert.equal((await sending).result.reply, "finished", "the other client's turn completes normally");
    const accepted = await updater.call("server.shutdown");
    assert.deepEqual(accepted.result, { accepted: true });
  } finally {
    releaseTurn?.();
    if (sending) await sending.catch(() => {});
    owner.close();
    updater.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server.shutdown leaves a pending approval intact, then succeeds after it resolves", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shutdown-approval-"));
  let turns = 0;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn({ onText }) {
      turns += 1;
      if (turns === 1) {
        return {
          text: "",
          toolUses: [{
            id: "brief",
            name: "task_intake",
            input: {
              intent: "change",
              goal: "write approved.txt",
              constraints: ["write only in the test workspace"],
              acceptance: ["approved.txt contains safe"],
              steps: ["record the brief", "write the file", "finish"],
            },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      if (turns === 2) {
        return {
          text: "",
          toolUses: [{
            id: "write",
            name: "write_file",
            input: { path: "approved.txt", content: "safe" },
          }],
          stop: "tool_use",
          usage: { input: 1, output: 1 },
        };
      }
      onText("done");
      return { text: "done", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    deps(provider, memStore(), "suggest"),
  );
  const owner = await connect(server.port);
  const updater = await connect(server.port);
  let sending;
  try {
    await Promise.all([initialize(owner), initialize(updater)]);
    const sessionId = (await owner.call("session.create")).result.sessionId;
    sending = owner.call("session.send", { sessionId, text: "write it" });
    const approval = await owner.waitEvent("approval.request");

    const refused = await updater.call("server.shutdown");
    assert.equal(refused.error.code, -32002);
    assert.equal(refused.error.message, busyMessage);
    assert.equal(existsSync(join(dir, "approved.txt")), false);

    await owner.call("approval.reply", { approvalId: approval.params.approvalId, allow: true });
    assert.equal((await sending).result.reply, "done");
    assert.equal(readFileSync(join(dir, "approved.txt"), "utf8"), "safe", "the attempted shutdown did not dismiss approval");
    assert.deepEqual((await updater.call("server.shutdown")).result, { accepted: true });
  } finally {
    if (sending) await sending.catch(() => {});
    owner.close();
    updater.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server.shutdown refuses async client work before it attaches a session", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shutdown-factory-"));
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn() {
      return { text: "unused", toolUses: [], stop: "end" };
    },
  };
  let finishFactory;
  let markFactoryStarted;
  const factoryStarted = new Promise((resolve) => { markFactoryStarted = resolve; });
  const serveDeps = deps(provider, memStore());
  serveDeps.buildSessionProvider = async () => {
    markFactoryStarted();
    return new Promise((resolve) => {
      finishFactory = () => resolve(provider);
    });
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    serveDeps,
  );
  const owner = await connect(server.port);
  const updater = await connect(server.port);
  let creating;
  try {
    await Promise.all([initialize(owner), initialize(updater)]);
    creating = owner.call("session.create");
    await factoryStarted;

    const refused = await updater.call("server.shutdown");
    assert.equal(refused.error.code, -32002);
    assert.equal(refused.error.message, busyMessage);

    finishFactory();
    assert.ok((await creating).result.sessionId, "the in-flight client request was not cancelled");
    assert.deepEqual((await updater.call("server.shutdown")).result, { accepted: true });
  } finally {
    finishFactory?.();
    if (creating) await creating.catch(() => {});
    owner.close();
    updater.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server.shutdown and session.delete stay BUSY until a timed-out compaction provider physically settles", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shutdown-compact-"));
  let calls = 0;
  let releaseCompact;
  let markCompactStarted;
  const compactStarted = new Promise((resolve) => { markCompactStarted = resolve; });
  const provider = {
    id: "fake",
    model: "fake-1",
    turn({ onText }) {
      if (calls++ === 0) {
        onText("ready");
        return Promise.resolve({ text: "ready", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
      }
      markCompactStarted();
      return new Promise((resolve) => {
        releaseCompact = () => resolve({
          text: "late summary",
          toolUses: [],
          stop: "end",
          usage: { input: 1, output: 1 },
        });
      });
    },
  };
  const serveDeps = { ...deps(provider, memStore()), compactTimeoutMs: 40 };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    serveDeps,
  );
  const owner = await connect(server.port);
  const updater = await connect(server.port);
  let compacting;
  try {
    await Promise.all([initialize(owner), initialize(updater)]);
    const sessionId = (await owner.call("session.create")).result.sessionId;
    assert.equal((await owner.call("session.send", { sessionId, text: "create history" })).result.reply, "ready");
    compacting = owner.call("session.compact", { sessionId });
    await compactStarted;
    const compactResult = await compacting;
    assert.equal(compactResult.error.code, -32603);
    assert.match(compactResult.error.message, /compaction failed|timed out/i);

    const deleteRefused = await owner.call("session.delete", { sessionId });
    assert.equal(deleteRefused.error.code, -32002, "the live session cannot disappear with a physical provider still pending");
    const sendRefused = await owner.call("session.send", { sessionId, text: "do not overlap compaction" });
    assert.equal(sendRefused.error.code, -32002, "the same session cannot start a turn while compaction is physically pending");
    const shutdownRefused = await updater.call("server.shutdown");
    assert.equal(shutdownRefused.error.code, -32002);
    assert.equal(shutdownRefused.error.message, busyMessage);

    releaseCompact();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual((await updater.call("server.shutdown")).result, { accepted: true });
  } finally {
    releaseCompact?.();
    if (compacting) await compacting.catch(() => {});
    owner.close();
    updater.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timed-out provider keeps its session BUSY until the physical request settles", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-provider-lease-"));
  let calls = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const provider = {
    id: "fake",
    model: "fake-1",
    turn({ onText }) {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        return new Promise((resolve) => {
          releaseFirst = () => {
            onText("late output must stay attached to the expired request");
            resolve({ text: "late", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
          };
        });
      }
      onText("next turn");
      return Promise.resolve({ text: "next turn", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
    },
  };
  const serveDeps = {
    ...deps(provider, memStore()),
    runLimits: () => ({ timeoutMs: 40, maxRounds: 10 }),
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    serveDeps,
  );
  const owner = await connect(server.port);
  try {
    await initialize(owner);
    const sessionId = (await owner.call("session.create")).result.sessionId;
    const first = owner.call("session.send", { sessionId, text: "let this provider ignore cancellation" });
    await firstStarted;
    const expired = await first;
    assert.equal(expired.error.code, -32603);
    assert.match(expired.error.message, /deadline|timed out/i);

    const overlap = await owner.call("session.send", { sessionId, text: "must wait for physical settlement" });
    assert.equal(overlap.error.code, -32002);
    assert.equal(calls, 1, "no second provider request started while the first physical request was pending");

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resumed = await owner.call("session.send", { sessionId, text: "now it is safe" });
    assert.equal(resumed.result.reply, "next turn");
    assert.equal(calls, 2);
  } finally {
    releaseFirst?.();
    owner.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server.shutdown tracks a guardian provider after the logical turn deadline", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shutdown-guardian-"));
  let round = 0;
  const provider = {
    id: "fake",
    model: "fake-1",
    async turn() {
      round += 1;
      if (round === 1) {
        return {
          text: "",
          toolUses: [{
            id: "brief",
            name: "task_intake",
            input: {
              intent: "change",
              goal: "exercise the guardian boundary",
              constraints: ["never execute the dangerous command"],
              acceptance: ["the command does not run"],
              steps: ["record the brief", "ask the guardian"],
            },
          }],
          stop: "tool_use",
        };
      }
      return {
        text: "",
        toolUses: [{ id: "danger", name: "bash", input: { command: "rm -rf /" } }],
        stop: "tool_use",
      };
    },
  };
  let releaseGuardian;
  let guardianSignal;
  let markGuardianStarted;
  const guardianStarted = new Promise((resolve) => { markGuardianStarted = resolve; });
  const guardianProvider = {
    id: "guardian",
    model: "guardian",
    turn({ signal }) {
      guardianSignal = signal;
      markGuardianStarted();
      return new Promise((resolve) => {
        releaseGuardian = () => resolve({
          text: '{"decision":"allow","reason":"late"}',
          toolUses: [],
          stop: "end",
        });
      });
    },
  };
  const serveDeps = {
    ...deps(provider, memStore()),
    runLimits: () => ({ timeoutMs: 1_000, maxRounds: 10 }),
    buildGuardian: async () => ({ enabled: true, provider: guardianProvider }),
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "tok", cwd: dir },
    serveDeps,
  );
  const owner = await connect(server.port);
  const updater = await connect(server.port);
  let sending;
  try {
    await Promise.all([initialize(owner), initialize(updater)]);
    const sessionId = (await owner.call("session.create")).result.sessionId;
    sending = owner.call("session.send", { sessionId, text: "exercise guardian timeout" });
    await guardianStarted;
    const sendResult = await sending;
    assert.equal(sendResult.error.code, -32603);
    assert.match(sendResult.error.message, /active-execution deadline/i);
    assert.equal(guardianSignal.aborted, true, "the logical deadline still cancels the guardian request");

    const shutdownRefused = await updater.call("server.shutdown");
    assert.equal(shutdownRefused.error.code, -32002, "the ignored guardian Promise remains in the process ledger");

    releaseGuardian();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual((await updater.call("server.shutdown")).result, { accepted: true });
  } finally {
    releaseGuardian?.();
    if (sending) await sending.catch(() => {});
    owner.close();
    updater.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
