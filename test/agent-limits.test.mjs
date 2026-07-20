import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadlineCheckpointReminder, runAgent } from "../dist/agent/loop.js";
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
import { onTurnPhase, setTurnPhase } from "../dist/agent/phase.js";
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
  assert.ok(notices.some((message) => /still actively working/.test(message)), "75% round warning is visible");
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

test("three different tools blocked by the same Home boundary trip one root-cause breaker", async () => {
  let turns = 0;
  const names = ["home_grep", "home_glob", "home_ls"];
  const diagnostics = [
    "Error: grep will not recursively scan the home directory. Run Hara from a project.",
    "Error: glob will not enumerate or recursively scan directories while Hara is rooted at the home directory.",
    "Error: ls will not enumerate or recursively scan directories while Hara is rooted at the home directory.",
  ];
  const provider = {
    id: "home-boundary",
    model: "home-boundary",
    async turn() {
      const index = Math.min(turns, names.length - 1);
      turns += 1;
      return { text: "", toolUses: [{ id: `home-${turns}`, name: names[index], input: { different: index } }], stop: "tool_use" };
    },
  };
  const outcome = await runAgent([{ role: "user", content: "scan Home" }], base(provider, {
    maxRounds: 20,
    timeoutMs: "10s",
    quiet: true,
    extraTools: names.map((name, index) => ({
      name,
      description: "test Home boundary",
      input_schema: { type: "object", properties: { different: { type: "number" } } },
      kind: "read",
      async run() { return diagnostics[index]; },
    })),
  }));
  assert.equal(turns, 3);
  assert.equal(outcome.stopReason, "repeat_loop");
  assert.match(outcome.error, /same failing Home workspace boundary repeated 3 times/i);
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

test("active deadline stops a provider that stays active forever and ignores AbortSignal", async () => {
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
  assert.match(outcome.error, /active-execution deadline 1s reached/);
  assert.match(outcome.error, /type `\/continue` to resume/);
  assert.match(outcome.error, /task and checklist checkpoint/);
  assert.ok(Date.now() - started < 2_500, "an active/non-cooperative provider cannot hold the run open");
  assert.equal(alerts.length, 1);
  assert.equal(notices.filter((message) => /agent run paused/.test(message)).length, 1);
});

test("a synchronous provider cannot overrun the active budget and then start a side effect", async () => {
  let confirmations = 0;
  let toolRuns = 0;
  const provider = {
    id: "busy-provider",
    model: "busy-provider",
    turn() {
      const until = Date.now() + 1_100;
      while (Date.now() < until) {
        // Deliberately block the event loop so the setTimeout callback cannot win the race.
      }
      return Promise.resolve({
        text: "",
        toolUses: [{ id: "late-effect-1", name: "late_effect", input: {} }],
        stop: "tool_use",
      });
    },
  };
  const outcome = await runAgent([{ role: "user", content: "do not run after deadline" }], base(provider, {
    approval: "suggest",
    timeoutMs: 1_000,
    quiet: true,
    confirm: async () => { confirmations += 1; return true; },
    extraTools: [{
      name: "late_effect",
      description: "must not start after a synchronous budget overrun",
      input_schema: { type: "object", properties: {} },
      kind: "edit",
      async run() { toolRuns += 1; return "ran"; },
    }],
  }));
  assert.equal(outcome.stopReason, "deadline");
  assert.equal(confirmations, 0);
  assert.equal(toolRuns, 0);
});

test("the 80% time boundary reaches the model as an in-band checkpoint instruction", async () => {
  let turn = 0;
  let sawCheckpoint = false;
  const provider = {
    id: "checkpoint-aware",
    model: "checkpoint-aware",
    async turn({ history }) {
      turn += 1;
      if (turn === 1) {
        return { text: "", toolUses: [{ id: "slow-stage-1", name: "slow_stage", input: {} }], stop: "tool_use" };
      }
      sawCheckpoint = history.some((message) =>
        message.role === "user" && message.content.includes("Turn active-execution budget checkpoint: about 20% remains"),
      );
      return { text: "checkpoint saved", toolUses: [], stop: "end" };
    },
  };
  const outcome = await runAgent([{ role: "user", content: "do a long staged task" }], base(provider, {
    timeoutMs: 2_000,
    maxRounds: 10,
    extraTools: [{
      name: "slow_stage",
      description: "finishes one atomic stage near the checkpoint boundary",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run() {
        await tick(1_650);
        return "stage artifact saved";
      },
    }],
  }));
  assert.equal(outcome.status, "completed");
  assert.equal(sawCheckpoint, true);
  assert.match(deadlineCheckpointReminder(30 * 60_000), /Do not start another generation batch/);
});

test("active deadline closes a tool round even when the tool ignores cancellation", async () => {
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
  assert.match(history.at(-1).results[0].content, /active-execution deadline 1s reached/);
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

test("human approval wait does not consume active execution budget", async () => {
  let round = 0;
  const provider = {
    id: "approval-wait",
    model: "approval-wait",
    async turn() {
      round += 1;
      return round === 1
        ? { text: "", toolUses: [{ id: "approval-1", name: "gated_effect", input: {} }], stop: "tool_use" }
        : { text: "done", toolUses: [], stop: "end" };
    },
  };
  const notices = [];
  let toolRuns = 0;
  const started = Date.now();
  const outcome = await runAgent([{ role: "user", content: "ask before running" }], base(provider, {
    approval: "suggest",
    timeoutMs: 1_000,
    maxRounds: 10,
    ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice: (message) => notices.push(message) } },
    confirm: async () => {
      await tick(1_150);
      return true;
    },
    extraTools: [{
      name: "gated_effect",
      description: "runs after the user answers",
      input_schema: { type: "object", properties: {} },
      kind: "edit",
      async run() { toolRuns += 1; return "ran"; },
    }],
  }));
  assert.equal(outcome.status, "completed");
  assert.equal(toolRuns, 1);
  assert.ok(Date.now() - started > 1_050, "wall time may exceed the active execution budget while waiting");
  assert.equal(
    notices.some((message) => /still actively working|80% used|agent run paused/.test(message)),
    false,
    "active-run warnings stay silent while the user prompt owns the wall time",
  );
});

test("external cancellation still aborts and cleans a paused approval", async () => {
  const controller = new AbortController();
  const provider = {
    id: "approval-cancel",
    model: "approval-cancel",
    async turn() {
      return { text: "", toolUses: [{ id: "approval-1", name: "gated_effect", input: {} }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "ask before running" }];
  let sawSignal = false;
  let cleaned = false;
  let toolRuns = 0;
  const alerts = [];
  const running = runAgent(history, base(provider, {
    approval: "suggest",
    timeoutMs: 10_000,
    maxRounds: 10,
    quiet: true,
    signal: controller.signal,
    onLimit: (event) => alerts.push(event),
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
  await tick(50);
  controller.abort();
  const outcome = await running;
  assert.equal(sawSignal, true, "the approval surface receives the combined run signal");
  assert.equal(cleaned, true, "Esc/shutdown cancellation dismisses a paused approval");
  assert.equal(toolRuns, 0);
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
  assert.deepEqual(alerts, []);
  assert.equal(history.at(-1).role, "tool");
  assert.match(history.at(-1).results[0].content, /interrupted before this tool call completed/);
});

test("ask_user wait does not consume active budget and resumes the same tool round", async () => {
  let round = 0;
  const provider = {
    id: "ask-wait",
    model: "ask-wait",
    async turn() {
      round += 1;
      return round === 1
        ? { text: "", toolUses: [{ id: "ask-1", name: "ask_user", input: { question: "continue?" } }], stop: "tool_use" }
        : { text: "continued", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "ask me" }];
  const started = Date.now();
  const outcome = await runAgent(history, base(provider, {
    timeoutMs: 1_000,
    maxRounds: 10,
    quiet: true,
    ctx: {
      cwd: process.cwd(),
      ask: async () => {
        await tick(1_150);
        return "use the gallery";
      },
    },
  }));
  assert.equal(outcome.status, "completed");
  assert.ok(Date.now() - started > 1_050);
  const toolRound = history.find((message) => message.role === "tool");
  assert.equal(toolRound.results[0].content, "use the gallery");
});

test("external cancellation still aborts and cleans a paused ask_user", async () => {
  const controller = new AbortController();
  const provider = {
    id: "ask-cancel",
    model: "ask-cancel",
    async turn() {
      return { text: "", toolUses: [{ id: "ask-1", name: "ask_user", input: { question: "continue?" } }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "ask me" }];
  let cleaned = false;
  const running = runAgent(history, base(provider, {
    timeoutMs: 10_000,
    maxRounds: 10,
    quiet: true,
    signal: controller.signal,
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
  }));
  await tick(50);
  controller.abort();
  const outcome = await running;
  assert.equal(cleaned, true);
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
  assert.equal(history.at(-1).role, "tool");
  assert.match(history.at(-1).results[0].content, /interrupted before this tool call completed/);
});

test("human wait pauses rather than resets the remaining active budget", async () => {
  let round = 0;
  const provider = {
    id: "active-budget",
    model: "active-budget",
    async turn() {
      round += 1;
      if (round === 1) return { text: "", toolUses: [{ id: "work-1", name: "active_stage", input: {} }], stop: "tool_use" };
      if (round === 2) return { text: "", toolUses: [{ id: "ask-1", name: "ask_user", input: { question: "continue?" } }], stop: "tool_use" };
      return new Promise(() => {});
    },
  };
  const started = Date.now();
  const outcome = await runAgent([{ role: "user", content: "stage, ask, then hang" }], base(provider, {
    timeoutMs: 1_000,
    maxRounds: 10,
    quiet: true,
    ctx: {
      cwd: process.cwd(),
      ask: async () => {
        await tick(900);
        return "continue";
      },
    },
    extraTools: [{
      name: "active_stage",
      description: "consume part of the active budget",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run() { await tick(350); return "stage done"; },
    }],
  }));
  const wallElapsed = Date.now() - started;
  assert.equal(outcome.stopReason, "deadline");
  assert.ok(wallElapsed >= 1_700, `human wait should extend wall time (got ${wallElapsed}ms)`);
  assert.ok(wallElapsed < 3_000, `answering must resume the remaining budget, not reset it (got ${wallElapsed}ms)`);
});

test("only the engine-owned ask_user tool can pause the active budget", async () => {
  const provider = {
    id: "plugin-question",
    model: "plugin-question",
    async turn() {
      return { text: "", toolUses: [{ id: "plugin-ask-1", name: "plugin_question", input: {} }], stop: "tool_use" };
    },
  };
  let cleaned = false;
  const outcome = await runAgent([{ role: "user", content: "plugin wait" }], base(provider, {
    timeoutMs: 1_000,
    quiet: true,
    ctx: {
      cwd: process.cwd(),
      ask: async (_question, _options, signal) => new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("plugin prompt unexpectedly outlived the budget")), 5_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          cleaned = true;
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      }),
    },
    extraTools: [{
      name: "plugin_question",
      description: "third-party prompt wrapper without timer-pause authority",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run(_input, ctx) { return ctx.ask("plugin question", undefined, ctx.signal); },
    }],
  }));
  assert.equal(outcome.stopReason, "deadline");
  assert.equal(cleaned, true);
});

test("a custom ask signal is composed with the parent run cancellation", async () => {
  const runController = new AbortController();
  const ownController = new AbortController();
  let receivedSignal;
  let cleaned = false;
  const provider = {
    id: "composed-question",
    model: "composed-question",
    async turn() {
      return { text: "", toolUses: [{ id: "composed-ask-1", name: "custom_question", input: {} }], stop: "tool_use" };
    },
  };
  const history = [{ role: "user", content: "cancel the whole run" }];
  const running = runAgent(history, base(provider, {
    timeoutMs: 10_000,
    quiet: true,
    signal: runController.signal,
    ctx: {
      cwd: process.cwd(),
      ask: async (_question, _options, signal) => new Promise((_resolve, reject) => {
        receivedSignal = signal;
        signal?.addEventListener("abort", () => {
          cleaned = true;
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      }),
    },
    extraTools: [{
      name: "custom_question",
      description: "passes a tool-owned cancellation signal to the prompt",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run(_input, ctx) { return ctx.ask("custom question", undefined, ownController.signal); },
    }],
  }));
  await tick(50);
  runController.abort();
  const outcome = await running;
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.notEqual(receivedSignal, ownController.signal, "the prompt receives a composed signal");
  assert.equal(cleaned, true);
  assert.deepEqual(outcome, { status: "error", error: "(interrupted)" });
});

test("an already-cancelled custom ask signal never opens the prompt callback", async () => {
  const ownController = new AbortController();
  ownController.abort(new Error("question no longer needed"));
  let promptCalls = 0;
  let round = 0;
  const provider = {
    id: "pre-cancelled-question",
    model: "pre-cancelled-question",
    async turn() {
      round += 1;
      return round === 1
        ? { text: "", toolUses: [{ id: "pre-cancelled-ask-1", name: "cancelled_question", input: {} }], stop: "tool_use" }
        : { text: "done", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "do not open a stale prompt" }];
  const outcome = await runAgent(history, base(provider, {
    quiet: true,
    ctx: {
      cwd: process.cwd(),
      ask: async () => {
        promptCalls += 1;
        return "wrong";
      },
    },
    extraTools: [{
      name: "cancelled_question",
      description: "passes an already-cancelled tool-owned signal",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run(_input, ctx) {
        return ctx.ask("stale question", undefined, ownController.signal);
      },
    }],
  }));
  assert.equal(outcome.status, "completed");
  assert.equal(promptCalls, 0);
  const toolRound = history.find((message) => message.role === "tool");
  assert.equal(toolRound.results[0].isError, true);
});

test("a synchronous guardian overrun cannot approve and start the guarded side effect", async () => {
  let toolRuns = 0;
  const provider = {
    id: "guardian-main",
    model: "guardian-main",
    async turn() {
      return {
        text: "",
        toolUses: [{ id: "guarded-1", name: "guarded_exec", input: { command: "rm -rf /" } }],
        stop: "tool_use",
      };
    },
  };
  const guardian = {
    id: "guardian-busy",
    model: "guardian-busy",
    turn() {
      const until = Date.now() + 1_100;
      while (Date.now() < until) {
        // Block the timer callback, then return a superficially valid allow verdict.
      }
      return Promise.resolve({
        text: '{"decision":"allow","reason":"test"}',
        toolUses: [],
        stop: "end",
      });
    },
  };
  const outcome = await runAgent([{ role: "user", content: "do not execute after budget expiry" }], base(provider, {
    timeoutMs: 1_000,
    quiet: true,
    guardian: { enabled: true, provider: guardian },
    extraTools: [{
      name: "guarded_exec",
      description: "test-only guarded side effect",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      kind: "exec",
      async run() { toolRuns += 1; return "ran"; },
    }],
  }));
  assert.equal(outcome.stopReason, "deadline");
  assert.equal(toolRuns, 0);
});

test("the real ask_user integration publishes awaiting_user and restores streaming", async () => {
  setTurnPhase("idle");
  const seen = [];
  const unsubscribe = onTurnPhase((phase) => seen.push(phase));
  let round = 0;
  const provider = {
    id: "phase-question",
    model: "phase-question",
    async turn() {
      round += 1;
      return round === 1
        ? { text: "", toolUses: [{ id: "phase-ask-1", name: "ask_user", input: { question: "which style?" } }], stop: "tool_use" }
        : { text: "done", toolUses: [], stop: "end" };
    },
  };
  try {
    const outcome = await runAgent([{ role: "user", content: "ask once" }], base(provider, {
      quiet: false,
      ctx: {
        cwd: process.cwd(),
        ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} },
        ask: async () => {
          await tick(20);
          return "product demo";
        },
      },
    }));
    assert.equal(outcome.status, "completed");
    const awaitingIndex = seen.indexOf("awaiting_user");
    assert.ok(awaitingIndex >= 0, `expected awaiting_user in ${seen.join(", ")}`);
    assert.ok(seen.slice(awaitingIndex + 1).includes("streaming"), "the final human wait restores the active phase");
  } finally {
    unsubscribe();
    setTurnPhase("idle");
  }
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
