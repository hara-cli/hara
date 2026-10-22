import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";

import { hostFixture, tools, lookup } from "./helpers/workspace-user-interaction.mjs";

test("budget telemetry creates a question before a sibling action and its answer retains the original usage", async t => {
  const a = hostFixture(t, n => n === 1 ? { ...tools(["workspace_write", { path: "not-written.txt", content: "synthetic" }]), usage: { input: 102400, output: 0 } }
    : { text: "Continued within the remaining allowance", toolUses: [], stop: "end", usage: { input: 1, output: 1 } });
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Inspect the current context", randomUUID()); await a.host.wait(run.runId);
  const before = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(a.turns.length, 1); assert.equal(before.pendingQuestion.reason, "budget_warning"); assert.equal(before.runUsage.inputTokens, 102400);
  assert.equal(fs.existsSync(join(a.root, "project", a.workspace.workspaceId, "not-written.txt")), false);
  const reply = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Continue within the remaining allowance", randomUUID(), true, undefined, undefined, undefined, undefined, before.pendingQuestion.id);
  await a.host.wait(reply.runId);
  const after = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(after.taskId, before.taskId); assert.equal(after.runId, before.runId); assert.equal(after.runUsage.inputTokens, 102401); assert.equal(a.turns.length, 2);
  const stored = new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId).read();
  assert.equal(stored.task.workspaceRunBinding.budget.maxTokens, 128000);
});

test("an exhausted question can be kept paused without spending or resetting the old budget", async t => {
  const a = hostFixture(t, n => n === 1 ? { ...tools(lookup("missing")), usage: { input: 128000, output: 0 } } : { text: "New task", toolUses: [], stop: "end" });
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Inspect the context", randomUUID()); await a.host.wait(run.runId);
  const before = a.host.snapshot(a.workspace.workspaceId).conversation, q = before.pendingQuestion;
  assert.equal(before.resumeAdmission.allowed, false); assert(q);
  assert.throws(() => a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Continue", randomUUID(), true, undefined, undefined, undefined, undefined, q.id), /budget exhausted/);
  assert.equal(a.turns.length, 1);
  assert.equal(a.host.pauseUserQuestion("client", a.workspace.workspaceId, a.workspace.selectedAgentId, q.id).state, "paused");
  a.host.pauseUserQuestion("client", a.workspace.workspaceId, a.workspace.selectedAgentId, q.id);
  const paused = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(paused.pendingQuestion, null); assert.equal(paused.taskId, before.taskId); assert.equal(paused.runUsage.inputTokens, 128000);
  const next = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Hello, this is a separate new task", randomUUID()); await a.host.wait(next.runId);
  const after = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.notEqual(after.taskId, before.taskId); assert.equal(after.pastTaskCount, 1); assert.equal(a.turns.length, 2);
});

test("a corrupt context index is rejected before an accepted job is published", async t => {
  const a = hostFixture(t, () => ({ text: "must not run", toolUses: [], stop: "end" }));
  const path = a.storage.run(() => join(workspaceStateHome(), ".hara", "colleague-references.json"));
  fs.writeFileSync(path, "{bad-json", { mode: 0o600 });
  const requestId = randomUUID(); assert.throws(() => a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Hello", requestId), /invalid private Workspace JSON/);
  assert.equal(a.host.requestReceipt(a.workspace.workspaceId, a.workspace.selectedAgentId, requestId).state, "rejected");
  assert.equal(a.turns.length, 0); assert.equal(new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId).read().task, null);
});
