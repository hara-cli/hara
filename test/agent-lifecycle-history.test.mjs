import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
import { agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";
import { AgentBoundaryContractError } from "../dist/workspace/agent-boundaries-contract.js";
import { closeWorkspaceRunPermit, workspaceRunDrainProof, executeWorkspaceTool } from "../dist/workspace/execution.js";
const code = value => error => error instanceof AgentBoundaryContractError && error.code === value;
const historyFile = f => join(dirname(f.file), `workspace-agent-history-${f.snapshot().lifecycle.segments[0].segmentId}.json`);
function abort(f, message = "never started") { const d = f.dispatch(message); d.accept(); f.control.abortBeforeExecution(d.prepared); return d; }

test("C4 immutable history frees active N5 slots but keeps exact IDs and only explicit positive-proof recovery", async t => {
  const f = lifecycleFixture(t), d = abort(f), sibling = f.dispatch("healthy sibling"); sibling.accept(); const s = sibling.runtime();
  const audit = f.control.audit(f.transport, f.agent.agentId), original = f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId);
  const saved = f.control.archiveLifecycleHistory(f.transport, f.agent.agentId, 1); assert.equal(saved.published, 1); assert.equal(saved.archivedRuns, 1);
  assert.equal(f.snapshot().control.runs.some(row => row.runId === d.binding.runId), false); assert.equal(f.snapshot().lifecycle.retiredRuns[0].taskId, d.task.id);
  assert.deepEqual(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId), original); assert.deepEqual(f.control.audit(f.transport, f.agent.agentId), audit);
  assert.deepEqual(f.control.begin(f.transport, d.command, { message: d.message }).receipt, original);
  const replay = f.control.begin(f.transport, d.command, { message: d.message }); assert.equal(replay.intake, undefined);
  const next = f.recover(d); assert.equal(next.accept().status, "accepted"); assert.equal(f.snapshot().control.runs.find(row => row.runId === next.binding.runId).claimRevision, 2);
  await next.runtime().call("workspace_write", { path: "new-intent.txt", content: "one explicit claim" });
  await s.call("workspace_write", { path: "healthy-history.txt", content: "unaffected" }); assert.equal(f.authority.commandControlSourceHealthy(), true);
});

test("C4 a physically drained UNKNOWN is archived with its original effect and never becomes a new claim", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept(); const r = d.runtime();
  await assert.rejects(executeWorkspaceTool(r.permit, "workspace_write", async input => { await r.files.find(row => row.name === "workspace_write").run(input, { cwd: f.project }); throw new Error("effect committed, response lost"); },
    undefined, { path: "unknown-once.txt", content: "one" }, randomUUID()));
  await closeWorkspaceRunPermit(r.permit); f.control.observeDrained(workspaceRunDrainProof(r.permit));
  assert.equal(f.snapshot().control.runs[0].effect, "unknown"); f.control.archiveLifecycleHistory(f.transport, f.agent.agentId);
  const old = f.snapshot().lifecycle.retiredRuns.find(row => row.runId === d.binding.runId); assert.equal(old.outcome, "unknown"); assert.equal(old.leaseReleased, true);
  const receipt = f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId); assert.equal(receipt.status, "unknown"); assert.equal(receipt.execution.effect, "unknown");
  assert.ok(f.control.begin(f.transport, d.command, { message: d.message }).receipt); assert.throws(() => f.recover(d), code("CONTROL_HELD"));
  assert.equal(fs.readFileSync(join(f.project, "unknown-once.txt"), "utf8"), "one"); assert.throws(() => f.control.executionGrant(d.binding.runId));
});

test("C4 unconfirmed issued ownership cannot be archived or inferred closed from an empty runtime map", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept(); f.control.executionGrant(d.binding.runId); f.control.settlePreparationFailure(d.prepared);
  const before = f.snapshot(), result = f.control.archiveLifecycleHistory(f.transport, f.agent.agentId); assert.equal(result.published, 0);
  assert.deepEqual(f.snapshot(), before); assert.equal(before.lifecycle.executions[0].leaseReleased, false); d.lease.assertCurrent();
  const sibling = f.dispatch("another conversation"); sibling.accept(); await sibling.runtime().call("workspace_write", { path: "while-unknown.txt", content: "allowed" });
});

