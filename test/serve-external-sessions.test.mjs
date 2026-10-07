import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { RemoteCommandLedger } from "../dist/serve/remote-command-ledger.js";
import { sessionCommandRequestHash, startServe } from "../dist/serve/server.js";

const connect = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const eventWaiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const finish = pending.get(message.id);
    if (finish) {
      pending.delete(message.id);
      finish(message);
      return;
    }
    if (typeof message.method === "string") {
      events.push(message);
      const waiterIndex = eventWaiters.findIndex((waiter) => waiter.method === message.method);
      if (waiterIndex >= 0) {
        const [waiter] = eventWaiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  ws.on("open", () => resolve({
    ws,
    call(method, params = {}) {
      return new Promise((finish) => {
        const id = nextId++;
        pending.set(id, finish);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    events,
    waitFor(method, timeoutMs = 2_000) {
      const existing = events.find((event) => event.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((finish, fail) => {
        const waiter = { method, resolve: finish, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = eventWaiters.indexOf(waiter);
          if (index >= 0) eventWaiters.splice(index, 1);
          fail(new Error(`timed out waiting for ${method}`));
        }, timeoutMs);
        eventWaiters.push(waiter);
      });
    },
  }));
  ws.on("error", reject);
});

const memStore = () => {
  const records = new Map();
  return {
    load: (id) => records.get(id) ?? null,
    save: (meta, history, task) => records.set(meta.id, { meta, history, task }),
    list: () => [...records.values()].map((entry) => entry.meta),
    acquire: () => ({ ok: true }),
    release: () => {},
    delete: (id) => records.delete(id),
  };
};

const provider = {
  id: "fake",
  model: "fake-1",
  async turn() {
    return { text: "", toolUses: [], stop: "end", usage: { input: 0, output: 0 } };
  },
};

const sourceResult = {
  sources: [{
    id: "codex",
    label: "Codex",
    state: "ready",
    capabilities: {
      listMetadata: true,
      read: true,
      create: false,
      fork: true,
      resume: true,
      observeLive: false,
      submit: true,
      steer: true,
      interrupt: true,
    },
  }],
};

const deps = (spaceId, externalSessions) => ({
  version: "0.0.0-test",
  providerId: "fake",
  model: "fake-1",
  buildSessionProvider: async () => provider,
  spawnSubagent: async () => "disabled",
  sandbox: "off",
  approval: "full-auto",
  store: memStore(),
  quietDiscovery: true,
  runtimeInfo: () => ({
    providerId: "fake",
    model: "fake-1",
    profileId: spaceId === "personal" ? "personal" : "company",
    spaceId,
  }),
  externalSessions,
});

const userQuestionFixture = async ({ compatible = true, request, timeoutMs, reconnectGraceMs, inputMode = "question",
  questionCount = 1, beforeQuestion } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-user-question-"));
  const sessionId = "ext_codex_0123456789abcdef01234567";
  const controller = new AbortController();
  const received = [];
  let resolveAnswered;
  const answered = new Promise((resolve) => { resolveAnswered = resolve; });
  const questions = request ?? { questions: [
    { id: "runtime", header: "Runtime", question: "Which runtime?", options: [{ label: "A" }, { label: "B" }] },
    { id: "title", question: "Pick a title", options: [{ label: "Default" }], isOther: true },
    { id: "checks", question: "Which checks?", options: [{ label: "Build" }, { label: "Test" }], multiSelect: true },
  ] };
  const externalSessions = {
    async submit(_sessionId, _text, sink) {
      let answer;
      for (let index = 0; index < questionCount; index++) {
        await beforeQuestion?.(index);
        answer = inputMode === "approval"
          ? await sink.confirm({ question: "Allow this isolated fixture action?", allowAlways: false }, controller.signal)
          : await sink.askUser(questions, controller.signal);
        received.push(answer);
      }
      resolveAnswered(answer);
      return { sessionId, turnId: "provider-private-turn", status: "completed", reply: "handled without answer echo" };
    },
    async interrupt() { controller.abort(); },
    async close() { controller.abort(); },
  };
  const server = await startServe({ host: "127.0.0.1", port: 0, token: "personal-token", cwd: root }, {
    ...deps("personal", externalSessions),
    remoteCommandLedger: new RemoteCommandLedger({ home: root }),
    ...(timeoutMs ? { externalUserQuestionTimeoutMs: timeoutMs } : {}),
    ...(reconnectGraceMs ? { pendingInputReconnectGraceMs: reconnectGraceMs } : {}),
  });
  const client = await connect(server.port);
  const initialized = await client.call("initialize", { token: "personal-token",
    ...(compatible ? { capabilities: { features: ["external.questions.v1"] } } : {}) });
  return { root, server, client, initialized, sessionId, controller, received, questions, answered,
    async close() { client.ws.close(); await server.close(); rmSync(root, { recursive: true, force: true }); } };
};

test("external structured questions recover, validate exact answers and dedupe without saving answer text", async () => {
  const fixture = await userQuestionFixture();
  const { root, server, client, initialized, sessionId, received, questions } = fixture;
  let observer;
  try {
    assert.ok(initialized.result.capabilities.features.includes("external.questions.v1"));
    assert.ok(initialized.result.capabilities.methods.includes("external.question.reply"));
    assert.ok(initialized.result.capabilities.events.includes("external.question.request"));
    assert.ok(initialized.result.capabilities.events.includes("external.question.resolved"));
    const submitting = client.call("external.sessions.submit", { sessionId, text: "ask with choices", commandId: randomUUID() });
    const { params: pending } = await client.waitFor("external.question.request");
    assert.deepEqual(pending.questions, questions.questions);
    assert.ok(Date.parse(pending.expiresAt) > Date.now());
    assert.match(pending.questionId, /^[a-f0-9-]{36}$/);
    observer = await connect(server.port);
    await observer.call("initialize", { token: "personal-token", capabilities: { features: ["external.questions.v1"] } });
    const snapshot = (await observer.call("events.snapshot", { sessionIds: [] })).result;
    assert.equal(snapshot.externalQuestions.length, 1);
    assert.deepEqual(snapshot.externalQuestions[0], {
      questionId: pending.questionId, sessionId, turnId: pending.turnId, expiresAt: pending.expiresAt, questions: pending.questions,
    });
    // Permission approval does not answer a question, even when its request UUID is known.
    await client.call("approval.reply", { approvalId: pending.questionId, allow: true });
    assert.equal(received.length, 0);
    const base = { questionId: pending.questionId, sessionId, turnId: pending.turnId };
    const wrongSession = await client.call("external.question.reply", { ...base,
      sessionId: "ext_codex_89abcdef0123456789abcdef", answers: {}, commandId: randomUUID() });
    assert.equal(wrongSession.error.code, -32005);
    const stale = await client.call("external.question.reply", { ...base,
      turnId: `extturn_${randomUUID()}`, answers: {}, commandId: randomUUID() });
    assert.equal(stale.error.code, -32005);
    const invalid = await client.call("external.question.reply", { ...base,
      answers: { runtime: { answers: ["Not an option"] } }, commandId: randomUUID() });
    assert.equal(invalid.error.code, -32602);
    assert.equal((await client.call("events.snapshot", { sessionIds: [] })).result.externalQuestions.length, 1,
      "invalid input never consumes the pending question");
    const marker = "PRIVATE_CUSTOM_ANSWER_NOT_FOR_JOURNAL_2049";
    const answers = { runtime: { answers: ["B"] }, title: { answers: [marker] }, checks: { answers: ["Build", "Test"] } };
    const replyParams = { ...base, answers, commandId: randomUUID() };
    assert.deepEqual((await observer.call("external.question.reply", replyParams)).result, {});
    assert.deepEqual((await submitting).result.reply, "handled without answer echo");
    assert.deepEqual(received, [answers]);
    assert.equal((await client.waitFor("external.question.resolved")).params.outcome, "answered");
    assert.deepEqual((await observer.call("external.question.reply", replyParams)).result, {}, "an exact retry never submits twice");
    const conflict = await observer.call("external.question.reply", { ...replyParams, answers: {} });
    assert.equal(conflict.error.code, -32005);
    assert.deepEqual((await client.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, []);
    assert.doesNotMatch(readFileSync(join(root, ".hara", "serve", "remote-command-receipts.json"), "utf8"), new RegExp(marker));
    assert.equal(JSON.stringify(client.events).includes(marker), false, "answer body is absent from streamed/replayed lifecycle data");
    const late = await client.call("external.question.reply", { ...replyParams, commandId: randomUUID() });
    assert.equal(late.error.code, -32005, "a new reply cannot reach a finished turn");
    assert.equal(received.length, 1);
  } finally { observer?.ws.close(); await fixture.close(); }
});

test("a sole Desktop can reconnect and recover a question or approval without extending expiry or auto-allowing", async () => {
  for (const inputMode of ["question", "approval"]) {
    const fixture = await userQuestionFixture({ reconnectGraceMs: 400, inputMode });
    let reconnected;
    try {
      const { client, server, sessionId, received } = fixture;
      void client.call("external.sessions.submit", { sessionId, text: "ask once" });
      const { params: pending } = await client.waitFor(inputMode === "question" ? "external.question.request" : "external.approval.request");
      const disconnected = new Promise((resolve) => client.ws.once("close", resolve));
      client.ws.close();
      await disconnected;
      assert.equal(received.length, 0, "disconnect itself does not choose an answer or allow an action");
      reconnected = await connect(server.port);
      assert.equal((await reconnected.call("initialize", { token: "wrong-token" })).error.code, -32001);
      await reconnected.call("initialize", { token: "personal-token", capabilities: { features: ["external.questions.v1"] } });
      // Outlive the disconnect grace: the compatible authenticated reconnect must have cleared it.
      await new Promise((resolve) => setTimeout(resolve, 450));
      const snapshot = (await reconnected.call("events.snapshot", { sessionIds: [] })).result;
      assert.equal(received.length, 0);
      if (inputMode === "question") {
        const { deliveryCursor: _transportCursor, ...requestProjection } = pending;
        assert.deepEqual(snapshot.externalQuestions, [requestProjection]);
        assert.equal(snapshot.externalQuestions[0].expiresAt, pending.expiresAt);
        assert.deepEqual((await reconnected.call("external.question.reply", { questionId: pending.questionId,
          sessionId, turnId: pending.turnId, answers: { runtime: { answers: ["B"] } }, commandId: randomUUID() })).result, {});
        assert.deepEqual(await fixture.answered, { runtime: { answers: ["B"] } });
      } else {
        assert.equal(snapshot.approvals.length, 1);
        assert.equal(snapshot.approvals[0].approvalId, pending.approvalId);
        assert.equal(snapshot.approvals[0].question, pending.question);
        assert.deepEqual((await reconnected.call("approval.reply", { approvalId: pending.approvalId, allow: false,
          scope: "external", sessionId, commandId: randomUUID() })).result, {});
        assert.equal(await fixture.answered, false);
      }
    } finally { reconnected?.ws.close(); await fixture.close(); }
  }
});

test("reconnect grace expires fail closed, respects the original question timeout, and shutdown cancels immediately", async () => {
  for (const scenario of ["grace", "expiry", "shutdown", "approval-grace"]) {
    const fixture = await userQuestionFixture({ reconnectGraceMs: scenario === "expiry" ? 1_000 : 40,
      ...(scenario === "expiry" ? { timeoutMs: 60 } : {}),
      ...(scenario === "approval-grace" ? { inputMode: "approval" } : {}) });
    let incompatible;
    try {
      const { client, server, sessionId } = fixture;
      void client.call("external.sessions.submit", { sessionId, text: "ask once" });
      await client.waitFor(scenario === "approval-grace" ? "external.approval.request" : "external.question.request");
      const disconnected = new Promise((resolve) => client.ws.once("close", resolve));
      client.ws.close();
      await disconnected;
      if (scenario === "grace") {
        incompatible = await connect(server.port);
        await incompatible.call("initialize", { token: "personal-token" });
        assert.deepEqual((await incompatible.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, []);
      }
      if (scenario === "shutdown") await server.close();
      assert.deepEqual(await fixture.answered, scenario === "approval-grace" ? false : {});
      if (incompatible) {
        await incompatible.call("initialize", { token: "personal-token", capabilities: { features: ["external.questions.v1"] } });
        assert.deepEqual((await incompatible.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, [],
          "an expired form cannot be resurrected by later feature negotiation");
      }
    } finally { incompatible?.ws.close(); await fixture.close(); }
  }
});

test("a negotiated turn can ask its second question after socket replacement, but old turns never gain input UI", async () => {
  const fixture = await userQuestionFixture({ reconnectGraceMs: 400, questionCount: 2 });
  let reconnected;
  try {
    const { client, server, sessionId } = fixture;
    void client.call("external.sessions.submit", { sessionId, text: "two cards" });
    const { params: first } = await client.waitFor("external.question.request");
    const disconnected = new Promise((resolve) => client.ws.once("close", resolve));
    client.ws.close();
    await disconnected;
    reconnected = await connect(server.port);
    await reconnected.call("initialize", { token: "personal-token", capabilities: { features: ["external.questions.v1"] } });
    const firstAnswers = { runtime: { answers: ["B"] } };
    assert.deepEqual((await reconnected.call("external.question.reply", { questionId: first.questionId, sessionId,
      turnId: first.turnId, answers: firstAnswers, commandId: randomUUID() })).result, {});
    const { params: second } = await reconnected.waitFor("external.question.request");
    assert.notEqual(second.questionId, first.questionId);
    assert.equal(second.turnId, first.turnId);
    const secondAnswers = { title: { answers: ["Second card"] } };
    assert.deepEqual((await reconnected.call("external.question.reply", { questionId: second.questionId, sessionId,
      turnId: second.turnId, answers: secondAnswers, commandId: randomUUID() })).result, {});
    assert.deepEqual(await fixture.answered, secondAnswers);
    assert.deepEqual(fixture.received, [firstAnswers, secondAnswers]);
  } finally { reconnected?.ws.close(); await fixture.close(); }

  for (const scenario of ["legacy", "disconnected-before-new-question"]) {
    let release;
    let reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { reached = resolve; });
    const old = await userQuestionFixture({ compatible: scenario !== "legacy", reconnectGraceMs: 40,
      beforeQuestion: async () => { reached(); await gate; } });
    let compatibleClient;
    try {
      const submitting = old.client.call("external.sessions.submit", { sessionId: old.sessionId, text: "hold before question" });
      await ready;
      if (scenario === "legacy") {
        compatibleClient = await connect(old.server.port);
        await compatibleClient.call("initialize", { token: "personal-token", capabilities: { features: ["external.questions.v1"] } });
      } else {
        const closed = new Promise((resolve) => old.client.ws.once("close", resolve));
        old.client.ws.close();
        await closed;
      }
      release();
      assert.deepEqual(await old.answered, {}, "an unsupported/disconnected new request closes without a choice or unbounded wait");
      assert.deepEqual(old.received, [{}]);
      if (scenario === "legacy") {
        await submitting;
        assert.equal(compatibleClient.events.some((event) => event.method === "external.question.request"), false);
      }
    } finally { release(); compatibleClient?.ws.close(); await old.close(); }
  }
});

test("shutdown does not admit a second question when cancellation releases the first form", async () => {
  const fixture = await userQuestionFixture({ questionCount: 2 });
  try {
    const { client, server, sessionId } = fixture;
    void client.call("external.sessions.submit", { sessionId, text: "two cards during shutdown" });
    await client.waitFor("external.question.request");
    // Leave the compatible socket open: this exercises the shutdown microtask window, not disconnect.
    await server.close();
    assert.deepEqual(await fixture.answered, {});
    assert.deepEqual(fixture.received, [{}, {}]);
    assert.equal(client.events.filter((event) => event.method === "external.question.request").length, 1,
      "stopping releases the original question but never broadcasts the provider's follow-up form");
  } finally { await fixture.close(); }
});

test("external question cancellation, timeout and interruption return no default answers", async () => {
  for (const reason of ["cancelled", "timed_out", "interrupted"]) {
    const fixture = await userQuestionFixture({ ...(reason === "timed_out" ? { timeoutMs: 30 } : {}) });
    const { client, sessionId, received } = fixture;
    try {
      const submitting = client.call("external.sessions.submit", { sessionId, text: "ask once" });
      const { params: pending } = await client.waitFor("external.question.request");
      if (reason === "cancelled") {
        assert.deepEqual((await client.call("external.question.reply", { questionId: pending.questionId, sessionId,
          turnId: pending.turnId, answers: {}, cancelled: true, commandId: randomUUID() })).result, {});
      } else if (reason === "interrupted") {
        await client.call("external.sessions.interrupt", { sessionId, expectedTurnId: pending.turnId, commandId: randomUUID() });
      }
      const resolved = await client.waitFor("external.question.resolved");
      assert.equal(resolved.params.outcome, reason);
      await submitting;
      assert.deepEqual(received, [{}]);
      assert.deepEqual((await client.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, []);
      assert.equal((await client.call("external.question.reply", { questionId: pending.questionId, sessionId,
        turnId: pending.turnId, answers: { runtime: { answers: ["A"] } }, commandId: randomUUID() })).error.code, -32005);
    } finally { await fixture.close(); }
  }
});

test("old clients and secret questions fail closed without a request or confirmation fallback", async () => {
  for (const scenario of ["old", "secret", "credential"]) {
    const fixture = await userQuestionFixture({ compatible: scenario !== "old",
      ...(scenario === "secret" ? { request: { questions: [{ id: "secret", question: "Required value", isSecret: true }] } } : {}),
      ...(scenario === "credential" ? { request: { questions: [{ id: "key", question: "Paste your API key here" }] } } : {}),
    });
    try {
      const { client, sessionId, received } = fixture;
      const result = await client.call("external.sessions.submit", { sessionId, text: "ask once" });
      assert.equal(result.result.status, "completed");
      assert.deepEqual(received, [{}]);
      assert.equal(client.events.some((event) => event.method === "external.question.request" || event.method === "external.approval.request"), false);
      assert.deepEqual((await client.call("events.snapshot", { sessionIds: [] })).result.externalQuestions, []);
      assert.doesNotMatch(JSON.stringify(client.events), /Paste your API key/);
    } finally { await fixture.close(); }
  }
});

test("an external retry cannot report provider success after its durable receipt failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-external-receipt-failure-"));
  const sessionId = "ext_codex_0123456789abcdef01234567";
  let submitted = 0;
  class FailingCompletionLedger extends RemoteCommandLedger {
    complete(commandId, outcome) {
      super.complete(commandId, outcome);
      throw new Error("injected durable receipt failure");
    }
  }
  const externalSessions = {
    async readSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return {
        session: {
          id: sessionId,
          sourceId: "codex",
          title: "Recovered provider session",
          workspaceName: "hara",
          workspaceId: "ws_receipt_failure",
          state: "idle",
          createdAt: "2026-09-07T00:00:00.000Z",
          updatedAt: "2026-09-07T00:01:00.000Z",
          ephemeral: false,
        },
        messages: [],
        readOnly: false,
        controlMode: "managed",
      };
    },
    async submit(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      submitted += 1;
      return {
        sessionId,
        turnId: "provider-private-turn",
        status: "completed",
        reply: "provider completed",
      };
    },
    async close() {},
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "personal-token", cwd: root },
    {
      ...deps("personal", externalSessions),
      remoteCommandLedger: new FailingCompletionLedger(),
    },
  );
  const client = await connect(server.port);
  try {
    await client.call("initialize", { token: "personal-token" });
    const command = {
      sessionId,
      text: "continue once",
      commandId: "77777777-7777-4777-8777-777777777777",
    };
    const first = await client.call("external.sessions.submit", command);
    const retry = await client.call("external.sessions.submit", command);
    assert.equal(first.error.code, -32603);
    assert.equal(retry.error.code, -32603);
    assert.match(first.error.message, /idempotency result could not be saved/);
    assert.equal(retry.error.message, first.error.message);
    assert.equal(submitted, 1, "the retry observes the whole failed commit transaction and never replays the provider action");
    assert.equal(client.events.some((event) => event.method === "external.event.command_committed"), false);

    const inspected = await client.call("external.sessions.read", { sessionId });
    assert.equal(inspected.result.session.state, "idle");
    const recoveredRetry = await client.call("external.sessions.submit", command);
    assert.equal(recoveredRetry.result.reply, "provider completed");
    assert.equal(submitted, 1, "authoritative recovery replays the saved result without rerunning the provider");
  } finally {
    client.ws.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval always requires an explicit allow and replays one durable external decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-approval-command-"));
  const sessionId = "ext_codex_approvalcommand00000000";
  let observedVerdict;
  const externalSessions = {
    async submit(requestedSessionId, _text, sink) {
      assert.equal(requestedSessionId, sessionId);
      observedVerdict = await sink.confirm(
        { question: "Allow one command?", allowAlways: true },
        new AbortController().signal,
      );
      return {
        sessionId,
        turnId: "provider-private-turn",
        status: "completed",
        reply: "decision observed",
      };
    },
    async close() {},
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "personal-token", cwd: root },
    deps("personal", externalSessions),
  );
  const client = await connect(server.port);
  try {
    await client.call("initialize", { token: "personal-token" });
    const submitting = client.call("external.sessions.submit", { sessionId, text: "ask once" });
    const approval = await client.waitFor("external.approval.request");
    const commandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
    const params = {
      approvalId: approval.params.approvalId,
      allow: false,
      always: true,
      scope: "external",
      sessionId,
      commandId,
    };
    const denied = await client.call("approval.reply", params);
    assert.deepEqual(denied.result, {});
    const completed = await submitting;
    assert.equal(completed.result.reply, "decision observed");
    assert.equal(observedVerdict, false, "always=true cannot turn an explicit denial into a remembered approval");
    assert.deepEqual((await client.call("approval.reply", params)).result, {});
    const conflicting = await client.call("approval.reply", { ...params, allow: true });
    assert.equal(conflicting.error.code, -32005);
  } finally {
    client.ws.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Serve advertises a Personal-only external session interaction surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-external-"));
  const sessionId = "ext_codex_0123456789abcdef01234567";
  const forkedSessionId = "ext_codex_89abcdef0123456789abcdef";
  let submittedCount = 0;
  let steeredCount = 0;
  let interrupted = 0;
  let terminalInput = "";
  let terminalKey = "";
  let terminalInputCount = 0;
  let terminalKeyCount = 0;
  let terminalRawInput = "";
  let terminalResize = [];
  let terminalScroll = [];
  let terminalStreamReleased = 0;
  let nativeTerminalOpen = null;
  let failNativeTerminalOpen = false;
  let removed = 0;
  let closed = 0;
  const externalSessions = {
    async listSources() { return sourceResult; },
    async listSessions() {
      return {
        ...sourceResult,
        sessions: [{
          id: sessionId,
          sourceId: "codex",
          title: "Session",
          workspaceName: "hara",
          workspaceId: "ws_opaque",
          state: "idle",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:01:00.000Z",
          ephemeral: false,
        }],
        page: { limit: 50, hasMore: false },
      };
    },
    async readSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return {
        session: { ...(await this.listSessions()).sessions[0] },
        messages: [{ id: "msg_0123456789abcdef01234567", role: "assistant", text: "existing reply" }],
        readOnly: true,
        controlMode: "history",
      };
    },
    async createSession(input) {
      assert.deepEqual(input, {
        sourceId: "runtime",
        cwd: root,
        agentKind: "codex",
        title: "Release relay",
        launch: { model: "gpt-5.6-terra", effort: "high", sandboxMode: "read-only", serviceTier: "fast" },
      });
      return {
        session: {
          id: "ext_runtime_0123456789abcdef01234567",
          sourceId: "runtime",
          title: "Release relay",
          workspaceName: "hara",
          workspaceId: "ws_runtime_opaque",
          state: "idle",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T00:01:00.000Z",
          origin: "haraRuntime",
          agentKind: "codex",
          ephemeral: false,
        },
        messages: [],
        readOnly: false,
        controlMode: "live",
      };
    },
    async resumeSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return {
        session: { ...(await this.listSessions()).sessions[0] },
        messages: [{ id: "msg_0123456789abcdef01234567", role: "assistant", text: "existing reply" }],
        readOnly: false,
        controlMode: "managed",
      };
    },
    async forkSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      const source = (await this.listSessions()).sessions[0];
      return {
        sourceSessionId: sessionId,
        session: { ...source, id: forkedSessionId, title: "Session · Hara fork" },
        messages: [{ id: "msg_0123456789abcdef01234567", role: "assistant", text: "existing reply" }],
        readOnly: false,
        controlMode: "managed",
      };
    },
    async submit(requestedSessionId, text, sink) {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(text, "continue safely");
      submittedCount += 1;
      sink.notice("Starting continuation");
      sink.tool("Command", "npm test");
      const verdict = await sink.confirm({ question: "Allow test command?", allowAlways: true }, new AbortController().signal);
      assert.equal(verdict, true);
      sink.text("hello ");
      await new Promise((resolve) => { finishAfterSteer = resolve; });
      sink.text("world");
      return {
        sessionId,
        turnId: "provider-turn-is-not-exposed",
        status: "completed",
        reply: "hello world",
      };
    },
    async steer(requestedSessionId, text) {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(text, "add one focused check");
      steeredCount += 1;
      finishAfterSteer?.();
      return {
        sessionId,
        turnId: "adapter-private-turn-is-not-exposed",
        accepted: true,
      };
    },
    async interrupt(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      interrupted += 1;
    },
    async terminalSnapshot(requestedSessionId) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      return { sessionId: requestedSessionId, text: "native screen", state: "idle", updatedAt: "2026-08-28T00:01:00.000Z" };
    },
    async terminalInput(requestedSessionId, text) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      terminalInputCount += 1;
      terminalInput = text;
    },
    async terminalKey(requestedSessionId, key) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      terminalKeyCount += 1;
      terminalKey = key;
    },
    async openTerminalStream(requestedSessionId, input, sink) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      assert.ok(input.mode === "control" || input.mode === "observe");
      queueMicrotask(() => sink.frame({
        seq: 4,
        encoding: "ansi-base64",
        width: input.cols,
        height: input.rows,
        full: true,
        bytes: Buffer.from(`${input.mode} stream frame`).toString("base64"),
      }));
      return {
        mode: input.mode,
        input(text) { terminalRawInput += text; },
        resize(cols, rows) { terminalResize = [cols, rows]; },
        scroll(direction, lines) { terminalScroll = [direction, lines]; },
        async release() { terminalStreamReleased += 1; },
      };
    },
    async openNativeTerminal(requestedSessionId, input) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      if (failNativeTerminalOpen) throw new Error("WezTerm is not installed");
      nativeTerminalOpen = input;
      return { terminal: "wezterm", opened: true };
    },
    async removeSession(requestedSessionId) {
      assert.equal(requestedSessionId, "ext_runtime_0123456789abcdef01234567");
      removed += 1;
    },
    async close() { closed += 1; },
  };
  let personal;
  let company;
  let finishAfterSteer;
  try {
    personal = await startServe(
      { host: "127.0.0.1", port: 0, token: "personal-token", cwd: root },
      deps("personal", externalSessions),
    );
    const client = await connect(personal.port);
    const initialized = await client.call("initialize", { token: "personal-token" });
    assert.ok(initialized.result.capabilities.methods.includes("external.sources.list"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.metadata.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.interaction.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.live-control.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.runtime.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.native-resume.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.launch-options.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.command-idempotency.serve-lifetime.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.command-idempotency.durable.v2"));
    assert.ok(initialized.result.capabilities.features.includes("approval.command-idempotency.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-mirror.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-stream.v2"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-input-sequence.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-command-idempotency.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.terminal-handoff.v1"));
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.runtime-remove.v1"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.terminal.handoff-ready"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.create"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.resume"));
    assert.ok(initialized.result.capabilities.methods.includes("external.sessions.remove"));
    assert.equal(initialized.result.capabilities.limits.externalCommandReceipts, 64);
    assert.equal(initialized.result.capabilities.limits.externalCommandResultBytes, 256 * 1024);
    const listed = await client.call("external.sessions.list", { sourceId: "codex" });
    assert.equal(listed.result.sessions[0].id, sessionId);
    const openCodeListed = await client.call("external.sessions.list", { sourceId: "opencode" });
    assert.equal(openCodeListed.error, undefined, "OpenCode is a valid Personal Space session source");
    const read = await client.call("external.sessions.read", { sessionId });
    assert.equal(read.result.messages[0].text, "existing reply");
    assert.equal(read.result.readOnly, true);
    const created = await client.call("external.sessions.create", {
      sourceId: "runtime",
      cwd: root,
      agentKind: "codex",
      title: "Release relay",
      launch: { model: "gpt-5.6-terra", effort: "high", sandboxMode: "read-only", serviceTier: "fast" },
    });
    assert.equal(created.result.session.sourceId, "runtime");
    assert.equal(created.result.controlMode, "live");
    const terminalSessionId = created.result.session.id;
    const terminal = await client.call("external.sessions.terminal.snapshot", { sessionId: terminalSessionId });
    assert.equal(terminal.result.text, "native screen");
    const terminalInputCommandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    await client.call("external.sessions.terminal.input", {
      sessionId: terminalSessionId,
      text: "/status",
      commandId: terminalInputCommandId,
    });
    await client.call("external.sessions.terminal.input", {
      commandId: terminalInputCommandId,
      text: "/status",
      sessionId: terminalSessionId,
    });
    const conflictingTerminalInput = await client.call("external.sessions.terminal.input", {
      sessionId: terminalSessionId,
      text: "/different",
      commandId: terminalInputCommandId,
    });
    assert.equal(conflictingTerminalInput.error.code, -32005);
    const terminalKeyCommandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    await client.call("external.sessions.terminal.key", {
      sessionId: terminalSessionId,
      key: "esc",
      commandId: terminalKeyCommandId,
    });
    await client.call("external.sessions.terminal.key", {
      commandId: terminalKeyCommandId,
      key: "esc",
      sessionId: terminalSessionId,
    });
    assert.equal(terminalInput, "/status");
    assert.equal(terminalKey, "esc");
    assert.equal(terminalInputCount, 1, "a terminal prompt retry does not inject text twice");
    assert.equal(terminalKeyCount, 1, "a terminal key retry does not inject the key twice");
    const attached = await client.call("external.sessions.terminal.attach", {
      sessionId: terminalSessionId,
      mode: "control",
      cols: 96,
      rows: 31,
    });
    assert.equal(attached.result.mode, "control");
    assert.equal(attached.result.nextInputSeq, 1);
    assert.match(attached.result.streamId, /^terminal_/);
    const terminalFrame = await client.waitFor("external.event.terminal.frame");
    assert.equal(terminalFrame.params.streamId, attached.result.streamId);
    assert.equal(Buffer.from(terminalFrame.params.bytes, "base64").toString(), "control stream frame");
    await client.call("external.sessions.terminal.raw-input", { streamId: attached.result.streamId, text: "\u0003" });
    const firstSequencedInput = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "x",
      inputSeq: 1,
    });
    assert.deepEqual(firstSequencedInput.result, {
      accepted: true,
      duplicate: false,
      inputSeq: 1,
      nextInputSeq: 2,
    });
    const duplicateInput = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "x",
      inputSeq: 1,
    });
    assert.equal(duplicateInput.result.duplicate, true);
    const reusedInput = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "different",
      inputSeq: 1,
    });
    assert.equal(reusedInput.error.code, -32005);
    const inputGap = await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "too early",
      inputSeq: 3,
    });
    assert.equal(inputGap.error.code, -32005);
    assert.match(inputGap.error.message, /expected 2/i);
    await client.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "z",
      inputSeq: 2,
    });
    await client.call("external.sessions.terminal.resize", { streamId: attached.result.streamId, cols: 101, rows: 33 });
    await client.call("external.sessions.terminal.scroll", { streamId: attached.result.streamId, direction: "down", lines: 5 });
    assert.equal(terminalRawInput, "\u0003xz", "duplicate, conflicting, and out-of-order input never reaches the PTY");
    assert.deepEqual(terminalResize, [101, 33]);
    assert.deepEqual(terminalScroll, ["down", 5]);
    const observerClient = await connect(personal.port);
    await observerClient.call("initialize", { token: "personal-token" });
    const deniedController = await observerClient.call("external.sessions.terminal.attach", {
      sessionId: terminalSessionId,
      mode: "control",
      cols: 80,
      rows: 24,
    });
    assert.ok(deniedController.error, "a second controller needs an explicit takeover");
    const observer = await observerClient.call("external.sessions.terminal.attach", {
      sessionId: terminalSessionId,
      mode: "observe",
      cols: 80,
      rows: 24,
    });
    const observerFrame = await observerClient.waitFor("external.event.terminal.frame");
    assert.equal(observerFrame.params.streamId, observer.result.streamId);
    assert.equal(Buffer.from(observerFrame.params.bytes, "base64").toString(), "observe stream frame");
    assert.equal(client.events.some((event) => event.params?.streamId === observer.result.streamId), false,
      "private terminal frames go only to the socket that attached that stream");
    await observerClient.call("external.sessions.terminal.release", { streamId: observer.result.streamId });
    observerClient.ws.close();
    const unconfirmedNativeTerminal = await client.call("external.sessions.terminal.open-wezterm", { sessionId: terminalSessionId });
    assert.ok(unconfirmedNativeTerminal.error, "even the current controller must explicitly confirm a native-terminal transfer");
    assert.equal(terminalStreamReleased, 1, "an unconfirmed native handoff keeps the in-app controller alive");
    failNativeTerminalOpen = true;
    const failedNativeTerminal = await client.call("external.sessions.terminal.open-wezterm", { sessionId: terminalSessionId, takeover: true });
    assert.ok(failedNativeTerminal.error, "a failed WezTerm launch remains visible to the requester");
    assert.equal(terminalStreamReleased, 1, "a failed WezTerm launch must not strand the in-app controller");
    failNativeTerminalOpen = false;
    const nativeTerminal = await client.call("external.sessions.terminal.open-wezterm", { sessionId: terminalSessionId, takeover: true });
    assert.deepEqual(nativeTerminal.result, { terminal: "wezterm", opened: true });
    assert.deepEqual(nativeTerminalOpen, { terminal: "wezterm", takeover: true });
    assert.equal(terminalStreamReleased, 2, "observers and the in-app controller release independently before WezTerm takes control");
    await client.call("external.sessions.remove", { sessionId: terminalSessionId });
    assert.equal(removed, 1);
    const resumed = await client.call("external.sessions.resume", { sessionId });
    assert.equal(resumed.result.session.id, sessionId);
    assert.equal(resumed.result.readOnly, false);
    assert.equal(resumed.result.controlMode, "managed");

    const submitCommandId = "11111111-1111-4111-8111-111111111111";
    const submitted = client.call("external.sessions.submit", {
      sessionId,
      text: "continue safely",
      commandId: submitCommandId,
    });
    const started = await client.waitFor("external.event.turn_start");
    const retryClient = await connect(personal.port);
    await retryClient.call("initialize", { token: "personal-token" });
    const submittedAfterReconnect = retryClient.call("external.sessions.submit", {
      commandId: submitCommandId,
      text: "continue safely",
      sessionId,
    });
    const conflictingSubmit = await retryClient.call("external.sessions.submit", {
      sessionId,
      text: "different input",
      commandId: submitCommandId,
    });
    assert.equal(conflictingSubmit.error.code, -32005);
    assert.equal(submittedCount, 1, "a reconnect retry must share the original provider submit");
    const approval = await client.waitFor("external.approval.request");
    assert.equal(approval.params.sessionId, sessionId);
    assert.equal(approval.params.question, "Allow test command?");
    const recoverySnapshot = await retryClient.call("events.snapshot", { sessionIds: [] });
    assert.deepEqual(recoverySnapshot.result.externalTurns, [{
      sessionId,
      turnId: started.params.turnId,
    }]);
    assert.deepEqual(recoverySnapshot.result.approvals, [{
      approvalId: approval.params.approvalId,
      sessionId,
      scope: "external",
      question: "Allow test command?",
      allowAlways: true,
    }]);
    const approvalCommandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    const approvalParams = {
      approvalId: approval.params.approvalId,
      allow: true,
      scope: "external",
      sessionId,
      commandId: approvalCommandId,
    };
    const approvalReply = await client.call("approval.reply", approvalParams);
    assert.deepEqual(approvalReply.result, {});
    const duplicateApprovalReply = await retryClient.call("approval.reply", {
      commandId: approvalCommandId,
      sessionId,
      scope: "external",
      allow: true,
      approvalId: approval.params.approvalId,
    });
    assert.deepEqual(duplicateApprovalReply.result, {});
    const conflictingApprovalReply = await retryClient.call("approval.reply", {
      ...approvalParams,
      allow: false,
    });
    assert.equal(conflictingApprovalReply.error.code, -32005);
    assert.equal(client.events.filter((event) => (
      event.method === "external.event.command_committed"
      && event.params.commandId === approvalCommandId
    )).length, 1, "only one durable approval command is committed");
    await client.waitFor("external.event.text");
    const staleSteer = await client.call("external.sessions.steer", {
      sessionId,
      text: "add one focused check",
      expectedTurnId: "extturn_stale",
      commandId: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(staleSteer.error.code, -32005);
    assert.equal(steeredCount, 0, "stale input must not reach the provider adapter");
    const steerCommandId = "33333333-3333-4333-8333-333333333333";
    const steered = await client.call("external.sessions.steer", {
      sessionId,
      text: "add one focused check",
      expectedTurnId: started.params.turnId,
      commandId: steerCommandId,
    });
    const duplicateSteer = await retryClient.call("external.sessions.steer", {
      commandId: steerCommandId,
      expectedTurnId: started.params.turnId,
      text: "add one focused check",
      sessionId,
    });
    assert.equal(steered.result.accepted, true);
    assert.deepEqual(duplicateSteer.result, steered.result);
    assert.equal(steeredCount, 1);
    assert.equal(steered.result.turnId, started.params.turnId);
    assert.notEqual(steered.result.turnId, "adapter-private-turn-is-not-exposed");
    assert.ok(client.events.some((event) => (
      event.method === "external.event.command_committed"
      && event.params.commandId === steerCommandId
      && event.params.commandMethod === "external.sessions.steer"
    )));
    const completed = await submitted;
    const completedAfterReconnect = await submittedAfterReconnect;
    assert.equal(completed.result.sessionId, sessionId);
    assert.equal(completed.result.reply, "hello world");
    assert.deepEqual(completedAfterReconnect.result, completed.result);
    assert.notEqual(completed.result.turnId, "provider-turn-is-not-exposed");
    assert.ok(client.events.some((event) => (
      event.method === "external.event.command_committed"
      && event.params.commandId === submitCommandId
      && event.params.commandMethod === "external.sessions.submit"
    )));
    assert.ok(client.events.some((event) => event.method === "external.event.text" && event.params.delta === "hello "));
    assert.ok(client.events.some((event) => event.method === "external.event.turn_end" && event.params.status === "completed"));
    const interruptCommandId = "44444444-4444-4444-8444-444444444444";
    await client.call("external.sessions.interrupt", { sessionId, commandId: interruptCommandId });
    await retryClient.call("external.sessions.interrupt", { commandId: interruptCommandId, sessionId });
    assert.equal(interrupted, 1);
    assert.ok(client.events.some((event) => (
      event.method === "external.event.command_committed"
      && event.params.commandId === interruptCommandId
      && event.params.commandMethod === "external.sessions.interrupt"
    )));
    const staleInterrupt = await retryClient.call("external.sessions.interrupt", {
      sessionId,
      expectedTurnId: started.params.turnId,
      commandId: "55555555-5555-4555-8555-555555555555",
    });
    assert.equal(staleInterrupt.error.code, -32005);
    assert.equal(interrupted, 1, "an interrupt for an ended turn must not hit the provider adapter");
    retryClient.ws.close();
    const forked = await client.call("external.sessions.fork", { sessionId });
    assert.equal(forked.result.sourceSessionId, sessionId);
    assert.equal(forked.result.session.id, forkedSessionId);
    client.ws.close();
    await personal.close();
    personal = null;
    assert.equal(closed, 1);

    company = await startServe(
      { host: "127.0.0.1", port: 0, token: "company-token", cwd: root },
      deps("org:company", externalSessions),
    );
    const companyClient = await connect(company.port);
    await companyClient.call("initialize", { token: "company-token" });
    const denied = await companyClient.call("external.sessions.list", { sourceId: "codex" });
    assert.equal(denied.error.code, -32001);
    const removeDenied = await companyClient.call("external.sessions.remove", {
      sessionId: "ext_runtime_0123456789abcdef01234567",
    });
    assert.equal(removeDenied.error.code, -32001);
    companyClient.ws.close();
  } finally {
    await personal?.close();
    await company?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature-aware terminal takeover drains input and restores the old controller when successor launch fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-terminal-handoff-"));
  const sessionId = "ext_runtime_0123456789abcdef01234567";
  let streamStarts = 0;
  let released = 0;
  let received = "";
  let failNextTakeover = true;
  const externalSessions = {
    async openTerminalStream(requestedSessionId, input) {
      assert.equal(requestedSessionId, sessionId);
      streamStarts += 1;
      if (input.takeover && failNextTakeover) {
        failNextTakeover = false;
        throw new Error("injected successor launch failure");
      }
      return {
        mode: input.mode,
        input(text) { received += text; },
        resize() {},
        scroll() {},
        async release() { released += 1; },
      };
    },
    async close() {},
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "personal-token", cwd: root },
    deps("personal", externalSessions),
  );
  const owner = await connect(server.port);
  const successor = await connect(server.port);
  try {
    await owner.call("initialize", {
      token: "personal-token",
      capabilities: { features: ["external.sessions.terminal-handoff.v1"] },
    });
    await successor.call("initialize", { token: "personal-token" });
    const attached = await owner.call("external.sessions.terminal.attach", {
      sessionId,
      mode: "control",
      cols: 80,
      rows: 24,
    });
    await owner.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "a",
      inputSeq: 1,
    });

    const failedTakeover = successor.call("external.sessions.terminal.attach", {
      sessionId,
      mode: "control",
      cols: 90,
      rows: 30,
      takeover: true,
    });
    const firstRequest = await owner.waitFor("external.event.terminal.handoff_requested");
    const wrongFence = await owner.call("external.sessions.terminal.handoff-ready", {
      streamId: attached.result.streamId,
      handoffId: firstRequest.params.handoffId,
      throughInputSeq: 0,
    });
    assert.equal(wrongFence.error.code, -32005);
    await owner.call("external.sessions.terminal.handoff-ready", {
      streamId: attached.result.streamId,
      handoffId: firstRequest.params.handoffId,
      throughInputSeq: 1,
    });
    assert.ok((await failedTakeover).error);
    await owner.waitFor("external.event.terminal.handoff_cancelled");
    const resumedInput = await owner.call("external.sessions.terminal.raw-input", {
      streamId: attached.result.streamId,
      text: "b",
      inputSeq: 2,
    });
    assert.equal(resumedInput.result.accepted, true, "failed successor launch unfreezes the original controller");
    assert.equal(released, 0, "failed takeover never releases the working controller");

    owner.events.length = 0;
    const successfulTakeover = successor.call("external.sessions.terminal.attach", {
      sessionId,
      mode: "control",
      cols: 90,
      rows: 30,
      takeover: true,
    });
    const secondRequest = await owner.waitFor("external.event.terminal.handoff_requested");
    await owner.call("external.sessions.terminal.handoff-ready", {
      streamId: attached.result.streamId,
      handoffId: secondRequest.params.handoffId,
      throughInputSeq: 2,
    });
    const transferred = await successfulTakeover;
    assert.equal(transferred.result.mode, "control");
    assert.equal(transferred.result.nextInputSeq, 1);
    const closed = await owner.waitFor("external.event.terminal.closed");
    assert.equal(closed.params.reason, "control_transferred");
    assert.equal(received, "ab");
    assert.equal(streamStarts, 3);
    assert.equal(released, 1);
  } finally {
    owner.ws.close();
    successor.ws.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal takeover cannot overwrite a controller that reattaches while the successor is launching", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-terminal-handoff-race-"));
  const sessionId = "ext_runtime_89abcdef0123456789abcdef";
  let streamStarts = 0;
  let signalTakeoverStarted;
  let finishTakeoverLaunch;
  const takeoverStarted = new Promise((resolve) => { signalTakeoverStarted = resolve; });
  const takeoverLaunch = new Promise((resolve) => { finishTakeoverLaunch = resolve; });
  const released = [];
  const received = new Map();
  const externalSessions = {
    async openTerminalStream(requestedSessionId, input) {
      assert.equal(requestedSessionId, sessionId);
      streamStarts += 1;
      const label = streamStarts === 1
        ? "original"
        : streamStarts === 2
          ? "stale-successor"
          : "replacement";
      if (label === "stale-successor") {
        signalTakeoverStarted();
        await takeoverLaunch;
      }
      return {
        mode: input.mode,
        input(text) { received.set(label, `${received.get(label) ?? ""}${text}`); },
        resize() {},
        scroll() {},
        async release() { released.push(label); },
      };
    },
    async close() {},
  };
  const server = await startServe(
    { host: "127.0.0.1", port: 0, token: "personal-token", cwd: root },
    deps("personal", externalSessions),
  );
  const owner = await connect(server.port);
  const successor = await connect(server.port);
  try {
    await owner.call("initialize", {
      token: "personal-token",
      capabilities: { features: ["external.sessions.terminal-handoff.v1"] },
    });
    await successor.call("initialize", { token: "personal-token" });
    const original = await owner.call("external.sessions.terminal.attach", {
      sessionId,
      mode: "control",
      cols: 80,
      rows: 24,
    });

    const staleTakeover = successor.call("external.sessions.terminal.attach", {
      sessionId,
      mode: "control",
      cols: 90,
      rows: 30,
      takeover: true,
    });
    const request = await owner.waitFor("external.event.terminal.handoff_requested");
    const ready = await owner.call("external.sessions.terminal.handoff-ready", {
      streamId: original.result.streamId,
      handoffId: request.params.handoffId,
      throughInputSeq: 0,
    });
    assert.equal(ready.result.accepted, true);
    await takeoverStarted;

    const replacement = await owner.call("external.sessions.terminal.attach", {
      sessionId,
      mode: "control",
      cols: 100,
      rows: 36,
    });
    assert.equal(replacement.result.mode, "control");
    finishTakeoverLaunch();
    const rejected = await staleTakeover;
    assert.equal(rejected.error.code, -32002);
    assert.match(rejected.error.message, /controller changed/);

    const accepted = await owner.call("external.sessions.terminal.raw-input", {
      streamId: replacement.result.streamId,
      text: "kept",
      inputSeq: 1,
    });
    assert.equal(accepted.result.accepted, true);
    const obsolete = await owner.call("external.sessions.terminal.raw-input", {
      streamId: original.result.streamId,
      text: "lost",
      inputSeq: 1,
    });
    assert.equal(obsolete.error.code, -32001);
    assert.equal(received.get("replacement"), "kept");
    assert.equal(received.has("stale-successor"), false);
    assert.deepEqual(released.sort(), ["original", "stale-successor"]);
    assert.equal(streamStarts, 3);
  } finally {
    finishTakeoverLaunch?.();
    owner.ws.close();
    successor.ws.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-owned command receipts replay across an orderly Serve replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-external-restart-"));
  const sessionId = "ext_codex_aaaaaaaaaaaaaaaaaaaaaaaa";
  const commandId = "77777777-7777-4777-8777-777777777777";
  let submits = 0;
  const session = {
    id: sessionId,
    sourceId: "codex",
    title: "Restart-safe session",
    workspaceName: "hara",
    workspaceId: "ws_restart_safe",
    state: "idle",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:01:00.000Z",
    ephemeral: false,
  };
  const externalSessions = {
    async listSources() { return sourceResult; },
    async listSessions() {
      return { ...sourceResult, sessions: [session], page: { limit: 50, hasMore: false } };
    },
    async readSession() {
      return { session, messages: [], readOnly: true, controlMode: "history" };
    },
    async resumeSession() {
      return { session, messages: [], readOnly: false, controlMode: "managed" };
    },
    async submit(requestedSessionId, text) {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(text, "finish exactly once");
      submits += 1;
      return { sessionId, turnId: "provider-private", status: "completed", reply: "done once" };
    },
    async close() {},
  };
  const persistentDeps = () => ({
    ...deps("personal", externalSessions),
    serveStateHome: root,
  });
  let first;
  let second;
  let firstClient;
  let secondClient;
  try {
    first = await startServe(
      { host: "127.0.0.1", port: 0, token: "first-token", cwd: root },
      persistentDeps(),
    );
    firstClient = await connect(first.port);
    await firstClient.call("initialize", { token: "first-token" });
    const original = await firstClient.call("external.sessions.submit", {
      sessionId,
      text: "finish exactly once",
      commandId,
    });
    assert.equal(original.result.reply, "done once");
    assert.equal(submits, 1);
    firstClient.ws.close();
    firstClient = null;
    await first.close();
    first = null;

    second = await startServe(
      { host: "127.0.0.1", port: 0, token: "second-token", cwd: root },
      persistentDeps(),
    );
    secondClient = await connect(second.port);
    const initialized = await secondClient.call("initialize", { token: "second-token" });
    assert.ok(initialized.result.capabilities.features.includes("external.sessions.command-idempotency.durable.v2"));
    const replayed = await secondClient.call("external.sessions.submit", {
      commandId,
      text: "finish exactly once",
      sessionId,
    });
    assert.deepEqual(replayed.result, original.result);
    assert.equal(submits, 1, "Serve replacement replays the receipt instead of invoking the provider again");
    const conflicting = await secondClient.call("external.sessions.submit", {
      sessionId,
      text: "different command",
      commandId,
    });
    assert.equal(conflicting.error.code, -32005);
    assert.equal(submits, 1);
  } finally {
    firstClient?.ws.close();
    secondClient?.ws.close();
    await first?.close();
    await second?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash-window remote command blocks mutation until an authoritative idle read", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-external-uncertain-"));
  const sessionId = "ext_codex_bbbbbbbbbbbbbbbbbbbbbbbb";
  const uncertainCommandId = "88888888-8888-4888-8888-888888888888";
  const nextCommandId = "99999999-9999-4999-8999-999999999999";
  let sessionState = "working";
  let submits = 0;
  const session = () => ({
    id: sessionId,
    sourceId: "codex",
    title: "Crash-window session",
    workspaceName: "hara",
    workspaceId: "ws_uncertain",
    state: sessionState,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:01:00.000Z",
    ephemeral: false,
  });
  const externalSessions = {
    async listSources() { return sourceResult; },
    async listSessions() {
      return { ...sourceResult, sessions: [session()], page: { limit: 50, hasMore: false } };
    },
    async readSession() {
      return { session: session(), messages: [], readOnly: false, controlMode: "managed" };
    },
    async resumeSession() {
      return { session: session(), messages: [], readOnly: false, controlMode: "managed" };
    },
    async submit(requestedSessionId, text) {
      assert.equal(requestedSessionId, sessionId);
      assert.equal(text, "safe successor");
      submits += 1;
      return { sessionId, turnId: "provider-private", status: "completed", reply: "continued" };
    },
    async close() {},
  };
  const uncertainParams = {
    sessionId,
    text: "outcome was lost with the old process",
    commandId: uncertainCommandId,
  };
  const ledger = new RemoteCommandLedger({ home: root });
  assert.equal(ledger.claim({
    commandId: uncertainCommandId,
    method: "external.sessions.submit",
    resourceHash: createHash("sha256").update(sessionId).digest("hex"),
    requestHash: sessionCommandRequestHash("external.sessions.submit", uncertainParams),
  }).kind, "new");

  let server;
  let client;
  try {
    server = await startServe(
      { host: "127.0.0.1", port: 0, token: "uncertain-token", cwd: root },
      { ...deps("personal", externalSessions), serveStateHome: root },
    );
    client = await connect(server.port);
    await client.call("initialize", { token: "uncertain-token" });

    const duplicate = await client.call("external.sessions.submit", uncertainParams);
    assert.equal(duplicate.error.code, -32005);
    const blocked = await client.call("external.sessions.submit", {
      sessionId,
      text: "safe successor",
      commandId: nextCommandId,
    });
    assert.equal(blocked.error.code, -32005);
    assert.equal(submits, 0, "Serve must not guess whether the crashed provider command ran");

    const workingRead = await client.call("external.sessions.read", { sessionId });
    assert.equal(workingRead.result.session.state, "working");
    const stillBlocked = await client.call("external.sessions.submit", {
      sessionId,
      text: "safe successor",
      commandId: nextCommandId,
    });
    assert.equal(stillBlocked.error.code, -32005, "a live provider session cannot clear uncertainty");

    sessionState = "idle";
    const idleRead = await client.call("external.sessions.read", { sessionId });
    assert.equal(idleRead.result.session.state, "idle");
    const continued = await client.call("external.sessions.submit", {
      sessionId,
      text: "safe successor",
      commandId: nextCommandId,
    });
    assert.equal(continued.result.reply, "continued");
    assert.equal(submits, 1);

    const oldOutcome = await client.call("external.sessions.submit", uncertainParams);
    assert.equal(oldOutcome.error.code, -32005);
    assert.match(oldOutcome.error.message, /exact result is unavailable|inspect/i);
    assert.equal(submits, 1, "the reconciled crash-window command remains deduplicated");
  } finally {
    client?.ws.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
