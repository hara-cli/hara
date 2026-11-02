import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
async function closed(url) {
  await until(async () => { try { await fetch(url); return false; } catch { return true; } }, Boolean);
}
test("session.send reaches registered Codex MCP and lists only this Workspace with governed receipts", async t => {
  const f = await cliMcpFixture(t); await f.send("List the colleagues of this Workspace.");
  const view = await until(f.read, done), meta = f.meta();
  assert.equal(view.conversation.state, "completed");
  assert(meta.tools.includes("agent_list") && meta.tools.includes("agent_create") && meta.tools.includes("task_checkpoint"));
  assert.equal(meta.tools.includes("bash"), false); assert.equal(meta.tools.includes("read_file"), false);
  assert.equal(meta.tokenPresent, true); assert.equal(meta.tokenInArgv, false);
  assert.equal(meta.readOnly, true); assert.equal(meta.onRequest, true); assert.equal(meta.haraOnlyTrust, true);
  const result = JSON.parse(meta.listed.text);
  assert.deepEqual(result.agents.map(row => row.agentId), [f.main.agentId]);
  assert.equal(typeof result.receipt.toolCallId, "string");
  const calls = view.conversation.history.flatMap(row => row.role === "tool" ? row.results : []);
  assert(calls.some(row => row.name === "agent_list" && row.id === result.receipt.toolCallId));
  assert(view.conversation.usage.modelCalls > 0 && view.conversation.usage.toolCalls > 0);
  await closed(meta.url);
});

test("registered CLI crash closes the per-attempt endpoint and records no fabricated success", async t => {
  const f = await cliMcpFixture(t, "crash"); await f.send("Hello.");
  const view = await until(f.read, done), meta = f.meta();
  assert.equal(view.conversation.state, "blocked"); assert.equal(view.agents.length, 1);
  await closed(meta.url);
});
test("a native CLI cannot leak the per-turn bearer through its final text", async t => {
  const f = await cliMcpFixture(t, "leak"); await f.send("Hello.");
  const view = await until(f.read, done);
  assert.equal(view.conversation.state, "completed");
  assert.equal(view.conversation.history.filter(row => row.role === "assistant").at(-1).text, "***");
  assert.equal(f.meta().tokenInArgv, false);
});
