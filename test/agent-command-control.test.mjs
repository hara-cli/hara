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

test("C3 explicit private migration preserves policies and fences legacy writers without changing portable C0", t => {
  const f = fixture(t), before = JSON.parse(f.beforeMigration), after = f.snapshot();
  assert.equal(before.schemaVersion, 1); assert.equal(after.schemaVersion, 2); assert.deepEqual(after.policies[0].boundary, before.policies[0].boundary);
  assert.equal(after.policies[0].revision, before.policies[0].revision + 1); assert.equal(after.control.origin.sourceRevision, before.revision);
  const view = f.authority.view(f.transport, f.agent.agentId);
  assert.throws(() => f.authority.configure(f.transport, f.agent.agentId, { expectedRevision: view.revision, duty: view.policy.duty, boundary: view.policy.boundary, rights: view.policy.rights }), code("AUTHORITY_UNVERIFIED"));
  const legacy = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, commandControl: false });
  assert.throws(() => legacy.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 1000,
    operation: { action: "agent.pause", reason: "human_request" } }), code("AUTHORITY_UNVERIFIED"));
});

test("C3 default control remains closed until explicit owner initialization", t => {
  const f = fixture(t, { noInitialize: true });
  assert.throws(() => f.control.inspect(f.transport, f.agent.agentId), code("AUTHORITY_UNVERIFIED"));
  assert.equal(f.snapshot().schemaVersion, 1);
});

test("C3 real runtime permit, C1 policy and persisted C3 source execute an admitted file effect", async t => {
  const f = fixture(t), d = f.dispatch(); assert.equal(d.accept().status, "accepted"); const r = d.runtime();
  await r.call("workspace_write", { path: "ok.txt", content: "only once" }); assert.equal(fs.readFileSync(join(f.project, "ok.txt"), "utf8"), "only once");
  assert.equal(f.snapshot().control.commands.length, 1); assert.equal(f.snapshot().control.runs.length, 1);
  assert.ok(f.snapshot().control.audit.every(event => event.actorId === f.row.actorId));
});

test("C3 original ID duplicates and reconnect/expired receipt reads do not mint another execution", t => {
  const f = fixture(t), d = f.dispatch(); const receipt = d.accept(); f.advance(60000);
  assert.deepEqual(f.control.begin(f.transport, d.command, { message: d.message }), { receipt });
  const another = f.transports.connect("owner-again", f.credential);
  assert.deepEqual(f.control.begin(another, d.command, { message: d.message }), { receipt });
  assert.throws(() => f.authority.check(another, d.command), code("AUTHORITY_UNVERIFIED"));
  const changed = structuredClone(d.command); changed.operation.messageDigest = "b".repeat(64);
  assert.throws(() => f.control.begin(another, changed, { message: d.message }), code("COMMAND_ID_CONFLICT"));
  assert.equal(f.snapshot().control.runs.length, 1);
});

