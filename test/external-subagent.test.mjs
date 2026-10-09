import test from "node:test";
import assert from "node:assert/strict";
import { executeExternalCodingAgent } from "../dist/subagent/external.js";
import { ExternalRuntimeSessionGoneError } from "../dist/external-sessions/types.js";

const runtimeId = `ext_runtime_${"b".repeat(24)}`;
const providerSessionId = `ext_codex_${"c".repeat(24)}`;
const session = { id: providerSessionId, sourceId: "codex", state: "idle" };
const admitted = { session, messages: [], readOnly: false, controlMode: "managed" };
const request = (overrides = {}) => ({
  id: "15ee97af-e175-4ac8-9cdb-801fe9d36d6f", path: "/root/coder", parentPath: "/root", generation: 1,
  runtime: "codex", task: "Implement the bounded change.", signal: new AbortController().signal, controller: {},
  pendingInput: async () => [], reportProgress: () => true,
  budget: { maxProviderRounds: 2, maxToolCalls: 10, maxTokens: 10_000, timeoutMs: 10_000 },
  workspace: { mode: "isolated-write", cwd: "/tmp/hara-agent-worktree", sourceCwd: "/tmp/source", writeBoundary: "/tmp/hara-agent-worktree" },
  ...overrides,
});
const service = (overrides = {}) => ({
  createCodingSession: async () => admitted, resumeCodingSession: async () => admitted,
  submit: async (id) => ({ sessionId: id, turnId: "turn", status: "completed", reply: "done" }),
  interrupt: async () => {}, steer: async (id) => ({ sessionId: id, turnId: "turn", accepted: true }), ...overrides,
});
const questions = { questions: [{ id: "choice", question: "Which implementation?", options: [{ label: "A" }, { label: "B" }] }] };

test("new coding worker uses a structured provider session and binds its parent before dispatch", async () => {
  const calls = [];
  const result = await executeExternalCodingAgent(request(), service({
    async createCodingSession(input) { calls.push(["create", input]); return admitted; },
    async submit(id, text, sink) {
      calls.push(["submit", id, text]); assert.equal(sink.signal.aborted, false);
      sink.text("stream"); sink.tool("Command", "bounded preview");
      return { sessionId: id, turnId: "turn", status: "completed", reply: "done" };
    },
  }), { onSession: (value) => calls.push(["bound", value]), text: (value) => calls.push(["text", value]),
    tool: (name) => calls.push(["tool", name]) });
  assert.equal(result.status, "completed"); assert.equal(result.providerSessionId, providerSessionId);
  assert.equal(result.runtimeSessionId, undefined);
  assert.deepEqual(calls.map((entry) => entry[0]), ["create", "bound", "submit", "text", "tool"]);
  assert.equal(calls[0][1].cwd, "/tmp/hara-agent-worktree"); assert.equal(calls[0][1].agentKind, "codex");
  assert.equal(calls[0][1].launch, undefined, "workers cannot choose bypass or acceptEdits profiles");
});

test("structured worker follow-ups resume only the saved provider conversation", async () => {
  const calls = [];
  const result = await executeExternalCodingAgent(request({ generation: 2, providerSessionId }), service({
    createCodingSession: async () => assert.fail("must not create a replacement"),
    async resumeCodingSession(input) { calls.push(input); return admitted; },
  }));
  assert.equal(result.status, "completed"); assert.equal(calls[0].providerSessionId, providerSessionId);
  assert.equal(result.runtimeSessionId, undefined);
});

test("worker permissions and questions return through separate parent callbacks, without permanent grants", async () => {
  let bound = false;
  const result = await executeExternalCodingAgent(request(), service({ async submit(id, _text, sink) {
    assert.equal(bound, true);
    assert.equal(await sink.confirm({ question: "Run this command?", allowAlways: true }, new AbortController().signal), true);
    assert.deepEqual(await sink.askUser(questions, new AbortController().signal), { choice: { answers: ["B"] } });
    return { sessionId: id, turnId: "turn", status: "completed", reply: "done" };
  } }), { onSession: () => { bound = true; }, confirm: async (approval) => {
    assert.equal(approval.allowAlways, false); return "always";
  }, askUser: async (value) => { assert.deepEqual(value, questions); return { choice: { answers: ["B"] } }; } });
  assert.equal(result.status, "completed");
});

