import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceOperationSkill } from "../../dist/workspace/operation-cards.js";
import { cliMcpFixture, until } from "./workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const starts = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
async function exchange(f, text) { await f.send(text); return until(f.read, done); }

const threadState = f => {
  const name = fs.readdirSync(f.root, { recursive: true }).find(name => /(?:^|\/)codex-thread-[a-f0-9]+\.json$/.test(name));
  return JSON.parse(fs.readFileSync(join(f.root, name), "utf8"));
};
const diagnostic = view => {
  const match = /hara_runtime_failure_v1=(\{[^\n]+?\})(?: \u2014|$)/.exec(view.conversation.blockReason);
  assert(match, "one controlled failure envelope"); return JSON.parse(match[1]);
};

export function registerCases(selected) {
if (selected.includes(0)) test("a delayed old-thread restore after Core restart completes in the same thread with fresh governance and provenance", async t => {
  const f = await cliMcpFixture(t, "list");
  const before = await exchange(f, "List colleagues BEFORE-CORE-RESTART?");
  assert.equal(before.conversation.state, "completed", before.conversation.blockReason);
  const saved = threadState(f), priorStage = before.conversation.runtimeStages.at(-1);
  assert.match(priorStage.provenance.startedAt, /^\d{4}-/);
  await f.restart(); f.mode({ mode: "list", resumeDelayMs: 250 });
  const next = await exchange(f, "List colleagues AFTER-CORE-RESTART?");
  assert.equal(next.conversation.state, "completed", next.conversation.blockReason);
  assert.equal(threadState(f).threadId, saved.threadId);
  const stage = next.conversation.runtimeStages.at(-1);
  assert.notEqual(stage.provenance.coreInstanceId, priorStage.provenance.coreInstanceId);
  assert.ok(stage.provenance.startedAt > priorStage.provenance.startedAt);
  assert.equal(next.conversation.runtimeStages.find(row => row.attemptId === priorStage.attemptId).provenance.startedAt, priorStage.provenance.startedAt);
  assert.equal(starts(f).filter(row => row.method === "thread/start").length, 1);
  assert.doesNotMatch(f.native().filter(row => row.method === "turn/start").at(-1).params.input[0].text, /BEFORE-CORE-RESTART/);
});

if (selected.includes(1)) test("silent thread/resume timeout after Core restart settles with its deadline, releases ownership and requires manual recovery", async t => {
  const f = await cliMcpFixture(t, "list"); await exchange(f, "List colleagues ORIGINAL-HISTORY?");
  assert.equal((await f.read()).conversation.state, "completed", (await f.read()).conversation.blockReason);
  const saved = threadState(f); await f.restart(); f.mode({ mode: "list", resumeHang: true });
  const failed = await exchange(f, "List colleagues MANUALLY-RESTORED?");
  assert.equal(failed.conversation.state, "blocked");
  assert.equal(failed.conversation.nativeSession.status, "recovery_needed");
  const info = diagnostic(failed);
  assert.equal(info.kind, "timeout"); assert.equal(info.rpcMethod, "thread/resume"); assert.equal(info.rpcTimeoutMs, 10000);
  assert.equal(info.errorFirstLine, undefined, "no fabricated upstream/network explanation when stderr is empty");
  assert.equal(threadState(f).threadId, saved.threadId); assert.equal(threadState(f).phase, "unknown");
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 1);
  const stage = failed.conversation.runtimeStages.at(-1);
  assert.equal(stage.errorKind, "timeout");
  assert.equal(stage.events.find(row => row.kind === "model_roundtrip" && row.phase === "end").errorKind, "timeout");
  assert.throws(() => process.kill(starts(f).at(-1).pid, 0), { code: "ESRCH" }, "owned native process exited before blocked is published");
  f.mode("list"); await f.restart();
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 1, "restart does not retry a paid turn");
  const receipt = await f.request("workspace.session.resume", { ...f.scope, agentId: f.main.agentId, message: "/continue", source: "ui", requestId: randomUUID() });
  const recovered = await until(f.read, done);
  assert.equal(receipt.runId, failed.conversation.runId);
  assert.equal(recovered.conversation.state, "completed", recovered.conversation.blockReason);
  assert.equal(recovered.conversation.runUsage.modelCalls, failed.conversation.runUsage.modelCalls + 2, "manual recovery retains the frozen run budget and prior usage");
  assert.equal(recovered.conversation.runtimeStages.find(row => row.attemptId === stage.attemptId).errorKind, "timeout", "historical failure is never rewritten");
  assert.equal(threadState(f).threadId, saved.threadId);
  assert.equal(starts(f).filter(row => row.method === "thread/start").length, 1);
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 2);
  assert.ok(JSON.stringify(recovered.conversation.history).includes("ORIGINAL-HISTORY"));
});

if (selected.includes(2)) test("new creation after an old native conversation reaches the first card with complete version-locked instructions at the RPC boundary", async t => {
  const f = await cliMcpFixture(t, "list"); const before = await exchange(f, "List colleagues HISTORICAL-CHECKPOINT?");
  assert.equal(before.conversation.state, "completed", before.conversation.blockReason);
  f.mode("create-direct"); const sent = await f.send("Create a colleague for the video project");
  const pending = await until(f.read, view => view.approvals.some(card => card.kind === "agent_create"));
  const skill = workspaceOperationSkill(), card = skill.files["cards/create-colleague.md"];
  const resumed = starts(f).at(-1), currentTurn = f.native().filter(row => row.method === "turn/start").at(-1);
  assert.equal(resumed.method, "thread/resume");
  assert.equal(resumed.params.developerInstructions.includes(card), true);
  assert.equal(resumed.params.developerInstructions.split(card).length - 1, 1);
  assert.equal(currentTurn.params.input[0].text.includes(card), true, "standing refresh reaches the actual native input");
  assert.equal(resumed.params.developerInstructions.includes(skill.version), true);
  assert.match(resumed.params.developerInstructions, /FIRST model response/);
  assert.doesNotMatch(resumed.params.developerInstructions, /via workspace_skill before using|load every page of instructions via workspace_skill before acting/);
  assert.doesNotMatch(currentTurn.params.input[0].text, /HISTORICAL-CHECKPOINT/);
  assert.equal(pending.conversation.runUsage.modelCalls, 1);
  assert.equal(pending.agents.length, 1, "only a proposal, not creation authority");
  const approval = pending.approvals.find(card => card.kind === "agent_create");
  await f.request("workspace.approval.respond", { ...f.scope, approvalId: approval.id, approved: false });
  await until(f.read, done);
  assert.equal((await f.read()).agents.length, 1); assert.equal(sent.runId, pending.conversation.runId);
});

}
