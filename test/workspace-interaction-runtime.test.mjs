import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { prepareWorkspaceStartContext } from "../dist/workspace/start-context.js";
import { WorkspaceColleagueReferences } from "../dist/workspace/colleague-references.js";
import {
  WorkspaceUserInteraction, assertWorkspaceInteractionDelivery, workspacePermissionInteraction, workspacePlanReviewInteraction, MAX_ASYNC_QUESTIONS,
} from "../dist/workspace/user-interaction.js";
import { storageFixture, gate, hostFixture, tools } from "./helpers/workspace-user-interaction.mjs";

test("a newer explicit sync ask supersedes an unanswered one; the old card is closed as dismissed, not answered", t => {
  const a = gate(t); a.interaction.prepared();
  const first = a.interaction.request("explicit", "Which target?", ["Alpha"]);
  assert.equal(a.interaction.request("explicit", "Which target?", ["Alpha"]).id, first.id, "the same ask is idempotent");
  const second = a.open().request("explicit", "Which file?");
  assert.notEqual(second.id, first.id); assert.equal(a.interaction.question().id, second.id);
  assert.deepEqual(a.interaction.decision(first.id), { requestId: first.id, dismissed: true, reason: "superseded" });
  assert.throws(() => a.interaction.answer(first.id), /changed/);
  a.interaction.answer(second.id);
  assert.deepEqual(a.interaction.decision(second.id), { requestId: second.id, dismissed: false });
});

test("an observation gate is never superseded by a model ask", t => {
  const a = gate(t); a.interaction.prepared();
  const gateQuestion = a.interaction.request("lookup_missing");
  assert.equal(a.interaction.request("explicit", "Something else?").id, gateQuestion.id);
  assert.equal(a.interaction.decision(gateQuestion.id), null);
});

