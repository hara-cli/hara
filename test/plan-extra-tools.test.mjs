// extraTools (run-scoped tools) — the plumbing plan mode's `exit_plan` rides on.
// A tool passed via opts.extraTools must be (a) advertised to the model for THAT run,
// (b) dispatched when called (winning over the registry), and (c) invisible to runs
// that don't pass it — it is never registered globally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../dist/agent/loop.js";

const mkProvider = (turns) => {
  const seenTools = [];
  let i = 0;
  return {
    seenTools,
    id: "fake",
    model: "fake-model",
    async turn({ tools }) {
      seenTools.push(tools.map((t) => t.name));
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
};

test("extraTools: advertised to the model, dispatched on call, result threaded back", async () => {
  let captured = null;
  const exitPlan = {
    name: "exit_plan",
    description: "submit the plan",
    input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
    kind: "read",
    run: async (input) => {
      captured = String(input?.plan ?? "");
      return "Plan submitted to the user for approval.";
    },
  };
  const provider = mkProvider([
    { text: "", toolUses: [{ id: "t1", name: "exit_plan", input: { plan: "1. do the thing" } }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "plan it" }];
  await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    toolFilter: (n) => n === "read_file", // a tight filter must NOT drop the extra tool
    extraTools: [exitPlan],
  });
  assert.ok(provider.seenTools[0].includes("exit_plan"), "extra tool advertised despite the tight toolFilter");
  assert.equal(captured, "1. do the thing", "extra tool's run() dispatched with the model's input");
  const flat = JSON.stringify(history);
  assert.ok(flat.includes("Plan submitted to the user for approval."), "tool result threaded back into history");
});

test("extraTools: NOT visible to a run that does not pass them (no global registration)", async () => {
  const provider = mkProvider([{ text: "hi", toolUses: [], stop: "end" }]);
  await runAgent([{ role: "user", content: "hello" }], {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
  });
  assert.ok(!provider.seenTools[0].includes("exit_plan"), "exit_plan absent without opts.extraTools");
});
