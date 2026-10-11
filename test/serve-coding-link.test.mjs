import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";
import { RemoteCommandLedger } from "../dist/serve/remote-command-ledger.js";
import { ExternalSessionDeliveryUnknownError } from "../dist/external-sessions/types.js";

const nativeId = `ext_codex_${"a".repeat(24)}`;
const features = ["external.delegated-interaction.v1", "external.questions.v1"];
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`), pending = new Map(), events = [], waiters = []; let nextId = 1;
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
      call(method, params = {}) { return new Promise((done, fail) => {
        const id = nextId++; const timer = setTimeout(() => { pending.delete(id); fail(new Error(`fixture RPC timeout: ${method}`)); }, 8000);
        pending.set(id, { resolve: done, timer }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }); },
      waitFor(method, predicate = () => true) {
        const found = events.find((value) => value.method === method && predicate(value.params)); if (found) return Promise.resolve(found);
        return new Promise((done, fail) => { const waiter = { method, predicate, resolve: done };
          waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); fail(new Error(`fixture event timeout: ${method}`)); }, 5000); waiters.push(waiter);
        });
      },
    }));
  });
}
function memoryStore() {
  const records = new Map(); return { records, load: (id) => structuredClone(records.get(id) ?? null),
    save: (meta, history, task) => records.set(meta.id, structuredClone({ meta, history, task })),
    list: () => [...records.values()].map(({ meta }) => structuredClone(meta)), acquire: () => ({ ok: true }), release() {}, delete: (id) => records.delete(id) };
}
async function fixture(t, { interact = false, replay = false, compatible = true, unknownDelivery = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-connected-serve-")), home = join(root, "home"), repo = join(root, "repo");
  mkdirSync(home); mkdirSync(repo);
  const store = memoryStore(); const submitted = [], received = [], toolsSeen = [];
  let mode = "live", shareable = true, targetWorkspace = "workspace-a", selectedSpace = "personal", nativeState = "working", handle, readBarrier, readStarted;
  const clients = [];
  const externalSessions = {
    async readSession(sessionId) { assert.equal(sessionId, nativeId); readStarted?.(); await readBarrier; return {
      session: { id: nativeId, sourceId: "codex", workspaceId: targetWorkspace, workspaceName: "repo", title: "Release implementation",
        state: mode === "history" ? "stored" : nativeState, createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", ephemeral: false },
      messages: [], readOnly: mode === "history", controlMode: mode, conversationLinkAvailable: shareable,
    }; },
    async submit(sessionId, text, sink) {
      assert.equal(sink.existingSessionMessage, true); submitted.push({ sessionId, text });
      if (unknownDelivery) throw new ExternalSessionDeliveryUnknownError();
      if (interact) {
        sink.notice("Delivery-local notice"); sink.text("Delivery-local output"); sink.tool("fixture", "Delivery-local operation");
        received.push(await sink.confirm({ question: "May the native worker run this command?", allowAlways: true }, sink.signal));
        received.push(await sink.askUser({ questions: [{ id: "scope", question: "Which part?", options: [{ label: "Tests" }, { label: "UI" }] }] }, sink.signal));
      }
      return { sessionId, turnId: "private-native-turn", status: "completed", reply: "The original active turn accepted the follow-up.", delivery: "accepted" };
    },
    async close() {}, async resumeSession() { throw new Error("must not resume"); }, async forkSession() { throw new Error("must not fork"); },
    async createSession() { throw new Error("must not create"); },
  };
  const provider = () => {
    let round = 0;
    return { id: "fake", model: "fixture", async turn({ tools, history }) {
      round++; toolsSeen.push(tools.map((tool) => tool.name));
      const tool = round === 1 ? { name: "task_intake", input: { intent: "change", goal: "Send one explicitly selected native-session follow-up",
        constraints: ["do not create or fork a session"], acceptance: ["return the delivery receipt"], steps: ["request confirmation", "deliver"] } }
        : round === 2 || (round === 3 && replay) ? { name: "connected_coding_session", input: { action: "message", text: "Please check the failing tests." } }
        : undefined;
      if (tool) return { text: "", toolUses: [{ id: tool.name === "connected_coding_session"
        ? replay === "distinct" ? `call-${round}` : "same-tool-call" : "intake", ...tool }], stop: "tool_use", usage: { input: 1, output: 1 } };
      return { text: "I checked the delivery receipt; accepted does not mean finished.", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    } };
  };
  t.after(async () => { for (const client of clients) client.ws.close(); await handle?.close(); rmSync(root, { recursive: true, force: true }); });
  const ledger = new RemoteCommandLedger({ home });
  handle = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: repo }, {
    version: "test", providerId: "fake", model: "fixture", buildSessionProvider: async () => provider(), spawnSubagent: async () => "unused",
    sandbox: "off", approval: "full-auto", quietDiscovery: true, store, agentTeamHome: home,
    remoteCommandLedger: ledger, externalSessions,
    runtimeInfo: () => ({ providerId: "fake", model: "fixture", profileId: "personal", spaceId: selectedSpace }),
  });
  const attach = async () => { const client = await connect(handle.port); clients.push(client);
    const initialized = await client.call("initialize", { token: "fixture-token", ...(compatible ? { capabilities: { features } } : {}) });
    assert.ok(initialized.result.capabilities.methods.includes("session.coding-link.set")); return client;
  };
  const client = await attach(); const created = await client.call("session.create"); assert.ok(created.result, JSON.stringify(created));
  const sessionId = created.result.sessionId;
  const setLink = (targetSessionId = nativeId, expectedRevision = null) => client.call("session.coding-link.set", { sessionId, targetSessionId, expectedRevision });
  return { client, handle, attach, sessionId, setLink, submitted, received, store, toolsSeen, ledger,
    history() { mode = "history"; }, privateWorker() { shareable = false; }, changeWorkspace() { targetWorkspace = "workspace-b"; },
    changeSpace() { selectedSpace = "organization-fixture"; },
    idle() { nativeState = "idle"; },
    holdReads(count = 2) {
      let release, ready, started = 0;
      readBarrier = new Promise((resolve) => { release = resolve; });
      const bothStarted = new Promise((resolve) => { ready = resolve; });
      readStarted = () => { if (++started === count) ready(); };
      return { release, ready: bothStarted };
    } };
}
test("connecting existing sessions persists a CAS address, starts nothing and rejects history/private workers", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); assert.deepEqual((await f.client.call("session.coding-link.get", { sessionId: f.sessionId })).result, { link: null });
  const linked = await f.setLink(); assert.ok(linked.result, JSON.stringify(linked));
  assert.equal(linked.result.link.sessionId, nativeId); assert.equal(linked.result.available, true);
  assert.equal(f.store.records.get(f.sessionId).meta.codingSessionLink.revision, linked.result.link.revision);
  assert.deepEqual(f.submitted, []);
  assert.equal((await f.setLink()).error.code, -32005);
  const detached = await f.setLink(null, linked.result.link.revision); assert.deepEqual(detached.result, { link: null });
  f.history(); assert.equal((await f.setLink()).error.code, -32005);
});
test("a private coding worktree cannot be linked as another Agent's session", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); f.privateWorker(); assert.equal((await f.setLink()).error.code, -32005); assert.deepEqual(f.submitted, []);
});
test("full-auto still asks for the exact target; native permission and question cards return to the same chat", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { interact: true }); assert.ok((await f.setLink()).result);
  const sending = f.client.call("session.send", { sessionId: f.sessionId, text: "Tell the connected session to check tests." });
  const approval = (await f.client.waitFor("approval.request")).params;
  assert.equal(approval.sessionId, f.sessionId); assert.equal(approval.allowAlways, false);
  assert.ok(approval.question.includes(nativeId)); assert.ok(approval.question.includes("Release implementation"));
  assert.deepEqual(f.submitted, []);
  assert.equal((await f.client.call("approval.reply", { approvalId: approval.approvalId, allow: true })).error, undefined);
  const nativeApproval = (await f.client.waitFor("external.approval.request")).params;
  assert.equal(nativeApproval.parentSessionId, f.sessionId); assert.equal(nativeApproval.sessionId, nativeId); assert.equal(nativeApproval.allowAlways, false);
  assert.equal((await f.client.call("external.approval.reply", { sessionId: nativeId, turnId: nativeApproval.turnId, approvalId: nativeApproval.approvalId, allow: true, commandId: randomUUID() })).error, undefined);
  const question = (await f.client.waitFor("external.question.request")).params;
  assert.equal(question.parentSessionId, f.sessionId); assert.equal(question.agentPath, "/root/connected-session");
  assert.equal((await f.client.call("external.question.reply", { sessionId: nativeId, turnId: question.turnId, questionId: question.questionId,
    answers: { scope: { answers: ["Tests"] } }, commandId: randomUUID() })).error, undefined);
  assert.equal((await sending).error, undefined); assert.deepEqual(f.submitted, [{ sessionId: nativeId, text: "Please check the failing tests." }]);
  assert.deepEqual(f.received, [true, { scope: { answers: ["Tests"] } }]);
  assert.equal(f.client.events.some((event) => /^external\.event\.(turn_start|turn_end|text|tool|notice)$/u.test(event.method)), false,
    "linked delivery must not impersonate the original native controller or trigger transcript auto-refresh");
  const receipt = JSON.stringify(f.store.records.get(f.sessionId).history);
  assert.match(receipt, /\\?"status\\?":\\?"accepted\\?"/);
  assert.doesNotMatch(receipt, /private-native-turn/);
});
test("denying or disconnecting while the first card is pending never sends", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const link = (await f.setLink()).result.link;
  const sending = f.client.call("session.send", { sessionId: f.sessionId, text: "Send to the selected session." });
  const approval = (await f.client.waitFor("approval.request")).params;
  assert.ok((await f.setLink(null, link.revision)).result);
  await f.client.call("approval.reply", { approvalId: approval.approvalId, allow: true });
  await sending; assert.deepEqual(f.submitted, []);
});
test("a repeated model tool call reuses its durable command receipt instead of sending twice", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { replay: true }); assert.ok((await f.setLink()).result);
  const sending = f.client.call("session.send", { sessionId: f.sessionId, text: "Send one message only." });
  const approval = (await f.client.waitFor("approval.request")).params;
  await f.client.call("approval.reply", { approvalId: approval.approvalId, allow: true });
  const second = await f.client.waitFor("approval.request", (entry) => entry.approvalId !== approval.approvalId);
  await f.client.call("approval.reply", { approvalId: second.params.approvalId, allow: true });
  await sending; assert.equal(f.submitted.length, 1);
});
test("a legacy client cannot send into native sessions by enabling full-auto", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { compatible: false }); assert.ok((await f.setLink()).result);
  const sending = f.client.call("session.send", { sessionId: f.sessionId, text: "Send a follow-up." });
  const approval = (await f.client.waitFor("approval.request")).params;
  await f.client.call("approval.reply", { approvalId: approval.approvalId, allow: true });
  await sending; assert.deepEqual(f.submitted, []);
});
test("changing the native workspace makes a selected link unavailable without guessing another target", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); assert.ok((await f.setLink()).result); f.changeWorkspace();
  const view = await f.client.call("session.coding-link.get", { sessionId: f.sessionId });
  assert.equal(view.result.available, false); assert.equal(view.result.link.sessionId, nativeId); assert.deepEqual(f.submitted, []);
});
test("forked conversations do not inherit native-session links or delegation authority", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); assert.ok((await f.setLink()).result);
  const fork = await f.client.call("session.fork", { sessionId: f.sessionId }); assert.ok(fork.result, JSON.stringify(fork));
  const forkId = fork.result.sessionId;
  const view = await f.client.call("session.coding-link.get", { sessionId: forkId }); assert.deepEqual(view.result, { link: null });
  assert.equal(f.store.records.get(forkId).meta.agentDelegation, undefined); assert.deepEqual(f.submitted, []);
});
test("concurrent selection cannot overwrite a newer link after an asynchronous native read", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const gate = f.holdReads();
  const first = f.setLink(), second = f.setLink(); await gate.ready; gate.release(); const results = await Promise.all([first, second]);
  assert.equal(results.filter((entry) => entry.result).length, 1);
  assert.equal(results.filter((entry) => entry.error?.code === -32005).length, 1);
  assert.deepEqual(f.submitted, []);
});
test("the coding link respects the original chat control lease and immutable Space", { timeout: 15000 }, async (t) => {
  const f = await fixture(t); const owner = await f.client.call("session.control.acquire", { sessionId: f.sessionId });
  assert.ok(owner.result?.lease, JSON.stringify(owner)); const other = await f.attach();
  const rejected = await other.call("session.coding-link.set", { sessionId: f.sessionId, targetSessionId: nativeId, expectedRevision: null });
  assert.equal(rejected.error.code, -32005);
  const linked = await f.client.call("session.coding-link.set", { sessionId: f.sessionId, targetSessionId: nativeId, expectedRevision: null, controlLease: owner.result.lease });
  assert.ok(linked.result, JSON.stringify(linked)); f.changeSpace();
  assert.ok((await f.client.call("session.coding-link.get", { sessionId: f.sessionId })).error);
  assert.deepEqual(f.submitted, []);
});

test("an uncertain native send cannot be retried under a fresh model call or link revision", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { replay: "distinct", unknownDelivery: true }); const link = (await f.setLink()).result.link;
  const sending = f.client.call("session.send", { sessionId: f.sessionId, text: "Send exactly once; never retry an unconfirmed delivery." });
  const first = (await f.client.waitFor("approval.request")).params;
  await f.client.call("approval.reply", { approvalId: first.approvalId, allow: true });
  const second = (await f.client.waitFor("approval.request", (entry) => entry.approvalId !== first.approvalId)).params;
  await f.client.call("approval.reply", { approvalId: second.approvalId, allow: true }); await sending;
  assert.equal(f.submitted.length, 1); assert.equal(f.ledger.snapshot()[0].outcome, undefined);
  assert.ok((await f.setLink(null, link.revision)).result); assert.ok((await f.setLink()).result);
  assert.equal(f.ledger.snapshot()[0].outcome, undefined, "relink is not an uncertainty-recovery grant");
  await f.client.call("external.sessions.read", { sessionId: nativeId }); assert.equal(f.ledger.snapshot()[0].outcome, undefined);
  f.idle(); await f.client.call("external.sessions.read", { sessionId: nativeId });
  assert.equal(f.ledger.snapshot()[0].outcome.kind, "result_omitted");
  assert.equal(f.submitted.length, 1);
});