test("abort/pause dismissal hides the sync card, records dismissed=true, and keeps the hard stop retained", t => {
  const a = gate(t); a.interaction.prepared();
  const q = a.interaction.request("explicit", "Which target?");
  a.interaction.dismiss("aborted");
  assert.equal(a.interaction.question(), null); assert.equal(a.interaction.retainedQuestion().id, q.id);
  assert.deepEqual(a.interaction.decision(q.id), { requestId: q.id, dismissed: true, reason: "aborted" });
  assert.deepEqual(a.interaction.pendingInteractions(), []);
  assert.throws(() => a.interaction.admit("workspace_write"), /waiting/, "a dismissed card is not a user skip");
  assert.equal(a.interaction.check({ modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, 0).id, q.id, "a continuation reopens it");
});

test("async asks do not gate dispatch, cap at the limit, answer once, and close as run_ended", t => {
  const a = gate(t);
  assert.throws(() => a.interaction.requestAsync("Which format?"), /preflight/);
  a.interaction.prepared();
  const one = a.interaction.requestAsync("Which format?", ["PDF", "Markdown"], "Format");
  assert.equal(a.interaction.question(), null); a.interaction.admit("workspace_write");
  const [view] = a.interaction.pendingInteractions();
  assert.deepEqual(view, { requestId: one.id, kind: "ask_user_question", delivery: "async",
    questions: [{ question: "Which format?", header: "Format", options: ["PDF", "Markdown"] }],
    metadata: { reason: "explicit", taskId: one.taskId, runId: one.runId } });
  const rest = Array.from({ length: MAX_ASYNC_QUESTIONS - 1 }, (_, i) => a.interaction.requestAsync(`Question ${i}?`));
  assert.throws(() => a.interaction.requestAsync("One too many?"), /At most/);
  a.open().answerAsync(one.id, "PDF");
  assert.throws(() => a.interaction.answerAsync(one.id, "Markdown"), /expired/);
  assert.deepEqual(a.interaction.drainAsyncAnswers(), [{ id: one.id, question: "Which format?", answer: "PDF" }]);
  assert.deepEqual(a.interaction.drainAsyncAnswers(), [], "each answer is delivered once");
  assert.equal(a.interaction.closeAsync("run_ended"), rest.length);
  assert.deepEqual(a.interaction.pendingInteractions(), []);
  assert.deepEqual(a.interaction.decision(one.id), { requestId: one.id, dismissed: false });
  for (const q of rest) assert.deepEqual(a.interaction.decision(q.id), { requestId: q.id, dismissed: true, reason: "run_ended" });
  assert.throws(() => a.interaction.answerAsync(rest[0].id, "late"), /expired/);
});

test("a sync ask and async cards share one channel; the sync card is listed first", t => {
  const a = gate(t); a.interaction.prepared();
  a.interaction.requestAsync("Optional detail?");
  const sync = a.interaction.request("explicit", "Blocking choice?", ["A", "B"], { header: "Choice" });
  const rows = a.interaction.pendingInteractions();
  assert.deepEqual(rows.map(row => [row.delivery, row.questions[0].question]), [["sync", "Blocking choice?"], ["async", "Optional detail?"]]);
  assert.equal(rows[0].requestId, sync.id); assert.equal(rows[0].questions[0].header, "Choice");
  assert.throws(() => a.interaction.admit("workspace_write"), /waiting/);
});

test("permission and plan_review are never async; plan_review is a reserved, unimplemented slot", () => {
  assert.throws(() => assertWorkspaceInteractionDelivery("permission", "async"), /always synchronous/);
  assert.throws(() => assertWorkspaceInteractionDelivery("plan_review", "async"), /always synchronous/);
  assertWorkspaceInteractionDelivery("ask_user_question", "async"); assertWorkspaceInteractionDelivery("permission", "sync");
  const id = randomUUID(), runId = randomUUID();
  assert.deepEqual(workspacePermissionInteraction({ id, kind: "agent_create", runId, draft: { displayName: "Alpha" } }),
    { requestId: id, kind: "permission", delivery: "sync", action: "agent_create", summary: "agent_create: Alpha", metadata: { runId } });
  assert.throws(() => workspacePlanReviewInteraction(), /not implemented/);
});

test("an ambiguous rename target becomes a rename choice card; a true double miss still pauses as lookup_missing", t => {
  const { root, storage } = storageFixture(t), resources = new WorkspaceResources(root, storage.scope); resources.initialize();
  resources.agents.initializeMain();
  for (const [username, displayName, title] of [["coder", "Coder", "负责程序开发"], ["backend", "Backend", "后端程序"]])
    resources.agents.create({ username, profile: { displayName, title } }, resources.agents.list().revision);
  const references = new WorkspaceColleagueReferences(storage, () => resources.agents.references()).read();
  const packet = prepareWorkspaceStartContext({ storage, workspaceRoots: [], references, objective: "把负责程序的同事改名嘉夫" });
  const result = packet.lookup("负责程序的同事");
  assert.equal(result.status, "ambiguous"); assert.equal(result.renameTo, "嘉夫");
  const g = gate(t), zh = new WorkspaceUserInteraction(g.storage, g.binding, randomUUID(), true); zh.prepared();
  zh.observe("workspace_context_lookup", JSON.stringify(result), false);
  const q = zh.question();
  assert.equal(q.reason, "lookup_ambiguous"); assert.equal(q.intent, "rename_target"); assert.equal(q.options.length, 2);
  assert.match(q.question, /嘉夫/); assert.equal(zh.pendingInteractions()[0].metadata.intent, "rename_target");
  const a = gate(t); a.interaction.prepared();
  for (let n = 0; n < 2; n++) a.interaction.observe("workspace_context_lookup", JSON.stringify(packet.lookup("嘉夫")), false);
  assert.equal(a.interaction.question(), null, "the new name never counts as a miss");
  const plain = prepareWorkspaceStartContext({ storage, workspaceRoots: [], references, objective: "Mori 去哪了" });
  assert.equal(plain.lookup("Mori").renameTo, undefined);
  const b = gate(t); b.interaction.prepared();
  b.interaction.observe("workspace_context_lookup", JSON.stringify(plain.lookup("Mori")), false);
  b.interaction.observe("workspace_memory_search", JSON.stringify({ hits: [] }), false);
  assert.equal(b.interaction.question().reason, "lookup_missing");
});

test("Host: a sync ask_user enters the unified channel with its header and stops dispatch", async t => {
  const a = hostFixture(t, () => tools(["ask_user", { question: "Which format?", header: "Format", options: ["PDF", "Markdown"] }],
    ["workspace_write", { path: "never.txt", content: "must not run" }]));
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Prepare the report", randomUUID()); await a.host.wait(run.runId);
  const view = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(a.turns.length, 1); assert.equal(view.state, "awaiting_user");
  assert.equal(view.pendingQuestion.reason, "explicit"); assert.equal(view.pendingQuestion.header, "Format");
  assert.deepEqual(view.pendingInteractions.map(row => [row.kind, row.delivery, row.requestId]), [["ask_user_question", "sync", view.pendingQuestion.id]]);
  assert.deepEqual(view.pendingInteractions[0].questions[0].options, ["PDF", "Markdown"]);
});

test("Host: an async ask lets a sibling read run, and a mid-run answer reaches the next model turn", async t => {
  const seen = {};
  const a = hostFixture(t, (n, args) => {
    if (n === 1) return tools(["ask_user", { question: "Which format?", options: ["PDF", "Markdown"], delivery: "async" }], ["workspace_read", { path: "notes.txt" }]);
    if (n === 2) {
      const results = args.history.flatMap(message => message.role === "tool" ? message.results : []);
      seen.ask = results.find(row => row.name === "ask_user"); seen.read = results.find(row => row.name === "workspace_read");
      seen.receipt = JSON.parse(seen.ask.content);
      seen.view = a.host.snapshot(a.workspace.workspaceId).conversation;
      a.host.answerAsyncQuestion("client", a.workspace.workspaceId, a.workspace.selectedAgentId, seen.receipt.questionId, "PDF please");
      return tools(["workspace_read", { path: "notes.txt" }]);
    }
    seen.history = args.history; return { text: "Using PDF.", toolUses: [], stop: "end" };
  });
  // An existing file: two absent reads would (correctly) trip the unrelated lookup_missing gate.
  fs.writeFileSync(join(a.root, "project", a.workspace.workspaceId, "notes.txt"), "synthetic notes\n");
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Prepare the report", randomUUID()); await a.host.wait(run.runId);
  assert.equal(seen.receipt.status, "pending"); assert.equal(seen.receipt.delivery, "async");
  assert.equal(seen.ask.isError ?? false, false); assert(seen.read, "the sibling non-interactive tool executed");
  assert.equal(seen.view.pendingQuestion, null); assert.equal(seen.view.state, "running");
  assert.deepEqual(seen.view.pendingInteractions.map(row => [row.kind, row.delivery, row.requestId]), [["ask_user_question", "async", seen.receipt.questionId]]);
  assert(seen.history.some(message => message.role === "user" && message.content.includes("PDF please") && message.content.includes("Which format?")));
  const after = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.deepEqual(after.pendingInteractions, []); assert.notEqual(after.state, "awaiting_user");
});

test("Host: an unanswered async ask is dismissed when the run ends and cannot be answered late", async t => {
  let questionId;
  const a = hostFixture(t, (n, args) => {
    if (n === 1) return tools(["ask_user", { question: "Any preference?", delivery: "async" }]);
    questionId = JSON.parse(args.history.flatMap(message => message.role === "tool" ? message.results : []).find(row => row.name === "ask_user").content).questionId;
    return { text: "Proceeding without it.", toolUses: [], stop: "end" };
  });
  const run = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Prepare the report", randomUUID()); await a.host.wait(run.runId);
  const view = a.host.snapshot(a.workspace.workspaceId).conversation;
  assert.equal(view.pendingQuestion, null); assert.deepEqual(view.pendingInteractions, []); assert.notEqual(view.state, "awaiting_user");
  assert.throws(() => a.host.answerAsyncQuestion("client", a.workspace.workspaceId, a.workspace.selectedAgentId, questionId, "late"), /expired/);
  const stored = new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId).read();
  const interaction = new WorkspaceUserInteraction(a.storage, stored.task.workspaceRunBinding, stored.task.id, false);
  assert.deepEqual(interaction.decision(questionId), { requestId: questionId, dismissed: true, reason: "run_ended" });
});
