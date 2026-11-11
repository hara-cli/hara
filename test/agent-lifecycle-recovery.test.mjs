import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
import { AgentBoundaryContractError } from "../dist/workspace/agent-boundaries-contract.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { WorkspaceAgentCommandControl } from "../dist/workspace/agent-command-control.js";
import { commandDigest } from "../dist/workspace/agent-command-state.js";
import { freezeWorkspaceRunBinding } from "../dist/workspace/run-binding.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { closeWorkspaceRunPermit, workspaceRunDrainProof } from "../dist/workspace/execution.js";
const code = expected => error => error instanceof AgentBoundaryContractError && error.code === expected;
const get = (f, d) => f.snapshot().lifecycle.executions.find(row => row.runId === d.binding.runId);

test("C4 N5 post-accept grant expiry proves never-issued, releases only that preparation and preserves sibling effects", async t => {
  const f = lifecycleFixture(t), sibling = f.dispatch("healthy sibling"); sibling.accept(); const s = sibling.runtime();
  const d = f.dispatch("accepted but not issued"), admit = f.authority.admit.bind(f.authority);
  f.authority.admit = (transport, command) => { if (command.commandId === d.command.commandId) f.advance(60000); return admit(transport, command); };
  assert.equal(d.accept().status, "accepted");
  const row = get(f, d); assert.equal(row.phase, "aborted_before_execution"); assert.ok(row.terminal); assert.equal(row.issuanceRef, null); assert.equal(row.leaseReleased, true);
  assert.equal(f.snapshot().control.runs.find(run => run.runId === d.binding.runId).effect, "none");
  assert.equal(row.acceptedReceipt.status, "accepted"); assert.throws(() => d.lease.assertCurrent());
  assert.throws(() => f.control.executionGrant(d.binding.runId), code("CONTROL_HELD"));
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).status, "accepted");
  await s.call("workspace_write", { path: "sibling.txt", content: "survived N5" });
  assert.equal(fs.readFileSync(join(f.project, "sibling.txt"), "utf8"), "survived N5"); assert.equal(f.authority.commandControlSourceHealthy(), true);
});

test("C4 no-live, zero usage and JSON cannot terminate a run after capability issuance", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept();
  assert.throws(() => f.control.abortBeforeExecution({ approved: true, binding: d.binding }), code("AUTHORITY_UNVERIFIED"));
  const r = d.runtime(); assert.equal(get(f, d).phase, "issued");
  assert.throws(() => f.control.abortBeforeExecution(d.prepared), code("CONTROL_HELD")); assert.equal(get(f, d).terminal, null);
  assert.throws(() => f.control.draftRecovery(f.transport, f.agent.agentId, { operationId: randomUUID(), previousRunId: d.binding.runId, expectedClaimRevision: 1,
    commandId: randomUUID(), rootRequestId: randomUUID(), message: "not authorized by zero counters", lifetimeMs: 30000 }), code("CONTROL_HELD"));
  await closeWorkspaceRunPermit(r.permit); f.control.observeDrained(workspaceRunDrainProof(r.permit));
  assert.equal(get(f, d).phase, "issued"); assert.equal(get(f, d).terminal, null);
});

test("C4 N5 publication failure retains acceptance/owner and reconciles only the genuine original preparation", t => {
  const f = lifecycleFixture(t), d = f.dispatch(), admit = f.authority.admit.bind(f.authority), observe = f.authority.observeCommandControl.bind(f.authority);
  f.authority.admit = (transport, command) => { if (command.commandId === d.command.commandId) throw new AgentBoundaryContractError("AUTHORIZATION_DENIED", "fixture.after_accept"); return admit(transport, command); };
  f.authority.observeCommandControl = () => { throw new AgentBoundaryContractError("STALE_REVISION", "fixture.publication_cut"); };
  assert.equal(d.accept().status, "accepted"); d.lease.assertCurrent(); assert.equal(get(f, d).terminal, null);
  assert.throws(() => f.control.executionGrant(d.binding.runId), code("CONTROL_HELD"));
  f.authority.admit = admit; f.authority.observeCommandControl = observe;
  f.control.reconcileLifecycleObservations(f.transport, f.agent.agentId);
  assert.equal(get(f, d).phase, "aborted_before_execution"); assert.equal(get(f, d).leaseReleased, true); assert.throws(() => d.lease.assertCurrent());
  assert.equal(f.snapshot().control.commands.filter(row => row.command.commandId === d.command.commandId).length, 1);
});

test("C4 terminal publication precedes lease closure and retry preserves its original proof", t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept();
  const release = d.lease.release.bind(d.lease); d.lease.release = () => { throw new Error("fixture lease release interruption"); };
  assert.throws(() => f.control.abortBeforeExecution(d.prepared)); d.lease.assertCurrent();
  const proof = structuredClone(get(f, d).terminal); assert.ok(proof); assert.equal(get(f, d).leaseReleased, false);
  d.lease.release = release; f.control.reconcileLifecycleObservations(f.transport, f.agent.agentId);
  assert.deepEqual(get(f, d).terminal, proof); assert.equal(get(f, d).leaseReleased, true);
  assert.equal(f.snapshot().control.audit.filter(row => row.commandId === d.command.commandId && row.action === "runtime.aborted").length, 1);
});