test("C3 opaque intake and genuine prepared lease cannot be replaced by JSON approved objects", t => {
  const f = fixture(t), d = f.dispatch();
  assert.throws(() => f.control.accept({ approved: true }, d.prepared), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.accept(d.intake, { approved: true }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.prepareRun(d.intake, d.binding, { sessionId: d.binding.sessionId, assertCurrent() {} }, randomUUID()), code("CONTEXT_MISMATCH"));
  assert.equal(f.snapshot().control.commands.length, 0);
});

test("C3 guest/source spoof is rejected before returning a private command receipt", t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const guest = f.transports.connect("guest", undefined);
  assert.throws(() => f.control.begin(guest, d.command, { message: d.message }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.readReceipt(guest, f.agent.agentId, d.command.commandId), code("AUTHORITY_UNVERIFIED"));
});

test("C3 stop after dispatch durably fences only the exact run; sibling work can still write", async t => {
  const f = fixture(t), first = f.dispatch("first"), second = f.dispatch("second"); first.accept(); second.accept(); const a = first.runtime(), b = second.runtime();
  const stop = f.draft({ action: "task.stop", taskId: first.task.id, runId: first.binding.runId, claimRevision: 1 });
  assert.equal(f.apply(stop).control.holdId.startsWith("hold_"), true);
  await assert.rejects(a.call("workspace_write", { path: "blocked.txt", content: "no" }), code("CONTROL_HELD"));
  await b.call("workspace_write", { path: "sibling.txt", content: "yes" });
  assert.equal(fs.existsSync(join(f.project, "blocked.txt")), false); assert.equal(fs.readFileSync(join(f.project, "sibling.txt"), "utf8"), "yes");
});

for (const failure of ["expired intake", "released preparation lease", "post-accept grant expiry"]) test(`C3 ${failure} rejection preserves healthy sibling effects and fresh stop/pause`, async t => {
  const f = fixture(t), healthy = f.dispatch("healthy sibling"); healthy.accept(); const runtime = healthy.runtime();
  const rejected = f.dispatch("only this command must fail", { lifetimeMs: 1000 }), before = fs.readFileSync(f.file, "utf8");
  if (failure === "expired intake") f.advance(1001);
  else if (failure === "released preparation lease") rejected.lease.release();
  if (failure === "post-accept grant expiry") {
    const admit = f.authority.admit.bind(f.authority);
    f.authority.admit = (transport, command) => { if (command.commandId === rejected.command.commandId) f.advance(1001); return admit(transport, command); };
    try { assert.equal(rejected.accept().status, "accepted"); } finally { f.authority.admit = admit; }
    const original = f.control.begin(f.transport, rejected.command, { message: rejected.message });
    assert.equal(original.receipt.status, "unknown"); assert.equal(original.intake, undefined);
    assert.throws(() => f.control.executionGrant(rejected.binding.runId), code("AUTHORITY_UNVERIFIED"));
    assert.equal(f.snapshot().control.runs.find(run => run.runId === rejected.binding.runId).state, "accepted");
  } else {
    assert.throws(() => rejected.accept(), code("AUTHORITY_UNVERIFIED"));
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
  assert.equal(f.authority.commandControlSourceHealthy(), true);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).sourceAvailableHere, true);
  await runtime.call("workspace_write", { path: "healthy-after-rejection.txt", content: failure });
  assert.equal(fs.readFileSync(join(f.project, "healthy-after-rejection.txt"), "utf8"), failure);
  const stopped = f.apply(f.draft({ action: "task.stop", taskId: healthy.task.id, runId: healthy.binding.runId, claimRevision: 1 }));
  assert.ok(stopped.control.holdId); assert.notEqual(stopped.status, "rejected");
  const paused = f.apply(f.draft({ action: "agent.pause", reason: "human_request" }));
  assert.ok(paused.control.holdId); assert.notEqual(paused.status, "rejected");
  await assert.rejects(runtime.call("workspace_write", { path: "held-after-rejection.txt", content: "no" }), code("CONTROL_HELD"));
  assert.equal(fs.existsSync(join(f.project, "held-after-rejection.txt")), false);
});

test("C3 pause before dispatch rejects the old command, while resume only permits fresh dispatch", async t => {
  const f = fixture(t), old = f.dispatch("old");
  const pause = f.draft({ action: "agent.pause", reason: "human_request" }), held = f.apply(pause);
  assert.equal(old.accept().status, "rejected"); assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, old.command.commandId).error.code, "STALE_REVISION");
  const resume = f.draft({ action: "agent.resume", holdId: held.control.holdId }); assert.equal(resume.expected.controlEpoch, 1);
  assert.equal(f.apply(resume).status, "applied");
  const fresh = f.dispatch("fresh"); assert.equal(fresh.command.expected.controlEpoch, 2); fresh.accept();
  await fresh.runtime().call("workspace_write", { path: "fresh.txt", content: "yes" });
  assert.deepEqual(f.control.begin(f.transport, old.command, { message: old.message }).receipt.status, "rejected");
});

test("C3 pause and resume never revive an old accepted gate", async t => {
  const f = fixture(t), old = f.dispatch(); old.accept(); const runtime = old.runtime();
  const held = f.apply(f.draft({ action: "agent.pause", reason: "human_request" }));
  await assert.rejects(runtime.call("workspace_write", { path: "held.txt", content: "no" }), code("CONTROL_HELD"));
  f.apply(f.draft({ action: "agent.resume", holdId: held.control.holdId }));
  await assert.rejects(runtime.call("workspace_write", { path: "still-old.txt", content: "no" }), code("STALE_REVISION"));
  assert.equal(fs.existsSync(join(f.project, "still-old.txt")), false);
});

test("C3 unauthorized stop is recorded as rejected and cannot hold an active run", t => {
  const f = fixture(t, { rights: { manage: false } }), d = f.dispatch(); d.accept();
  // Build an authenticated intent as the real connection, but alter no permission or signing bytes.
  const command = { ...structuredClone(d.command), commandId: randomUUID(), rootRequestId: randomUUID(),
    operation: { action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 } };
  command.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex");
  assert.equal(f.apply(command).error.code, "AUTHORIZATION_DENIED");
  assert.equal(f.snapshot().control.audit.at(-1).decision, "rejected");
  assert.throws(() => f.authority.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 1000,
    operation: { action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 } }), code("AUTHORIZATION_DENIED"));
  assert.equal(f.snapshot().control.runs[0].hold, null); assert.equal(command.actorChain.requestedBy, f.row.actorId);
});
