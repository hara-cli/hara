// system-reminder injection layer (à la Claude Code's Ie1/WD5) + todo attention-refresh.
// Pins: (a) the queue/wrap contract incl. the ignore-if-irrelevant disclaimer, (b) the loop injecting
// queued reminders as ONE user message before the next model call, (c) staleness firing after
// TODO_STALE_ROUNDS untouched rounds and resetting on todo_write, (d) quiet (sub-agent) runs neither
// draining nor nagging, and (e) the 8-section compaction brief keeping user messages verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushReminder, drainReminders, wrapReminders, todoStaleReminder, TODO_STALE_ROUNDS } from "../dist/agent/reminders.js";
import { COMPACT_SYSTEM } from "../dist/agent/compact.js";
import { runAgent } from "../dist/agent/loop.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/todo.js"; // registers todo_write
import { clearTodos } from "../dist/tools/todo.js";

test("reminders: FIFO queue + wrap carries the ignore-if-irrelevant disclaimer", () => {
  drainReminders(); // clean slate
  pushReminder("first");
  pushReminder("  second  ");
  pushReminder(""); // blank is dropped
  const items = drainReminders();
  assert.deepEqual(items, ["first", "second"], "FIFO, trimmed, blanks dropped");
  assert.deepEqual(drainReminders(), [], "drain clears the queue");
  const wrapped = wrapReminders(items);
  assert.ok(wrapped.startsWith("<system-reminder>"), "wrapped in the reminder tag");
  assert.ok(wrapped.includes("first\n\nsecond"), "items merged");
  assert.ok(/ignore it unless it is relevant/i.test(wrapped), "disclaimer present (never derails unrelated work)");
});

// A fake provider that runs `rounds` tool rounds (each calling the given tool uses), then ends.
const mkProvider = (roundsToolUses) => {
  let i = 0;
  return {
    id: "fake",
    model: "fake-model",
    async turn() {
      const tus = roundsToolUses[i++];
      if (tus) return { text: "", toolUses: tus.map((name, k) => ({ id: `t${i}_${k}`, name, input: name === "todo_write" ? { todos: [{ text: "step", status: "in_progress" }] } : {} })), stop: "tool_use" };
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
};
const noop = {
  name: "noop",
  description: "does nothing",
  input_schema: { type: "object", properties: {} },
  kind: "read",
  run: async () => "ok",
};
const base = (history, provider, extra = {}) => ({
  provider,
  ctx: { cwd: process.cwd() },
  approval: "full-auto",
  confirm: async () => true,
  extraTools: [noop],
  ...extra,
});

test("loop: queued reminder lands as ONE <system-reminder> user message before the next model call", async () => {
  drainReminders();
  clearTodos();
  pushReminder("the config file changed on disk");
  const provider = mkProvider([]);
  const history = [{ role: "user", content: "hi" }];
  await runAgent(history, base(history, provider));
  const injected = history.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<system-reminder>"));
  assert.equal(injected.length, 1, "exactly one injected reminder message");
  assert.ok(injected[0].content.includes("config file changed"), "carries the queued event");
});

test("loop: todo staleness fires after TODO_STALE_ROUNDS untouched rounds (unfinished items)", async () => {
  drainReminders();
  clearTodos();
  await getTool("todo_write").run({ todos: [{ text: "big task", status: "in_progress" }] }, { cwd: process.cwd() });
  // TODO_STALE_ROUNDS rounds of non-todo tools → nag queued on the Nth, injected on the NEXT call.
  const provider = mkProvider(Array.from({ length: TODO_STALE_ROUNDS + 1 }, () => ["noop"]));
  const history = [{ role: "user", content: "work" }];
  await runAgent(history, base(history, provider));
  const nag = history.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("todo list has not been updated"));
  assert.ok(nag, "staleness reminder injected");
  assert.ok(nag.content.includes("big task"), "re-shows the authoritative list");
  clearTodos();
});

test("loop: a todo_write round resets the staleness clock (no nag)", async () => {
  drainReminders();
  clearTodos();
  await getTool("todo_write").run({ todos: [{ text: "t", status: "in_progress" }] }, { cwd: process.cwd() });
  // rounds: N-1 noops, then a todo_write (reset), then N-1 noops → never reaches N untouched.
  const rounds = [
    ...Array.from({ length: TODO_STALE_ROUNDS - 1 }, () => ["noop"]),
    ["todo_write"],
    ...Array.from({ length: TODO_STALE_ROUNDS - 1 }, () => ["noop"]),
  ];
  const provider = mkProvider(rounds);
  const history = [{ role: "user", content: "work" }];
  await runAgent(history, base(history, provider));
  assert.ok(
    !history.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("todo list has not been updated")),
    "no staleness nag when the checklist keeps being touched",
  );
  clearTodos();
});