test("C4 one explicit recovery wins claim CAS, old IDs stay read-only and an old stop cannot stop the new claim", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept(); f.control.abortBeforeExecution(d.prepared);
  const next = f.recover(d), competing = f.control.draftRecovery(f.transport, f.agent.agentId, { operationId: randomUUID(), previousRunId: d.binding.runId,
    expectedClaimRevision: 1, commandId: randomUUID(), rootRequestId: randomUUID(), message: "competing intent", lifetimeMs: 30000 });
  const begun = f.control.beginRecovery(f.transport, competing.recovery, competing.command, { message: "competing intent" });
  const binding = freezeWorkspaceRunBinding({ ...next.binding, runId: randomUUID() }), prepared = f.control.prepareRun(begun.intake, binding, next.lease, randomUUID());
  assert.equal(next.accept().status, "accepted");
  const loser = f.control.accept(begun.intake, prepared); assert.equal(loser.status, "rejected"); assert.equal(loser.error.code, "STALE_REVISION");
  assert.equal(f.authority.commandControlSourceHealthy(), true); assert.equal(get(f, next).claimRevision, 2);
  assert.equal(f.control.beginRecovery(f.transport, next.recovery, next.command, { message: next.message }).receipt.status, "accepted");
  assert.throws(() => f.control.beginRecovery(f.transport, { ...next.recovery, proofDigest: "a".repeat(64) }, next.command, { message: next.message }), code("COMMAND_ID_CONFLICT"));
  assert.ok(f.control.begin(f.transport, d.command, { message: d.message }).receipt); assert.throws(() => f.control.executionGrant(d.binding.runId), code("CONTROL_HELD"));
  const r = next.runtime(), stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 }); f.apply(stop);
  await r.call("workspace_write", { path: "new-claim.txt", content: "new authorized intent" });
  assert.equal(fs.readFileSync(join(f.project, "new-claim.txt"), "utf8"), "new authorized intent");
  assert.equal(f.snapshot().control.runs.find(row => row.runId === d.binding.runId).claimRevision, 1);
});

test("C4 same-task conversation projection requires its exact opaque new-claim handle and retains the old attempt", t => {
  const f = lifecycleFixture(t, { fixedSession: true }), d = f.dispatch(); d.accept();
  const store = new WorkspaceConversationStore(f.storage, f.agent.agentId); let value = store.read();
  value.task = d.task; value.attempt = { attemptId: d.lease.attemptId, fence: 1, runId: d.binding.runId, state: "running", startedAt: new Date().toISOString(), endedAt: null };
  value.requests.push({ requestId: d.requestId, digest: commandDigest(d.message), taskId: d.task.id, runId: d.binding.runId }); value = store.save(value.revision, value);
  f.control.abortBeforeExecution(d.prepared); value.attempt = { ...value.attempt, state: "blocked", endedAt: new Date().toISOString() }; value = store.save(value.revision, value);
  const original = structuredClone(value), next = f.recover(d); next.accept();
  value.pastTasks.push({ task: value.task, usage: value.runUsage, endedAt: new Date().toISOString() }); value.task = next.task;
  value.attempt = { attemptId: next.lease.attemptId, fence: 2, runId: next.binding.runId, state: "running", startedAt: new Date().toISOString(), endedAt: null };
  value.requests.push({ requestId: next.requestId, digest: commandDigest(next.message), taskId: next.task.id, runId: next.binding.runId });
  assert.throws(() => store.save(original.revision, value));
  assert.throws(() => store.save(original.revision, value, { approved: true }), code("AUTHORITY_UNVERIFIED")); assert.deepEqual(store.read(), original);
  const published = store.save(original.revision, value, f.control.claimProjection(next.intake));
  assert.equal(published.task.id, d.task.id); assert.equal(published.task.workspaceRunBinding.runId, next.binding.runId);
  assert.deepEqual(published.pastTasks[0].task, original.task); assert.deepEqual(published.requests.slice(0, 1), original.requests);
  f.control.abortBeforeExecution(next.prepared);
});

test("C4 historical UNKNOWN cannot acquire a new claim from missing ownership or a fabricated terminal digest", t => {
  const f = lifecycleFixture(t, { lifecycleControl: false }), d = f.dispatch(); d.accept(); d.lease.release();
  const authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, lifecycleControl: true }); authority.initializeAgentLifecycle(f.transport);
  const control = new WorkspaceAgentCommandControl(authority); t.after(() => authority.close());
  assert.equal(control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).status, "unknown");
  assert.throws(() => control.draftRecovery(f.transport, f.agent.agentId, { operationId: randomUUID(), previousRunId: d.binding.runId, expectedClaimRevision: 1,
    commandId: randomUUID(), rootRequestId: randomUUID(), message: "never auto replay", lifetimeMs: 30000 }), code("CONTROL_HELD"));
  assert.equal(control.lifecycleProjection(f.transport, f.agent.agentId).runs[0].execution, "legacy_unknown");
  assert.equal(control.lifecycleProjection(f.transport, f.agent.agentId).runs[0].recovery.includes("new_explicit_claim"), false);
});


test("C4 post-issuance startup failure is durable UNKNOWN and never frees or reissues the original owner", async t => {
  const f = lifecycleFixture(t), sibling = f.dispatch("sibling before unknown"); sibling.accept(); const s = sibling.runtime();
  const d = f.dispatch("issued without runtime return"); d.accept(); f.control.executionGrant(d.binding.runId);
  const result = f.control.settlePreparationFailure(d.prepared); assert.equal(result.acceptance, "accepted"); d.lease.assertCurrent();
  const run = f.snapshot().control.runs.find(row => row.runId === d.binding.runId); assert.equal(run.state, "unknown"); assert.equal(run.effect, "unknown"); assert.ok(run.hold);
  assert.equal(get(f, d).phase, "issued"); assert.equal(get(f, d).terminal, null); assert.equal(get(f, d).leaseReleased, false);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).status, "unknown");
  assert.throws(() => f.control.executionGrant(d.binding.runId), code("CONTROL_HELD"));
  await s.call("workspace_write", { path: "unaffected.txt", content: "healthy sibling" }); assert.equal(f.authority.commandControlSourceHealthy(), true);
});
