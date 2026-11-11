import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lifecycleHostFixture } from "./helpers/agent-lifecycle-host-fixture.mjs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceRequestJournal } from "../dist/workspace/request-journal.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";

async function peerFixture(t) {
  const f = await lifecycleHostFixture(t), transports = new AgentBoundaryTransports(f.ownerCredential), transport = transports.connect("recovery_owner", f.ownerCredential);
  let calls = 0;
  const peer = new LocalWorkspaceHost(f.root, { boundaryTransports: transports, boundaryCommandControl: true, boundaryLifecycleControl: true,
    providerFactory: (connection, binding) => ({ id: "openai", model: binding.model, async turn() { calls++;
      return { text: "hello", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    } }) });
  peer.agentBoundaryView(transport, f.params.workspaceId, f.params.agentId);
  const context = peer.contexts.get(f.params.workspaceId), control = context.commandControl; // Inspect real Host state, never install a fake grant/source.
  const draft = async () => { const template = await f.dispatch("hello"); return peer.draftAgentBoundaryCommand(transport, f.params.workspaceId, f.params.agentId,
    { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000, operation: template.command.operation }); };
  const submit = command => peer.submitAgentBoundaryCommand("recovery_owner", transport, f.params.workspaceId, f.params.agentId, command, { message: "hello" });
  return { f, peer, context, transport, transports, draft, submit, calls: () => calls };
}

test("C4 actual Host repairs a post-projection N5, keeps accepted journal and only explicit new claim can execute", async t => {
  const h = await peerFixture(t), { f, peer, context, transport } = h, save = WorkspaceConversationStore.prototype.save;
  const store = new WorkspaceConversationStore(context.storage, f.params.agentId); let interrupted = false;
  WorkspaceConversationStore.prototype.save = function (...args) {
    const actual = save.apply(this, args), snapshot = context.boundaryAuthority.commandControlState();
    if (!interrupted && snapshot.lifecycle.executions.some(row => row.phase === "prepared" && row.runId === actual.task?.workspaceRunBinding?.runId)) {
      interrupted = true; throw new Error("synthetic startup failure after durable conversation projection");
    }
    return actual;
  };
  try {
    const command = await h.draft(), accepted = h.submit(command); assert.equal(accepted.status, "accepted"); assert.equal(h.calls(), 0); assert.equal(interrupted, true);
    const first = context.boundaryAuthority.commandControlState(), run = first.control.runs.find(row => row.commandId === command.commandId), execution = first.lifecycle.executions.find(row => row.runId === run.runId);
    assert.equal(execution.phase, "aborted_before_execution"); assert.equal(execution.leaseReleased, true);
    const journal = new WorkspaceRequestJournal(context.storage, f.params.agentId); assert.equal(journal.find(run.requestId).state, "accepted");
    const original = store.read(); assert.equal(original.attempt.state, "blocked"); assert.equal(original.task.status, "blocked");
    const ordinary = peer.draftAgentBoundaryCommand(transport, f.params.workspaceId, f.params.agentId,
      { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000, operation: command.operation });
    assert.equal(h.submit(ordinary).status, "rejected"); assert.equal(h.calls(), 0);
    WorkspaceConversationStore.prototype.save = save;
    const recovery = peer.draftAgentLifecycleRecovery(transport, f.params.workspaceId, f.params.agentId,
      { operationId: randomUUID(), previousRunId: run.runId, expectedClaimRevision: 1, commandId: randomUUID(), rootRequestId: randomUUID(), message: "hello", lifetimeMs: 30000 });
    const next = peer.submitAgentLifecycleRecovery("recovery_owner", transport, f.params.workspaceId, f.params.agentId, recovery.recovery, recovery.command, { message: "hello" });
    assert.equal(next.status, "accepted");
    const nextRun = context.boundaryAuthority.commandControlState().control.runs.find(row => row.commandId === recovery.command.commandId); assert.equal(nextRun.claimRevision, 2);
    await peer.wait(nextRun.runId); assert.equal(h.calls(), 1);
    const after = store.read(); assert.equal(after.task.id, original.task.id); assert.equal(after.task.workspaceRunBinding.runId, nextRun.runId);
    assert.deepEqual(after.pastTasks[0].task, original.task); assert.deepEqual(after.requests.slice(0, 1), original.requests);
    assert.equal(journal.find(run.requestId).state, "accepted");
    peer.submitAgentLifecycleRecovery("recovery_owner", transport, f.params.workspaceId, f.params.agentId, recovery.recovery, recovery.command, { message: "hello" }); assert.equal(h.calls(), 1);
  } finally { WorkspaceConversationStore.prototype.save = save; await peer.close(); h.transports.close(); }
});

test("C4 actual Host preserves post-issuance UNKNOWN and does not acquire another lease for a new message", async t => {
  const h = await peerFixture(t), { f, peer, context, transport } = h, capture = context.boundaryAuthority.captureExecutionPolicy.bind(context.boundaryAuthority);
  context.boundaryAuthority.captureExecutionPolicy = grant => { capture(grant); throw new Error("synthetic failure after durable issuance"); };
  try {
    const command = await h.draft(), receipt = h.submit(command); assert.equal(receipt.status, "unknown"); assert.equal(h.calls(), 0);
    const snapshot = context.boundaryAuthority.commandControlState(), run = snapshot.control.runs.find(row => row.commandId === command.commandId), execution = snapshot.lifecycle.executions.find(row => row.runId === run.runId);
    assert.equal(run.effect, "unknown"); assert.ok(run.hold); assert.equal(execution.phase, "issued"); assert.equal(execution.terminal, null); assert.equal(execution.leaseReleased, false);
    assert.equal(new WorkspaceRequestJournal(context.storage, f.params.agentId).find(run.requestId).state, "accepted");
    assert.throws(() => WorkspaceSessionLease.acquire(context.storage, run.binding.sessionId));
    const next = await h.draft(); assert.equal(h.submit(next).status, "rejected"); assert.equal(h.calls(), 0);
    assert.throws(() => peer.draftAgentLifecycleRecovery(transport, f.params.workspaceId, f.params.agentId,
      { operationId: randomUUID(), previousRunId: run.runId, expectedClaimRevision: 1, commandId: randomUUID(), rootRequestId: randomUUID(), message: "hello", lifetimeMs: 30000 }));
    assert.equal(new WorkspaceConversationStore(context.storage, f.params.agentId).read().attempt.state, "draining");
  } finally { context.boundaryAuthority.captureExecutionPolicy = capture; await peer.close(); h.transports.close(); }
});
