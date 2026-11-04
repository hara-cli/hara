import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { hostFixture, gate, emptyUsage, tools, storageFixture } from "./helpers/workspace-user-interaction.mjs";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceUserInteraction } from "../dist/workspace/user-interaction.js";
import { WorkspaceTreeBudget } from "../dist/workspace/tree-budget.js";
import { compactWorkspaceRoster } from "../dist/workspace/management-context.js";
import { WorkspaceContextReceipts, WORKSPACE_RECEIPT_PAGE_CHARS } from "../dist/workspace/context-receipts.js";
import { workspaceTaskProjection } from "../dist/workspace/model-context.js";
import { DEFAULT_WORKSPACE_RUN_BUDGET, INTERACTIVE_WORKSPACE_RUN_BUDGET, freezeWorkspaceRunBinding } from "../dist/workspace/run-binding.js";
import { workspaceStateHome } from "../dist/workspace/resource-context.js";

const ui = { source: "ui", channel: "rpc", clientId: "client" };
const start = (a, message, origin = ui) => a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, message, randomUUID(), false, undefined, undefined, origin);
const store = a => new WorkspaceConversationStore(a.storage, a.workspace.selectedAgentId);
const snapshot = a => a.host.snapshot(a.workspace.workspaceId, a.workspace.selectedAgentId, "client");
async function until(check) { for (let n = 0; n < 400; n++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("synthetic state not reached"); }

test("twenty colleagues with long public bios fit a compact directory and reach an unchanged approval within four rounds", async t => {
  const a = hostFixture(t, n => n === 1 ? tools(["agent_list", {}]) : n === 2
    ? tools(["agent_create", { username: "video-new", displayName: "Video New", title: "video project", instructions: "Work on the requested video project." }])
    : { text: "The proposal was declined; no colleague was created.", toolUses: [], stop: "end" });
  const resources = a.host.context(a.workspace.workspaceId).resources;
  for (let n = 0; n < 20; n++) resources.agents.create({ username: `peer-${n}`, profile: { displayName: `Peer ${n}`, title: `Role ${n}`, bio: "Long public biography. ".repeat(100) },
    description: "Frontend Developer with a lengthy public role description. ".repeat(3), instructions: "Private instructions must never enter the roster. ".repeat(200) }, resources.agents.list().revision);
  const packet = compactWorkspaceRoster(resources.agents.list().agents);
  assert.equal(packet.total, 21); assert.equal(packet.agents.length, 21); assert.equal(packet.truncated, false);
  assert.ok(JSON.stringify(packet).length < 2000); assert.equal(JSON.stringify(packet).includes("biography"), false);
  assert.equal(JSON.stringify(packet).includes("Private instructions"), false);
  const run = start(a, "Create a new colleague Video New to work on the video project");
  const card = await until(() => snapshot(a).approvals[0]);
  assert.ok(a.turns.length <= 4); assert.equal(a.turns.length, 2); assert.equal(snapshot(a).agents.length, 21);
  assert.match(a.turns[0].system, /catalog_only/); assert.match(a.turns[0].system, /peer|Peer/);
  assert.equal(a.turns[0].system.includes("Long public biography"), false);
  assert.equal(a.turns.some(turn => turn.history.some(message => message.role === "tool" && message.results.some(result => result.name === "workspace_receipt_read"))), false);
  assert.throws(() => a.host.answerApproval("foreign-client", a.workspace.workspaceId, card.id, true), /approval/);
  a.host.answerApproval("client", a.workspace.workspaceId, card.id, false); await a.host.wait(run.runId);
  assert.equal(snapshot(a).agents.length, 21); assert.equal(store(a).read().task.workspaceRunBinding.budget.mode, "interactive");
});

test("interactive chat passes twelve rounds and aggregate token/tool sizing without budget cards; raw usage and compaction remain", async t => {
  const a = hostFixture(t, n => n <= 14 ? { ...tools(...[1, 2, 3].map(part => ["workspace_read", { path: `report-${n}-${part}.txt` }])), usage: { input: 12000, output: 20 } }
    : { text: "The fourteen reports were read.", toolUses: [], stop: "end" });
  const project = a.host.context(a.workspace.workspaceId).project;
  for (let n = 1; n <= 14; n++) for (const part of [1, 2, 3]) fs.writeFileSync(join(project, `report-${n}-${part}.txt`),
    `Report ${n}: ${Array.from({ length: 100 }, () => randomBytes(5).toString("hex")).join(" ")}`);
  const run = start(a, "What do the numbered reports say?"); await a.host.wait(run.runId);
  assert.equal(a.turns.length, 15, snapshot(a).conversation.blockReason); assert.equal(snapshot(a).conversation.pendingQuestion, null);
  assert.equal(snapshot(a).conversation.runUsage.toolCalls, 42);
  assert.equal(snapshot(a).conversation.runUsage.modelCalls, 15); assert.ok(snapshot(a).conversation.runUsage.inputTokens > 128000);
  assert.equal(snapshot(a).conversation.state, "completed", snapshot(a).conversation.blockReason);
  assert.equal(store(a).read().task.roundsUsed, 15);
});

for (const source of ["host", "delegation", "cli", "legacy_rpc", "automatic_retry"]) test(`${source} requests keep the original budget`, async t => {
  const a = hostFixture(t, () => ({ text: "Hello", toolUses: [], stop: "end" }));
  const run = start(a, "Hello", { source, channel: source === "host" || source === "delegation" ? "internal" : "rpc", clientId: "client" }); await a.host.wait(run.runId);
  assert.deepEqual(store(a).read().task.workspaceRunBinding.budget, DEFAULT_WORKSPACE_RUN_BUDGET);
});

test("interactive fuse is durable, has explicit choices, and a human continuation advances only its window", t => {
  const a = gate(t); a.binding.budget = { ...INTERACTIVE_WORKSPACE_RUN_BUDGET }; a.interaction.prepared();
  const usage = { modelCalls: 99, toolCalls: 2000, inputTokens: 900000, outputTokens: 500000 };
  assert.equal(a.interaction.check(usage, 9e6), null);
  const q = a.open().check({ ...usage, modelCalls: 100 }, 9e6);
  assert.equal(q.reason, "runaway_guard"); assert.deepEqual(q.options, ["Continue", "Stop"]);
  assert.equal(a.open().check({ ...usage, modelCalls: 100 }, 9e6).id, q.id);
  a.open().answer(q.id, 100); assert.equal(a.open().check({ ...usage, modelCalls: 199 }, 9e6), null);
  assert.equal(a.open().check({ ...usage, modelCalls: 200 }, 9e6).reason, "runaway_guard");
  assert.deepEqual(usage, { modelCalls: 99, toolCalls: 2000, inputTokens: 900000, outputTokens: 500000 });
});

for (const decision of ["Continue", "Stop"]) test(`recovered fuse ${decision} keeps usage and never charges a model to stop`, async t => {
  const a = hostFixture(t, n => n === 1 ? tools(["ask_user", { question: "Choose the next step", options: ["Continue", "Stop"] }])
    : { text: "Continued from the preserved progress.", toolUses: [], stop: "end" });
  const first = start(a, "Inspect the current progress"); await a.host.wait(first.runId);
  let value = store(a).read(); const binding = value.task.workspaceRunBinding;
  // Simulate a persisted 100-round boundary without spending 100 real model calls.
  const interactionFile = a.storage.run(() => join(workspaceStateHome(), ".hara", `interaction-${first.runId}.json`));
  const interaction = JSON.parse(fs.readFileSync(interactionFile)); interaction.question.reason = "runaway_guard"; interaction.question.options = ["Continue", "Stop"];
  fs.writeFileSync(interactionFile, JSON.stringify(interaction));
  const tree = new WorkspaceTreeBudget(a.storage, first.runId, binding.budget);
  tree.consume({ ...emptyUsage(), modelCalls: 100 - value.runUsage.modelCalls });
  value.runUsage.modelCalls = 100; value.usage.modelCalls = 100; value.task.roundsUsed = 100;
  store(a).save(value.revision, value);
  const before = snapshot(a).conversation;
  const result = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, decision, randomUUID(), true, undefined, undefined, ui, undefined, before.pendingQuestion.id);
  await a.host.wait(result.runId);
  assert.equal(a.turns.length, decision === "Stop" ? 1 : 2);
  assert.equal(snapshot(a).conversation.runUsage.modelCalls, decision === "Stop" ? 100 : 101);
  assert.equal(snapshot(a).conversation.pendingQuestion, null);
  if (decision === "Continue") assert.equal(store(a).read().task.roundsUsed, 101);
});

