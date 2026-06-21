import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../dist/agent/loop.js";
import { registerTool } from "../dist/tools/registry.js";
import { toAnthropic } from "../dist/providers/anthropic.js";

// a read-kind no-op tool so a turn can "use a tool" and force a 2nd model call (no confirm needed)
registerTool({ name: "noop_read", description: "test", input_schema: { type: "object", properties: {} }, kind: "read", async run() { return "ok"; } });

// fake provider that records the history snapshot it was handed on each call, and plays a script
function fakeProvider(script, seen) {
  let i = 0;
  return {
    id: "fake",
    model: "fake",
    async turn({ history }) {
      seen.push(history.map((m) => ({ role: m.role, content: m.content, text: m.text })));
      const step = script[Math.min(i, script.length - 1)];
      i++;
      return { text: step.text ?? "", toolUses: step.toolUses ?? [], stop: step.stop ?? "end", usage: { input: 1, output: 1 } };
    },
  };
}

test("pendingInput steers a mid-turn message into the NEXT model call", async () => {
  const seen = [];
  const provider = fakeProvider(
    [
      { toolUses: [{ id: "t1", name: "noop_read", input: {} }], stop: "tool_use" }, // call 1 → use a tool (forces a 2nd call)
      { text: "done", toolUses: [], stop: "end" }, // call 2 → finish
    ],
    seen,
  );
  // queue a message "after the first step" — drain #1 (turn start) empty, drain #2 yields it
  let drains = 0;
  const pendingInput = async () => (++drains === 2 ? [{ role: "user", content: "[steer] also add tests" }] : []);

  const history = [{ role: "user", content: "implement foo" }];
  await runAgent(history, { provider, ctx: { cwd: process.cwd() }, approval: "full-auto", confirm: async () => true, quiet: true, pendingInput });

  assert.equal(seen.length, 2, "the model was called twice (tool round + finish)");
  assert.ok(
    seen[1].some((m) => m.role === "user" && /also add tests/.test(m.content || "")),
    "the injected message was present on the 2nd model call (steered, not deferred)",
  );
  assert.ok(history.some((m) => m.role === "user" && /also add tests/.test(m.content || "")), "and it lives in the final history");
});

test("no pendingInput → the loop is unchanged", async () => {
  const seen = [];
  const provider = fakeProvider([{ text: "hi", toolUses: [], stop: "end" }], seen);
  const history = [{ role: "user", content: "hello" }];
  await runAgent(history, { provider, ctx: { cwd: process.cwd() }, approval: "full-auto", confirm: async () => true, quiet: true });
  assert.equal(seen.length, 1);
});

test("toAnthropic coalesces a user message injected after tool-results (roles stay alternating)", () => {
  const msgs = toAnthropic([
    { role: "user", content: "do it" },
    { role: "assistant", text: "", toolUses: [{ id: "t1", name: "noop_read", input: {} }] },
    { role: "tool", results: [{ id: "t1", content: "ok" }] },
    { role: "user", content: "[steer] also add tests" }, // injected mid-turn, right after the tool-results
  ]);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
    "no two consecutive user turns (Anthropic would reject that)",
  );
  const merged = msgs[2];
  assert.ok(Array.isArray(merged.content), "tool-results + injected text merged into one block array");
  assert.ok(merged.content.some((b) => b.type === "tool_result"), "keeps the tool_result");
  assert.ok(merged.content.some((b) => b.type === "text" && /also add tests/.test(b.text)), "keeps the injected text");
});
