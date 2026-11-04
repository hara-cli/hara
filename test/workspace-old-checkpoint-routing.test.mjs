import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hostFixture, tools } from "./helpers/workspace-user-interaction.mjs";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceTreeBudget } from "../dist/workspace/tree-budget.js";
import { workspaceOperationSkill } from "../dist/workspace/operation-cards.js";
import { runtimeFailureMessage } from "../dist/agent-runtime/failure-diagnostics.js";

const priorFailure = runtimeFailureMessage({ runtime: "codex", kind: "timeout", version: "0.163.0", loginSource: "host",
  homeMatchesAccount: true, elapsedMs: 12000, retryAtMs: 1, consecutiveFailures: 3 });
const ui = { source: "ui", channel: "rpc", clientId: "client" };
async function oldBlocked(t) {
  const f = hostFixture(t, n => n === 1 ? { text: "", toolUses: [], stop: "error", errorMsg: priorFailure }
    : tools(["agent_create", { username: "video-helper", displayName: "Video helper", title: "Video", instructions: "Manage video work." }]));
  const w = f.workspace, run = f.host.start("client", w.workspaceId, w.selectedAgentId, "hello OLD-OBJECTIVE", randomUUID());
  await f.host.wait(run.runId);
  const store = new WorkspaceConversationStore(f.storage, w.selectedAgentId), value = store.read();
  assert.equal(value.task.workspaceRunBinding.budget.mode, undefined);
  assert.equal(value.task.workspaceRunBinding.budget.maxRounds, 12);
  assert.match(value.task.checkpoint.blockReason, /consecutiveFailures":3/);
  for (let n = 0; n < 120; n++) value.history.push({ role: "user", content: `HISTORICAL-ONLY-${n} ` + "old context ".repeat(35) },
    { role: "assistant", text: "A historical answer.", toolUses: [] });
  store.save(value.revision, value);
  return { ...f, store, before: store.read(), run };
}

test("new send after long legacy history archives old checkpoint and failure counts and reaches one fresh version-locked creation card", async t => {
  const f = await oldBlocked(t), w = f.workspace;
  const tree = new WorkspaceTreeBudget(f.storage, f.run.runId, f.before.task.workspaceRunBinding.budget).read();
  const run = f.host.start("client", w.workspaceId, w.selectedAgentId, "Create a colleague for the video project", randomUUID(), false, undefined, undefined, ui);
  let card;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    card = f.host.snapshot(w.workspaceId, w.selectedAgentId, "client").approvals.find(card => card.kind === "agent_create");
    if (card) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(card, "new send reaches the human card");
  const value = f.store.read(), args = f.turns.at(-1), skill = workspaceOperationSkill();
  assert.notEqual(run.runId, f.run.runId); assert.notEqual(value.task.id, f.before.task.id);
  assert.equal(value.task.workspaceRunBinding.budget.mode, "interactive");
  assert.deepEqual(value.pastTasks.at(-1).task, f.before.task);
  assert.deepEqual(value.pastTasks.at(-1).usage, f.before.runUsage);
  assert.deepEqual(value.history.slice(0, f.before.history.length), f.before.history);
  assert.deepEqual(new WorkspaceTreeBudget(f.storage, f.run.runId, f.before.task.workspaceRunBinding.budget).read(), tree);
  assert.equal(value.runUsage.modelCalls, 1); assert.equal(value.usage.modelCalls, f.before.usage.modelCalls + 1);
  assert.doesNotMatch(JSON.stringify(args.history), /HISTORICAL-ONLY|OLD-OBJECTIVE/);
  assert.doesNotMatch(args.system, /consecutiveFailures|OLD-OBJECTIVE|via workspace_skill before using|load every page of instructions via workspace_skill before acting/);
  assert.equal(args.system.split(skill.files["cards/create-colleague.md"]).length - 1, 1);
  assert.equal(args.system.includes(skill.version), true);
  assert.equal(f.turns.length, 2); assert.equal(f.host.snapshot(w.workspaceId).agents.length, 1);
  f.host.answerApproval("client", w.workspaceId, card.id, false); await f.host.wait(run.runId);
  assert.equal(f.host.snapshot(w.workspaceId).agents.length, 1);
});

test("explicit continue keeps the frozen legacy run, cumulative usage and historical checkpoint without upgrading its budget", async t => {
  const f = await oldBlocked(t), w = f.workspace;
  // Stop at a synthetic second error; no tool or replacement task can hide an accounting reset.
  f.options.providerFactory = (_connection, binding) => ({ id: "openai", model: binding.model, async turn() {
    return { text: "", toolUses: [], stop: "error", errorMsg: "synthetic continuation failed", usage: { input: 5, output: 1 } };
  } });
  const run = f.host.start("client", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true, undefined, undefined, ui);
  await f.host.wait(run.runId);
  const value = f.store.read();
  assert.equal(run.runId, f.run.runId); assert.equal(value.task.id, f.before.task.id);
  assert.deepEqual(value.task.workspaceRunBinding, f.before.task.workspaceRunBinding);
  assert.equal(value.runUsage.modelCalls, f.before.runUsage.modelCalls + 1);
  assert.equal(value.runUsage.inputTokens, f.before.runUsage.inputTokens + 5);
  assert.deepEqual(value.pastTasks, f.before.pastTasks);
  assert.deepEqual(value.history.slice(0, f.before.history.length), f.before.history);
});

test("a question-card answer that sounds like a new creation stays in its original legacy task and requires the current question ID", async t => {
  const f = hostFixture(t, n => n === 1 ? tools(["ask_user", { question: "Which project should I report on?", options: ["Video", "Design"] }])
    : { text: "The selected project is video.", toolUses: [], stop: "end" });
  const w = f.workspace, first = f.host.start("client", w.workspaceId, w.selectedAgentId, "Help choose the report project", randomUUID());
  await f.host.wait(first.runId);
  const store = new WorkspaceConversationStore(f.storage, w.selectedAgentId), before = store.read();
  const question = f.host.snapshot(w.workspaceId).conversation.pendingQuestion; assert(question);
  const answer = "Create a colleague for the video project";
  assert.throws(() => f.host.start("client", w.workspaceId, w.selectedAgentId, answer, randomUUID(), false), /specific answer/);
  assert.throws(() => f.host.start("client", w.workspaceId, w.selectedAgentId, answer, randomUUID(), true, undefined, undefined, ui, undefined, randomUUID()), /specific answer|changed/);
  assert.equal(f.turns.length, 1);
  const replied = f.host.start("client", w.workspaceId, w.selectedAgentId, answer, randomUUID(), true, undefined, undefined, ui, undefined, question.id);
  await f.host.wait(replied.runId);
  const after = store.read();
  assert.equal(replied.runId, first.runId); assert.equal(after.task.id, before.task.id);
  assert.deepEqual(after.task.workspaceRunBinding, before.task.workspaceRunBinding);
  assert.equal(after.runUsage.modelCalls, before.runUsage.modelCalls + 1);
  assert.equal(after.pastTasks.length, 0);
  assert.equal(f.host.snapshot(w.workspaceId).conversation.pendingQuestion, null);
  assert.doesNotMatch(f.turns.at(-1).system, /FIRST model response.*agent_create/);
});
