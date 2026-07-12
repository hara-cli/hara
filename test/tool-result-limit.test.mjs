import test from "node:test";
import assert from "node:assert/strict";
import { limitToolResult, MAX_TOOL_RESULT_CHARS } from "../dist/tools/result-limit.js";
import { getTool, registerTool, toolSpecs } from "../dist/tools/registry.js";

test("limitToolResult keeps head and tail within one hard context budget", () => {
  const value = "HEAD" + "中".repeat(MAX_TOOL_RESULT_CHARS * 2) + "TAIL";
  const out = limitToolResult(value);
  assert.ok(out.length <= MAX_TOOL_RESULT_CHARS);
  assert.ok(out.startsWith("HEAD"));
  assert.ok(out.endsWith("TAIL"));
  assert.match(out, /chars omitted/);
});

test("limitToolResult never splits a surrogate pair at either retained boundary", () => {
  const value = "🙂".repeat(100);
  const out = limitToolResult(value, 80);
  assert.ok(out.length <= 80);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out), "does not end on a high surrogate");
  assert.ok(!out.includes("�"), "does not introduce a replacement character");
});

test("registry caps every tool and invalidates its cached schema snapshot", async () => {
  const before = toolSpecs();
  registerTool({
    name: "test_huge_result",
    description: "test",
    input_schema: { type: "object", properties: {} },
    async run() {
      return "start" + "x".repeat(MAX_TOOL_RESULT_CHARS * 2) + "finish";
    },
  });
  const after = toolSpecs();
  assert.ok(!before.some((tool) => tool.name === "test_huge_result"));
  assert.ok(after.some((tool) => tool.name === "test_huge_result"), "new registration invalidates the spec cache");

  const out = await getTool("test_huge_result").run({}, { cwd: process.cwd() });
  assert.ok(out.length <= MAX_TOOL_RESULT_CHARS);
  assert.ok(out.startsWith("start") && out.endsWith("finish"));
});
