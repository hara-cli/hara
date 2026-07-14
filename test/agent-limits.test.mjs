import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import {
  agentMaxRounds,
  agentRunTimeoutMs,
  DEFAULT_AGENT_MAX_ROUNDS,
  DEFAULT_AGENT_RUN_TIMEOUT_MS,
  MAX_AGENT_MAX_ROUNDS,
  MAX_AGENT_RUN_TIMEOUT_MS,
} from "../dist/agent/limits.js";
import { runShell } from "../dist/sandbox.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/builtin.js";
import "../dist/tools/memory.js";

const originalHome = process.env.HOME;
const testHomeRoot = mkdtempSync(join(tmpdir(), "hara-agent-limits-"));
const testHome = join(testHomeRoot, "home");
mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(testHomeRoot, { recursive: true, force: true });
});

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function base(provider, extra = {}) {
  return {
    provider,
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } },
    approval: "full-auto",
    confirm: async () => true,
    ...extra,
  };
}

test("agent lifecycle limit parsers accept friendly durations and cannot be disabled", () => {
  assert.equal(agentRunTimeoutMs("30m"), 30 * 60_000);
  assert.equal(agentRunTimeoutMs("90s"), 90_000);
  assert.equal(agentRunTimeoutMs("1h"), 3_600_000);
  assert.equal(agentRunTimeoutMs("250"), 1_000, "plain values are milliseconds and retain the safety floor");
  assert.equal(agentRunTimeoutMs("0"), DEFAULT_AGENT_RUN_TIMEOUT_MS, "zero cannot disable the deadline");
  assert.equal(agentRunTimeoutMs("forever"), DEFAULT_AGENT_RUN_TIMEOUT_MS);
  assert.equal(agentRunTimeoutMs("999h"), MAX_AGENT_RUN_TIMEOUT_MS);
  assert.equal(agentMaxRounds("12"), 12);
  assert.equal(agentMaxRounds("0"), DEFAULT_AGENT_MAX_ROUNDS, "zero cannot disable the round cap");
  assert.equal(agentMaxRounds("garbage"), DEFAULT_AGENT_MAX_ROUNDS);
  assert.equal(agentMaxRounds("9999"), MAX_AGENT_MAX_ROUNDS);
});

test("an active tool loop hard-stops at maxRounds and alerts exactly once", async () => {
  let turns = 0;
  let tools = 0;
  const notices = [];
  const alerts = [];
  const provider = {
    id: "looper",
    model: "looper",
    async turn() {
      turns += 1;
      return { text: "", toolUses: [{ id: `call-${turns}`, name: "progress_probe", input: { turn: turns } }], stop: "tool_use" };
    },
  };
  const outcome = await runAgent([{ role: "user", content: "loop" }], base(provider, {
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice: (message) => notices.push(message) } },
    maxRounds: 3,
    timeoutMs: "10s",
    onLimit: (event) => alerts.push(event),
    extraTools: [{
      name: "progress_probe",
      description: "test probe",
      input_schema: { type: "object", properties: { turn: { type: "number" } }, required: ["turn"] },
      kind: "read",
      async run() { tools += 1; return "ok"; },
    }],
  }));
  assert.equal(turns, 3);
  assert.equal(tools, 3);
  assert.equal(outcome.status, "halted");
  assert.equal(outcome.stopReason, "max_rounds");
  assert.match(outcome.error, /3-round safety limit/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "max_rounds");
  assert.ok(notices.some((message) => /still running/.test(message)), "75% round warning is visible");
  assert.equal(notices.filter((message) => /agent run stopped/.test(message)).length, 1);
});