test("missing or rejected parent callbacks deny permissions and choose no answer", async () => {
  for (const observer of [{}, { confirm: async () => { throw new Error("closed"); }, askUser: async () => { throw new Error("closed"); } }]) {
    const result = await executeExternalCodingAgent(request(), service({ async submit(id, _text, sink) {
      assert.equal(await sink.confirm({ question: "Run?" }, new AbortController().signal), false);
      assert.deepEqual(await sink.askUser(questions, new AbortController().signal), {});
      return { sessionId: id, turnId: "turn", status: "completed", reply: "denied safely" };
    } }), observer);
    assert.equal(result.status, "completed");
  }
});

test("parent cancellation settles a non-cooperative question callback without selecting an answer", async () => {
  const controller = new AbortController(); let interrupted = 0;
  const result = await executeExternalCodingAgent(request({ signal: controller.signal }), service({
    async submit(id, _text, sink) {
      const answer = sink.askUser(questions, new AbortController().signal); controller.abort();
      assert.deepEqual(await answer, {});
      assert.equal(await sink.confirm({ question: "Run?" }, new AbortController().signal), false);
      return { sessionId: id, turnId: "turn", status: "interrupted", reply: "" };
    }, interrupt: async () => { interrupted++; },
  }), { askUser: async (_value, signal) => { assert.equal(signal.aborted, true); return new Promise(() => {}); } });
  assert.equal(result.status, "cancelled"); assert.ok(interrupted > 0);
});

test("cancelled admission and failed parent binding never start a provider turn", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(); let submitted = 0;
    const result = await executeExternalCodingAgent(request({ signal: controller.signal }), service({
      async createCodingSession() { if (cancel) controller.abort(); return admitted; },
      async submit() { submitted++; assert.fail("no dispatch after failed binding/cancellation"); },
    }), { onSession: () => { throw new Error("parent turn is stale"); } });
    assert.equal(result.status, cancel ? "cancelled" : "error");
    assert.equal(result.providerSessionId, providerSessionId); assert.equal(submitted, 0);
  }
});

test("legacy live terminal, including idle, is never silently joined or killed", async () => {
  const calls = [];
  const result = await executeExternalCodingAgent(request({ runtimeSessionId: runtimeId, providerSessionId }), service({
    readSession: async () => ({ session: { id: runtimeId, providerSessionId, state: "idle" } }),
    createCodingSession: async () => assert.fail("no replacement"), resumeCodingSession: async () => assert.fail("no second controller"),
    interrupt: async () => assert.fail("do not kill user terminal"),
  }), { onSession: () => calls.push("bound") });
  assert.equal(result.status, "error"); assert.match(result.error, /Release that terminal explicitly/);
  assert.equal(result.runtimeSessionId, runtimeId); assert.deepEqual(calls, []);
});

test("authoritatively gone legacy terminal resumes the exact provider, without creating a terminal", async () => {
  const calls = [];
  const result = await executeExternalCodingAgent(request({ runtimeSessionId: runtimeId, providerSessionId }), service({
    readSession: async () => { throw new ExternalRuntimeSessionGoneError("gone"); },
    async resumeCodingSession(input) { calls.push(input); return admitted; },
    createCodingSession: async () => assert.fail("no new conversation"),
  }));
  assert.equal(result.status, "completed"); assert.equal(result.providerSessionId, providerSessionId);
  assert.equal(result.runtimeSessionId, runtimeId, "legacy identity is retained, not represented as a new live terminal");
  assert.equal(calls[0].providerSessionId, providerSessionId);
});

test("legacy inspection faults and missing provider links never create a replacement", async () => {
  for (const [error, providerId] of [[new Error("temporary transport failure"), providerSessionId], [new ExternalRuntimeSessionGoneError("gone"), undefined]]) {
    const result = await executeExternalCodingAgent(request({ runtimeSessionId: runtimeId, providerSessionId: providerId }), service({
      readSession: async () => { throw error; }, resumeCodingSession: async () => assert.fail("no ambiguous recovery"),
      createCodingSession: async () => assert.fail("no replacement"),
    }));
    assert.equal(result.status, "error");
  }
});

test("structured admission cannot swap provider/session or silently use protected history", async () => {
  for (const bad of [{ ...admitted, session: { ...session, sourceId: "claude" } },
    { ...admitted, session: { ...session, id: `ext_codex_${"d".repeat(24)}` } },
    { ...admitted, readOnly: true }, { ...admitted, controlMode: "history" }]) {
    const result = await executeExternalCodingAgent(request({ providerSessionId }), service({
      resumeCodingSession: async () => bad, submit: async () => assert.fail("invalid admission must not submit"),
    }));
    assert.equal(result.status, "error"); assert.equal(result.providerSessionId, providerSessionId);
  }
});

