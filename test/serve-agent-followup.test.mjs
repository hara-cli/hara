import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processAgentFollowupDelivery } from "../dist/gateway/agent-followup.js";
import { fixture } from "./fixtures/colleague-host.mjs";

test("a named colleague owns authorized Feishu replies and returns decisions and closure without a main-Agent hop", { timeout: 40_000 }, async (t) => {
  // Even a full-auto parent cannot grant this scope silently or let a group bypass fresh file approval.
  const f = await fixture(t, { mode: "followup", approvalMode: "full-auto" });
  const grantCard = await f.client.event("agent.approval.request", (p) => p.question.includes("Feishu thread"));
  assert.equal(grantCard.parentSessionId, f.parent); assert.equal(grantCard.executorDisplayName, "Cora");
  assert.equal(f.followups.list(f.parent).length, 0);
  const approved = await f.client.call("agent.approval.reply", { approvalId: grantCard.approvalId, sessionId: grantCard.sessionId,
    turnId: grantCard.turnId, allow: true, commandId: randomUUID() });
  assert.ok(approved.result, JSON.stringify(approved)); assert.ok((await f.sending).result);
  const [grant] = f.followups.list(f.parent); assert.equal(grant.agentRef, "global:coder"); assert.equal(grant.sessionId, grantCard.sessionId);
  const message = { chatId: "oc_fixture", userId: "ou_fixture", userName: "Fixture owner", text: "Write the fixture and ask me which option.",
    messageId: "om_fixture_followup", createdAtMs: Date.now(), senderType: "user", chatType: "group",
    replyContext: { valid: true, rootMessageId: "om_fixture_root", parentMessageId: "om_fixture_root" } };
  assert.equal(f.followups.admit("feishu-fixture", message, true), "queued");
  const writeCard = await f.client.event("agent.approval.request", (p) => p.approvalId !== grantCard.approvalId);
  assert.equal(writeCard.parentSessionId, f.parent); assert.equal(writeCard.sessionId, grant.sessionId);
  assert.equal(existsSync(join(f.repo, "followup.txt")), false);
  assert.ok((await f.client.call("agent.approval.reply", { approvalId: writeCard.approvalId, sessionId: writeCard.sessionId,
    turnId: writeCard.turnId, allow: true, commandId: randomUUID() })).result);
  const choice = await f.client.event("agent.question.request");
  assert.equal(choice.parentSessionId, f.parent); assert.equal(choice.executorDisplayName, "Cora");
  assert.ok((await f.client.call("agent.question.reply", { questionId: choice.questionId, sessionId: choice.sessionId,
    turnId: choice.turnId, answers: { decision: { answers: ["B"] } }, commandId: randomUUID() })).result);
  const deadline = Date.now() + 10_000;
  while (f.followups.receipts(f.parent)[0]?.status !== "complete" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  assert.equal(f.followups.receipts(f.parent)[0]?.status, "complete");
  assert.equal(readFileSync(join(f.repo, "followup.txt"), "utf8"), "explicit follow-up approval\n");
  const sent = [];
  await processAgentFollowupDelivery({ name: "feishu", reply: async (...args) => sent.push(args) }, "feishu-fixture", new AbortController().signal, f.followups);
  assert.equal(sent.length, 1); assert.equal(sent[0][1], message.messageId);
  assert.equal(f.followups.admit("feishu-fixture", message, true), "duplicate");
  // Initial main/manager contacts ran once. The queued event was handled by Cora directly.
  assert.equal(f.observations.filter((record) => record.name === "architect").length, 1);
  assert.equal(f.observations.filter((record) => record.name === "manager").length, 1);
});

for (const stopKind of ["disconnect", "control-change", "interrupt", "policy-change"]) {
  test(`a live follow-up is paused on ${stopKind}; queued work cannot resume through a new socket`, { timeout: 30_000 }, async (t) => {
    const f = await fixture(t, { mode: "followup" });
    const card = await f.client.event("agent.approval.request", (p) => p.question.includes("Feishu thread"));
    assert.ok((await f.client.call("agent.approval.reply", { approvalId: card.approvalId, sessionId: card.sessionId,
      turnId: card.turnId, allow: true, commandId: randomUUID() })).result);
    assert.ok((await f.sending).result);
    const grant = f.followups.list(f.parent)[0]; assert.equal(grant.status, "active");
    if (stopKind === "disconnect") f.client.ws.close();
    else if (stopKind === "control-change") {
      const observer = await f.attach(); assert.ok((await observer.call("session.control.acquire", { sessionId: f.parent })).result);
    } else if (stopKind === "policy-change") assert.ok((await f.client.call("settings.computer.save", { mode: "off", apps: [] })).result);
    else assert.ok((await f.client.call("session.interrupt", { sessionId: f.parent })).result);
    const deadline = Date.now() + 5_000;
    while (f.followups.get(grant.id).status === "active" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    assert.equal(f.followups.get(grant.id).status, "paused");
    const observer = await f.attach(); assert.ok((await observer.call("session.resume", { sessionId: f.parent })).result);
    assert.equal(f.followups.get(grant.id).status, "paused");
    assert.equal(f.followups.admit("feishu-fixture", { chatId: "oc_fixture", userId: "ou_fixture", userName: "Fixture owner",
      text: "Do not run this after authority changed", messageId: "om_after_stop", createdAtMs: Date.now(), chatType: "group", senderType: "user",
      replyContext: { valid: true, rootMessageId: "om_fixture_root" } }, true), "blocked");
    assert.equal(existsSync(join(f.repo, "followup.txt")), false);
  });
}