test("interactive shared tree accounting cannot expand delegated children or erase missing receipts", t => {
  const { storage } = storageFixture(t), rootId = randomUUID();
  const root = new WorkspaceTreeBudget(storage, rootId, INTERACTIVE_WORKSPACE_RUN_BUDGET);
  root.consume({ modelCalls: 125, toolCalls: 400, inputTokens: 500000, outputTokens: 200000 });
  assert.doesNotThrow(() => root.assertResumeAdmission(root.read().usage));
  const child = new WorkspaceTreeBudget(storage, rootId, DEFAULT_WORKSPACE_RUN_BUDGET, true);
  assert.doesNotThrow(() => child.assertResumeAdmission({ ...emptyUsage(), modelCalls: 11 }));
  assert.throws(() => child.assertResumeAdmission({ ...emptyUsage(), modelCalls: 12 }), /run_rounds/);
  assert.throws(() => new WorkspaceTreeBudget(storage, randomUUID(), INTERACTIVE_WORKSPACE_RUN_BUDGET).assertResumeAdmission({ ...emptyUsage(), modelCalls: 1 }), /missing_tree_receipt/);
});

test("full receipt pages are read once and stay intact in the fresh model projection; ownership still gates reads", async t => {
  const a = hostFixture(t, () => ({ text: "Hello", toolUses: [], stop: "end" })), runId = randomUUID();
  const receipts = new WorkspaceContextReceipts(a.storage, runId, a.workspace.selectedAgentId, () => {});
  const full = { id: "source", name: "fixture_read", content: "x".repeat(18000) }, file = receipts.retain(full), id = file.slice(8, -5);
  const first = await receipts.tool().run({ id, offset: 0 }, {}), page = JSON.parse(first);
  assert.equal(page.content.length, WORKSPACE_RECEIPT_PAGE_CHARS); assert.equal(page.nextOffset, 12000);
  const history = [{ role: "user", content: "Read the reference" }, { role: "assistant", text: "", toolUses: [{ id: "page", name: "workspace_receipt_read", input: { id, offset: 0 } }] },
    { role: "tool", results: [{ id: "page", name: "workspace_receipt_read", content: first }] }];
  const projection = workspaceTaskProjection(history, 0, { retain() { throw new Error("must not recursively retain a complete page"); } });
  assert.equal(projection.history[2].results[0].content, first);
  const second = JSON.parse(await receipts.tool().run({ id, offset: page.nextOffset }, {}));
  assert.equal(second.nextOffset, null); assert.deepEqual(JSON.parse(page.content + second.content), full);
  await assert.rejects(new WorkspaceContextReceipts(a.storage, randomUUID(), a.workspace.selectedAgentId, () => {}).tool().run({ id, offset: 0 }, {}), /ownership/);
});


