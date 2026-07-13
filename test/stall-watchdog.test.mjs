// Stall watchdog + turn-phase channel (codex-parity: a silent connection must never hang forever,
// and the pre-first-token stretch must read as "waiting for the model", not generic "working").
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, stallMs } from "../dist/agent/loop.js";
import { onTurnPhase, turnPhase, setTurnPhase } from "../dist/agent/phase.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("stallMs: env-tunable with a sane default and a 1s floor", () => {
  delete process.env.HARA_STALL_TIMEOUT;
  assert.equal(stallMs(), 240_000, "default 240s (generous — reasoning models go quiet before the first content token)");
  process.env.HARA_STALL_TIMEOUT = "5000";
  assert.equal(stallMs(), 5000);
  process.env.HARA_STALL_TIMEOUT = "10";
  assert.equal(stallMs(), 1000, "floor 1s");
  process.env.HARA_STALL_TIMEOUT = "garbage";
  assert.equal(stallMs(), 240_000, "garbage → default");
  delete process.env.HARA_STALL_TIMEOUT;
});

/** A provider that streams nothing and only "fails" when the watchdog aborts it (like a dead socket). */
const deadProvider = {
  id: "dead",
  model: "dead-model",
  turn({ signal }) {
    return new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve({ text: "", toolUses: [], stop: "error", errorMsg: "interrupted" }), { once: true });
    });
  },
};

test("watchdog: a silent turn is aborted, rewritten to a timeout error, and FAILOVER takes over", async () => {
  process.env.HARA_STALL_TIMEOUT = "1200";
  const notices = [];
  const fallback = {
    id: "backup",
    model: "backup-model",
    async turn() {
      return { text: "rescued", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "hi" }];
  await runAgent(history, {
    provider: deadProvider,
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice: (t) => notices.push(t) } },
    approval: "full-auto",
    confirm: async () => true,
    fallback: { provider: fallback },
  });
  const last = history[history.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.text, "rescued", "turn completed on the fallback model after the stall");
  assert.ok(notices.some((n) => /falling back to backup-model/.test(n)), "fallback was announced to the user");
  delete process.env.HARA_STALL_TIMEOUT;
});

test("watchdog: without a fallback the stall surfaces as a TIMEOUT error (not a fake user-interrupt)", async () => {
  process.env.HARA_STALL_TIMEOUT = "1200";
  const notices = [];
  const history = [{ role: "user", content: "hi" }];
  await runAgent(history, {
    provider: deadProvider,
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice: (t) => notices.push(t) } },
    approval: "full-auto",
    confirm: async () => true,
  });
  const all = notices.join("\n");
  assert.ok(/no output for \d+s/.test(all), "stall description surfaced");
  assert.ok(!/\(interrupted\)/.test(all), "NOT misreported as a user interrupt");
  delete process.env.HARA_STALL_TIMEOUT;
});

test("watchdog: a provider that ignores AbortSignal cannot hold the agent loop forever", async () => {
  process.env.HARA_STALL_TIMEOUT = "1000";
  const provider = {
    id: "non-cooperative",
    model: "non-cooperative",
    turn() {
      return new Promise(() => {});
    },
  };
  const started = Date.now();
  const outcome = await runAgent([{ role: "user", content: "do not hang" }], {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /model stream timeout.*no output/i);
  assert.ok(Date.now() - started < 2500, "the watchdog itself is a hard wait boundary");
  delete process.env.HARA_STALL_TIMEOUT;
});

test("provider errors close any partially assembled tool-use round without executing it", async () => {
  const history = [{ role: "user", content: "try a tool" }];
  const outcome = await runAgent(history, {
    provider: {
      id: "partial",
      model: "partial",
      async turn() {
        return {
          text: "",
          toolUses: [{ id: "partial-call", name: "write_file", input: { path: "never.txt", content: "never" } }],
          stop: "error",
          errorMsg: "stream ended mid-response",
        };
      },
    },
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.equal(outcome.status, "error");
  assert.equal(history[1].role, "assistant");
  assert.deepEqual(history[2], {
    role: "tool",
    results: [{
      id: "partial-call",
      name: "write_file",
      content: "Error: provider failed before this tool call could be executed. stream ended mid-response",
      isError: true,
    }],
  });
});

test("watchdog: a real user interrupt stays an interrupt (no timeout rewrite, no fallback)", async () => {
  process.env.HARA_STALL_TIMEOUT = "60000"; // far away — only the user aborts
  const ctrl = new AbortController();
  const notices = [];
  const history = [{ role: "user", content: "hi" }];
  const p = runAgent(history, {
    provider: deadProvider,
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice: (t) => notices.push(t) } },
    approval: "full-auto",
    confirm: async () => true,
    signal: ctrl.signal,
    fallback: { provider: { id: "b", model: "b", async turn() { return { text: "x", toolUses: [], stop: "end" }; } } },
  });
  await tick(150);
  ctrl.abort();
  await p;
  assert.ok(notices.some((n) => /\(interrupted\)/.test(n)), "surfaced as an interrupt");
  assert.ok(!history.some((m) => m.role === "assistant" && m.text === "x"), "no fallback fired for a user interrupt");
  delete process.env.HARA_STALL_TIMEOUT;
});

test("interrupt boundary: a pre-aborted run passes an already-aborted attempt signal", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let sawAborted = false;
  let fallbackCalls = 0;
  const provider = {
    id: "late",
    model: "late",
    async turn({ signal }) {
      sawAborted = signal?.aborted === true;
      throw new Error("provider observed cancellation");
    },
  };
  const history = [{ role: "user", content: "do not start" }];
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    signal: ctrl.signal,
    fallback: { provider: { id: "fallback", model: "fallback", async turn() { fallbackCalls++; return { text: "wrong", toolUses: [], stop: "end" }; } } },
  });
  assert.equal(sawAborted, true, "late AbortSignal listeners are not the only propagation mechanism");
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
  assert.equal(fallbackCalls, 0, "user interruption never triggers failover");
  assert.deepEqual(history, [{ role: "user", content: "do not start" }], "no late assistant response entered history");
});

