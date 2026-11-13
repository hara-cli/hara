// Middle part of the C3 command-control suite (stop/pause/drain/UNKNOWN/observation), split from
// agent-command-control.test.mjs to keep each file within the per-file runner limit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { AgentBoundaryContractError, agentBoundaryCommandSigningText } from "../dist/workspace/agent-boundaries-contract.js";
import { WorkspaceAgentCommandControl, agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";
import { agentPolicyProposalDigest, assertAgentCommandTransition } from "../dist/workspace/agent-command-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createTaskExecution } from "../dist/session/task.js";
import { localWorkspaceFileTools } from "../dist/workspace/local-tools.js";
import { createAgentBoundaryExecutionGate } from "../dist/workspace/agent-boundary-execution.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, closeWorkspaceRunPermit, workspaceRunDrainProof, executeWorkspaceTool, assertWorkspaceRunContextCurrent } from "../dist/workspace/execution.js";
import { fixture, code, fixtureDocs } from "./helpers/agent-command-control-fixture.mjs";

test("C3 same authority transaction publishes a boundary change and its original command audit", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), view = f.authority.view(f.transport, f.agent.agentId);
  const proposal = { duty: structuredClone(view.policy.duty), boundary: structuredClone(view.policy.boundary), rights: structuredClone(view.policy.rights) };
  proposal.boundary.boundaryRevision++; proposal.boundary.tools.readOnly = true;
  const command = f.draft({ action: "boundary.update", proposedBoundaryDigest: agentPolicyProposalDigest(proposal) });
  assert.equal(f.apply(command, proposal).status, "applied"); const state = f.snapshot();
  assert.equal(state.policies[0].boundary.tools.readOnly, true); assert.equal(state.control.commands.at(-1).command.commandId, command.commandId);
  assert.equal(state.control.audit.at(-1).policyRevision, state.policies[0].revision);
  await assert.rejects(runtime.call("workspace_write", { path: "revoked.txt", content: "no" }));
  assert.equal(fs.existsSync(join(f.project, "revoked.txt")), false);
});

test("C3 a mismatched policy proposal is rejected without policy publication", t => {
  const f = fixture(t), view = f.authority.view(f.transport, f.agent.agentId), proposal = { duty: view.policy.duty, boundary: view.policy.boundary, rights: view.policy.rights };
  const before = f.snapshot().policies; const command = f.draft({ action: "boundary.update", proposedBoundaryDigest: "a".repeat(64) });
  assert.equal(f.apply(command, proposal).status, "rejected"); assert.deepEqual(f.snapshot().policies, before);
});

test("C3 restart can query original receipts but cannot rebind an accepted run", t => {
  const f = fixture(t), d = f.dispatch(); d.accept();
  const restarted = new WorkspaceAgentCommandControl(f.authority);
  const receipt = restarted.readReceipt(f.transport, f.agent.agentId, d.command.commandId);
  assert.equal(receipt.status, "unknown"); assert.equal(receipt.error.code, "AUTHORITY_UNVERIFIED");
  assert.equal(receipt.execution.effect, "none");
  assert.equal(restarted.inspect(f.transport, f.agent.agentId).runs[0].controlledHere, false);
  assert.throws(() => restarted.bind(d.command, d.binding), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => restarted.executionGrant(d.binding.runId), code("AUTHORITY_UNVERIFIED"));
});

test("C3 unreadable private store blocks new effects and preserves corruption", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), original = fs.readFileSync(f.file, "utf8");
  fs.writeFileSync(f.file, "CORRUPT_RETAINED", { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "no.txt", content: "no" }));
  assert.equal(fs.readFileSync(f.file, "utf8"), "CORRUPT_RETAINED"); assert.equal(fs.existsSync(join(f.project, "no.txt")), false);
  fs.writeFileSync(f.file, original, { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "still-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "still-no.txt")), false);
});

test("C3 counter exhaustion never resets the epoch or writes a false successful receipt", t => {
  const f = fixture(t), state = f.snapshot(); state.control.agents[0].epoch = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 }); const before = fs.readFileSync(f.file, "utf8");
  const command = f.draft({ action: "agent.pause", reason: "human_request" });
  assert.throws(() => f.apply(command), code("COUNTER_EXHAUSTED")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});


