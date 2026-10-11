import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { startServe } from "../dist/serve/server.js";
import { RemoteCommandLedger } from "../dist/serve/remote-command-ledger.js";
import { AgentFollowupStore, processAgentFollowupDelivery } from "../dist/gateway/agent-followup.js";

const features = ["agent.delegated-interaction.v1", "external.delegated-interaction.v1", "external.questions.v1", "task.approvals.v1"];
const nativeId = `ext_codex_${"c".repeat(24)}`;
const question = { questions: [{ id: "scope", question: "Which fixture implementation?", options: [{ label: "A" }, { label: "B" }] }] };
const cardEvents = ["agent.approval.request", "agent.approval.resolved", "agent.question.request", "agent.question.resolved"];
const projection = ({ deliveryCursor: _cursor, ...value }) => value;

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`), events = [], requests = new Map(); let next = 0;
    ws.on("message", (raw) => {
      const value = JSON.parse(String(raw)), request = requests.get(value.id);
      if (request) { requests.delete(value.id); clearTimeout(request.timer); request.resolve(value); }
      else if (value.method) events.push(value);
    });
    ws.on("close", () => {
      for (const request of requests.values()) { clearTimeout(request.timer); request.resolve({ error: { code: -1, message: "fixture disconnected" } }); }
      requests.clear();
    });
    ws.once("error", reject);
    ws.once("open", () => resolve({ ws, events,
      call(method, params = {}) {
        return new Promise((done, fail) => {
          // session.send waits for the entire two-colleague run, including several real human-card
          // decisions and isolated worktree setup. A transport-only deadline is not its task budget.
          const id = ++next, timer = setTimeout(() => { requests.delete(id); fail(Error(`fixture RPC timeout: ${method}`)); }, method === "session.send" ? 30_000 : 12_000);
          requests.set(id, { resolve: done, timer }); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
      async event(method, predicate = () => true) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const event = events.find((event) => event.method === method && predicate(event.params));
          if (event) return event.params;
          await new Promise((done) => setTimeout(done, 5));
        }
        throw Error(`fixture event timeout: ${method}; recent events: ${JSON.stringify(events.slice(-5)).slice(0, 2_000)}`);
      },
    }));
  });
}

async function fixture(t, { mode = "choice", clientFeatures = features, timeout = 5_000, holdCoder = false, approvalMode = "suggest" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hara-colleague-input-")), home = join(root, "home"), repo = join(root, "repo");
  const previousHome = process.env.HOME; process.env.HOME = home;
  mkdirSync(join(home, ".hara", "roles"), { recursive: true }); mkdirSync(repo);
  writeFileSync(join(repo, "source.txt"), "original\n");
  if (mode === "coding") for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.test"], ["add", "source.txt"], ["commit", "-qm", "fixture"]]) {
    const git = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(git.status, 0, git.stderr);
  }
  for (const name of ["architect", "manager", "coder"]) writeFileSync(join(home, ".hara", "roles", `${name}.md`),
    `---\nname: ${name}\ndisplay-name: ${name === "coder" ? "Cora" : name}\ndescription: Fixture ${name}\n---\nPERSONA_${name.toUpperCase()}\n`);
  const records = new Map(), observations = [], clients = [];
  const followups = new AgentFollowupStore(home), sourceTime = Date.now();
  if (mode === "followup") followups.observe("feishu-fixture", {
    chatId: "oc_fixture", userId: "ou_fixture", userName: "Fixture owner", text: "Observe this thread only",
    messageId: "om_fixture_root", createdAtMs: sourceTime, senderType: "user", chatType: "group", mentions: [{ isSelf: true }],
  }, true);
  const store = { load: (id) => records.get(id) ?? null, save: (meta, history, task) => records.set(meta.id, structuredClone({ meta, history, task })),
    list: () => [...records.values()].map(({ meta }) => meta), acquire: () => ({ ok: true }), release() {}, delete: (id) => records.delete(id) };
  let releaseCoder; const coderHold = new Promise((done) => { releaseCoder = done; });
  let server, submitted = 0;
  const provider = () => ({ id: "fake", model: "fixture", async turn({ system, history, onText, signal }) {
    const name = /PERSONA_(ARCHITECT|MANAGER|CODER)/.exec(system)?.[1].toLowerCase();
    const lastUser = history.findLastIndex((message) => message.role === "user");
    const followupTurn = mode === "followup" && String(history[lastUser]?.content).startsWith("A human explicitly authorized");
    const results = (mode === "followup" ? history.slice(lastUser + 1) : history).filter((message) => message.role === "tool").flatMap((message) => message.results);
    const has = (tool) => results.some((result) => result.name === tool); let tool;
    if (!has("task_intake")) {
      if (name === "coder" && holdCoder) await Promise.race([coderHold, new Promise((done) => signal.addEventListener("abort", done, { once: true }))]);
      tool = { name: "task_intake", input: { intent: "change", goal: "One bounded colleague interaction", constraints: ["private fixture only"],
        acceptance: ["explicit human decision or cancellation"], steps: ["delegate", "decide", "verify"] } };
    } else if (name !== "coder" && !has("agent_contact")) tool = { name: "agent_contact", input: {
      action: "message", recipient: `global:${name === "architect" ? "manager" : "coder"}`, message: `Handle fixture ${mode}` } };
    else if (name === "coder" && mode === "write" && !has("write_file")) tool = { name: "write_file", input: { path: "approved.txt", content: "only after approval\n" } };
    else if (name === "coder" && mode === "followup" && !followupTurn && !has("agent_followup")) tool = { name: "agent_followup", input: {
      action: "grant", candidateId: followups.candidates()[0].id, minutes: 10, maxMessages: 2 } };
    else if (name === "coder" && followupTurn && !has("write_file")) tool = { name: "write_file", input: { path: "followup.txt", content: "explicit follow-up approval\n" } };
    else if (name === "coder" && mode === "coding" && !has("spawn_agent")) tool = { name: "spawn_agent", input: {
      task_name: "implementation", message: "Bounded fixture", runtime: "codex", workspace: "isolated-write" } };
    else if (name === "coder" && mode === "coding" && !has("wait_agent")) tool = { name: "wait_agent", input: { target: "/root/implementation", timeout_ms: 20_000 } };
    else if (name === "coder" && mode !== "coding" && (mode !== "followup" || followupTurn) && !has("ask_user")) tool = { name: "ask_user", input: {
      question: "Which fixture implementation?", options: ["A", "B"], default: "A" } };
    else if (!has("task_checkpoint")) {
      observations.push({ name, results: structuredClone(results) });
      tool = { name: "task_checkpoint", input: { completion: { state: "verified", evidence: ["fixture decision returned without changing its scope"] } } };
    }
    const text = tool ? "" : "Fixture handled."; if (text) onText?.(text);
    return { text, toolUses: tool ? [{ id: `${name}-${tool.name}`, ...tool }] : [], stop: tool ? "tool_use" : "end", usage: { input: 1, output: 1 } };
  } });
  const externalSessions = {
    async createCodingSession() { return { session: { id: nativeId, sourceId: "codex", state: "idle" }, messages: [], readOnly: false, controlMode: "managed" }; },
    async submit(sessionId, _text, sink) {
      submitted++; observations.push({ nativeApproval: await sink.confirm({ question: "Run this native fixture?", allowAlways: true }, sink.signal) });
      observations.push({ nativeAnswers: await sink.askUser(question, sink.signal) });
      return { sessionId, turnId: "private-native-turn", status: sink.signal.aborted ? "interrupted" : "completed", reply: "Native fixture finished." };
    }, async interrupt() {}, async close() {},
  };
  t.after(async () => { releaseCoder(); for (const client of clients) client.ws.close(); await server?.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true }); });
  server = await startServe({ host: "127.0.0.1", port: 0, token: "fixture-token", cwd: repo }, {
    version: "test", providerId: "fake", model: "fixture", buildSessionProvider: async () => provider(), spawnSubagent: async () => "unused",
    sandbox: "off", approval: approvalMode, guardian: { enabled: false }, quietDiscovery: true, store, discoveryHome: home, agentTeamHome: home,
    externalSessions, remoteCommandLedger: new RemoteCommandLedger({ home }), externalUserQuestionTimeoutMs: timeout, pendingInputReconnectGraceMs: 800,
    computerSettings: () => ({ mode: "off", apps: [] }), saveComputerSettings: (input) => input,
    runtimeInfo: () => ({ providerId: "fake", model: "fixture", profileId: "personal", spaceId: "personal" }),
  });
  const attach = async (declared = clientFeatures) => {
    const client = await connect(server.port); clients.push(client);
    await client.call("initialize", { token: "fixture-token", capabilities: { features: declared } }); return client;
  };
  const client = await attach(), created = await client.call("session.create", { cwd: repo, agentRef: "global:architect" });
  assert.ok(created.result, JSON.stringify(created)); const parent = created.result.sessionId;
  const sending = client.call("session.send", { sessionId: parent, text: `Handle fixture ${mode} through Manager and Cora.` });
  return { client, parent, sending, attach, repo, records, observations, releaseCoder, submitted: () => submitted, followups };
}

test("a named colleague owns authorized Feishu replies and returns decisions and closure without a main-Agent hop", { timeout: 40_000 }, async (t) => {
  // Even a full-auto parent cannot grant this scope silently or let a group bypass fresh file approval.
  const f = await fixture(t, { mode: "followup", approvalMode: "full-auto" });
  const grantCard = await f.client.event("agent.approval.request", (p) => p.question.includes("Feishu thread"));
  assert.equal(grantCard.parentSessionId, f.parent); assert.equal(grantCard.executorDisplayName, "Cora");
  assert.equal(f.followups.list(f.parent).length, 0);
  const approved = await f.client.call("agent.approval.reply", { approvalId: grantCard.approvalId, sessionId: grantCard.sessionId,
    turnId: grantCard.turnId, allow: true, commandId: randomUUID() });
  assert.ok(approved.result, JSON.stringify(approved)); assert.ok((await f.sending).result);
  const [grant] = f.followups.list(f.parent); assert.equal(grant.agentRef, "global:coder"); assert.equal(grant.sessionId, grantCard.sessionId);
  const message = { chatId: "oc_fixture", userId: "ou_fixture", userName: "Fixture owner", text: "Write the fixture and ask me which option.",
    messageId: "om_fixture_followup", createdAtMs: Date.now(), senderType: "user", chatType: "group",
    replyContext: { valid: true, rootMessageId: "om_fixture_root", parentMessageId: "om_fixture_root" } };
  assert.equal(f.followups.admit("feishu-fixture", message, true), "queued");
  const writeCard = await f.client.event("agent.approval.request", (p) => p.approvalId !== grantCard.approvalId);
  assert.equal(writeCard.parentSessionId, f.parent); assert.equal(writeCard.sessionId, grant.sessionId);
  assert.equal(existsSync(join(f.repo, "followup.txt")), false);
  assert.ok((await f.client.call("agent.approval.reply", { approvalId: writeCard.approvalId, sessionId: writeCard.sessionId,
    turnId: writeCard.turnId, allow: true, commandId: randomUUID() })).result);
  const choice = await f.client.event("agent.question.request");
  assert.equal(choice.parentSessionId, f.parent); assert.equal(choice.executorDisplayName, "Cora");
  assert.ok((await f.client.call("agent.question.reply", { questionId: choice.questionId, sessionId: choice.sessionId,
    turnId: choice.turnId, answers: { decision: { answers: ["B"] } }, commandId: randomUUID() })).result);
  const deadline = Date.now() + 10_000;
  while (f.followups.receipts(f.parent)[0]?.status !== "complete" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  assert.equal(f.followups.receipts(f.parent)[0]?.status, "complete");
  assert.equal(readFileSync(join(f.repo, "followup.txt"), "utf8"), "explicit follow-up approval\n");
  const sent = [];
  await processAgentFollowupDelivery({ name: "feishu", reply: async (...args) => sent.push(args) }, "feishu-fixture", new AbortController().signal, f.followups);
  assert.equal(sent.length, 1); assert.equal(sent[0][1], message.messageId);
  assert.equal(f.followups.admit("feishu-fixture", message, true), "duplicate");
  // Initial main/manager contacts ran once. The queued event was handled by Cora directly.
  assert.equal(f.observations.filter((record) => record.name === "architect").length, 1);
  assert.equal(f.observations.filter((record) => record.name === "manager").length, 1);
});

for (const stopKind of ["disconnect", "control-change", "interrupt", "policy-change"]) {
  test(`a live follow-up is paused on ${stopKind}; queued work cannot resume through a new socket`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t, { mode: "followup" });
    const card = await f.client.event("agent.approval.request", (p) => p.question.includes("Feishu thread"));
    assert.ok((await f.client.call("agent.approval.reply", { approvalId: card.approvalId, sessionId: card.sessionId,
      turnId: card.turnId, allow: true, commandId: randomUUID() })).result);
    assert.ok((await f.sending).result);
    const grant = f.followups.list(f.parent)[0]; assert.equal(grant.status, "active");
    if (stopKind === "disconnect") f.client.ws.close();
    else if (stopKind === "control-change") {
      const observer = await f.attach(); assert.ok((await observer.call("session.control.acquire", { sessionId: f.parent })).result);
    } else if (stopKind === "policy-change") assert.ok((await f.client.call("settings.computer.save", { mode: "off", apps: [] })).result);
    else assert.ok((await f.client.call("session.interrupt", { sessionId: f.parent })).result);
    const deadline = Date.now() + 5_000;
    while (f.followups.get(grant.id).status === "active" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.equal(f.followups.get(grant.id).status, "paused");
    const observer = await f.attach(); assert.ok((await observer.call("session.resume", { sessionId: f.parent })).result);
    assert.equal(f.followups.get(grant.id).status, "paused");
    assert.equal(f.followups.admit("feishu-fixture", { chatId: "oc_fixture", userId: "ou_fixture", userName: "Fixture owner",
      text: "Do not run this after authority changed", messageId: "om_after_stop", createdAtMs: Date.now(), chatType: "group", senderType: "user",
      replyContext: { valid: true, rootMessageId: "om_fixture_root" } }, true), "blocked");
    assert.equal(existsSync(join(f.repo, "followup.txt")), false);
  });
}

test("two colleague hops return a single-use permission and structured question to the initiating chat", { timeout: 40_000 }, async (t) => {
  const f = await fixture(t, { mode: "write" }), approval = await f.client.event("agent.approval.request");
  assert.equal(approval.parentSessionId, f.parent); assert.equal(approval.executorAgentRef, "global:coder"); assert.equal(approval.executorDisplayName, "Cora");
  assert.equal(approval.agentPath, "/root/global:manager/global:coder"); assert.equal(approval.interactionKind, "agent");
  assert.equal(approval.allowAlways, false); assert.notEqual(approval.sessionId, f.parent);
  assert.equal(existsSync(join(f.repo, "approved.txt")), false);
  const snapshot = (await f.client.call("events.snapshot", { sessionIds: [f.parent] })).result;
  assert.deepEqual(snapshot.agentApprovals, [projection(approval)]); assert.deepEqual(snapshot.approvals, []);
  const childSnapshot = (await f.client.call("events.snapshot", { sessionIds: [approval.sessionId] })).result;
  assert.deepEqual(childSnapshot.agentApprovals, []);
  assert.ok(childSnapshot.taskStates.every((state) => state.approval === undefined), "child task snapshots cannot synthesize a legacy approval card");
  assert.deepEqual((await f.client.call("session.resume", { sessionId: approval.sessionId })).result.pendingApprovals, [],
    "foreground child resume cannot duplicate the original chat's delegated approval");
  const legacy = await f.attach(features.filter((feature) => feature !== "agent.delegated-interaction.v1"));
  const legacySnapshot = (await legacy.call("events.snapshot", { sessionIds: [f.parent, approval.sessionId] })).result;
  assert.equal(legacySnapshot.agentApprovals, undefined);
  assert.ok(legacySnapshot.taskStates.every((state) => state.approval === undefined));
  assert.deepEqual((await legacy.call("session.resume", { sessionId: approval.sessionId })).result.pendingApprovals, []);
  await legacy.call("events.replay", { streamId: approval.deliveryCursor.streamId, after: approval.deliveryCursor.sequence - 1 });
  assert.equal(legacy.events.some((event) => cardEvents.includes(event.method)), false);
  assert.equal((await f.client.call("approval.reply", { approvalId: approval.approvalId, allow: true })).error.code, -32005);
  const decision = { approvalId: approval.approvalId, sessionId: approval.sessionId, turnId: approval.turnId, allow: true, commandId: randomUUID() };
  assert.equal((await f.client.call("agent.approval.reply", { ...decision, forTask: true })).error.code, -32602);
  assert.equal((await f.client.call("agent.approval.reply", { ...decision, turnId: randomUUID(), commandId: randomUUID() })).error.code, -32005);
  assert.equal((await f.client.call("agent.approval.reply", decision)).error, undefined);
  assert.equal((await f.client.call("agent.approval.reply", decision)).error, undefined);
  const input = await f.client.event("agent.question.request"); assert.equal(input.parentSessionId, f.parent); assert.equal(input.executorDisplayName, "Cora");
  assert.equal(readFileSync(join(f.repo, "approved.txt"), "utf8"), "only after approval\n");
  assert.equal(input.sessionId, approval.sessionId); assert.equal(input.turnId, approval.turnId);
  const answer = { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId, answers: { decision: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("agent.question.reply", answer)).error, undefined);
  assert.equal((await f.client.call("agent.question.reply", answer)).error, undefined);
  assert.equal((await f.sending).error, undefined);
  assert.equal(f.observations.find((entry) => entry.name === "coder").results.find((result) => result.name === "ask_user").content, "B");
  assert.equal(f.client.events.some((event) => event.method === "approval.request" && event.params.sessionId === approval.sessionId), false);
});

test("a colleague's native coding worker keeps the initiating chat and real colleague identity", { timeout: 40_000 }, async (t) => {
  const f = await fixture(t, { mode: "coding" }), launch = await f.client.event("agent.approval.request");
  assert.equal(launch.executorDisplayName, "Cora");
  assert.equal((await f.client.call("agent.approval.reply", { approvalId: launch.approvalId, sessionId: launch.sessionId, turnId: launch.turnId, allow: true, commandId: randomUUID() })).error, undefined);
  const approval = await f.client.event("external.approval.request");
  assert.equal(approval.parentSessionId, f.parent); assert.equal(approval.executorAgentRef, "global:coder");
  assert.equal(approval.agentPath, "/root/global:manager/global:coder/implementation"); assert.equal(approval.sessionId, nativeId);
  const legacy = await f.attach(features.filter((feature) => feature !== "agent.delegated-interaction.v1"));
  assert.deepEqual((await legacy.call("events.snapshot", { sessionIds: [f.parent] })).result.approvals, []);
  await legacy.call("events.replay", { streamId: approval.deliveryCursor.streamId, after: approval.deliveryCursor.sequence - 1 });
  assert.equal(legacy.events.some((event) => event.method === "external.approval.request"), false);
  const controller = await f.attach(), controlLease = (await controller.call("session.control.acquire", { sessionId: f.parent })).result.lease;
  const decision = { approvalId: approval.approvalId, sessionId: nativeId, turnId: approval.turnId, allow: false, commandId: randomUUID() };
  assert.equal((await legacy.call("external.approval.reply", { ...decision, commandId: randomUUID() })).error.code, -32001);
  assert.equal((await f.client.call("external.approval.reply", decision)).error.code, -32005);
  assert.equal((await controller.call("external.approval.reply", { ...decision, commandId: randomUUID(), controlLease })).error, undefined);
  const input = await f.client.event("external.question.request"); assert.equal(input.parentSessionId, f.parent); assert.equal(input.executorDisplayName, "Cora");
  assert.deepEqual((await legacy.call("events.snapshot", { sessionIds: [f.parent] })).result.externalQuestions, []);
  const answer = { questionId: input.questionId, sessionId: nativeId, turnId: input.turnId,
    answers: { scope: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("external.question.reply", answer)).error.code, -32005);
  assert.equal((await controller.call("external.question.reply", { ...answer, commandId: randomUUID(), controlLease })).error, undefined);
  assert.equal((await f.sending).error, undefined); assert.equal(f.submitted(), 1);
  assert.ok(f.observations.some((entry) => entry.nativeApproval === false)); assert.ok(f.observations.some((entry) => entry.nativeAnswers?.scope?.answers[0] === "B"));
});

test("a compatible reconnect restores only the original parent question, deadline and executor", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request");
  await new Promise((done) => { f.client.ws.once("close", done); f.client.ws.close(); });
  const client = await f.attach();
  assert.deepEqual((await client.call("events.snapshot", { sessionIds: [f.parent] })).result.agentQuestions, [projection(input)]);
  assert.deepEqual((await client.call("events.snapshot", { sessionIds: [input.sessionId] })).result.agentQuestions, []);
  assert.equal((await client.call("agent.question.reply", { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["B"] } }, commandId: randomUUID() })).error, undefined);
  await client.event("agent.question.resolved");
});

test("root cancellation resolves colleague input and a late answer cannot execute it", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request");
  assert.equal((await f.client.call("session.interrupt", { sessionId: f.parent })).error, undefined);
  await f.sending; const resolution = await f.client.event("agent.question.resolved"); assert.equal(resolution.outcome, "interrupted");
  assert.equal((await f.client.call("agent.question.reply", { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["B"] } }, commandId: randomUUID() })).error.code, -32005);
});

test("question expiry selects no default even when the model supplied one", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { timeout: 120 }); await f.client.event("agent.question.request");
  assert.equal((await f.client.event("agent.question.resolved")).outcome, "timed_out"); await f.sending;
  const coder = [...f.records.values()].find(({ meta }) => meta.agentRef === "global:coder");
  assert.ok(coder.history.some((message) => message.results?.some((result) => result.name === "ask_user" && result.isError)));
  assert.equal(f.observations.some((entry) => entry.name === "coder"), false);
  const manager = [...f.records.values()].find(({ meta }) => meta.agentRef === "global:manager");
  const receipt = manager.history.flatMap((message) => message.results ?? []).find((result) => result.name === "agent_contact");
  assert.ok(receipt, "the immediate parent retains the colleague's actual handoff outcome");
  assert.ok(["paused", "failed"].includes(JSON.parse(receipt.content).status), "unanswered input cannot become a completed receipt");
});

test("legacy root turns cannot acquire colleague interaction consent from a later compatible observer", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { clientFeatures: features.filter((feature) => feature !== "agent.delegated-interaction.v1"), holdCoder: true });
  const observer = await f.attach(features); f.releaseCoder(); await f.sending;
  assert.equal([...f.client.events, ...observer.events].some((event) => cardEvents.includes(event.method)), false);
  const coder = [...f.records.values()].find(({ meta }) => meta.agentRef === "global:coder");
  assert.ok(coder.history.some((message) => message.results?.some((result) => result.name === "ask_user" && result.isError)));
});

test("cancelling a root awaiting colleague permission performs no write and refuses the late approval", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { mode: "write" }), approval = await f.client.event("agent.approval.request");
  assert.equal((await f.client.call("session.interrupt", { sessionId: f.parent })).error, undefined);
  await f.sending; assert.equal((await f.client.event("agent.approval.resolved")).outcome, "interrupted");
  assert.equal(existsSync(join(f.repo, "approved.txt")), false);
  assert.equal((await f.client.call("agent.approval.reply", { approvalId: approval.approvalId, sessionId: approval.sessionId,
    turnId: approval.turnId, allow: true, commandId: randomUUID() })).error.code, -32005);
});

test("colleague answers obey the initiating conversation's current input lease", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request"), controller = await f.attach();
  const lease = (await controller.call("session.control.acquire", { sessionId: f.parent })).result.lease;
  const answer = { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("agent.question.reply", answer)).error.code, -32005);
  assert.equal((await f.client.call("agent.question.reply", { ...answer, commandId: randomUUID(), controlLease: lease })).error.code, -32005);
  assert.equal((await controller.call("agent.question.reply", { ...answer, commandId: randomUUID(), controlLease: lease })).error, undefined);
  assert.equal((await f.sending).error, undefined);
});

test("a successful host policy change withdraws the old colleague card without choosing its default", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request");
  assert.equal((await f.client.call("settings.computer.save", { mode: "off", apps: [] })).error, undefined);
  assert.equal((await f.client.event("agent.question.resolved")).outcome, "interrupted");
  assert.equal((await f.client.call("agent.question.reply", { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["A"] } }, commandId: randomUUID() })).error.code, -32005);
  await f.sending;
  assert.equal(f.observations.some((entry) => entry.name === "coder"), false);
});
