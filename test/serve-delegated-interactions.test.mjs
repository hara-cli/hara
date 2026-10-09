import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";
import { RemoteCommandLedger } from "../dist/serve/remote-command-ledger.js";

const features = ["external.delegated-interaction.v1", "external.questions.v1"];
const providerSessionId = `ext_codex_${"e".repeat(24)}`;
const questions = { questions: [{ id: "implementation", question: "Which bounded implementation?",
  options: [{ label: "A" }, { label: "B" }] }] };
const delegatedEvents = ["external.approval.request", "external.approval.resolved", "external.question.request", "external.question.resolved"];
const requestProjection = ({ deliveryCursor: _cursor, ...value }) => value;
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture worker did not settle")), 5_000); })]); }
  finally { clearTimeout(timer); }
}
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const pending = new Map(); const events = []; const waiters = []; let nextId = 1;
    ws.on("message", (raw) => {
      const value = JSON.parse(String(raw)); const rpc = pending.get(value.id);
      if (rpc) { pending.delete(value.id); clearTimeout(rpc.timer); rpc.resolve(value); return; }
      if (!value.method) return; events.push(value);
      for (const waiter of [...waiters]) if (waiter.method === value.method && waiter.predicate(value.params)) {
        waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value);
      }
    });
    ws.on("close", () => { for (const rpc of pending.values()) { clearTimeout(rpc.timer); rpc.resolve({ error: { code: -1, message: "fixture disconnected" } }); } pending.clear(); });
    ws.once("error", reject);
    ws.once("open", () => resolve({ ws, events,
      call(method, params = {}) {
        return new Promise((done, fail) => {
          const id = nextId++; const timer = setTimeout(() => { pending.delete(id); fail(new Error(`fixture RPC timeout: ${method}`)); }, 15_000);
          pending.set(id, { resolve: done, timer }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      waitFor(method, predicate = () => true) {
        const found = events.find((value) => value.method === method && predicate(value.params)); if (found) return Promise.resolve(found);
        return new Promise((done, fail) => {
          const waiter = { method, predicate, resolve: done, timer: undefined };
          waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); fail(new Error(`fixture event timeout: ${method}`)); }, 5_000); waiters.push(waiter);
        });
      },
    }));
  });
}
const memoryStore = () => {
  const records = new Map(); return { load: (id) => records.get(id) ?? null,
    save: (meta, history, task) => records.set(meta.id, { meta: { ...meta }, history: structuredClone(history), task: task && structuredClone(task) }),
    list: () => [...records.values()].map(({ meta }) => meta), acquire: () => ({ ok: true }), release() {}, delete: (id) => records.delete(id) };
};
function provider() {
  let round = 0; return { id: "fake", model: "fixture", async turn() {
    round++; let tool;
    if (round === 1) tool = { name: "task_intake", input: { intent: "change", goal: "delegate one bounded coding task",
      constraints: ["preserve the original checkout"], acceptance: ["receive explicit user choices through the parent chat"], steps: ["delegate", "wait", "verify"] } };
    else if (round === 2) tool = { name: "spawn_agent", input: { task_name: "coder", message: "Review this isolated fixture", runtime: "codex", workspace: "isolated-write" } };
    else if (round === 3) tool = { name: "wait_agent", input: { target: "/root/coder", timeout_ms: 20_000 } };
    else if (round === 4) tool = { name: "task_checkpoint", input: { completion: { state: "verified", evidence: ["the isolated fixture returned its explicit interaction receipt"] } } };
    return { text: tool ? "" : "Delegation finished.", toolUses: tool ? [{ id: `fixture-${round}`, ...tool }] : [], stop: tool ? "tool_use" : "end", usage: { input: 1, output: 1 } };
  } };
}
async function fixture(t, { compatible = true, approval = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-delegated-serve-")); const home = join(root, "home"); const repo = join(root, "repo");
  mkdirSync(home); mkdirSync(repo); writeFileSync(join(repo, "source.txt"), "unchanged\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Hara Fixture"], ["config", "user.email", "fixture@example.test"], ["add", "source.txt"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  }
  const received = []; let submitted = 0; const controller = new AbortController(); let server; const clients = [];
  let finish; const settled = new Promise((resolve) => { finish = resolve; });
  const externalSessions = {
    async createCodingSession(input) { assert.notEqual(input.cwd, repo); return { session: { id: providerSessionId, sourceId: "codex", state: "idle" }, messages: [], readOnly: false, controlMode: "managed" }; },
    async submit(sessionId, _text, sink) {
      submitted++;
      try {
        if (approval) received.push(await sink.confirm({ question: "Run the bounded fixture command?", allowAlways: true }, controller.signal));
        received.push(await sink.askUser(questions, controller.signal));
        return { sessionId, turnId: "native-private-turn", status: sink.signal.aborted ? "interrupted" : "completed", reply: "No answer text is echoed." };
      } finally { finish(); }
    }, interrupt: async () => { controller.abort(); }, close: async () => { controller.abort(); },
  };
  t.after(async () => { for (const client of clients) client.ws.close(); await server?.close(); rmSync(root, { recursive: true, force: true }); });
  server = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: repo }, {
    version: "test", providerId: "fake", model: "fixture", buildSessionProvider: async () => provider(), spawnSubagent: async () => "unused",
    sandbox: "off", approval: "full-auto", quietDiscovery: true, store: memoryStore(), agentTeamHome: home,
    remoteCommandLedger: new RemoteCommandLedger({ home }), externalSessions, pendingInputReconnectGraceMs: 1_000,
    runtimeInfo: () => ({ providerId: "fake", model: "fixture", profileId: "personal", spaceId: "personal" }),
  });
  const attach = async ({ compatible: clientCompatible = compatible } = {}) => {
    const client = await connect(server.port); clients.push(client);
    await client.call("initialize", { token: "fixture-token", ...(clientCompatible ? { capabilities: { features } } : {}) }); return client;
  };
  const client = await attach(); const created = await client.call("session.create"); const parentSessionId = created.result.sessionId;
  const sending = client.call("session.send", { sessionId: parentSessionId, text: "Delegate this bounded change to Codex." });
  const launch = await client.waitFor("approval.request");
  assert.equal((await client.call("approval.reply", { approvalId: launch.params.approvalId, allow: true })).error, undefined);
  return { client, server, parentSessionId, sending, received, attach, settled: () => bounded(settled), submitted: () => submitted };
}