test("C3 drained requires a genuine post-drain runtime proof; JSON and abort are not observation", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  assert.throws(() => f.control.observeDrained({ approved: true }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => workspaceRunDrainProof(runtime.permit), code("AUTHORITY_UNVERIFIED"));
  await runtime.call("workspace_write", { path: "observed.txt", content: "yes" });
  await closeWorkspaceRunPermit(runtime.permit);
  const proof = workspaceRunDrainProof(runtime.permit); f.control.observeDrained(proof); f.control.observeDrained(proof);
  const receipt = f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId);
  assert.equal(receipt.status, "drained"); assert.equal(receipt.execution.drain, "observed"); assert.ok(receipt.execution.drainProofRef);
  assert.equal(receipt.execution.effect, "completed");
  assert.equal(f.snapshot().control.audit.filter(row => row.action === "runtime.drained").length, 1);
});

test("C3 drain owner alone rejects a genuine proof paired with another genuine permit", async t => {
  const f = fixture(t), a = f.dispatch("original drain"), b = f.dispatch("different permit"); a.accept(); b.accept();
  const first = a.runtime(), other = b.runtime(); await closeWorkspaceRunPermit(first.permit);
  const proof = workspaceRunDrainProof(first.permit), before = fs.readFileSync(f.file, "utf8");
  // Fault injection isolates the owner defense: binding/attempt still match A, only its private permit slot is B.
  // Both handles are real. No test capability or production injection API is introduced.
  const live = f.control.live.get(a.binding.runId); live.permit = other.permit;
  try { assert.throws(() => f.control.observeDrained(proof), code("AUTHORITY_UNVERIFIED")); }
  finally { live.permit = first.permit; }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).pendingDrainObservations, 0);
});

test("C3 transition independently refuses erasing UNKNOWN effect with the drained state unchanged", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  await assert.rejects(executeWorkspaceTool(runtime.permit, "workspace_write", async () => { throw new Error("synthetic unknown outcome"); }, undefined,
    { path: "unknown-transition.txt", content: "no replay" }, "unknown-transition"));
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  const before = f.snapshot().control, next = structuredClone(before); assert.equal(before.runs[0].state, "drained");
  assert.equal(before.runs[0].effect, "unknown"); next.runs[0].effect = "completed";
  assert.throws(() => assertAgentCommandTransition(before, next), code("AUTHORITY_UNVERIFIED"));
});

test("C3 persisted unknown run cannot return to execution but genuine drain remains observable", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), state = f.snapshot();
  state.control.runs[0].state = "unknown"; fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 });
  const before = f.authority.commandControlState().control;
  for (const oldPhase of ["unknown", "draining"]) for (const phase of ["accepted", "bound", "running"]) {
    const original = structuredClone(before); original.runs[0].state = oldPhase;
    const next = structuredClone(original); next.runs[0].state = phase;
    assert.throws(() => assertAgentCommandTransition(original, next), code("AUTHORITY_UNVERIFIED"));
  }
  await assert.rejects(runtime.call("workspace_write", { path: "unknown-state-no.txt", content: "no" }), code("CONTROL_HELD"));
  assert.equal(fs.existsSync(join(f.project, "unknown-state-no.txt")), false);
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  assert.equal(f.snapshot().control.runs[0].state, "drained");
});

