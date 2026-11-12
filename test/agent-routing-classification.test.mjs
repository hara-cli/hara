import { agentPolicyProposalDigest } from "../dist/workspace/agent-command-state.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceAgentRouting } from "../dist/workspace/agent-routing.js";
import { AgentRoutingClassifier } from "../dist/workspace/agent-routing-classification.js";
import { routingFixture } from "./helpers/agent-routing-fixture.mjs";
const config = invoke => ({ providerRef: "single-origin-v1", budgetRef: "routing-budget-v1", timeoutMs: 1000, maxInputBytes: 16384, maxOutputTokens: 128, invoke });
const reply = candidateId => ({ text: JSON.stringify({ candidateId }), toolUses: [], providerRequestRef: "request-fixture" });
function router(t, f, cfg) { const r = new WorkspaceAgentRouting({ ...f.options, classifier: cfg }); t.after(() => r.close()); return r; }

test("C6 RoutingPermit invokes one no-tool public-duty adapter and never calls it business_mapping", async t => {
  const f = routingFixture(t); let calls = 0;
  const r = router(t, f, config(async request => {
    calls++; assert.deepEqual(request.tools, []); assert.equal(request.maxOutputTokens, 128); assert.equal(request.providerRef, "single-origin-v1"); assert.ok(request.requestId);
    assert.equal(request.payload.candidates.length, 3);
    for (const candidate of request.payload.candidates) assert.deepEqual(Object.keys(candidate.publicProfile).sort(), ["description", "owns", "rejects", "title"]);
    assert.ok(!JSON.stringify(request.payload).includes("instructions")); return reply(f.agent.agentId);
  }));
  const data = f.input("reconcile this receipt"), selected = await r.classify(f.transport, data);
  assert.equal(calls, 1); assert.equal(selected.state, "selected"); assert.equal(selected.method, "classification"); assert.equal(selected.decision, null); assert.equal(selected.executionPermit, false); assert.equal(f.snapshot().control.runs.length, 0);
  const d = f.prepare(data, r); d.accept(); const owned = r.get(f.transport, data.channelId, data.workItemId);
  assert.equal(owned.method, "classification"); assert.equal(owned.decision.reason, "current_owner"); assert.notEqual(owned.decision.reason, "business_mapping");
});

test("C6 disabled classification and deterministic ties never call a model or pick the first candidate", async t => {
  const f = routingFixture(t); let calls = 0; const r = router(t, f, config(async () => { calls++; return reply(f.agent.agentId); }));
  assert.equal((await f.router.classify(f.transport, f.input("unknown"))).state, "needs_owner");
  assert.equal((await r.classify(f.transport, f.input("invoice compile"))).state, "needs_owner");
  assert.equal((await r.classify(f.transport, f.input("unknown", { explicitAgentIds: f.members.slice(0, 2).map(r => r.agentId) }))).state, "needs_owner"); assert.equal(calls, 0);
  const huge = router(t, f, { ...config(async () => { calls++; return reply(f.agent.agentId); }), maxInputBytes: 128 });
  assert.equal((await huge.classify(f.transport, f.input("unknown"))).state, "needs_owner"); assert.equal(calls, 0);
});

test("C6 malformed, outside-candidate, multi-answer and tool results stay NEEDS_OWNER without another call", async t => {
  const f = routingFixture(t); let calls = 0, answer; const r = router(t, f, config(async () => { calls++; return answer; }));
  for (answer of [reply("outside"), { ...reply(f.agent.agentId), text: "first role please" }, { ...reply(f.agent.agentId), text: JSON.stringify({ candidateId: f.agent.agentId, reason: "business_mapping" }) },
    { ...reply(f.agent.agentId), text: JSON.stringify({ candidateId: f.members.map(r => r.agentId) }) }, { ...reply(f.agent.agentId), toolUses: [{ name: "exec" }] }]) {
    const data = f.input("unknown"), before = calls, result = await r.classify(f.transport, data); assert.equal(result.state, "needs_owner"); assert.equal(calls, before + 1);
    await r.classify(f.transport, data); assert.equal(calls, before + 1); assert.equal(f.snapshot().control.runs.length, 0);
  }
});

test("C6 two routing objects cannot spend twice for one root; cold reads never mint another permit", async t => {
  const f = routingFixture(t); let calls = 0, finish;
  const cfg = config(async () => { calls++; return new Promise(resolve => { finish = resolve; }); }), r = router(t, f, cfg), other = router(t, f, cfg), data = f.input("unknown");
  const first = r.classify(f.transport, data); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  const observed = await other.classify(f.transport, data); assert.equal(observed.classification.phase, "unknown"); assert.equal(calls, 1);
  finish(reply(f.agent.agentId)); assert.equal((await first).state, "selected"); assert.equal(calls, 1);
  await other.classify(f.transport, data); assert.equal(calls, 1);
  const raw = new AgentRoutingClassifier(f.authority, cfg); t.after(() => raw.close());
  await assert.rejects(() => raw.run({ approved: true }), error => error.code === "AUTHORITY_UNVERIFIED"); assert.equal(calls, 1);
});

