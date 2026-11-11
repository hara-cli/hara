import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
import { lifecycleHostFixture, until } from "./helpers/agent-lifecycle-host-fixture.mjs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { AgentBoundaryContractError } from "../dist/workspace/agent-boundaries-contract.js";
import { closeWorkspaceRunPermit, workspaceRunDrainProof, executeWorkspaceTool } from "../dist/workspace/execution.js";
const code = value => error => error instanceof AgentBoundaryContractError && error.code === value;

test("C4 persistence fences issuance before the first real gate and publishes quiescence before lease release", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept();
  assert.equal(f.snapshot().lifecycle.executions[0].phase, "prepared");
  const capture = f.authority.captureExecutionPolicy.bind(f.authority);
  f.authority.captureExecutionPolicy = grant => {
    assert.equal(f.snapshot().lifecycle.executions[0].phase, "issued");
    assert.ok(f.snapshot().lifecycle.executions[0].issuanceRef); return capture(grant);
  };
  const r = d.runtime(); await r.call("workspace_write", { path: "once.txt", content: "one effect" });
  const observe = f.control.observeQuiescence.bind(f.control); let published = 0;
  f.control.observeQuiescence = proof => {
    d.lease.assertCurrent(); observe(proof); published++;
    assert.ok(f.snapshot().lifecycle.executions[0].quiescence);
    assert.equal(f.snapshot().lifecycle.executions[0].leaseReleased, false); d.lease.assertCurrent();
  };
  await closeWorkspaceRunPermit(r.permit); assert.equal(published, 1);
  assert.throws(() => d.lease.assertCurrent());
  f.control.observeDrained(workspaceRunDrainProof(r.permit));
  assert.equal(f.snapshot().lifecycle.executions[0].leaseReleased, true);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).execution.drain, "observed");
  assert.equal(fs.readFileSync(join(f.project, "once.txt"), "utf8"), "one effect");
});

test("C4 exact task stop keeps a non-cooperative real operation leased and lets a sibling still write", async t => {
  let release, entered; const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = lifecycleFixture(t), d = f.dispatch(), sibling = f.dispatch("sibling"); d.accept(); sibling.accept(); const r = d.runtime(), s = sibling.runtime();
  const operation = executeWorkspaceTool(r.permit, "workspace_write", async input => {
    const result = await r.files.find(tool => tool.name === "workspace_write").run(input, { cwd: f.project }); entered(); await waiting; return result;
  }, undefined, { path: "inflight.txt", content: "already committed once" }, randomUUID());
  void operation.catch(() => {}); await ready;
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 }); f.apply(stop);
  f.control.observeLifecycleNotification(stop.commandId, d.binding.runId, r.permit);
  let closed = false; const closing = closeWorkspaceRunPermit(r.permit).then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(closed, false); d.lease.assertCurrent();
  assert.throws(() => workspaceRunDrainProof(r.permit), code("AUTHORITY_UNVERIFIED"));
  await s.call("workspace_write", { path: "sibling.txt", content: "still allowed" });
  assert.equal(fs.readFileSync(join(f.project, "sibling.txt"), "utf8"), "still allowed");
  release(); await assert.rejects(operation); await closing; f.control.observeDrained(workspaceRunDrainProof(r.permit));
  assert.equal(f.snapshot().control.runs.find(run => run.runId === d.binding.runId).effect, "unknown");
  assert.equal(fs.readFileSync(join(f.project, "inflight.txt"), "utf8"), "already committed once");
});

