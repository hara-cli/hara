import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { routingHostFixture, routingUntil, boundary } from "./helpers/agent-routing-host-fixture.mjs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";

test("C6 two real Hosts compete for the same physical scope and publish exactly one business claim", async t => {
  const f = await routingHostFixture(t), transports = new AgentBoundaryTransports(f.ownerCredential);
  const peer = new LocalWorkspaceHost(f.root, { boundaryTransports: transports, boundaryCommandControl: true, boundaryLifecycleControl: true,
    boundaryRouting: f.bootstrap.agentBoundaries.routing, providerFactory: f.bootstrap.providerFactory });
  await peer.initialize(); const transport = transports.connect("genuine_second_host", f.ownerCredential);
  t.after(async () => { await peer.close(); transports.close(); });
  const data = f.data(), views = await Promise.all([f.submit(data), peer.submitAgentRouting("second_host", transport, f.common.workspaceId, data)]);
  assert.ok(views.every(view => view.ownerAgentId === f.members[0])); assert.deepEqual(views[0].claim, views[1].claim);
  await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed");
  assert.equal(f.state().control.runs.length, 1); assert.equal(f.providers.length, 1); assert.equal(f.calls.length, 1);
});

test("C6 actual WS classification is one no-tool public call, then one separately claimed business owner", async t => {
  const routingCalls = []; let f;
  const classifier = { providerRef: "synthetic-origin-v1", budgetRef: "routing-fixture", timeoutMs: 1000, maxInputBytes: 8192, maxOutputTokens: 64,
    async invoke(request) { routingCalls.push(request); return { text: JSON.stringify({ candidateId: f.members[2] }), toolUses: [], providerRequestRef: "original-call" }; } };
  f = await routingHostFixture(t, { classifier }); const data = f.data("A new authorized request with no duty keywords"), result = await f.submit(data);
  assert.equal(result.ownerAgentId, f.members[2]); assert.equal(result.method, "classification"); assert.equal(result.decision.reason, "current_owner"); assert.equal(result.classification.phase, "completed");
  await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed");
  assert.equal(routingCalls.length, 1); assert.deepEqual(routingCalls[0].tools, []); assert.equal(routingCalls[0].maxOutputTokens, 64);
  assert.ok(!JSON.stringify(routingCalls[0].payload).includes("PRIVATE_")); assert.equal(routingCalls[0].payload.candidates.length, 3);
  assert.deepEqual(f.providers, [f.members[2]]); assert.equal(f.calls.length, 1);
  await f.submit({ ...data, requestId: randomUUID() }); assert.equal(routingCalls.length, 1); assert.equal(f.calls.length, 1);
});

test("C6 real routing RPC rejects a fabricated C0/Hub source and cannot enable classification through request fields", async t => {
  const f = await routingHostFixture(t), data = f.data("unmatched");
  for (const extra of [{ actor: { kind: "external-agent" }, humanPrincipal: null }, { classifier: { enabled: true } }, { routingPermit: {} }, { approved: true }]) {
    await assert.rejects(f.owner.request("workspace.boundaries.routing.submit", { ...f.common, input: data, ...extra }));
    await assert.rejects(f.submit({ ...data, ...extra }), boundary("INVALID_DOCUMENT"));
  }
  await assert.rejects(f.owner.request("workspace.boundaries.routing.get", { ...f.common, expectedGeneration: randomUUID(), channelId: f.channelId, workItemId: data.workItemId }));
  assert.equal(f.calls.length, 0); assert.equal(f.providers.length, 0); assert.equal(f.state().routing.records.length, 0);
});
