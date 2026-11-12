import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lifecycleHostFixture, until } from "./helpers/agent-lifecycle-host-fixture.mjs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";

test("C4 actual Host closes the stopped job's genuine pending approval and keeps another Workspace's card and provider alive", async t => {
  const f = await lifecycleHostFixture(t); let release; const waiting = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const transports = new AgentBoundaryTransports(f.ownerCredential), transport = transports.connect("approval_owner", f.ownerCredential);
  const entered = new Set();
  const peer = new LocalWorkspaceHost(f.root, { boundaryTransports: transports, boundaryCommandControl: true, boundaryLifecycleControl: true,
    providerFactory: (connection, binding, context) => ({ id: "openai", model: binding.model, async turn() { entered.add(context.agent.agentId); await waiting; return { text: "done", toolUses: [], stop: "end", usage: { input: 1, output: 1 } }; } }) });
  try {
    peer.agentBoundaryView(transport, f.params.workspaceId, f.params.agentId);
    const second = peer.createWorkspace("Other", peer.catalog.read().revision), w2 = second.workspaceId, a2 = second.selectedAgentId, agent = second.agents.find(row => row.agentId === a2);
    peer.setAgentPermissionTier(w2, a2, "controlled", agent.configRevision, agent.agentEpoch); peer.configureSynthetic(w2, 0);
    const template = peer.agentBoundaryView(transport, f.params.workspaceId, f.params.agentId).policy, view = peer.prepareAgentBoundaryProject(transport, w2, a2);
    const duty = structuredClone(template.duty), boundary = structuredClone(template.boundary);
    for (const doc of [duty, boundary]) { doc.agentId = a2; doc.context = view.context; } boundary.resources = [{ resourceId: view.resources[0].resourceId, access: ["read", "write"] }];
    peer.configureAgentBoundary(transport, w2, a2, { expectedRevision: view.revision, duty, boundary, rights: { manage: true, invoke: true, privateRead: true, nodeUse: true } }); peer.initializeAgentCommandControl(transport, w2, a2);
    const dispatch = (workspaceId, agentId, clientId) => {
      peer.select(clientId, workspaceId, peer.catalog.read().revision, true);
      const message = "hello", command = peer.draftAgentBoundaryCommand(transport, workspaceId, agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
        operation: { action: "task.dispatch", taskId: randomUUID(), conversationId: agentId.slice(3), messageDigest: agentCommandMessageDigest(agentId.slice(3), message) } });
      peer.submitAgentBoundaryCommand(clientId, transport, workspaceId, agentId, command, { message }); return command;
    };
    const d1 = dispatch(f.params.workspaceId, f.params.agentId, "view_one"), d2 = dispatch(w2, a2, "view_two");
    const j1 = [...peer.jobs.values()].find(row => row.workspaceId === f.params.workspaceId), j2 = [...peer.jobs.values()].find(row => row.workspaceId === w2); assert.ok(j1?.permit); assert.ok(j2?.permit);
    await until(() => entered.has(f.params.agentId) && entered.has(a2));
    // Real Host approval factory and genuine owned jobs. No fabricated approval or permission object.
    const p1 = peer.approval(j1, { content: "one", scope: "project" }, "memory_promote"), p2 = peer.approval(j2, { content: "two", scope: "project" }, "memory_promote");
    assert.equal(peer.pending.size, 2); const other = [...peer.pending.values()].find(row => row.job === j2).card;
    const status = peer.agentCommandStatus(transport, f.params.workspaceId, f.params.agentId).runs[0], stop = peer.draftAgentBoundaryCommand(transport, f.params.workspaceId, f.params.agentId,
      { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000, operation: { action: "task.stop", taskId: status.taskId, runId: status.runId, claimRevision: 1 } });
    peer.submitAgentBoundaryCommand("view_one", transport, f.params.workspaceId, f.params.agentId, stop, {});
    assert.deepEqual(await p1, { approved: false, state: "aborted" }); assert.equal(j1.signal.aborted, true);
    assert.equal(j2.signal.aborted, false); assert.equal(peer.pending.size, 1); assert.equal(peer.pending.has(other.id), true);
    assert.throws(() => peer.answerApproval("view_one", f.params.workspaceId, other.id, true)); assert.equal(peer.pending.has(other.id), true);
    release(); await Promise.all([peer.wait(j1.id), peer.wait(j2.id)]); await p2;
    assert.equal(peer.agentCommandReceipt(transport, f.params.workspaceId, f.params.agentId, d1.commandId).execution.drain, "observed");
    assert.equal(peer.agentCommandReceipt(transport, w2, a2, d2.commandId).execution.drain, "observed");
  } finally { release(); await peer.close(); transports.close(); }
});
