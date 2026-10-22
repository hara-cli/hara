import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";

import { hostFixture, tools, lookup } from "./helpers/workspace-user-interaction.mjs";

test("Host stops at two misses without a third model round and a real answer resumes the same task/run", async t => {
  const a = hostFixture(t, n => n <= 2 ? tools(lookup(`unknown-${n}`)) : { text: "Resolved", toolUses: [], stop: "end" });
  const accepted = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Find the missing context", randomUUID());
  await a.host.wait(accepted.runId);
  const before = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(a.turns.length, 2); assert.equal(before.state, "awaiting_user"); assert.equal(before.pendingQuestion.reason, "lookup_missing");
  assert.equal(before.runUsage.modelCalls, 2); assert.equal(before.runUsage.toolCalls, 2);
  assert(a.turns[0].system.includes("Context data only")); assert(a.turns[0].tools.some(tool => tool.name === "workspace_context_lookup"));
  assert.throws(() => a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "/continue", randomUUID(), true), /specific answer/);
  assert.throws(() => a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "guess", randomUUID()), /specific answer/);
  await a.host.close();
  const reopened = new LocalWorkspaceHost(a.root, a.options);
  try {
    const retained = reopened.snapshot(a.workspace.workspaceId).conversation.pendingQuestion;
    assert.equal(retained.id, before.pendingQuestion.id);
    const requestId = randomUUID(), answer = "Use the archived colleague's current name.";
    const reply = reopened.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, answer, requestId, true, undefined, undefined, undefined, undefined, retained.id);
    await reopened.wait(reply.runId);
    const after = reopened.snapshot(a.workspace.workspaceId).conversation;
    assert.equal(after.taskId, before.taskId); assert.equal(after.runId, before.runId);
    assert.equal(after.pendingQuestion, null); assert.equal(after.runUsage.modelCalls, 3); assert.equal(a.turns.length, 3);
    const stored = new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId).read();
    assert(stored.task.decisions.some(decision => decision.callId === retained.id && decision.answer === answer));
    assert(a.turns[2].system.includes("archived colleague"));
    assert.equal(reopened.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, answer, requestId, true, undefined, undefined, undefined, undefined, retained.id).duplicate, true);
    assert.throws(() => reopened.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "different", requestId, true, undefined, undefined, undefined, undefined, retained.id), /another request/);
    assert.equal(a.turns.length, 3);
  } finally { await reopened.close(); }
});

test("three parallel lookups and a sibling write execute only two lookups, never the write", async t => {
  const a = hostFixture(t, () => tools(lookup("unknown-one"), lookup("unknown-two"), lookup("unknown-three"), ["workspace_write", { path: "must-not-exist.txt", content: "synthetic" }]));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Find missing context", randomUUID()); await a.host.wait(run.runId);
  const result = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(a.turns.length, 1); assert.equal(result.runUsage.toolCalls, 2); assert.equal(result.pendingQuestion.reason, "lookup_missing");
  assert.equal(fs.existsSync(join(a.root, "project", a.workspace.workspaceId, "must-not-exist.txt")), false);
});

test("ordinary no-memory greeting runs without a false question", async t => {
  const a = hostFixture(t, () => ({ text: "Hello", toolUses: [], stop: "end" }));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Hello", randomUUID()); await a.host.wait(run.runId);
  assert.equal(a.turns.length, 1); assert.equal(a.host.snapshot(a.workspace.workspaceId).conversation.pendingQuestion, null);
});

test("an explicitly unresolved colleague reference is stopped by startup context before any model or file action", async t => {
  const a = hostFixture(t, () => tools(["workspace_write", { path: "never.txt", content: "must not run" }]));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Where is UnknownColleague", randomUUID()); await a.host.wait(run.runId);
  const view = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(a.turns.length, 0); assert.equal(view.state, "awaiting_user"); assert.equal(view.pendingQuestion.reason, "lookup_missing");
  assert.equal(view.runUsage.modelCalls, 0); assert.match(view.pendingQuestion.question, /UnknownColleague/);
});


test("two absent file reads stop a queued third read and write without another model call", async t => {
  const a = hostFixture(t, () => tools(["workspace_read", { path: "absent-one.txt" }], ["workspace_read", { path: "absent-two.txt" }],
    ["workspace_read", { path: "absent-three.txt" }], ["workspace_write", { path: "must-not-exist.txt", content: "synthetic" }]));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Locate the requested file", randomUUID()); await a.host.wait(run.runId);
  const view = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(view.pendingQuestion.reason, "lookup_missing"); assert.equal(view.runUsage.toolCalls, 2); assert.equal(a.turns.length, 1);
  assert.equal(fs.existsSync(join(a.root, "project", a.workspace.workspaceId, "must-not-exist.txt")), false);
});