test("C4 a manifest CAS cut keeps active records and retries the same immutable file without duplicate retirement", async t => {
  const f = lifecycleFixture(t), d = abort(f), before = f.snapshot(), update = f.authority.state.update.bind(f.authority.state);
  f.authority.state.update = () => { throw new Error("Workspace state changed; refresh before writing"); };
  assert.throws(() => f.control.archiveLifecycleHistory(f.transport, f.agent.agentId, 1), code("STALE_REVISION"));
  assert.deepEqual(f.snapshot(), before); assert.equal(f.authority.commandControlSourceHealthy(), true);
  const names = fs.readdirSync(dirname(f.file)).filter(name => name.startsWith("workspace-agent-history-") && name.endsWith(".json")); assert.equal(names.length, 1);
  const saved = fs.readFileSync(join(dirname(f.file), names[0])); f.authority.state.update = update;
  f.control.archiveLifecycleHistory(f.transport, f.agent.agentId, 1); assert.equal(fs.readdirSync(dirname(f.file)).filter(name => name.startsWith("workspace-agent-history-") && name.endsWith(".json")).length, 1);
  assert.deepEqual(fs.readFileSync(join(dirname(f.file), names[0])), saved); assert.equal(f.snapshot().lifecycle.retiredRuns.filter(row => row.runId === d.binding.runId).length, 1);
  assert.equal(f.control.archiveLifecycleHistory(f.transport, f.agent.agentId).published, 0);
});

for (const damage of ["missing", "bytes", "symlink", "hardlink", "index"]) test(`C4 ${damage} history refuses dependent reads/admission while healthy sibling effects remain usable`, async t => {
  const f = lifecycleFixture(t), d = abort(f), sibling = f.dispatch("healthy active"); sibling.accept(); const s = sibling.runtime(); f.control.archiveLifecycleHistory(f.transport, f.agent.agentId);
  const file = historyFile(f), body = fs.readFileSync(file), aggregate = fs.readFileSync(f.file), spare = join(dirname(f.file), "untrusted-history-copy.json");
  if (damage === "index") { const broken = f.snapshot(); broken.lifecycle.retiredRuns[0].recordDigest = "f".repeat(64); fs.writeFileSync(f.file, JSON.stringify(broken) + "\n"); }
  else if (damage === "bytes") fs.writeFileSync(file, "{}");
  else { fs.unlinkSync(file); if (damage === "symlink") { fs.writeFileSync(spare, body, { mode: 0o600 }); fs.symlinkSync(spare, file); }
    if (damage === "hardlink") { fs.writeFileSync(spare, body, { mode: 0o600 }); fs.linkSync(spare, file); } }
  assert.throws(() => f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId), code("AUTHORITY_UNVERIFIED"));
  const message = "new after damaged history", sessionId = randomUUID(), command = f.draft({ action: "task.dispatch", taskId: randomUUID(), conversationId: sessionId, messageDigest: agentCommandMessageDigest(sessionId, message) });
  assert.throws(() => f.control.begin(f.transport, command, { message }), code("AUTHORITY_UNVERIFIED")); assert.equal(f.authority.commandControlSourceHealthy(), true);
  await s.call("workspace_write", { path: `healthy-${damage}.txt`, content: "still governed by active authority" });
  if (fs.existsSync(file) || damage === "symlink") fs.unlinkSync(file); if (fs.existsSync(spare)) fs.unlinkSync(spare); fs.writeFileSync(file, body, { mode: 0o600 }); fs.writeFileSync(f.file, aggregate);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).status, "accepted"); assert.throws(() => f.control.executionGrant(d.binding.runId));
});