test("C6 timeout/late reply/restart retain original UNKNOWN identity and never repurchase", async t => {
  const f = routingFixture(t); let calls = 0, finish;
  const cfg = { ...config(async () => { calls++; return new Promise(resolve => { finish = resolve; }); }), timeoutMs: 20 }, r = router(t, f, cfg), data = f.input("unknown");
  const unknown = await r.classify(f.transport, data); assert.equal(unknown.state, "needs_owner"); assert.equal(unknown.classification.phase, "unknown"); assert.equal(calls, 1);
  const requestId = unknown.classification.requestId, reopened = router(t, f, cfg);
  assert.equal((await reopened.classify(f.transport, data)).classification.requestId, requestId); assert.equal(calls, 1);
  await reopened.classify(f.transport, { ...data, requestId: randomUUID(), expectedWorkRevision: unknown.revision }); assert.equal(calls, 1);
  finish(reply(f.agent.agentId)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened.get(f.transport, data.channelId, data.workItemId).state, "needs_owner"); assert.equal(reopened.get(f.transport, data.channelId, data.workItemId).classification.requestId, requestId);
});

test("C6 stale audience cannot accept a late classification, and a manual owner is never replaced", async t => {
  const f = routingFixture(t); let finish;
  const r = router(t, f, config(async () => new Promise(resolve => { finish = resolve; }))), data = f.input("unknown");
  const pending = r.classify(f.transport, data); await new Promise(resolve => setImmediate(resolve));
  const current = r.get(f.transport, data.channelId, data.workItemId), choose = { ...data, requestId: randomUUID(), expectedWorkRevision: current.revision, explicitAgentIds: [f.members[1].agentId] };
  const selected = r.select(f.transport, choose); assert.equal(selected.ownerAgentId, f.members[1].agentId);
  finish(reply(f.agent.agentId)); const result = await pending; assert.equal(result.ownerAgentId, f.members[1].agentId); assert.equal(result.method, "explicit_human");
  assert.equal(f.snapshot().routing.records[0].classification.phase, "completed");
  const nextData = f.input("unknown again"); const next = r.classify(f.transport, nextData); await new Promise(resolve => setImmediate(resolve)); f.changeAudience({ memberIds: [f.members[1].agentId] });
  finish(reply(f.agent.agentId)); const stale = await next; assert.equal(stale.state, "needs_owner"); assert.equal(stale.reason, "stale"); assert.equal(f.snapshot().control.runs.length, 0);
});


test("C6 exhausted routing counters refuse new classification without corrupting a healthy source", async t => {
  const f = routingFixture(t); let calls = 0; const r = router(t, f, config(async () => { calls++; return reply(f.agent.agentId); })), data = f.input("unknown");
  r.select(f.transport, data); const state = f.snapshot(); state.routing.sequence = Number.MAX_SAFE_INTEGER;
  const fs = await import("node:fs"); fs.writeFileSync(f.file, JSON.stringify(state) + "\n");
  await assert.rejects(() => r.classify(f.transport, data), error => error.code === "COUNTER_EXHAUSTED");
  assert.equal(calls, 0); assert.equal(f.authority.commandControlSourceHealthy(), true); assert.equal(f.snapshot().routing.records[0].classification, null);
});

test("C6 classifier cancellation preserves UNKNOWN while the physical adapter is still pending", async t => {
  const f = routingFixture(t); let calls = 0, finish;
  const cfg = config(async () => { calls++; return new Promise(resolve => { finish = resolve; }); }), r = router(t, f, cfg), data = f.input("unmatched authorized request");
  const pending = r.classify(f.transport, data); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(r.pendingClassificationTurns(), 1);
  r.close(); const result = await pending; assert.equal(result.classification.phase, "unknown"); assert.equal(result.code, "NEEDS_OWNER"); assert.equal(r.pendingClassificationTurns(), 1);
  const next = router(t, f, cfg); await next.classify(f.transport, data); assert.equal(calls, 1);
  finish(reply(f.agent.agentId)); await new Promise(resolve => setImmediate(resolve)); assert.equal(r.pendingClassificationTurns(), 0);
  assert.equal(next.get(f.transport, data.channelId, data.workItemId).classification.phase, "unknown"); assert.equal(f.snapshot().control.runs.length, 0);
});


test("C6 classification redacts every public duty field and message without changing confirmed C0 duties", async t => {
  const f = routingFixture(t), view = f.authority.view(f.transport, f.agent.agentId), secret = label => `sk-${label}-${"x".repeat(32)}`;
  const profile = { title: "Finance " + secret("title"), description: "Public responsibility " + secret("description"), owns: ["invoice", secret("owns")], rejects: ["publish", secret("rejects")] };
  const duty = structuredClone(view.policy.duty); duty.dutyRevision++; duty.publicProfile = profile;
  const proposal = { duty, boundary: view.policy.boundary, rights: view.policy.rights };
  const command = f.authority.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
    operation: { action: "duty.update", proposedDutyDigest: agentPolicyProposalDigest(proposal) } });
  const begun = f.control.begin(f.transport, command, { proposal }); assert.equal(f.control.accept(begun.intake).status, "applied");
  let payload, calls = 0;
  const r = router(t, f, config(async request => { calls++; payload = request.payload; return reply(f.agent.agentId); }));
  const result = await r.classify(f.transport, f.input("new authorized request " + secret("message"))); assert.equal(result.state, "selected"); assert.equal(calls, 1);
  const serialized = JSON.stringify(payload);
  for (const field of ["title", "description", "owns", "rejects", "message"]) assert.equal(serialized.includes(secret(field)), false, `raw ${field} credential must not leave for classification`);
  assert.ok(serialized.includes("sk-***")); assert.deepEqual(f.authority.view(f.transport, f.agent.agentId).policy.duty.publicProfile, profile);
});