test("in-flight worker mail uses structured steer, not raw terminal input", { timeout: 3_000 }, async () => {
  let finish; const completed = new Promise((resolve) => { finish = resolve; });
  let pending = [{ id: "late-mail", sourcePath: "/root", content: "Use the smaller API." }];
  const result = await executeExternalCodingAgent(request({ pendingInput: async () => { const value = pending; pending = []; return value; } }), service({
    submit: async () => completed,
    async steer(id, text) {
      assert.equal(id, providerSessionId); assert.match(text, /Use the smaller API/);
      finish({ sessionId: id, turnId: "turn", status: "completed", reply: "done" });
      return { sessionId: id, turnId: "turn", accepted: true };
    }, terminalInput: async () => assert.fail("no terminal transport"),
  }));
  assert.equal(result.status, "completed");
});

test("durable provider binding precedes reservation, observer, and dispatch and refuses persistence failure", async () => {
  const order = [];
  await executeExternalCodingAgent(request({
    bindProviderSession: (id) => { assert.equal(id, providerSessionId); order.push("persist"); },
    reserveInput: async () => { order.push("reserve"); return []; },
  }), service({ submit: async (id) => { order.push("submit"); return { sessionId: id, status: "completed", reply: "done" }; } }),
  { onSession: () => order.push("observe") });
  assert.deepEqual(order, ["persist", "reserve", "observe", "submit"]);
  const failed = await executeExternalCodingAgent(request({ bindProviderSession: () => { throw new Error("durable store refused binding"); } }),
    service({ submit: async () => assert.fail("no dispatch after persistence failed") }),
    { onSession: () => assert.fail("no observer before durable binding") });
  assert.equal(failed.status, "error"); assert.match(failed.error, /refused binding/);
});