test("C3 UNKNOWN can be queried and manually stopped; drain/ack cannot erase or replay it", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), input = { path: "unknown.txt", content: "accepted" };
  await assert.rejects(executeWorkspaceTool(runtime.permit, "workspace_write", async frozen => {
    await runtime.files.find(tool => tool.name === "workspace_write").run(frozen, { cwd: f.project }); throw new Error("synthetic response lost");
  }, undefined, input, "unknown-effect"), /response lost/);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).execution.effect, "unknown");
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 }), stopped = f.apply(stop);
  assert.equal(stopped.status, "unknown"); assert.equal(stopped.execution.drain, "observed"); assert.equal(stopped.execution.effect, "unknown");
  assert.ok(stopped.control.holdId); assert.equal(f.snapshot().control.runs[0].effect, "unknown");
  assert.ok(f.control.inspect(f.transport, f.agent.agentId).runs[0].recovery.includes("query_original"));
  assert.equal(fs.readFileSync(join(f.project, "unknown.txt"), "utf8"), "accepted");
  const retry = { ...structuredClone(d.command), commandId: randomUUID() };
  retry.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(retry)).digest("hex");
  const begun = f.control.begin(f.transport, retry, { message: d.message });
  const retryLease = f.trackLease(WorkspaceSessionLease.acquire(f.storage, d.binding.sessionId));
  const prepared = f.control.prepareRun(begun.intake, { ...d.binding, runId: randomUUID() }, retryLease, randomUUID());
  // Original accepted root/task remain non-replayable even with a new command/run ID.
  const result = f.control.accept(begun.intake, prepared); assert.equal(result.status, "rejected"); assert.equal(result.error.code, "COMMAND_ID_CONFLICT");
});

test("C3 audit outbox acknowledgments are durable and idempotent without changing UNKNOWN/control", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  await assert.rejects(executeWorkspaceTool(runtime.permit, "workspace_write", async () => { throw new Error("uncertain"); }, undefined,
    { path: "unknown-audit.txt", content: "do not replay" }, "unknown-audit"));
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  const before = f.snapshot(), events = f.control.audit(f.transport, f.agent.agentId), ids = events.map(row => row.eventId);
  assert.ok(events.every(row => !row.acknowledged));
  assert.throws(() => f.control.acknowledgeAudit(f.transport, f.agent.agentId, ["foreign-event"]), code("AUTHORIZATION_DENIED"));
  const ack = f.control.acknowledgeAudit(f.transport, f.agent.agentId, ids); assert.ok(ack.every(row => row.acknowledged));
  const after = f.snapshot(); assert.deepEqual(after.control.runs, before.control.runs); assert.deepEqual(after.control.commands, before.control.commands);
  assert.equal(after.control.runs[0].effect, "unknown");
  assert.deepEqual(f.control.acknowledgeAudit(f.transport, f.agent.agentId, ids), ack); assert.equal(f.snapshot().revision, after.revision);
});

test("C3 observation write failure retains the genuine proof and reconciles only its publication", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(); await runtime.call("workspace_write", { path: "once.txt", content: "once" });
  await Promise.all([closeWorkspaceRunPermit(runtime.permit), closeWorkspaceRunPermit(runtime.permit)]);
  const proof = workspaceRunDrainProof(runtime.permit), original = f.authority.observeCommandControl.bind(f.authority), before = fs.readFileSync(f.file, "utf8");
  f.authority.observeCommandControl = () => { throw new Error("synthetic unavailable writer"); };
  assert.throws(() => f.control.observeDrained(proof), /unavailable writer/); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).pendingDrainObservations, 1);
  f.authority.observeCommandControl = original;
  f.control.reconcileDrainObservations(f.transport, f.agent.agentId);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).execution.drain, "observed");
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).pendingDrainObservations, 0);
  f.control.observeDrained(proof); assert.equal(f.snapshot().control.audit.filter(row => row.action === "runtime.drained").length, 1);
  assert.equal(fs.readFileSync(join(f.project, "once.txt"), "utf8"), "once");
});

// C5 M1 authenticated receipt lookup (from #73), placed with the observation tests.
test("C5 M1 authenticated missing-receipt observation uses authority time and an expired intake cannot later commit", t => {
  const f = fixture(t), command = f.draft({ action: "agent.pause", reason: "human_request" });
  const intake = f.control.begin(f.transport, command).intake;
  const before = f.control.lookupReceipt(f.transport, f.agent.agentId, command.commandId);
  assert.equal(before.state, "not_seen"); assert.equal(before.receipt, null);
  assert.equal(before.kind, "command-receipt-lookup"); assert.deepEqual(before.context, command.context);
  assert.equal(before.agentId, command.agentId); assert.equal(before.commandId, command.commandId);
  assert.ok(Date.parse(before.observedAt) < Date.parse(command.notAfter));
  f.advance(31001);
  const expired = f.control.lookupReceipt(f.transport, f.agent.agentId, command.commandId);
  assert.ok(Date.parse(expired.observedAt) > Date.parse(command.notAfter) + 1000);
  assert.throws(() => f.control.accept(intake), code("AUTHORITY_UNVERIFIED"));
  assert.equal(f.snapshot().control.commands.length, 0); assert.equal(f.snapshot().control.runs.length, 0);
});

