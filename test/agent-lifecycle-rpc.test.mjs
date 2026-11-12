import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { once } from "node:events";
import { lifecycleHostFixture } from "./helpers/agent-lifecycle-host-fixture.mjs";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
const boundary = code => error => error.data?.boundary?.code === code;

test("C4 real RPC returns only bound lifecycle facts and refuses guests, wrong generation, source claims and extra fields", async t => {
  const f = await lifecycleHostFixture(t), projection = await f.owner.request("workspace.boundaries.lifecycle.get", f.params);
  assert.equal(projection.kind, "agent-lifecycle-projection"); assert.equal(projection.context.scope.workspaceId, f.params.workspaceId);
  assert.equal(projection.context.resourceBinding.generation, f.params.expectedGeneration); assert.equal(projection.productionEnabled, false);
  assert.equal(f.init.capabilities.includes("workspace.agent-lifecycle.v1"), true);
  const guest = await f.open(); await assert.rejects(guest.request("initialize", { token: f.handle.token }), boundary("AUTHORITY_UNVERIFIED"));
  for (const method of ["get", "reconcile", "recovery.draft", "history.archive"]) await assert.rejects(guest.request(`workspace.boundaries.lifecycle.${method}`, f.params), error => error.message === "unauthorized");
  await assert.rejects(f.owner.request("workspace.boundaries.lifecycle.get", { ...f.params, expectedGeneration: randomUUID() }));
  for (const extra of [{ approved: true }, { provenance: { kind: "local_human" } }, { proofRef: "self_claimed" }]) await assert.rejects(f.owner.request("workspace.boundaries.lifecycle.get", { ...f.params, ...extra }));
  assert.equal(f.calls(), 0); assert.equal(f.providers(), 0);
});

test("C4 real WS recovery consumes a genuine pre-issuance terminal once and preserves the old journal and archived identity", async t => {
  const f = await lifecycleHostFixture(t), save = WorkspaceConversationStore.prototype.save; let interrupted = false;
  WorkspaceConversationStore.prototype.save = function (...args) {
    const actual = save.apply(this, args);
    if (!interrupted && actual.task?.workspaceRunBinding) { interrupted = true; throw new Error("synthetic projection publication cut"); }
    return actual;
  };
  let d;
  try { d = await f.dispatch("hello"); assert.equal((await f.submit(d.command, d.message)).status, "accepted"); }
  finally { WorkspaceConversationStore.prototype.save = save; }
  assert.equal(f.calls(), 0); const original = await f.owner.request("workspace.boundaries.lifecycle.get", f.params), run = original.runs[0];
  assert.equal(run.execution, "aborted_before_execution"); assert.equal(run.physical, "lease_released");
  assert.equal(run.commandId, d.command.commandId); assert.equal(run.rootRequestId, d.command.rootRequestId);
  await f.owner.request("workspace.boundaries.lifecycle.history.archive", { ...f.params, maximum: 1 });
  const archived = await f.owner.request("workspace.boundaries.lifecycle.get", f.params); assert.equal(archived.archived[0].runId, run.runId);
  const next = await f.owner.request("workspace.boundaries.lifecycle.recovery.draft", { ...f.params, input: { operationId: randomUUID(), previousRunId: run.runId,
    expectedClaimRevision: 1, commandId: randomUUID(), rootRequestId: randomUUID(), message: "hello", lifetimeMs: 30000 } });
  const submitted = await f.owner.request("workspace.boundaries.lifecycle.recovery.submit", { ...f.params, ...next, message: "hello" }); assert.equal(submitted.status, "accepted");
  const { until } = await import("./helpers/agent-lifecycle-host-fixture.mjs"); await until(async () => (await f.receipt(next.command)).execution.drain === "observed");
  const calls = f.calls(); assert.equal(calls, 1);
  await f.owner.request("workspace.boundaries.lifecycle.recovery.submit", { ...f.params, ...next, message: "hello" }); assert.equal(f.calls(), calls);
  const after = await f.owner.request("workspace.boundaries.lifecycle.get", f.params); assert.equal(after.runs.find(row => row.commandId === next.command.commandId).claimRevision, 2);
  assert.equal(after.archived[0].runId, run.runId); assert.deepEqual(after.archived[0].recovery, ["query_original"]);
  assert.equal((await f.receipt(d.command)).status, "accepted");
});

test("C4 default bootstrap is absent and invalid lifecycle-only bootstrap is refused before source creation", async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c4-off-"))), invalid = join(root, "invalid"), credential = randomBytes(32).toString("hex");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => new LocalWorkspaceHost(invalid, { boundaryLifecycleControl: true })); assert.equal(fs.existsSync(invalid), false);
  await assert.rejects(startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root: invalid, version: "C4-test", agentBoundaries: { lifecycleControl: true, ownerCredential: credential } }));
  assert.equal(fs.existsSync(invalid), false);
  fs.mkdirSync(join(root, "default"), { mode: 0o700 });
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root: join(root, "default"), version: "C4-test" });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); socket.on("error", () => {}); await once(socket, "open");
  try {
    const result = once(socket, "message"); socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { token: handle.token } }));
    const init = JSON.parse((await result)[0].toString()).result; assert.equal(init.capabilities.includes("workspace.agent-lifecycle.v1"), false);
  } finally { socket.terminate(); await handle.close(); }
});

for (const missing of ["manage", "invoke", "nodeUse"]) test(`C4 explicit recovery independently requires current ${missing}`, async t => {
  const { lifecycleFixture } = await import("./helpers/agent-lifecycle-fixture.mjs");
  // Authorize the original acceptance. Change current rights through the real C3 boundary path.
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept(); f.control.abortBeforeExecution(d.prepared);
  const proposal = { duty: f.duty, boundary: f.boundary, rights: { ...f.rights, [missing]: false } }, { agentPolicyProposalDigest } = await import("../dist/workspace/agent-command-state.js");
  const update = f.draft({ action: "boundary.update", proposedBoundaryDigest: agentPolicyProposalDigest(proposal) }); assert.equal(f.apply(update, proposal).status, "applied");
  assert.throws(() => f.control.draftRecovery(f.transport, f.agent.agentId, { operationId: randomUUID(), previousRunId: d.binding.runId, expectedClaimRevision: 1,
    commandId: randomUUID(), rootRequestId: randomUUID(), message: "new explicit intent", lifetimeMs: 30000 }));
  assert.equal(f.snapshot().control.runs.length, 1); assert.equal(f.snapshot().control.runs[0].claimRevision, 1);
});