test("C4 physical history bound includes unpublished orphan files and never evicts active or UNKNOWN identities", t => {
  const f = lifecycleFixture(t), d = abort(f), before = f.snapshot();
  for (let i = 0; i < 64; i++) fs.writeFileSync(join(dirname(f.file), `workspace-agent-history-${randomUUID()}.json`), "retained unpublished fixture", { mode: 0o600 });
  assert.throws(() => f.control.archiveLifecycleHistory(f.transport, f.agent.agentId), code("AUTHORITY_UNVERIFIED"));
  assert.deepEqual(f.snapshot(), before); assert.equal(f.authority.commandControlSourceHealthy(), true);
  assert.ok(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId)); assert.equal(fs.readdirSync(dirname(f.file)).filter(name => name.startsWith("workspace-agent-history-") && name.endsWith(".json")).length, 64);
});


test("C4 retired task and root IDs remain exact dedup entries, and retired recovery retransmission is read-only", t => {
  const f = lifecycleFixture(t), d = abort(f); f.control.archiveLifecycleHistory(f.transport, f.agent.agentId);
  const message = "new intent", sessionId = randomUUID();
  for (const [taskId, rootRequestId] of [[d.task.id, randomUUID()], [randomUUID(), d.command.rootRequestId]]) {
    const command = f.draft({ action: "task.dispatch", taskId, conversationId: sessionId, messageDigest: agentCommandMessageDigest(sessionId, message) }, { rootRequestId });
    const begun = f.control.begin(f.transport, command, { message }); assert.equal(f.control.rejectBlocked(begun.intake).error.code, "COMMAND_ID_CONFLICT");
  }
  const next = f.recover(d); next.accept(); f.control.abortBeforeExecution(next.prepared); f.control.archiveLifecycleHistory(f.transport, f.agent.agentId);
  const before = f.snapshot(), duplicate = f.control.beginRecovery(f.transport, next.recovery, next.command, { message: next.message });
  assert.equal(duplicate.intake, undefined); assert.equal(duplicate.receipt.commandId, next.command.commandId); assert.deepEqual(f.snapshot(), before);
});

test("C4 logical dismissal and subsequent history retirement retain management provenance without allowing restore", t => {
  const f = lifecycleFixture(t, { colleague: true }), d = abort(f), dismiss = f.draft({ action: "agent.dismiss", retention: "keep_records_and_recovery" });
  f.apply(dismiss); f.control.reconcileLifecycleOperation(dismiss.commandId);
  assert.equal(f.resources.agents.get(f.agent.agentId).state, "archived");
  const result = f.control.archiveLifecycleHistory(f.transport, f.agent.agentId); assert.ok(result.published > 0);
  assert.equal(f.control.archiveLifecycleHistory(f.transport, f.agent.agentId).published, 0);
  assert.ok(f.control.readReceipt(f.transport, f.agent.agentId, dismiss.commandId)); assert.equal(f.snapshot().control.agents.find(row => row.agentId === f.agent.agentId).dismissed, true);
});


test("C5 M1 receipt lookup includes retired commands and corrupt history cannot prove an ID unseen", t => {
  const f = lifecycleFixture(t), run = abort(f), id = run.command.commandId;
  f.control.acknowledgeAudit(f.transport, f.agent.agentId, f.control.audit(f.transport, f.agent.agentId).map(row => row.eventId));
  f.control.archiveLifecycleHistory(f.transport, f.agent.agentId);
  assert.ok(f.snapshot().lifecycle.retiredCommands.some(row => row.commandId === id));
  const seen = f.control.lookupReceipt(f.transport, f.agent.agentId, id);
  assert.equal(seen.state, "seen"); assert.deepEqual(seen.receipt, f.control.readReceipt(f.transport, f.agent.agentId, id));
  const file = historyFile(f), saved = fs.readFileSync(file); fs.writeFileSync(file, "corrupt synthetic history");
  try { assert.throws(() => f.control.lookupReceipt(f.transport, f.agent.agentId, randomUUID()), code("AUTHORITY_UNVERIFIED")); }
  finally { fs.writeFileSync(file, saved); }
});
