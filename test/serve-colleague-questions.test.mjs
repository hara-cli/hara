import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, features, cardEvents, projection } from "./fixtures/colleague-host.mjs";

test("a compatible reconnect restores only the original parent question, deadline and executor", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request");
  await new Promise((done) => { f.client.ws.once("close", done); f.client.ws.close(); });
  const client = await f.attach();
  assert.deepEqual((await client.call("events.snapshot", { sessionIds: [f.parent] })).result.agentQuestions, [projection(input)]);
  assert.deepEqual((await client.call("events.snapshot", { sessionIds: [input.sessionId] })).result.agentQuestions, []);
  assert.equal((await client.call("agent.question.reply", { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["B"] } }, commandId: randomUUID() })).error, undefined);
  await client.event("agent.question.resolved");
});

test("root cancellation resolves colleague input and a late answer cannot execute it", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request");
  assert.equal((await f.client.call("session.interrupt", { sessionId: f.parent })).error, undefined);
  await f.sending; const resolution = await f.client.event("agent.question.resolved"); assert.equal(resolution.outcome, "interrupted");
  assert.equal((await f.client.call("agent.question.reply", { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["B"] } }, commandId: randomUUID() })).error.code, -32005);
});

test("question expiry selects no default even when the model supplied one", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { timeout: 120 }); await f.client.event("agent.question.request");
  assert.equal((await f.client.event("agent.question.resolved")).outcome, "timed_out"); await f.sending;
  const coder = [...f.records.values()].find(({ meta }) => meta.agentRef === "global:coder");
  assert.ok(coder.history.some((message) => message.results?.some((result) => result.name === "ask_user" && result.isError)));
  assert.equal(f.observations.some((entry) => entry.name === "coder"), false);
  const manager = [...f.records.values()].find(({ meta }) => meta.agentRef === "global:manager");
  const receipt = manager.history.flatMap((message) => message.results ?? []).find((result) => result.name === "agent_contact");
  assert.ok(receipt, "the immediate parent retains the colleague's actual handoff outcome");
  assert.ok(["paused", "failed"].includes(JSON.parse(receipt.content).status), "unanswered input cannot become a completed receipt");
});

test("legacy root turns cannot acquire colleague interaction consent from a later compatible observer", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { clientFeatures: features.filter((feature) => feature !== "agent.delegated-interaction.v1"), holdCoder: true });
  const observer = await f.attach(features); f.releaseCoder(); await f.sending;
  assert.equal([...f.client.events, ...observer.events].some((event) => cardEvents.includes(event.method)), false);
  const coder = [...f.records.values()].find(({ meta }) => meta.agentRef === "global:coder");
  assert.ok(coder.history.some((message) => message.results?.some((result) => result.name === "ask_user" && result.isError)));
});

test("cancelling a root awaiting colleague permission performs no write and refuses the late approval", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t, { mode: "write" }), approval = await f.client.event("agent.approval.request");
  assert.equal((await f.client.call("session.interrupt", { sessionId: f.parent })).error, undefined);
  await f.sending; assert.equal((await f.client.event("agent.approval.resolved")).outcome, "interrupted");
  assert.equal(existsSync(join(f.repo, "approved.txt")), false);
  assert.equal((await f.client.call("agent.approval.reply", { approvalId: approval.approvalId, sessionId: approval.sessionId,
    turnId: approval.turnId, allow: true, commandId: randomUUID() })).error.code, -32005);
});

test("colleague answers obey the initiating conversation's current input lease", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request"), controller = await f.attach();
  const lease = (await controller.call("session.control.acquire", { sessionId: f.parent })).result.lease;
  const answer = { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["B"] } }, commandId: randomUUID() };
  assert.equal((await f.client.call("agent.question.reply", answer)).error.code, -32005);
  assert.equal((await f.client.call("agent.question.reply", { ...answer, commandId: randomUUID(), controlLease: lease })).error.code, -32005);
  assert.equal((await controller.call("agent.question.reply", { ...answer, commandId: randomUUID(), controlLease: lease })).error, undefined);
  assert.equal((await f.sending).error, undefined);
});

test("a successful host policy change withdraws the old colleague card without choosing its default", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t), input = await f.client.event("agent.question.request");
  assert.equal((await f.client.call("settings.computer.save", { mode: "off", apps: [] })).error, undefined);
  assert.equal((await f.client.event("agent.question.resolved")).outcome, "interrupted");
  assert.equal((await f.client.call("agent.question.reply", { questionId: input.questionId, sessionId: input.sessionId, turnId: input.turnId,
    answers: { decision: { answers: ["A"] } }, commandId: randomUUID() })).error.code, -32005);
  await f.sending;
  assert.equal(f.observations.some((entry) => entry.name === "coder"), false);
});