test("interrupt boundary: a provider that ignores abort cannot execute its late tool_use", async () => {
  const ctrl = new AbortController();
  let markStarted;
  let finishProvider;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const provider = {
    id: "late",
    model: "late",
    turn() {
      markStarted();
      return new Promise((resolve) => {
        finishProvider = () => resolve({ text: "", toolUses: [{ id: "t1", name: "side_effect", input: {} }], stop: "tool_use" });
      });
    },
  };
  let toolRuns = 0;
  const sideEffect = {
    name: "side_effect",
    description: "test-only side effect",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() { toolRuns++; return "ran"; },
  };
  const history = [{ role: "user", content: "wait" }];
  const running = runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    signal: ctrl.signal,
    extraTools: [sideEffect],
  });
  await started;
  ctrl.abort();
  finishProvider();
  assert.deepEqual(await running, { status: "error", error: "(interrupted)" });
  assert.equal(toolRuns, 0, "late tool call was never dispatched");
  assert.equal(history.some((message) => message.role === "tool"), false, "no fabricated tool result was persisted");
});

test("interrupt boundary: cancellation during approval wins over an allow response", async () => {
  const ctrl = new AbortController();
  let toolRuns = 0;
  const gated = {
    name: "gated_effect",
    description: "test-only gated side effect",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() { toolRuns++; return "ran"; },
  };
  const provider = {
    id: "p",
    model: "m",
    async turn() { return { text: "", toolUses: [{ id: "t1", name: gated.name, input: {} }], stop: "tool_use" }; },
  };
  const history = [{ role: "user", content: "gate it" }];
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "suggest",
    confirm: async () => { ctrl.abort(); return true; },
    quiet: true,
    signal: ctrl.signal,
    extraTools: [gated],
  });
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
  assert.equal(toolRuns, 0, "approval completion cannot revive an interrupted run");
  assert.equal(history[1].role, "assistant");
  assert.deepEqual(history[2], {
    role: "tool",
    results: [{ id: "t1", name: gated.name, content: "Error: interrupted before this tool call completed.", isError: true }],
  }, "persisted history closes every interrupted tool_use");
});

test("interrupt boundary: cancellation after one sequential tool prevents the next tool", async () => {
  const ctrl = new AbortController();
  let firstRuns = 0;
  let secondRuns = 0;
  const first = {
    name: "first_effect",
    description: "test-only first effect",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() { firstRuns++; ctrl.abort(); return "first done"; },
  };
  const second = {
    name: "second_effect",
    description: "test-only second effect",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() { secondRuns++; return "second done"; },
  };
  const provider = {
    id: "p",
    model: "m",
    async turn() {
      return {
        text: "",
        toolUses: [
          { id: "t1", name: first.name, input: {} },
          { id: "t2", name: second.name, input: {} },
        ],
        stop: "tool_use",
      };
    },
  };
  const history = [{ role: "user", content: "two steps" }];
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    signal: ctrl.signal,
    extraTools: [first, second],
  });
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
  assert.equal(firstRuns, 1, "the already-started tool completed");
  assert.equal(secondRuns, 0, "no later tool started after cancellation");
  assert.equal(history[2].role, "tool");
  assert.deepEqual(history[2].results.map(({ id, name, content, isError }) => ({ id, name, content, isError })), [
    { id: "t1", name: first.name, content: "first done", isError: undefined },
    { id: "t2", name: second.name, content: "Error: interrupted before this tool call completed.", isError: true },
  ], "completed side effects keep their real result while later calls close as interrupted");
});

test("phase: waiting → streaming published for main runs; quiet runs never touch the channel", async () => {
  setTurnPhase("idle"); // earlier tests may have left the module mid-phase (dedup would swallow "waiting")
  const seen = [];
  const un = onTurnPhase((p) => seen.push(p));
  const slowStreamer = {
    id: "s",
    model: "s",
    async turn({ onText }) {
      await tick(60);
      onText("hi");
      return { text: "hi", toolUses: [], stop: "end" };
    },
  };
  await runAgent([{ role: "user", content: "q" }], {
    provider: slowStreamer,
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } },
    approval: "full-auto",
    confirm: async () => true,
  });
  assert.deepEqual(seen.slice(0, 2), ["waiting", "streaming"], "waiting precedes streaming");
  seen.length = 0;
  await runAgent([{ role: "user", content: "q" }], { provider: slowStreamer, ctx: { cwd: process.cwd() }, approval: "full-auto", confirm: async () => true, quiet: true });
  assert.deepEqual(seen, [], "quiet run published nothing");
  un();
  assert.ok(["idle", "waiting", "streaming"].includes(turnPhase()), "phase getter sane");
});
