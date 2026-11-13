import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { routingHostFixture, routingUntil } from "./helpers/agent-routing-host-fixture.mjs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { WorkspaceAgentRouting } from "../dist/workspace/agent-routing.js";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
const hash = value => createHash("sha256").update(value).digest("hex");

function evidence(caseId, f, data, extra = {}) {
  const state = f.state(), route = state.routing.records.find(row => row.workItemId === data.workItemId);
  const run = state.control.runs.find(row => row.commandId === route.commandId), execution = state.lifecycle.executions.find(row => row.runId === run.runId);
  console.log("C13_JOINT_CASE " + JSON.stringify({ schemaVersion: 1, caseId, workspaceId: f.common.workspaceId, generation: f.common.expectedGeneration,
    workItemId: route.workItemId, rootRequestId: route.rootRequestId, commandId: route.commandId, taskId: route.taskId, runId: run.runId,
    ownerAgentId: route.ownerAgentId, claimRevision: run.claimRevision, providerFactories: f.providers.length, modelCalls: f.calls.length,
    classificationCalls: 0, lifecycle: { phase: execution.phase, leaseReleased: execution.leaseReleased }, ...extra }));
}

test("C13 joint two real Hosts cross the selected barrier and read one genuine claim without duplicate business execution", { timeout: 45000 }, async t => {
  let releaseModel, releaseBarrier;
  const model = new Promise(resolve => { releaseModel = resolve; }), barrier = new Promise(resolve => { releaseBarrier = resolve; });
  const f = await routingHostFixture(t, { turn: async () => { await model; return { text: "one original work item", toolUses: [], stop: "end" }; } });
  const data = f.data(), transports = new AgentBoundaryTransports(f.ownerCredential), transport = transports.connect("independent_actual_host", f.ownerCredential);
  const peer = new LocalWorkspaceHost(f.root, { boundaryTransports: transports, boundaryCommandControl: true, boundaryLifecycleControl: true,
    boundaryRouting: { automaticAgentIds: () => f.members }, providerFactory: f.bootstrap.providerFactory });
  peer.agentBoundaryView(transport, f.common.workspaceId, f.members[0]);
  const classify = WorkspaceAgentRouting.prototype.classify; let arrivals = 0;
  WorkspaceAgentRouting.prototype.classify = async function (auth, input) {
    const actual = await classify.call(this, auth, input);
    if (input.workItemId === data.workItemId && actual.state === "selected") {
      arrivals++; if (arrivals === 2) releaseBarrier(); await barrier;
    }
    return actual; // Actual C1/C6 result, not a substituted permit or classifier decision.
  };
  try {
    let views;
    await assert.doesNotReject(async () => { views = await Promise.all([f.submit(data), peer.submitAgentRouting("independent_actual_host", transport, f.common.workspaceId, data)]); },
      "a competing genuine original claim must remain readable after real admission conflict");
    assert.equal(arrivals, 2, "both actual Hosts must reach selected before either may dispatch");
    assert.deepEqual(views[0].claim, views[1].claim); assert.ok(views[0].claim);
    await routingUntil(() => f.calls.length === 1);
    const before = f.state(), route = before.routing.records[0], run = before.control.runs[0];
    assert.equal(route.ownerAgentId, f.members[0]); assert.equal(before.routing.records.length, 1); assert.equal(before.control.runs.length, 1);
    assert.equal(run.binding.sessionId, channelSessionId(f.channelId, f.members[0])); assert.deepEqual(f.providers, [f.members[0]]);
    const repeated = await peer.submitAgentRouting("independent_actual_host", transport, f.common.workspaceId,
      { ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1]] });
    assert.deepEqual(repeated.claim, views[0].claim); assert.equal(f.state().routing.records[0].commandId, route.commandId);
    assert.deepEqual(f.providers, [f.members[0]]); assert.equal(f.calls.length, 1);
    releaseModel(); await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed");
    assert.equal(f.state().control.runs.length, 1); assert.equal(f.state().lifecycle.executions[0].leaseReleased, true);
    evidence("L06-two-host-original-claim", f, data, { selectedArrivals: arrivals, originalPhysicalSession: run.binding.sessionId });
  } finally {
    releaseBarrier(); releaseModel(); WorkspaceAgentRouting.prototype.classify = classify;
    await peer.close(); transports.close();
  }
});