test("delegated permission and question cards belong to the parent chat and exact external turn", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const { params: pending } = await f.client.waitFor("external.approval.request");
  assert.equal(pending.parentSessionId, f.parentSessionId); assert.equal(pending.agentPath, "/root/coder");
  assert.equal(pending.sessionId, providerSessionId); assert.equal(pending.allowAlways, false); assert.ok(pending.expiresAt);
  const hidden = (await f.client.call("events.snapshot", { sessionIds: [] })).result;
  assert.deepEqual(hidden.approvals, []); assert.deepEqual(hidden.externalQuestions, []);
  const legacy = await f.attach({ compatible: false });
  const legacySnapshot = (await legacy.call("events.snapshot", { sessionIds: [f.parentSessionId] })).result;
  assert.deepEqual(legacySnapshot.approvals, []); assert.deepEqual(legacySnapshot.externalQuestions, []);
  assert.equal((await legacy.call("events.replay", { streamId: pending.deliveryCursor.streamId, after: pending.deliveryCursor.sequence - 1 })).error, undefined);
  assert.equal(legacy.events.some((event) => delegatedEvents.includes(event.method)), false, "replay does not leak delegated cards to legacy observers");
  assert.equal((await f.client.call("approval.reply", { approvalId: pending.approvalId, allow: true })).error.code, -32005);
  const reply = { approvalId: pending.approvalId, sessionId: pending.sessionId, turnId: pending.turnId, allow: true, commandId: randomUUID() };
  assert.equal((await f.client.call("external.approval.reply", { ...reply, turnId: `extturn_${randomUUID()}`, commandId: randomUUID() })).error.code, -32005);
  assert.equal((await f.client.call("external.approval.reply", reply)).error, undefined);
  assert.equal((await f.client.call("external.approval.reply", reply)).error, undefined);
  const { params: question } = await f.client.waitFor("external.question.request");
  assert.equal(question.parentSessionId, f.parentSessionId); assert.equal(question.agentPath, "/root/coder");
  assert.deepEqual((await f.client.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, []);
  assert.deepEqual((await legacy.call("events.snapshot", { sessionIds: [f.parentSessionId] })).result.externalQuestions, []);
  assert.equal((await legacy.call("events.replay", { streamId: question.deliveryCursor.streamId, after: question.deliveryCursor.sequence - 1 })).error, undefined);
  assert.equal(legacy.events.some((event) => delegatedEvents.includes(event.method)), false, "live/replay question events require original feature negotiation");
  const answer = { questionId: question.questionId, sessionId: question.sessionId, turnId: question.turnId, answers: { implementation: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("external.question.reply", { ...answer, turnId: `extturn_${randomUUID()}`, commandId: randomUUID() })).error.code, -32005);
  assert.equal((await f.client.call("external.question.reply", answer)).error, undefined);
  assert.equal((await f.client.call("external.question.reply", answer)).error, undefined);
  assert.equal((await f.sending).error, undefined); assert.deepEqual(f.received, [true, { implementation: { answers: ["B"] } }]);
  assert.equal(f.submitted(), 1);
});

