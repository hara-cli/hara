import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
import { lifecycleHostFixture } from "./helpers/agent-lifecycle-host-fixture.mjs";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { WorkspaceFeatures } from "../dist/workspace/features.js";
import { AgentBoundaryContractError } from "../dist/workspace/agent-boundaries-contract.js";
import { closeWorkspaceRunPermit, workspaceRunDrainProof } from "../dist/workspace/execution.js";
const code = value => error => error instanceof AgentBoundaryContractError && error.code === value;
const features = f => new WorkspaceFeatures(f.storage, f.project, f.row.scope.workspaceId);
function schedule(store, agentId) { const id = randomUUID(); store.saveSchedule({ id, name: "Synthetic schedule", task: "hello", agentId, enabled: true,
  schedule: { kind: "once", runAt: Date.now() + 3600000, display: "fixture" } }, store.list().revision); return id; }

test("C4 persistent task revocation rejects copied C1 grants and policies in another Host while a sibling writes", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(), sibling = f.dispatch("sibling"); d.accept(); sibling.accept(); const r = d.runtime(), s = sibling.runtime();
  const peer = new WorkspaceAgentBoundaryAuthority(f.authorityOptions), copy = peer.admit(f.transport, d.command), policy = peer.captureExecutionPolicy(copy); t.after(() => peer.close());
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 }); f.apply(stop);
  const result = f.control.reconcileLifecycleOperation(stop.commandId); assert.deepEqual(result.revokedRunIds, [d.binding.runId]);
  assert.throws(() => peer.grantFacts(copy), code("GRANT_REVOKED")); assert.throws(() => peer.executionPolicyFacts(policy), code("GRANT_REVOKED"));
  await s.call("workspace_write", { path: "sibling-revocation.txt", content: "still allowed" });
  assert.equal(fs.readFileSync(join(f.project, "sibling-revocation.txt"), "utf8"), "still allowed");
  assert.equal(f.catalog.resolve(f.row.scope.workspaceId).grantId, d.binding.host.grantId); assert.ok(f.connections.capture());
  await closeWorkspaceRunPermit(r.permit); f.control.observeDrained(workspaceRunDrainProof(r.permit));
});

test("C4 pause/resume retires the old epoch permanently and never enables its schedules", async t => {
  const f = lifecycleFixture(t), store = features(f), id = schedule(store, f.agent.agentId), d = f.dispatch(); d.accept(); const r = d.runtime();
  const peer = new WorkspaceAgentBoundaryAuthority(f.authorityOptions), copy = peer.admit(f.transport, d.command), policy = peer.captureExecutionPolicy(copy); t.after(() => peer.close());
  const pause = f.draft({ action: "agent.pause", reason: "human_request" }), held = f.apply(pause); f.control.reconcileLifecycleOperation(pause.commandId);
  const early = f.apply(f.draft({ action: "agent.resume", holdId: held.control.holdId })); assert.equal(early.error.code, "CONTROL_HELD");
  await closeWorkspaceRunPermit(r.permit); f.control.observeDrained(workspaceRunDrainProof(r.permit));
  assert.equal(f.apply(f.draft({ action: "agent.resume", holdId: held.control.holdId })).status, "applied");
  assert.throws(() => peer.grantFacts(copy)); assert.throws(() => peer.executionPolicyFacts(policy)); assert.equal(store.schedules().find(row => row.id === id).enabled, false);
  const next = f.dispatch("new work"); next.accept(); await next.runtime().call("workspace_write", { path: "after-resume.txt", content: "new authority" });
});

test("C4 a cut after durable schedule pause preserves its receipt and retries publication without rollback", t => {
  const f = lifecycleFixture(t, { colleague: true }), store = features(f), main = f.resources.agents.list().mainAgentId;
  assert.notEqual(main, f.agent.agentId);
  const id = schedule(store, f.agent.agentId), other = schedule(store, main);
  const pause = f.draft({ action: "agent.pause", reason: "human_request" }); f.apply(pause);
  const observe = f.authority.observeCommandControl.bind(f.authority); let interrupted = false;
  f.authority.observeCommandControl = (...args) => { if (!interrupted && store.archivePauseReceipts().length) { interrupted = true; throw new AgentBoundaryContractError("STALE_REVISION", "synthetic.cross_file_cut"); } return observe(...args); };
  assert.throws(() => f.control.reconcileLifecycleOperation(pause.commandId), code("STALE_REVISION"));
  assert.equal(store.schedules().find(row => row.id === id).enabled, false); assert.equal(store.schedules().find(row => row.id === other).enabled, true);
  assert.equal(store.archivePauseReceipts().length, 1); assert.equal(f.snapshot().lifecycle.operations[0].schedules, "pending");
  f.authority.observeCommandControl = observe; const done = f.control.reconcileLifecycleOperation(pause.commandId); assert.equal(done.schedules, "paused");
  assert.equal(store.archivePauseReceipts().length, 0); assert.deepEqual(f.control.reconcileLifecycleOperation(pause.commandId), done);
});

test("C4 dismiss waits for positive physical closure then publishes only the exact logical archive after a cut", async t => {
  const f = lifecycleFixture(t, { colleague: true }), store = features(f), id = schedule(store, f.agent.agentId), d = f.dispatch(); d.accept(); const r = d.runtime();
  fs.writeFileSync(join(f.project, "retained-user-data.txt"), "keep");
  const dismiss = f.draft({ action: "agent.dismiss", retention: "keep_records_and_recovery" }); assert.equal(f.apply(dismiss).status, "accepted");
  assert.equal(f.control.reconcileLifecycleOperation(dismiss.commandId).archive, "pending"); assert.equal(f.resources.agents.get(f.agent.agentId).state, "active");
  await closeWorkspaceRunPermit(r.permit); f.control.observeDrained(workspaceRunDrainProof(r.permit));
  const observe = f.authority.observeCommandControl.bind(f.authority); let interrupted = false;
  f.authority.observeCommandControl = (...args) => { if (!interrupted && f.resources.agents.get(f.agent.agentId).state === "archived") {
    interrupted = true; throw new AgentBoundaryContractError("STALE_REVISION", "synthetic.archive_publication_cut"); } return observe(...args); };
  assert.throws(() => f.control.reconcileLifecycleOperation(dismiss.commandId), code("STALE_REVISION"));
  assert.equal(f.snapshot().lifecycle.operations[0].archive, "pending"); assert.equal(f.resources.agents.get(f.agent.agentId).state, "archived");
  f.authority.observeCommandControl = observe; const done = f.control.reconcileLifecycleOperation(dismiss.commandId);
  assert.equal(done.archive, "archived"); assert.equal(done.archivedResource.agentEpoch, f.agent.agentEpoch + 1);
  assert.equal(store.schedules().find(row => row.id === id).enabled, false); assert.equal(fs.readFileSync(join(f.project, "retained-user-data.txt"), "utf8"), "keep");
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).commandId, d.command.commandId);
  assert.throws(() => f.control.executionGrant(d.binding.runId)); assert.equal(f.snapshot().control.agents.find(row => row.agentId === f.agent.agentId).dismissed, true);
});

test("C4 protected Host rejects legacy archive and restore before directory or schedule writes", async t => {
  const f = await lifecycleHostFixture(t), before = await f.snapshot(), agent = before.agents.find(row => row.agentId === f.params.agentId);
  for (const archived of [true, false]) await assert.rejects(f.owner.request("workspace.agents.setArchived", { ...f.params, archived, configRevision: agent.configRevision, agentEpoch: agent.agentEpoch }));
  assert.deepEqual((await f.snapshot()).agents, before.agents); assert.equal(f.calls(), 0);
});
