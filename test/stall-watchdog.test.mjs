// Stall watchdog + turn-phase channel (codex-parity: a silent connection must never hang forever,
// and the pre-first-token stretch must read as "waiting for the model", not generic "working").
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, stallMs } from "../dist/agent/loop.js";
import { onTurnPhase, turnPhase, setTurnPhase } from "../dist/agent/phase.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("stallMs: env-tunable with a sane default and a 1s floor", () => {
  delete process.env.HARA_STALL_TIMEOUT;
  assert.equal(stallMs(), 120_000, "default 120s");
  process.env.HARA_STALL_TIMEOUT = "5000";
  assert.equal(stallMs(), 5000);
  process.env.HARA_STALL_TIMEOUT = "10";
  assert.equal(stallMs(), 1000, "floor 1s");
  process.env.HARA_STALL_TIMEOUT = "garbage";
  assert.equal(stallMs(), 120_000, "garbage → default");
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
