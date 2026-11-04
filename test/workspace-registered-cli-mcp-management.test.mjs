import { governedToolResult } from "./helpers/governed-tool-result.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
async function closed(url) {
  await until(async () => { try { await fetch(url); return false; } catch { return true; } }, Boolean);
}
test("Codex generic creation keeps the native turn-limit guard after the exact Desk card, creates once, and ordinary colleagues lack management tools", async t => {
  const f = await cliMcpFixture(t, "create"); await f.send("Create one test assistant after confirmation.");
  const pending = await until(f.read, view => view.approvals.length === 1);
  assert.equal(pending.agents.length, 1, "no persisted colleague before confirmation");
  assert.equal(f.meta().created, undefined);
  const card = pending.approvals[0]; assert.equal(card.kind, "agent_create");
  await assert.rejects(f.request("workspace.approval.respond", { ...f.scope, approvalId: randomUUID(), approved: true }));
  assert.equal((await f.read()).agents.length, 1);
  await f.request("workspace.approval.respond", { ...f.scope, approvalId: card.id, approved: true });
  const view = await until(f.read, done), meta = f.meta();
  assert.equal(view.conversation.state, "completed");
  assert.equal(view.agents.length, 2); assert.equal(view.approvals.length, 0);
  const created = governedToolResult(meta.created.text), refusal = governedToolResult(meta.second.text);
  assert.equal(created.created, true); assert.equal(created.humanConfirmed, true);
  assert.equal(refusal.refused, "turn_limit"); assert.equal(refusal.created, false);
  assert.equal(view.conversation.completion.state, "verified");
  await assert.rejects(f.request("workspace.approval.respond", { ...f.scope, approvalId: card.id, approved: true }));
  await closed(meta.url);
  const colleague = view.agents.find(row => row.kind === "colleague"); f.mode("list");
  await f.request("workspace.agents.setRuntime", { ...f.scope, agentId: colleague.agentId, runtimeId: "codex",
    configRevision: colleague.configRevision, agentEpoch: colleague.agentEpoch });
  await f.request("workspace.session.send", { ...f.scope, agentId: colleague.agentId, message: "Hello.", requestId: randomUUID(), source: "ui" });
  await until(() => f.request("workspace.snapshot", { workspaceId: f.scope.workspaceId, agentId: colleague.agentId }), done);
  const child = f.meta();
  for (const name of ["agent_list", "agent_create", "agent_rename", "agent_contact"]) assert.equal(child.tools.includes(name), false);
  assert.equal(child.listed.isError, true);
  await closed(child.url);
});

for (const action of ["decline", "cancel"]) test("a " + action + "d Codex confirmation cannot create a colleague and closes its MCP endpoint", async t => {
  const f = await cliMcpFixture(t, "create"), sent = await f.send("Create one test colleague after confirmation.");
  const pending = await until(f.read, view => view.approvals.length === 1), url = f.meta().url;
  assert.equal(pending.agents.length, 1);
  if (action === "decline") await f.request("workspace.approval.respond", { ...f.scope, approvalId: pending.approvals[0].id, approved: false });
  else await f.request("workspace.session.cancel", { ...f.scope, agentId: f.main.agentId, runId: sent.runId });
  const view = await until(f.read, view => done(view) && view.approvals.length === 0);
  assert.equal(view.agents.length, 1);
  if (action === "decline") assert.equal(governedToolResult(f.meta().created.text).approvalState, "declined");
  await closed(url);
});