test("three identical failed tool calls trip the repeat-loop circuit breaker", async () => {
  let turns = 0;
  const provider = {
    id: "repeat",
    model: "repeat",
    async turn() {
      turns += 1;
      return { text: "", toolUses: [{ id: `same-${turns}`, name: "always_fails", input: { same: true } }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "repeat" }];
  const outcome = await runAgent(history, base(provider, {
    maxRounds: 20,
    timeoutMs: "10s",
    quiet: true,
    extraTools: [{
      name: "always_fails",
      description: "test failure",
      input_schema: { type: "object", properties: { same: { type: "boolean" } } },
      kind: "read",
      async run() { return "Error: deterministic failure"; },
    }],
  }));
  assert.equal(turns, 3);
  assert.equal(outcome.status, "halted");
  assert.equal(outcome.stopReason, "repeat_loop");
  assert.match(outcome.error, /same failing always_fails call repeated 3 times/);
  assert.equal(history.at(-1).role, "tool", "the last assistant tool_use remains protocol-complete");
});

test("a changed failure or successful call clears an older repeated-failure streak", async () => {
  let turn = 0;
  const sequence = ["fail", "fail", "other-fail", "fail", "fail", "progress", "fail", "fail", "done"];
  const provider = {
    id: "recovering-repeat",
    model: "recovering-repeat",
    async turn() {
      const step = sequence[turn++];
      if (step === "done") return { text: "recovered", toolUses: [], stop: "end" };
      return {
        text: "",
        toolUses: [{
          id: `call-${turn}`,
          name: step === "progress" ? "successful_edit" : "sometimes_fails",
          input: step === "progress" ? { path: "fixed.txt" } : { same: step !== "other-fail" },
        }],
        stop: "tool_use",
      };
    },
  };
  const outcome = await runAgent([{ role: "user", content: "recover" }], base(provider, {
    maxRounds: 10,
    timeoutMs: "10s",
    quiet: true,
    extraTools: [
      {
        name: "sometimes_fails",
        description: "test failure",
        input_schema: { type: "object", properties: { same: { type: "boolean" } } },
        kind: "read",
        async run() { return "Error: deterministic failure"; },
      },
      {
        name: "successful_edit",
        description: "test progress",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
        kind: "edit",
        async run() { return "updated file"; },
      },
    ],
  }));
  assert.equal(outcome.status, "completed");
  assert.equal(turn, sequence.length, "the old failures do not combine with failures after progress");
});

test("three repeated unknown or denied calls are failures and trip the breaker", async (t) => {
  for (const scenario of [
    { name: "unknown", toolName: "missing_tool" },
    { name: "denied", toolName: "denied_tool" },
  ]) {
    await t.test(scenario.name, async () => {
      let turns = 0;
      const provider = {
        id: scenario.name,
        model: scenario.name,
        async turn() {
          turns += 1;
          return { text: "", toolUses: [{ id: `${scenario.name}-${turns}`, name: scenario.toolName, input: { same: true } }], stop: "tool_use" };
        },
      };
      const opts = {
        maxRounds: 10,
        timeoutMs: "10s",
        quiet: true,
        ...(scenario.name === "denied"
          ? {
              approval: "suggest",
              confirm: async () => false,
              extraTools: [{
                name: "denied_tool",
                description: "requires approval",
                input_schema: { type: "object", properties: { same: { type: "boolean" } } },
                kind: "edit",
                async run() { throw new Error("denied tool must never execute"); },
              }],
            }
          : {}),
      };
      const outcome = await runAgent([{ role: "user", content: scenario.name }], base(provider, opts));
      assert.equal(turns, 3);
      assert.equal(outcome.stopReason, "repeat_loop");
      assert.match(outcome.error, new RegExp(`same failing ${scenario.toolName} call repeated 3 times`));
    });
  }
});

test("total deadline stops a provider that stays active forever and ignores AbortSignal", async () => {
  const notices = [];
  const alerts = [];
  const provider = {
    id: "busy-forever",
    model: "busy-forever",
    turn({ onActivity }) {
      const timer = setInterval(() => onActivity?.(), 20);
      timer.unref?.();
      return new Promise(() => {});
    },
  };
  const started = Date.now();
  const outcome = await runAgent([{ role: "user", content: "never finish" }], base(provider, {
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice: (message) => notices.push(message) } },
    timeoutMs: 1_000,
    maxRounds: 20,
    onLimit: (event) => alerts.push(event),
  }));
  assert.equal(outcome.status, "halted");
  assert.equal(outcome.stopReason, "deadline");
  assert.match(outcome.error, /total deadline 1s reached/);
  assert.ok(Date.now() - started < 2_500, "an active/non-cooperative provider cannot hold the run open");
  assert.equal(alerts.length, 1);
  assert.equal(notices.filter((message) => /agent run stopped/.test(message)).length, 1);
});