test("OpenCode receives its scoped host factory and replaces zero-round admission with actual absolute metrics", async () => {
  const opencodeId = `ext_opencode_${"e".repeat(24)}`;
  const actual = { providerRounds: 2, toolCalls: 3, inputTokens: 120, outputTokens: 40 };
  const progress = []; const workerController = new AbortController(); let hostSignal;
  const result = await executeExternalCodingAgent(request({ runtime: "opencode", reportProgress: (metrics) => { progress.push({ ...metrics }); return true; } }),
    service({ createCodingSession: async (input) => {
      assert.equal(input.agentKind, "opencode"); assert.match(input.title, /^OpenCode/);
      return { ...admitted, session: { ...session, id: opencodeId, sourceId: "opencode" } };
    }, submit: async (id, text, sink) => {
      assert.equal(text, "Implement the bounded change.");
      assert.deepEqual(await sink.prepareCodingHost(workerController.signal), { marker: "host bridge" });
      assert.equal(hostSignal.aborted, false); workerController.abort(); assert.equal(hostSignal.aborted, true);
      return { sessionId: id, status: "completed", reply: "done", metrics: actual };
    } }), { prepareCodingHost: async (signal) => { hostSignal = signal; return { marker: "host bridge" }; } });
  assert.equal(result.status, "completed"); assert.deepEqual(result.metrics, actual);
  assert.deepEqual(progress, [{ providerRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, actual]);
});

test("Pi is not admitted through external session providers or PTY adapters", async () => {
  const result = await executeExternalCodingAgent(request({ runtime: "pi" }), service({
    createCodingSession: async () => assert.fail("Pi has its own internal SDK executor"),
    submit: async () => assert.fail("no external dispatch for Pi"),
  }));
  assert.equal(result.status, "error"); assert.match(result.error, /not an external/);
});

test("host-authoritative final metrics never regress or inflate to different OpenCode event counters", async () => {
  const opencodeId = `ext_opencode_${"e".repeat(24)}`;
  for (const adapter of [{ providerRounds: 1, toolCalls: 1, inputTokens: 50, outputTokens: 5 },
    { providerRounds: 5, toolCalls: 8, inputTokens: 800, outputTokens: 90 }]) {
    const host = { providerRounds: 2, toolCalls: 3, inputTokens: 120, outputTokens: 40 }, reports = [];
    const execution = request({ runtime: "opencode", reportProgress: metrics => {
      const previous = reports.at(-1);
      if (previous) for (const key of Object.keys(host)) assert.ok(metrics[key] >= previous[key], `${key} must not descend`);
      reports.push({ ...metrics }); return true;
    } });
    const result = await executeExternalCodingAgent(execution, service({ createCodingSession: async () => ({ ...admitted, session: { ...session, id: opencodeId, sourceId: "opencode" } }),
      submit: async id => { execution.reportProgress(host); return { sessionId: id, status: "completed", reply: "done", metrics: adapter }; },
    }), { executionMetrics: () => host });
    assert.equal(result.status, "completed"); assert.deepEqual(result.metrics, host); assert.deepEqual(reports.at(-1), host);
  }
});

test("host counters remain authoritative on failed, cancelled, thrown and foreign external completions", async () => {
  const opencodeId = `ext_opencode_${"e".repeat(24)}`;
  for (const mode of ["failed", "interrupted", "throw", "foreign"]) {
    const host = { providerRounds: 2, toolCalls: 1, inputTokens: 123, outputTokens: 7 }, reports = [];
    const execution = request({ runtime: "opencode", reportProgress: value => { reports.push({ ...value }); return true; } });
    const result = await executeExternalCodingAgent(execution, service({ createCodingSession: async () => ({ ...admitted, session: { ...session, id: opencodeId, sourceId: "opencode" } }),
      submit: async id => {
        execution.reportProgress(host);
        if (mode === "throw") throw new Error("synthetic upstream failure");
        return { sessionId: mode === "foreign" ? providerSessionId : id, status: mode === "foreign" ? "completed" : mode, reply: "partial", metrics: { providerRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 } };
      },
    }), { executionMetrics: () => host });
    assert.notEqual(result.status, "completed"); assert.deepEqual(result.metrics, host); assert.deepEqual(reports.at(-1), host);
  }
});

test("invalid or unavailable host counters refuse successful output and never ACK represented input", async () => {
  const opencodeId = `ext_opencode_${"e".repeat(24)}`;
  for (const source of [() => ({ providerRounds: 1, toolCalls: 0, inputTokens: -1, outputTokens: 0 }),
    () => ({ providerRounds: 1, toolCalls: 0, inputTokens: 1 }), () => undefined, () => { throw new Error("synthetic unavailable host"); }]) {
    const result = await executeExternalCodingAgent(request({ runtime: "opencode", initialInputIds: ["initial"], reserveInput: async () => [{ id: "initial", sourcePath: "/root", content: "represented" }],
      acknowledgeInput: async () => assert.fail("invalid accounting cannot complete/ACK"),
    }), service({ createCodingSession: async () => ({ ...admitted, session: { ...session, id: opencodeId, sourceId: "opencode" } }),
      submit: async id => ({ sessionId: id, status: "completed", reply: "must not project", metrics: { providerRounds: 1, toolCalls: 0, inputTokens: 1, outputTokens: 0 } }),
    }), { executionMetrics: source });
    assert.equal(result.status, "error"); assert.equal(result.text, ""); assert.equal(result.metrics, undefined);
  }
});

test("foreign completions and invalid absolute counters never ACK initial durable input", async () => {
  for (const bad of [
    { sessionId: `ext_codex_${"f".repeat(24)}` },
    { metrics: { providerRounds: -1, toolCalls: 0, inputTokens: 0, outputTokens: 0 } },
    { metrics: { providerRounds: 1, toolCalls: 0, inputTokens: 0 } },
  ]) {
    const result = await executeExternalCodingAgent(request({ initialInputIds: ["initial-mail"],
      reserveInput: async () => [{ id: "initial-mail", sourcePath: "/root", content: "captured" }],
      acknowledgeInput: async () => assert.fail("invalid completion cannot acknowledge input"),
    }), service({ submit: async (id) => ({ sessionId: id, status: "completed", reply: "must not project", ...bad }) }));
    assert.equal(result.status, "error"); assert.equal(result.text, "");
  }
});

test("initial input stays pending on failure and is ACKed only after confirmed completed submission without prompt duplication", async () => {
  for (const turnStatus of ["completed", "failed", "interrupted", "throw"]) {
    const ack = []; const order = []; const task = "Assignment plus accepted follow-up already captured.";
    const result = await executeExternalCodingAgent(request({ task, initialInputIds: ["initial-mail"],
      reserveInput: async () => [{ id: "initial-mail", sourcePath: "/root", content: "already captured", kind: "followup" }],
      acknowledgeInput: async (id) => { order.push("ack"); ack.push(id); },
    }), service({ submit: async (id, text) => {
      assert.equal(text, task); order.push("submit");
      if (turnStatus === "throw") throw new Error("dispatch failed");
      return { sessionId: id, status: turnStatus, reply: "done" };
    }, steer: async () => assert.fail("initial input was included once in task") }));
    assert.equal(result.status, turnStatus === "completed" ? "completed" : turnStatus === "interrupted" ? "cancelled" : "error");
    assert.deepEqual(ack, turnStatus === "completed" ? ["initial-mail"] : []);
    assert.deepEqual(order, turnStatus === "completed" ? ["submit", "ack"] : ["submit"]);
  }
});

test("captured initial IDs exclude admission-time new mail and repeated reservations never steer or ACK twice", { timeout: 3_000 }, async () => {
  const initial = { id: "initial-mail", sourcePath: "/root", content: "captured follow-up", kind: "followup" };
  const late = { id: "late-mail", sourcePath: "/root", content: "arrived during admission", kind: "message" };
  let polls = 0, steers = 0, finish; const ack = []; const notices = [];
  const completion = new Promise((resolve) => { finish = resolve; });
  const result = await executeExternalCodingAgent(request({ initialInputIds: [initial.id],
    reserveInput: async () => {
      polls++;
      if (polls === 4) finish({ sessionId: providerSessionId, status: "completed", reply: "done" });
      return [initial, late];
    },
    acknowledgeInput: async (id) => ack.push(id),
  }), service({ submit: async () => completion, steer: async (id, text) => {
    steers++; assert.match(text, /arrived during admission/); assert.doesNotMatch(text, /captured follow-up/);
    return { sessionId: id, turnId: "turn", accepted: true };
  } }), { notice: (text) => notices.push(text) });
  assert.equal(result.status, "completed"); assert.equal(steers, 1);
  assert.deepEqual(ack, [late.id, initial.id]); assert.equal(notices.length, 1);
});

test("unconfirmed steer leaves durable mail pending and does not claim delivery", { timeout: 3_000 }, async () => {
  let finish; const completed = new Promise((resolve) => { finish = resolve; });
  const ack = [], notices = [];
  const result = await executeExternalCodingAgent(request({ initialInputIds: [],
    reserveInput: async () => [{ id: "late-mail", sourcePath: "/root", content: "not accepted" }],
    acknowledgeInput: async (id) => ack.push(id),
  }), service({ submit: async () => completed, steer: async () => undefined,
    interrupt: async () => finish({ sessionId: providerSessionId, status: "interrupted", reply: "" }),
  }), { notice: (text) => notices.push(text) });
  assert.equal(result.status, "error"); assert.match(result.error, /did not confirm/);
  assert.deepEqual(ack, []); assert.deepEqual(notices, []);
});

test("unsupported Claude in-flight mail fails explicitly and interrupts without restarting or claiming delivery", { timeout: 3_000 }, async () => {
  const claudeId = `ext_claude_${"d".repeat(24)}`; let created = 0; let submitted = 0; let interrupted = 0;
  let finish; const completed = new Promise((resolve) => { finish = resolve; });
  let pending = [{ sourcePath: "/root", content: "Use the smaller API." }]; const notices = [];
  const result = await executeExternalCodingAgent(request({ runtime: "claude", pendingInput: async () => { const value = pending; pending = []; return value; } }), service({
    createCodingSession: async () => { created++; return { ...admitted, session: { id: claudeId, sourceId: "claude", state: "idle" } }; },
    submit: async () => { submitted++; return completed; },
    steer: async () => { throw new Error("Claude does not support in-flight input"); },
    interrupt: async () => { interrupted++; finish({ sessionId: claudeId, turnId: "turn", status: "interrupted", reply: "" }); },
    terminalInput: async () => assert.fail("no raw terminal fallback"),
  }), { notice: (value) => notices.push(value) });
  assert.equal(result.status, "error"); assert.match(result.error, /does not support in-flight input/);
  assert.equal(created, 1); assert.equal(submitted, 1); assert.equal(interrupted, 1);
  assert.deepEqual(notices, [], "an unconfirmed message is not reported as relayed");
});