// Outer bound only: both waits inside are progress-aware (a stalled run fails after 30 s without an
// observable change). Measured 2026-11-13: ~10 s at low load, 49.6 s while still progressing at load1 ~30
// with four files in parallel, which the former 45 s bound cut off. 110 s stays under the 120 s file limit.
test("C13 joint real WS routing and C2 IO retain the original owner while audience revocation refuses the next real file effect", { timeout: 110000 }, async t => {
  let resume; const continueResponse = new Promise(resolve => { resume = resolve; }); let paused = false, f;
  f = await routingHostFixture(t, { provider(connection, binding, context) {
    const synthetic = createWorkspaceSyntheticProvider(connection, binding, context);
    return { ...synthetic, async turn(args) {
      const run = f.state().control.runs.find(row => row.agentId === context.agent.agentId), beforeFile = join(run.binding.project.root, "hello.md");
      if (!paused && fs.existsSync(beforeFile)) {
        paused = true; await continueResponse;
        const write = args.tools.find(tool => tool.name.replace(/^mcp__hara__/, "") === "workspace_write"); assert.ok(write);
        return { text: "", toolUses: [{ id: `call_${randomUUID()}`, name: write.name, input: { path: "after-removal.txt", content: "must never be written" } }],
          stop: "tool_use", usage: { input: 1, output: 1 } };
      }
      return synthetic.turn(args);
    } };
  } });
  const data = f.data("Write hello.md and verify the file", { explicitAgentIds: [f.members[0]] });
  try {
    const accepted = await f.submit(data); assert.equal(accepted.state, "claimed");
    // Progress: the authority state (routing/control/lifecycle) and the owner's channel conversation change
    // as the real routed run starts, writes and calls the model; a stalled run still fails after the idle window.
    const progress = () => JSON.stringify([f.state(), f.conversation(f.members[0]).revision, f.providers.length]);
    await routingUntil(() => paused, progress);
    const before = f.state(), route = before.routing.records[0], run = before.control.runs[0];
    const file = join(run.binding.project.root, "hello.md"), forbidden = join(run.binding.project.root, "after-removal.txt");
    assert.equal(fs.readFileSync(file, "utf8"), "hello workspace\n"); const firstDigest = hash(fs.readFileSync(file));
    f.rooms.update(f.channelId, "Original owner removed after first actual IO", f.members.slice(1), f.rooms.list().revision);
    resume(); await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed", progress);
    assert.equal(fs.existsSync(forbidden), false); assert.equal(hash(fs.readFileSync(file)), firstDigest);
    const observed = await f.read(data); assert.equal(observed.state, "blocked"); assert.equal(observed.reason, "unknown_effect");
    assert.equal(observed.effectObservation, "unknown"); assert.equal(observed.receipt.status, "unknown");
    const repeated = await f.submit({ ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1]] }); assert.equal(repeated.state, "blocked");
    const after = f.state(); assert.equal(after.routing.records.length, 1); assert.equal(after.control.runs.length, 1);
    assert.equal(after.routing.records[0].ownerAgentId, route.ownerAgentId); assert.equal(after.routing.records[0].commandId, route.commandId);
    assert.equal(after.routing.records[0].taskId, route.taskId); assert.deepEqual(f.providers, [f.members[0]]);
    assert.equal(after.control.runs[0].effect, "unknown"); assert.equal(repeated.effectObservation, "unknown");
    assert.equal(after.lifecycle.executions[0].leaseReleased, true);
    evidence("L08-audience-current-at-actual-effect", f, data, { beforeFileSha256: firstDigest, afterFileExists: false, closedAfterRevocation: true, effectObservation: observed.effectObservation, receiptStatus: observed.receipt.status });
  } finally { resume(); }
});