test("total deadline closes a tool round even when the tool ignores cancellation", async () => {
  const provider = {
    id: "tool-hang",
    model: "tool-hang",
    async turn() {
      return { text: "", toolUses: [{ id: "hang-1", name: "hang_tool", input: {} }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "hang" }];
  let sawSignal = false;
  const started = Date.now();
  const outcome = await runAgent(history, base(provider, {
    timeoutMs: 1_000,
    maxRounds: 20,
    quiet: true,
    extraTools: [{
      name: "hang_tool",
      description: "never settles",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run(_input, ctx) {
        sawSignal = ctx.signal instanceof AbortSignal;
        return new Promise(() => {});
      },
    }],
  }));
  assert.equal(sawSignal, true, "tools receive the combined run signal");
  assert.equal(outcome.stopReason, "deadline");
  assert.ok(Date.now() - started < 2_500);
  assert.equal(history.at(-1).role, "tool");
  assert.match(history.at(-1).results[0].content, /run deadline 1s reached/);
});

test("a late non-cooperative wrapper cannot commit through built-in write_file after the deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-late-write-"));
  const target = join(dir, "late.txt");
  let lateResult = "";
  const provider = {
    id: "late-write",
    model: "late-write",
    async turn() {
      return { text: "", toolUses: [{ id: "late-1", name: "late_write_wrapper", input: {} }], stop: "tool_use" };
    },
  };
  try {
    const outcome = await runAgent([{ role: "user", content: "write late" }], base(provider, {
      ctx: { cwd: dir },
      timeoutMs: 1_000,
      quiet: true,
      extraTools: [{
        name: "late_write_wrapper",
        description: "delays, then delegates to the built-in writer",
        input_schema: { type: "object", properties: {} },
        kind: "edit",
        async run(_input, ctx) {
          await tick(1_200); // deliberately ignores cancellation while waiting
          lateResult = await getTool("write_file").run({ path: "late.txt", content: "must not land\n" }, ctx);
          return lateResult;
        },
      }],
    }));
    assert.equal(outcome.stopReason, "deadline");
    await tick(350);
    assert.equal(existsSync(target), false, "the physical late tool cannot cross the atomic commit gate");
    assert.match(lateResult, /cancel|No changes written/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a late non-cooperative wrapper cannot start another registered edit tool after the deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-late-memory-"));
  const target = join(dir, ".hara", "memory", "MEMORY.md");
  let lateResult = "";
  const provider = {
    id: "late-memory",
    model: "late-memory",
    async turn() {
      return { text: "", toolUses: [{ id: "late-memory-1", name: "late_memory_wrapper", input: {} }], stop: "tool_use" };
    },
  };
  try {
    const outcome = await runAgent([{ role: "user", content: "write memory late" }], base(provider, {
      ctx: { cwd: dir },
      timeoutMs: 1_000,
      quiet: true,
      extraTools: [{
        name: "late_memory_wrapper",
        description: "delays, then delegates to another registered edit tool",
        input_schema: { type: "object", properties: {} },
        kind: "edit",
        async run(_input, ctx) {
          await tick(1_200); // deliberately ignores cancellation while waiting
          lateResult = await getTool("memory_write").run({ content: "must not land", scope: "project" }, ctx);
          return lateResult;
        },
      }],
    }));
    assert.equal(outcome.stopReason, "deadline");
    await tick(350);
    assert.equal(existsSync(target), false, "the registry boundary refuses delayed cross-tool side effects");
    assert.match(lateResult, /cancelled before execution/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("total deadline actively aborts and cleans a hanging approval prompt", async () => {
  const provider = {
    id: "approval-hang",
    model: "approval-hang",
    async turn() {
      return { text: "", toolUses: [{ id: "approval-1", name: "gated_effect", input: {} }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "ask before running" }];
  let sawSignal = false;
  let cleaned = false;
  let toolRuns = 0;
  const outcome = await runAgent(history, base(provider, {
    approval: "suggest",
    timeoutMs: 1_000,
    maxRounds: 10,
    quiet: true,
    confirm: async (_question, signal) => new Promise((_resolve, reject) => {
      sawSignal = signal instanceof AbortSignal;
      signal?.addEventListener("abort", () => {
        cleaned = true;
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    }),
    extraTools: [{
      name: "gated_effect",
      description: "must never execute",
      input_schema: { type: "object", properties: {} },
      kind: "edit",
      async run() { toolRuns += 1; return "ran"; },
    }],
  }));
  assert.equal(sawSignal, true, "the approval surface receives the combined run signal");
  assert.equal(cleaned, true, "deadline actively dismisses the approval instead of only abandoning its Promise");
  assert.equal(toolRuns, 0);
  assert.equal(outcome.stopReason, "deadline");
  assert.equal(history.at(-1).role, "tool");
  assert.match(history.at(-1).results[0].content, /run deadline 1s reached/);
});

test("total deadline propagates through ToolContext.ask and closes a hanging question", async () => {
  const provider = {
    id: "ask-hang",
    model: "ask-hang",
    async turn() {
      return { text: "", toolUses: [{ id: "ask-1", name: "interactive_wait", input: {} }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "ask me" }];
  let cleaned = false;
  const outcome = await runAgent(history, base(provider, {
    timeoutMs: 1_000,
    maxRounds: 10,
    quiet: true,
    ctx: {
      cwd: process.cwd(),
      ask: async (_question, _options, signal) => new Promise((_resolve, reject) => {
        assert.ok(signal instanceof AbortSignal);
        signal.addEventListener("abort", () => {
          cleaned = true;
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      }),
    },
    extraTools: [{
      name: "interactive_wait",
      description: "wait for an interactive answer",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run(_input, ctx) { return ctx.ask("continue?", undefined, ctx.signal); },
    }],
  }));
  assert.equal(cleaned, true, "the hanging question owns an abort cleanup path");
  assert.equal(outcome.stopReason, "deadline");
  assert.equal(history.at(-1).role, "tool");
  assert.match(history.at(-1).results[0].content, /run deadline 1s reached/);
});

test("a rejected approval closes every tool_use and returns an explicit interaction error", async () => {
  let toolRuns = 0;
  const provider = {
    id: "approval-error",
    model: "approval-error",
    async turn() {
      return {
        text: "",
        toolUses: [
          { id: "reject-1", name: "gated_one", input: {} },
          { id: "reject-2", name: "gated_two", input: {} },
        ],
        stop: "tool_use",
      };
    },
  };
  const history = [{ role: "user", content: "run gated tools" }];
  const tool = (name) => ({
    name,
    description: "gated",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() { toolRuns += 1; return "ran"; },
  });
  const outcome = await runAgent(history, base(provider, {
    approval: "suggest",
    quiet: true,
    confirm: async () => { throw new Error("approval transport disconnected"); },
    extraTools: [tool("gated_one"), tool("gated_two")],
  }));
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /Interactive approval prompt failed: approval transport disconnected/);
  assert.equal(toolRuns, 0);
  assert.equal(history.at(-1).role, "tool");
  assert.deepEqual(history.at(-1).results.map((result) => result.id), ["reject-1", "reject-2"]);
  assert.ok(history.at(-1).results.every((result) => result.isError === true));
});

test("a rejected pending-input channel returns a clear error without starting the provider", async () => {
  let turns = 0;
  const provider = {
    id: "unused",
    model: "unused",
    async turn() { turns += 1; return { text: "wrong", toolUses: [], stop: "end" }; },
  };
  const outcome = await runAgent([{ role: "user", content: "steer" }], base(provider, {
    quiet: true,
    pendingInput: async () => { throw new Error("input queue unavailable"); },
  }));
  assert.equal(turns, 0);
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /Interactive pending-input channel failed: input queue unavailable/);
});

test("a user abort remains an interrupt and never emits a timeout/loop alert", async () => {
  const controller = new AbortController();
  const alerts = [];
  const provider = { id: "wait", model: "wait", turn() { return new Promise(() => {}); } };
  const running = runAgent([{ role: "user", content: "wait" }], base(provider, {
    signal: controller.signal,
    timeoutMs: "10s",
    quiet: true,
    onLimit: (event) => alerts.push(event),
  }));
  await tick(30);
  controller.abort();
  assert.deepEqual(await running, { status: "error", error: "(interrupted)" });
  assert.deepEqual(alerts, []);
});

test("a pre-aborted run does not start the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let turns = 0;
  const provider = {
    id: "must-not-start",
    model: "must-not-start",
    async turn() {
      turns += 1;
      return { text: "late", toolUses: [], stop: "end" };
    },
  };
  const outcome = await runAgent([{ role: "user", content: "cancelled" }], base(provider, {
    signal: controller.signal,
    quiet: true,
  }));
  assert.equal(turns, 0);
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
});

test("synchronous/rejected provider failures become explicit outcomes and retain fallback", async () => {
  for (const mode of ["throw", "reject"]) {
    let fallbackTurns = 0;
    const primary = {
      id: `primary-${mode}`,
      model: `primary-${mode}`,
      turn() {
        if (mode === "throw") throw new Error("429 rate limit");
        return Promise.reject(new Error("429 rate limit"));
      },
    };
    const fallback = {
      id: "fallback",
      model: "fallback",
      async turn() {
        fallbackTurns += 1;
        return { text: "recovered", toolUses: [], stop: "end" };
      },
    };
    const history = [{ role: "user", content: "recover" }];
    const outcome = await runAgent(history, base(primary, {
      quiet: true,
      fallback: { provider: fallback },
    }));
    assert.equal(outcome.status, "completed", `${mode} follows ordinary failover`);
    assert.equal(fallbackTurns, 1);
    assert.equal(history.at(-1).text, "recovered");
  }
});

test("multiple ask_user calls in one model round are serialized and every tool_use is closed", async () => {
  let round = 0;
  let active = 0;
  let peak = 0;
  const asked = [];
  const provider = {
    id: "two-questions",
    model: "two-questions",
    async turn() {
      round += 1;
      return round === 1
        ? {
            text: "",
            toolUses: [
              { id: "q1", name: "ask_user", input: { question: "first?" } },
              { id: "q2", name: "ask_user", input: { question: "second?" } },
            ],
            stop: "tool_use",
          }
        : { text: "done", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "ask twice" }];
  const outcome = await runAgent(history, base(provider, {
    quiet: true,
    ctx: {
      cwd: process.cwd(),
      ask: async (question) => {
        active += 1;
        peak = Math.max(peak, active);
        asked.push(question);
        await tick(20);
        active -= 1;
        return `answer-${asked.length}`;
      },
    },
    extraTools: [{
      name: "ask_user",
      description: "ask",
      input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      kind: "read",
      async run(input, ctx) { return ctx.ask(input.question, undefined, ctx.signal); },
    }],
  }));
  assert.equal(outcome.status, "completed");
  assert.equal(peak, 1, "the single TUI prompt slot is never overwritten by parallel asks");
  assert.deepEqual(asked, ["first?", "second?"]);
  const toolRound = history.find((message) => message.role === "tool");
  assert.deepEqual(toolRound.results.map((result) => result.id), ["q1", "q2"]);
});

test("runShell cancellation terminates the owned foreground command", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runShell("sleep 30", process.cwd(), "off", {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    signal: controller.signal,
  });
  const rejected = assert.rejects(running, /interrupted by agent run deadline or cancellation/);
  await tick(50);
  controller.abort();
  await rejected;
  assert.ok(Date.now() - started < 2_000, "abort does not wait for the command's own timeout");
});