test("loop: quiet (sub-agent) runs neither drain reminders nor nag", async () => {
  drainReminders();
  clearTodos();
  await getTool("todo_write").run({ todos: [{ text: "t", status: "in_progress" }] }, { cwd: process.cwd() });
  pushReminder("main-loop event — a quiet run must not steal this");
  const provider = mkProvider(Array.from({ length: TODO_STALE_ROUNDS + 1 }, () => ["noop"]));
  const history = [{ role: "user", content: "sub-task" }];
  await runAgent(history, base(history, provider, { quiet: true }));
  assert.ok(!history.some((m) => typeof m.content === "string" && m.content.includes("<system-reminder>")), "quiet run injected nothing");
  assert.deepEqual(drainReminders(), ["main-loop event — a quiet run must not steal this"], "queued reminder still there for the main loop");
  clearTodos();
});

test("COMPACT_SYSTEM: 8 sections incl. verbatim user messages + key technical concepts", () => {
  for (const heading of ["Goal", "Key technical concepts", "Key decisions", "Files & code", "Errors & fixes", "Current state", "All user messages", "Next step"]) {
    assert.ok(COMPACT_SYSTEM.includes(heading), `section present: ${heading}`);
  }
  assert.ok(/verbatim and in order/.test(COMPACT_SYSTEM), "user messages preserved verbatim (anti-drift)");
  assert.ok(/8\./.test(COMPACT_SYSTEM), "numbered through 8");
});

test("synthesis nudge: a ≥3-agent fan-out round injects the merge reminder before the next call", async () => {
  drainReminders();
  clearTodos();
  const fakeAgent = {
    name: "agent",
    description: "spawn",
    input_schema: { type: "object", properties: { task: { type: "string" } } },
    kind: "read",
    run: async () => "report",
  };
  let round = 0;
  const provider = {
    id: "f",
    model: "f",
    async turn() {
      round++;
      if (round === 1)
        return { text: "", toolUses: [1, 2, 3].map((i) => ({ id: `a${i}`, name: "agent", input: { task: `q${i}` } })), stop: "tool_use" };
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "investigate three things" }];
  await runAgent(history, { provider, ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } }, approval: "full-auto", confirm: async () => true, extraTools: [fakeAgent] });
  const nudge = history.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("3 parallel agent reports"));
  assert.ok(nudge, "synthesis reminder injected after the fan-out round");
  assert.ok(nudge.content.includes("SYNTHESIZE"), "asks for an explicit merge");
});

test("synthesis nudge: 1-2 agent calls do NOT trigger it (only real fan-outs)", async () => {
  drainReminders();
  clearTodos();
  const fakeAgent = { name: "agent", description: "spawn", input_schema: { type: "object", properties: {} }, kind: "read", run: async () => "r" };
  let round = 0;
  const provider = {
    id: "f",
    model: "f",
    async turn() {
      round++;
      if (round === 1) return { text: "", toolUses: [{ id: "a1", name: "agent", input: {} }, { id: "a2", name: "agent", input: {} }], stop: "tool_use" };
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "two lookups" }];
  await runAgent(history, { provider, ctx: { cwd: process.cwd(), ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice() {} } }, approval: "full-auto", confirm: async () => true, extraTools: [fakeAgent] });
  assert.ok(!history.some((m) => typeof m.content === "string" && m.content.includes("parallel agent reports")), "no nudge below the threshold");
});