test("C4 failed positive-proof publication retains the physical owner and only original closure can be reconciled", async t => {
  const f = lifecycleFixture(t), d = f.dispatch(); d.accept(); const r = d.runtime();
  await r.call("workspace_write", { path: "not-replayed.txt", content: "one" });
  const publish = f.authority.observeCommandControl.bind(f.authority);
  f.authority.observeCommandControl = () => { throw new AgentBoundaryContractError("STALE_REVISION", "test.concurrent_writer"); };
  await assert.rejects(closeWorkspaceRunPermit(r.permit), code("STALE_REVISION")); d.lease.assertCurrent();
  assert.equal(f.snapshot().lifecycle.executions[0].quiescence, null);
  assert.throws(() => f.control.observeQuiescence({ proofRef: "approved", quiescent: true }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.reconcileLifecycleLease(f.transport, "other_run"), code("AUTHORITY_UNVERIFIED"));
  f.authority.observeCommandControl = publish;
  f.control.reconcileLifecycleLease(f.transport, d.binding.runId);
  assert.throws(() => d.lease.assertCurrent());
  const row = f.snapshot().control.runs[0]; assert.equal(row.state, "drained"); assert.equal(row.effect, "unknown");
  assert.equal(f.snapshot().lifecycle.executions[0].leaseReleased, true);
  assert.throws(() => f.control.observeQuiescence(structuredClone(f.snapshot().lifecycle.executions[0].quiescence)), code("AUTHORITY_UNVERIFIED"));
  await closeWorkspaceRunPermit(r.permit); // Finishes only the original genuine closer after reconciliation.
  assert.equal(fs.readFileSync(join(f.project, "not-replayed.txt"), "utf8"), "one");
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).execution.effect, "unknown");
});

test("C4 resume checks incomplete physical closure in the same CAS and main cannot be dismissed", async t => {
  const f = lifecycleFixture(t), mainDismiss = f.draft({ action: "agent.dismiss", retention: "keep_records_and_recovery" });
  const denied = f.apply(mainDismiss); assert.equal(denied.status, "rejected"); assert.equal(denied.error.code, "AUTHORIZATION_DENIED");
  assert.equal(f.snapshot().control.agents[0].hold, null); assert.equal(f.resources.agents.get(f.agent.agentId).state, "active");
  const d = f.dispatch(); d.accept(); const r = d.runtime(), pause = f.draft({ action: "agent.pause", reason: "human_request" }), held = f.apply(pause);
  const resume = f.draft({ action: "agent.resume", holdId: held.control.holdId }), result = f.apply(resume);
  assert.equal(result.status, "rejected"); assert.equal(result.error.code, "CONTROL_HELD");
  assert.equal(f.snapshot().control.agents[0].hold.holdId, held.control.holdId);
  await assert.rejects(r.call("workspace_write", { path: "denied.txt", content: "never" })); assert.equal(fs.existsSync(join(f.project, "denied.txt")), false);
});

test("C4 a second genuine Host persists exact stop and the owning Host actually aborts its pending provider", async t => {
  let release, entered, sawAbort; const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; }), aborted = new Promise(resolve => { sawAbort = resolve; });
  t.after(() => release());
  const f = await lifecycleHostFixture(t, { provider: binding => ({ id: "openai", model: binding.model, async turn(args) {
    assert.ok(args.signal); args.signal.addEventListener("abort", sawAbort, { once: true }); entered(); await waiting;
    return { text: "late", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
  } }) });
  const d = await f.dispatch("hello"); await f.submit(d.command, d.message); await ready;
  const transportOwner = new AgentBoundaryTransports(f.ownerCredential), transport = transportOwner.connect("second_real_host", f.ownerCredential);
  const peer = new LocalWorkspaceHost(f.root, { boundaryTransports: transportOwner, boundaryCommandControl: true, boundaryLifecycleControl: true });
  try {
    const run = (await f.inspect()).runs[0];
    const stop = peer.draftAgentBoundaryCommand(transport, f.params.workspaceId, f.params.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
      operation: { action: "task.stop", taskId: run.taskId, runId: run.runId, claimRevision: run.claimRevision } });
    const accepted = peer.submitAgentBoundaryCommand("second_real_host", transport, f.params.workspaceId, f.params.agentId, stop, {});
    assert.equal(accepted.execution.drain, "pending");
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("owning Host did not receive persisted stop")), 10000))]);
    assert.notEqual((await f.receipt(stop)).execution.drain, "observed"); assert.equal(f.calls(), 1);
    release(); await until(async () => (await f.receipt(stop)).execution.drain === "observed");
    const before = f.calls(); await f.submit(d.command, d.message); assert.equal(f.calls(), before);
  } finally { release(); await peer.close(); transportOwner.close(); }
});