test("legacy clients receive no delegated permission or question choice and never default to an answer", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { compatible: false }); await f.sending;
  assert.deepEqual(f.received, [false, {}]); assert.equal(f.submitted(), 1);
  assert.equal(f.client.events.some((event) => ["external.approval.request", "external.question.request"].includes(event.method)), false);
});

test("interrupting the parent cancels its delegated form and rejects late answers", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { approval: false }); const { params: question } = await f.client.waitFor("external.question.request");
  assert.equal((await f.client.call("session.interrupt", { sessionId: f.parentSessionId })).error, undefined);
  await f.sending; await f.settled(); assert.deepEqual(f.received, [{}]);
  assert.equal((await f.client.call("external.question.reply", { questionId: question.questionId, sessionId: question.sessionId, turnId: question.turnId,
    answers: { implementation: { answers: ["B"] } }, commandId: randomUUID() })).error.code, -32005);
});

test("interrupting the parent denies its delegated permission card and any following form", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const { params: approval } = await f.client.waitFor("external.approval.request");
  assert.equal((await f.client.call("session.interrupt", { sessionId: f.parentSessionId })).error, undefined);
  await f.sending; await f.settled(); assert.deepEqual(f.received, [false, {}]);
  assert.equal((await f.client.call("external.approval.reply", { approvalId: approval.approvalId, sessionId: approval.sessionId,
    turnId: approval.turnId, allow: true, commandId: randomUUID() })).error.code, -32005);
  assert.equal(f.client.events.some((event) => event.method === "external.question.request"), false,
    "a cancelled permission must not admit a follow-on form");
});

test("delegated forms recover with their parent binding and original expiry after a socket reconnect", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { approval: false }); const { params: question } = await f.client.waitFor("external.question.request");
  await new Promise((resolve) => { f.client.ws.once("close", resolve); f.client.ws.close(); });
  const reconnected = await f.attach(); const snapshot = (await reconnected.call("events.snapshot", { sessionIds: [f.parentSessionId] })).result;
  assert.deepEqual(snapshot.externalQuestions, [requestProjection(question)]);
  assert.deepEqual((await reconnected.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, []);
  assert.equal((await reconnected.call("external.question.reply", { questionId: question.questionId, sessionId: question.sessionId, turnId: question.turnId,
    answers: { implementation: { answers: ["B"] } }, commandId: randomUUID() })).error, undefined);
  await reconnected.waitFor("external.question.resolved", (params) => params.questionId === question.questionId);
  await f.settled();
  assert.deepEqual(f.received, [{ implementation: { answers: ["B"] } }]); assert.equal(f.submitted(), 1);
});

test("delegated approval reconnect restores the original card only for its requested parent and never auto-allows", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t); const { params: approval } = await f.client.waitFor("external.approval.request");
  await new Promise((resolve) => { f.client.ws.once("close", resolve); f.client.ws.close(); });
  assert.deepEqual(f.received, [], "disconnect is not an approval");
  const reconnected = await f.attach();
  for (const sessionIds of [[], [randomUUID()], [providerSessionId]]) {
    const hidden = (await reconnected.call("events.snapshot", { sessionIds })).result;
    assert.deepEqual(hidden.approvals, []); assert.deepEqual(hidden.externalQuestions, []);
  }
  const snapshot = (await reconnected.call("events.snapshot", { sessionIds: [f.parentSessionId] })).result;
  assert.deepEqual(snapshot.approvals, [{ ...requestProjection(approval), scope: "external" }]);
  assert.equal((await reconnected.call("external.approval.reply", { approvalId: approval.approvalId, sessionId: approval.sessionId,
    turnId: approval.turnId, allow: true, commandId: randomUUID() })).error, undefined);
  const { params: question } = await reconnected.waitFor("external.question.request");
  assert.equal((await reconnected.call("external.question.reply", { questionId: question.questionId, sessionId: question.sessionId, turnId: question.turnId,
    answers: { implementation: { answers: ["A"] } }, commandId: randomUUID() })).error, undefined);
  await f.settled(); assert.deepEqual(f.received, [true, { implementation: { answers: ["A"] } }]); assert.equal(f.submitted(), 1);
});