test("scheduled dispatch and interactive colleague chats receive distinct frozen policies", async t => {
  const a = hostFixture(t, () => ({ text: "Hello", toolUses: [], stop: "end" }));
  const context = a.host.context(a.workspace.workspaceId);
  const scheduled = a.host.start("client", a.workspace.workspaceId, a.workspace.selectedAgentId, "Hello on a schedule", randomUUID(), false,
    undefined, undefined, ui, undefined, undefined, context.connections.capture());
  await a.host.wait(scheduled.runId); assert.deepEqual(store(a).read().task.workspaceRunBinding.budget, DEFAULT_WORKSPACE_RUN_BUDGET);
  const colleague = context.resources.agents.create({ username: "interactive-peer", profile: { displayName: "Interactive Peer" }, instructions: "Reply to the user" }, context.resources.agents.list().revision);
  context.resources.agents.setPermissionTier(colleague.agentId, "controlled", colleague.configRevision, colleague.agentEpoch);
  const direct = a.host.start("client", a.workspace.workspaceId, colleague.agentId, "Hello", randomUUID(), false, undefined, undefined, ui);
  await a.host.wait(direct.runId);
  const binding = new WorkspaceConversationStore(a.storage, colleague.agentId).read().task.workspaceRunBinding;
  assert.equal(binding.budget.mode, "interactive");
  assert.throws(() => freezeWorkspaceRunBinding({ ...binding, lineage: { rootRunId: randomUUID(), parentRunId: randomUUID(), depth: 1 } }), /invalid/);
});
