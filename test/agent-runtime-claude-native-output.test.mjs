import test from "node:test";
import assert from "node:assert/strict";
import { claudeRuntimeEnvironment, parseClaudeCliOutput } from "../dist/agent-runtime/claude-cli.js";
const frame = value => JSON.stringify(value);
const result = value => frame({ type: "result", subtype: "success", is_error: false, result: value });
test("Claude requires its terminal success frame and forwards only the final result", () => {
  const output = [frame({ type: "system", subtype: "init" }),
    frame({ type: "assistant", message: { content: [{ type: "text", text: "private intermediate" }] } }), result("Final reply")].join("\n");
  assert.deepEqual(parseClaudeCliOutput(output), { ok: true, text: "Final reply" });
  for (const invalid of ["plain prose", frame({ type: "assistant" }), result("done") + "\ntrailing text",
    result("done") + "\n" + result("again"), frame({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["401 Unauthorized"] })])
    assert.equal(parseClaudeCliOutput(invalid).ok, false);
  assert.equal(parseClaudeCliOutput(result("x".repeat(2 * 1024 * 1024))).ok, false);
});
test("native tool events are observations and do not accept model claims as write evidence", () => {
  const observed = [];
  const output = [frame({ type: "assistant", message: { content: [
    { type: "text", text: "I changed everything" },
    { type: "tool_use", id: "cmd", name: "Bash", input: { command: "git push" } },
    { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "actual.txt" } },
    { type: "tool_use", id: "mcp", name: "mcp__hara__agent_create", input: { file_path: "invented.txt" } }] } }),
    frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "edit", is_error: true }] } }), result("Done")].join("\n");
  assert.equal(parseClaudeCliOutput(output, value => observed.push(value)).ok, true);
  assert.deepEqual(observed.map(row => [row.type, row.status, row.id]), [["command", "started", "cmd"], ["file", "started", "edit"], ["file", "failed", "edit"]]);
  assert(observed.every(row => !("verified" in row) && row.id !== "mcp"));
});
test("Claude child drops ambient plugin-directory injection and cannot auto-background work", () => {
  const source = { HOME: "/fixture", CLAUDE_CODE_PLUGIN_DIRS: "/personal/plugins", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" };
  const env = claudeRuntimeEnvironment(source, "/private-policy-temp");
  assert.equal(env.HOME, source.HOME); assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_AGENT_VIEW, "1"); assert.equal(env.CLAUDE_CODE_DISABLE_CRON, "1");
  assert.equal(env.CLAUDE_CODE_TMPDIR, "/private-policy-temp");
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1"); assert.equal(source.CLAUDE_CODE_PLUGIN_DIRS, "/personal/plugins");
});
