import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { routingFixture } from "./helpers/agent-routing-fixture.mjs";
import { WorkspaceAgentRouting } from "../dist/workspace/agent-routing.js";
import { AgentRoutingClassifier } from "../dist/workspace/agent-routing-classification.js";
import { commandDigest } from "../dist/workspace/agent-command-state.js";
const config = invoke => ({ providerRef: "synthetic-origin-v1", budgetRef: "routing-fixture", timeoutMs: 1000, maxInputBytes: 8192, maxOutputTokens: 64, invoke });
const reply = candidateId => ({ text: JSON.stringify({ candidateId }), toolUses: [], providerRequestRef: null });
function permit(f, cfg) {
  const data = f.input("unmatched authorized request"), row = f.router.select(f.transport, data), snapshot = f.authority.routingSnapshot(f.transport);
  const payload = { schemaVersion: 1, message: data.message, candidates: f.router.directory(f.transport, data.channelId).map(row => ({ agentId: row.agentId, publicProfile: row.publicProfile })) };
  const entry = { providerRef: cfg.providerRef, budgetRef: cfg.budgetRef, timeoutMs: cfg.timeoutMs, maxInputBytes: cfg.maxInputBytes, maxOutputTokens: cfg.maxOutputTokens,
    requestId: randomUUID(), maxCalls: 1, inputDigest: commandDigest(payload), catalogDigest: row.catalogDigest, startedAt: new Date().toISOString(), phase: "submission_started", candidateId: null, responseDigest: null, providerRequestRef: null };
  return f.authority.beginRoutingClassification(f.transport, snapshot.revision, row.workKey, row.revision, entry, payload, () => {});
}

test("C6 the genuine RoutingPermit cannot be consumed twice even while its durable request remains pending", async t => {
  const f = routingFixture(t); let calls = 0;
  const cfg = config(async () => { calls++; return reply(f.agent.agentId); }), classifier = new AgentRoutingClassifier(f.authority, cfg); t.after(() => classifier.close());
  const handle = permit(f, cfg); assert.equal((await classifier.run(handle)).phase, "completed");
  await assert.rejects(() => classifier.run(handle), error => error.code === "AUTHORITY_UNVERIFIED"); assert.equal(calls, 1);
});

test("C6 the actual provider boundary independently refuses a second use of the original submitted permit", t => {
  const f = routingFixture(t), cfg = config(async () => reply(f.agent.agentId)), handle = permit(f, cfg);
  f.authority.consumeRoutingPermit(handle); f.authority.submitRoutingPermit(handle);
  assert.throws(() => f.authority.submitRoutingPermit(handle), error => error.code === "AUTHORITY_UNVERIFIED");
});

test("C6 adapter itself rejects extra output fields, outside candidates and tools before an observation is published", async t => {
  const f = routingFixture(t); let answer;
  const cfg = config(async () => answer), classifier = new AgentRoutingClassifier(f.authority, cfg); t.after(() => classifier.close());
  for (answer of [reply("outside"), { ...reply(f.agent.agentId), text: JSON.stringify({ candidateId: f.agent.agentId, reason: "approved" }) }, { ...reply(f.agent.agentId), toolUses: [{ name: "exec" }] }]) {
    const handle = permit(f, cfg), result = await classifier.run(handle); assert.equal(result.phase, "failed"); assert.equal(result.candidateId, null);
  }
  assert.equal(f.snapshot().control.runs.length, 0);
});

test("C6 the persisted transition cannot reopen a classification with final UNKNOWN for another purchase", async t => {
  const f = routingFixture(t); let calls = 0;
  const router = new WorkspaceAgentRouting({ ...f.options, classifier: config(async () => { calls++; throw new Error("accepted outcome unknown"); }) }); t.after(() => router.close());
  const data = f.input("unmatched request"); await router.classify(f.transport, data);
  const snapshot = f.authority.routingSnapshot(f.transport), before = fs.readFileSync(f.file, "utf8"); assert.equal(snapshot.routing.records[0].classification.phase, "unknown");
  assert.throws(() => f.authority.mutateRouting(f.transport, snapshot.revision, routing => {
    routing.records[0].classification.phase = "submission_started"; routing.records[0].revision++; routing.sequence++; return routing;
  }), error => error.field === "routing.classification");
  assert.equal(fs.readFileSync(f.file, "utf8"), before); await router.classify(f.transport, data); assert.equal(calls, 1);
});

test("C6 the persisted owner transition refuses dropping an existing claim for another proposed owner", t => {
  const f = routingFixture(t), data = f.input(); f.router.select(f.transport, data); const d = f.prepare(data); d.accept();
  const snapshot = f.authority.routingSnapshot(f.transport), before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => f.authority.mutateRouting(f.transport, snapshot.revision, routing => {
    const row = routing.records[0]; row.ownerAgentId = f.members[1].agentId; row.state = "selected"; row.method = "explicit_human"; row.reason = "selected"; row.claim = null; row.revision++; routing.sequence++; return routing;
  }), error => error.field === "routing.claim");
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.snapshot().control.runs[0].runId, d.binding.runId);
});
