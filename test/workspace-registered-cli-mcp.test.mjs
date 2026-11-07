import { observeCodexAttempts } from "./helpers/codex-attempt-probe.mjs";
import { governedToolResult, compactRosterIds } from "./helpers/governed-tool-result.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
test("session.send reaches registered Codex MCP and lists only this Workspace with governed receipts", async t => {
  const revoked = observeCodexAttempts(t);
  const f = await cliMcpFixture(t); await f.send("List the colleagues of this Workspace.");
  const view = await until(f.read, done), meta = f.meta();
  assert.equal(view.conversation.state, "completed");
  assert(meta.tools.includes("agent_list") && meta.tools.includes("agent_create") && meta.tools.includes("task_checkpoint"));
  assert(["schedule_create", "schedule_list", "schedule_cancel"].every(name => meta.tools.includes(name)), "chat schedule tools are available through the governed MCP endpoint");
  assert.equal(meta.tools.includes("bash"), false); assert.equal(meta.tools.includes("read_file"), false);
  assert.equal(meta.tokenPresent, true); assert.equal(meta.tokenInArgv, false);
  assert.equal(meta.readOnly, false); assert.equal(meta.onRequest, false); assert.equal(meta.nativeSandboxDisabled,true); assert.equal(meta.nativeApprovalDisabled,true); assert.equal(meta.haraOnlyTrust, true);
  const thread=f.native().find(row=>row.method==="thread/start");assert.equal(thread.params.sandbox,"danger-full-access");assert.equal(thread.params.approvalPolicy,"never");assert.equal(view.conversation.permissionTier,"full-protected");
  const result = governedToolResult(meta.listed.text);
  assert.deepEqual(compactRosterIds(result), [f.main.agentId]);
  assert.equal(typeof result.receipt.toolCallId, "string");
  const calls = view.conversation.history.flatMap(row => row.role === "tool" ? row.results : []);
  assert(calls.some(row => row.name === "agent_list" && row.id === result.receipt.toolCallId));
  assert(view.conversation.usage.modelCalls > 0 && view.conversation.usage.toolCalls > 0);
  await revoked(meta, { resident: true });
});

test("registered CLI crash revokes the per-attempt capability and records no fabricated success", async t => {
  const revoked = observeCodexAttempts(t);
  const f = await cliMcpFixture(t, "crash"); await f.send("Hello.");
  const view = await until(f.read, done), meta = f.meta();
  assert.equal(view.conversation.state, "blocked"); assert.equal(view.agents.length, 1);
  await revoked(meta);
});
test("a native CLI cannot leak the per-turn bearer through its final text", async t => {
  const revoked = observeCodexAttempts(t);
  const f = await cliMcpFixture(t, "leak"); await f.send("Hello.");
  const view = await until(f.read, done);
  assert.equal(view.conversation.state, "blocked");
  assert.equal(view.conversation.taskState, "paused");
  assert.equal(view.conversation.history.filter(row => row.role === "assistant").at(-1).text, "***");
  assert.equal(f.meta().tokenInArgv, false);
  await revoked(f.meta());
});
