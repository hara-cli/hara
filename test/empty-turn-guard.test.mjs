// Empty-turn guard: a model turn with no text AND no tool calls must NOT silently vanish (which reads
// as a 15-hour hang) NOR loop forever. It retries once with a nudge, then ends with a clear notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../dist/agent/loop.js";

const ui = (notices) => ({ text() {}, reasoning() {}, tool() {}, diff() {}, notice: (t) => notices.push(t) });
const base = (notices) => ({ ctx: { cwd: process.cwd(), ui: ui(notices) }, approval: "full-auto", confirm: async () => true });

test("empty turn → retries once, then completes when the retry yields real output", async () => {
  const notices = [];
  let calls = 0;
  const provider = {
    id: "p",
    model: "m",
    async turn() {
      calls++;
      return calls === 1 ? { text: "", toolUses: [], stop: "end" } : { text: "here is the answer", toolUses: [], stop: "end" };
    },
  };
  const history = [{ role: "user", content: "继续" }];
  await runAgent(history, { provider, ...base(notices) });
  assert.equal(calls, 2, "retried exactly once");
  assert.ok(notices.some((n) => /retrying once/.test(n)), "announced the retry");
  const last = history[history.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.text, "here is the answer", "the retry's real answer is what remains in history");
});

test("empty turn twice → gives up with a clear notice, does NOT loop forever", async () => {
  const notices = [];
  let calls = 0;
  const provider = { id: "p", model: "m", async turn() { calls++; return { text: "", toolUses: [], stop: "end" }; } };
  const history = [{ role: "user", content: "继续" }];
  await runAgent(history, { provider, ...base(notices) });
  assert.equal(calls, 2, "one original + one retry, then stop (bounded, no infinite loop)");
  assert.ok(notices.some((n) => /empty response/.test(n) && /nothing to do|Rephrase/.test(n)), "surfaced a give-up notice");
});

test("tool_use stop with an EMPTY tool list is treated as empty (no re-request spin)", async () => {
  const notices = [];
  let calls = 0;
  // stop claims tool_use but there are zero tools — the old code would push an empty tool round and
  // re-request forever; the guard now bounds it to a single retry.
  const provider = { id: "p", model: "m", async turn() { calls++; return { text: "", toolUses: [], stop: "tool_use" }; } };
  const history = [{ role: "user", content: "go" }];
  await runAgent(history, { provider, ...base(notices) });
  assert.equal(calls, 2, "retried once then stopped — never spins");
});

test("tool_use stop with text but no tools ends cleanly (shows text, no loop, no retry)", async () => {
  const notices = [];
  let calls = 0;
  const provider = { id: "p", model: "m", async turn() { calls++; return { text: "partial thought", toolUses: [], stop: "tool_use" }; } };
  const history = [{ role: "user", content: "go" }];
  await runAgent(history, { provider, ...base(notices) });
  assert.equal(calls, 1, "had text → no retry, no empty-tool spin — ended after one call");
  const last = history[history.length - 1];
  assert.equal(last.text, "partial thought");
});

test("runAgent returns a machine-readable provider error outcome", async () => {
  const provider = { id: "p", model: "m", async turn() { return { text: "", toolUses: [], stop: "error", errorMsg: "bad credentials" }; } };
  const outcome = await runAgent([{ role: "user", content: "go" }], { provider, ...base([]), quiet: true });
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /bad credentials/);
});