test("C5 M1 observed time is sampled before reading the ledger, never after an acceptance window", t => {
  const f = fixture(t), command = f.draft({ action: "agent.pause", reason: "human_request" });
  const read = f.authority.commandControlForReader.bind(f.authority);
  let once = false;
  f.authority.commandControlForReader = (...args) => { if (!once) { once = true; f.advance(31001); } return read(...args); };
  const observed = f.control.lookupReceipt(f.transport, f.agent.agentId, command.commandId);
  assert.equal(observed.state, "not_seen");
  assert.ok(Date.parse(observed.observedAt) < Date.parse(command.notAfter), "A late snapshot cannot turn an earlier observation into an expired proof");
});

test("C5 M1 seen accepted commands survive expiry and absence is never substituted for failed authority", t => {
  const f = fixture(t), run = f.dispatch(); run.accept(); f.advance(60000);
  const seen = f.control.lookupReceipt(f.transport, f.agent.agentId, run.command.commandId);
  assert.equal(seen.state, "seen"); assert.equal(seen.receipt.status, "accepted");
  assert.deepEqual(seen.receipt, f.control.readReceipt(f.transport, f.agent.agentId, run.command.commandId));
  assert.throws(() => f.control.lookupReceipt({}, f.agent.agentId, randomUUID()), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.lookupReceipt(f.transport, "other-agent", randomUUID()), code("AUTHORIZATION_DENIED"));
  assert.throws(() => f.control.lookupReceipt(f.transport, f.agent.agentId, "bad id"), code("INVALID_DOCUMENT"));
  const healthy = f.authority.commandControlSourceHealthy; f.authority.commandControlSourceHealthy = () => false;
  try { assert.throws(() => f.control.lookupReceipt(f.transport, f.agent.agentId, randomUUID()), code("AUTHORITY_UNVERIFIED")); }
  finally { f.authority.commandControlSourceHealthy = healthy; }
});


test("C5 M1 lookup requires current manage or invoke and cannot return absence for another agent's ID", t => {
  const denied = fixture(t, { rights: { manage: false, invoke: false } });
  assert.throws(() => denied.control.lookupReceipt(denied.transport, denied.agent.agentId, randomUUID()), code("AUTHORIZATION_DENIED"));
  const f = fixture(t), run = f.dispatch(); run.accept();
  const reader = f.authority.commandControlForReader.bind(f.authority);
  f.authority.commandControlForReader = (transport, _target) => reader(transport, f.agent.agentId);
  assert.throws(() => f.control.lookupReceipt(f.transport, "other-authorized-agent", run.command.commandId), code("AUTHORIZATION_DENIED"));
});


test("C5 M1 an in-flight real CAS cannot be observed absent and lock contention leaves authority usable", t => {
  const f = fixture(t), id = randomUUID(), revision = f.snapshot().revision;
  f.authority.state.update(revision, state => {
    assert.throws(() => f.control.lookupReceipt(f.transport, f.agent.agentId, id), code("AUTHORITY_UNVERIFIED"));
    return state;
  });
  assert.equal(f.authority.commandControlSourceHealthy(), true);
  const before = fs.readFileSync(f.file, "utf8"), observed = f.control.lookupReceipt(f.transport, f.agent.agentId, id);
  assert.equal(observed.state, "not_seen"); assert.equal(fs.readFileSync(f.file, "utf8"), before, "A lookup cannot change state/revision");
  assert.throws(() => f.authority.state.withReadLock(() => Promise.resolve("not an observation")), /synchronous/);
  assert.equal(f.authority.commandControlSourceHealthy(), true);
});
