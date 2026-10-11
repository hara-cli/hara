import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, features, nativeId, cardEvents, projection } from "./fixtures/colleague-host.mjs";

test("two colleague hops return a single-use permission and structured question to the initiating chat", { timeout: 40_000 }, async (t) => {
  const f = await fixture(t, { mode: "write" }), approval = await f.client.event("agent.approval.request");
  assert.equal(approval.parentSessionId, f.parent); assert.equal(approval.executorAgentRef, "global:coder"); assert.equal(approval.executorDisplayName, "Cora");
  assert.equal(approval.agentPath, "/root/global:manager/global:coder"); assert.equal(approval.interactionKind, "agent");
  assert.equal(approval.allowAlways, false); assert.notEqual(approval.sessionId, f.parent);
  assert.equal(existsSync(join(f.repo, "approved.txt")), false);
  const snapshot = (await f.client.call("events.snapshot", { sessionIds: [f.parent] })).result;
  assert.deepEqual(snapshot.agentApprovals, [projection(approval)]); assert.deepEqual(snapshot.approvals, []);
  const childSnapshot = (await f.client.call("events.snapshot", { sessionIds: [approval.sessionId] })).result;
  assert.deepEqual(childSnapshot.agentApprovals, []);
  assert.ok(childSnapshot.taskStates.every((state) => state.approval === undefined), "child task snapshots cannot synthesize a legacy approval card");
  assert.deepEqual((await f.client.call("session.resume", { sessionId: approval.sessionId })).result.pendingApprovals, [],
    "foreground child resume cannot duplicate the original chat's delegated approval");
  const legacy = await f.attach(features.filter((feature) => feature !== "agent.delegated-interaction.v1"));
  const legacySnapshot = (await legacy.call("events.snapshot", { sessionIds: [f.parent, approval.sessionId] })).result;
  assert.equal(legacySnapshot.agentApprovals, undefined);
  assert.ok(legacySnapshot.taskStates.every((state) => state.approval === undefined));
  assert.deepEqual((await legacy.call("session.resume", { sessionId: approval.sessionId })).result.pendingApprovals, []);
  await legacy.call("events.replay", { streamId: approval.deliveryCursor.streamId, after: approval.deliveryCursor.sequence - 1 });
  assert.equal(legacy.events.some((event) => cardEvents.includes(event.method)), false);
  assert.equal((await f.client.call("approval.reply", { approvalId: approval.approvalId, allow: true })).error.code, -32005);
  const decision = { approvalId: approval.approvalId, sessionId: approval.sessionId, turnId: approval.turnId, allow: true, commandId: randomUUID() };
  assert.equal((await f.client.call("agent.approval.reply", { ...decision, forTask: true })).error.code, -32602);
  assert.equal((await f.client.call("agent.approval.reply", { ...decision, turnId: randomUUID(), commandId: randomUUID() })).error.code, -32005);
  assert.equal((await f.client.call("agent.approval.reply", decision)).error, undefined);
  assert.equal((await f.client.call("agent.approval.reply", decision)).error, undefined);
  const input = await f.client.event("agent.question.request"); assert.equal(input.parentSessionId, f.parent); assert.equal(input.executorDisplayName, "Cora");
  assert.equal(readFileSync(join(f.repo, "approved.txt"), "utf8"), "only after approval\n");
  assert.equal(input.sessionId, approval.sessionId); assert.equal(input.turnId, approval.turnId);
  const answer = { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId, answers: { decision: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("agent.question.reply", answer)).error, undefined);
  assert.equal((await f.client.call("agent.question.reply", answer)).error, undefined);
  assert.equal((await f.sending).error, undefined);
  assert.equal(f.observations.find((entry) => entry.name === "coder").results.find((result) => result.name === "ask_user").content, "B");
  assert.equal(f.client.events.some((event) => event.method === "approval.request" && event.params.sessionId === approval.sessionId), false);
});

test("a colleague's native coding worker keeps the initiating chat and real colleague identity", { timeout: 40_000 }, async (t) => {
  const f = await fixture(t, { mode: "coding" }), launch = await f.client.event("agent.approval.request");
  assert.equal(launch.executorDisplayName, "Cora");
  assert.equal((await f.client.call("agent.approval.reply", { approvalId: launch.approvalId, sessionId: launch.sessionId, turnId: launch.turnId, allow: true, commandId: randomUUID() })).error, undefined);
  const approval = await f.client.event("external.approval.request");
  assert.equal(approval.parentSessionId, f.parent); assert.equal(approval.executorAgentRef, "global:coder");
  assert.equal(approval.agentPath, "/root/global:manager/global:coder/implementation"); assert.equal(approval.sessionId, nativeId);
  const legacy = await f.attach(features.filter((feature) => feature !== "agent.delegated-interaction.v1"));
  assert.deepEqual((await legacy.call("events.snapshot", { sessionIds: [f.parent] })).result.approvals, []);
  await legacy.call("events.replay", { streamId: approval.deliveryCursor.streamId, after: approval.deliveryCursor.sequence - 1 });
  assert.equal(legacy.events.some((event) => event.method === "external.approval.request"), false);
  const controller = await f.attach(), controlLease = (await controller.call("session.control.acquire", { sessionId: f.parent })).result.lease;
  const decision = { approvalId: approval.approvalId, sessionId: nativeId, turnId: approval.turnId, allow: false, commandId: randomUUID() };
  assert.equal((await legacy.call("external.approval.reply", { ...decision, commandId: randomUUID() })).error.code, -32001);
  assert.equal((await f.client.call("external.approval.reply", decision)).error.code, -32005);
  assert.equal((await controller.call("external.approval.reply", { ...decision, commandId: randomUUID(), controlLease })).error, undefined);
  const input = await f.client.event("external.question.request"); assert.equal(input.parentSessionId, f.parent); assert.equal(input.executorDisplayName, "Cora");
  assert.deepEqual((await legacy.call("events.snapshot", { sessionIds: [f.parent] })).result.externalQuestions, []);
  const answer = { questionId: input.questionId, sessionId: nativeId, turnId: input.turnId,
    answers: { scope: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("external.question.reply", answer)).error.code, -32005);
  assert.equal((await controller.call("external.question.reply", { ...answer, commandId: randomUUID(), controlLease })).error, undefined);
  assert.equal((await f.sending).error, undefined); assert.equal(f.submitted(), 1);
  assert.ok(f.observations.some((entry) => entry.nativeApproval === false)); assert.ok(f.observations.some((entry) => entry.nativeAnswers?.scope?.answers[0] === "B"));
});
