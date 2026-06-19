import { test } from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/agent.js";

test("agent tool: delegates via ctx.spawn; errors without it / on empty task", async () => {
  const t = getTool("agent");
  // no spawn capability in this context
  assert.match(await t.run({ task: "x" }, { cwd: "." }), /not available/);
  // delegates to ctx.spawn and returns its result
  assert.equal(
    await t.run({ task: "analyze foo", role: "reviewer" }, { cwd: ".", spawn: async (task, role) => `${task} as ${role}` }),
    "analyze foo as reviewer",
  );
  // empty task
  assert.match(await t.run({ task: "   " }, { cwd: ".", spawn: async () => "y" }), /needs a/);
});
