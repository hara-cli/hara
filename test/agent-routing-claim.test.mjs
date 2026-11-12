import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { routingFixture } from "./helpers/agent-routing-fixture.mjs";
import { commandDigest } from "../dist/workspace/agent-command-state.js";
import { agentRoutingWorkKey } from "../dist/workspace/agent-routing-state.js";
import { WorkspaceAgentRouting } from "../dist/workspace/agent-routing.js";
import { closeWorkspaceRunPermit } from "../dist/workspace/execution.js";
const code = c => error => error.code === c;

test("C6 checks actual audience before directory, private context or ownership mutation", t => {
  const f = routingFixture(t), data = f.input(), before = fs.readFileSync(f.file, "utf8"); f.denyAudience();
  assert.throws(() => f.router.select(f.transport, data), code("AUTHORIZATION_DENIED"));
  assert.equal(f.directoryReads(), 0); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("C6 C3 accepts exactly one owner/claim in the same aggregate and projects genuine C0 facts", t => {
  const f = routingFixture(t), data = f.input(), selected = f.router.select(f.transport, data);
  assert.equal(selected.ownerAgentId, f.agent.agentId); assert.equal(f.router.get(f.transport, data.channelId, data.workItemId).decision, null);
  const d = f.prepare(data), receipt = d.accept(); assert.equal(receipt.status, "accepted");
  const state = f.snapshot(), record = state.routing.records[0]; assert.equal(record.state, "claimed"); assert.equal(state.control.runs.length, 1);
  assert.equal(record.claim.runId, state.control.runs[0].runId); assert.equal(record.claim.taskId, state.control.runs[0].taskId);
  const view = f.router.get(f.transport, data.channelId, data.workItemId); assert.equal(view.decision.reason, "current_owner"); assert.equal(view.claim.claimRevision, 1); assert.equal(view.method, "duty_match"); assert.equal(view.executionPermit, false);
  assert.equal(f.router.select(f.transport, { ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1].agentId], message: "compile instead" }).ownerAgentId, f.agent.agentId);
  assert.throws(() => f.router.prepareDispatch(f.transport, data), code("CONTROL_HELD")); assert.equal(f.snapshot().control.runs.length, 1);
});

test("C6 JSON nomination and C1 grants cannot bypass the genuine route-to-C3 bridge", t => {
  const f = routingFixture(t), data = f.input(); f.router.select(f.transport, data); const intent = f.router.prepareDispatch(f.transport, data);
  for (const routing of [{ approved: true }, JSON.parse(JSON.stringify(intent.routing)), f.authority.admit(f.transport, intent.command)]) {
    assert.throws(() => f.control.begin(f.transport, intent.command, { message: data.message, routing }), code("AUTHORITY_UNVERIFIED"));
  }
  assert.equal(f.snapshot().control.commands.length, 0); assert.equal(f.authority.commandControlSourceHealthy(), true);
  const wrong = f.authority.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 1000, operation: { ...intent.command.operation, taskId: randomUUID() } });
  assert.throws(() => f.control.begin(f.transport, wrong, { message: data.message, routing: intent.routing }), code("CONTROL_HELD"));
  assert.equal(f.snapshot().control.runs.length, 0);
});

test("C6 another actual authority cannot steal a selected work item with new message/command IDs", t => {
  const f = routingFixture(t), data = f.input(), first = f.router.select(f.transport, data), other = f.competitor();
  const proposed = other.router.select(f.transport, { ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1].agentId] });
  assert.equal(proposed.commandId, first.commandId); assert.equal(proposed.taskId, first.taskId); assert.equal(proposed.ownerAgentId, first.ownerAgentId);
  const d = f.prepare(data); d.accept(); assert.equal(other.router.get(f.transport, data.channelId, data.workItemId).claim.taskId, d.task.id);
  assert.equal(f.snapshot().routing.records[0].claim.runId, d.binding.runId);
  assert.throws(() => other.router.prepareDispatch(f.transport, data), code("CONTROL_HELD")); assert.equal(f.snapshot().control.runs.length, 1);
});

test("C6 NEEDS_OWNER can be explicitly resolved with CAS; duplicate human selections are read-only", t => {
  const f = routingFixture(t), data = f.input("not matched"), pending = f.router.select(f.transport, data); assert.equal(pending.state, "needs_owner");
  assert.equal(f.router.get(f.transport, data.channelId, data.workItemId).decision, null);
  const choose = { ...data, requestId: randomUUID(), explicitAgentIds: [f.agent.agentId], expectedWorkRevision: pending.revision };
  const selected = f.router.select(f.transport, choose); assert.equal(selected.ownerAgentId, f.agent.agentId); const before = fs.readFileSync(f.file, "utf8");
  assert.deepEqual(f.router.select(f.transport, choose), selected); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.throws(() => f.router.select(f.transport, { ...choose, message: "changed same id" }), code("COMMAND_ID_CONFLICT"));
  const d = f.prepare(choose); assert.equal(d.accept().status, "accepted");
});

test("C6 audience changes between nomination and CAS refuse execution without poisoning the source", t => {
  const f = routingFixture(t), data = f.input(); f.router.select(f.transport, data); const d = f.prepare(data);
  f.changeAudience({ memberIds: [f.members[1].agentId] });
  const receipt = d.accept(); assert.equal(receipt.status, "rejected"); assert.equal(f.snapshot().control.runs.length, 0); assert.equal(f.authority.commandControlSourceHealthy(), true);
});

test("C6 every real effect rechecks the current audience and prevents a leaked file", async t => {
  const f = routingFixture(t), data = f.input(); f.router.select(f.transport, data); const d = f.prepare(data); d.accept(); const runtime = d.runtime();
  await runtime.call("workspace_write", { path: "allowed.txt", content: "before" });
  f.changeAudience({ memberIds: [f.members[1].agentId] });
  await assert.rejects(async () => runtime.call("workspace_write", { path: "denied.txt", content: "must not leak" }));
  assert.equal(fs.existsSync(join(f.project, "denied.txt")), false); assert.equal(fs.readFileSync(join(f.project, "allowed.txt"), "utf8"), "before");
  assert.equal(f.authority.commandControlSourceHealthy(), true);
});

test("C6 UNKNOWN remains owned after original physical closure and a new authority never replays it", async t => {
  const f = routingFixture(t), data = f.input(); f.router.select(f.transport, data); const d = f.prepare(data); d.accept(); const runtime = d.runtime();
  await assert.rejects(runtime.call("workspace_write", { path: "unknown.txt", content: "once" }, "unknown-effect", async frozen => {
    await runtime.files.find(tool => tool.name === "workspace_write").run(frozen, { cwd: f.project }); throw new Error("response lost");
  }), /response lost/);
  assert.equal(f.router.get(f.transport, data.channelId, data.workItemId).receipt.execution.effect, "unknown");
  await closeWorkspaceRunPermit(runtime.permit); const other = f.competitor(), before = fs.readFileSync(f.file, "utf8");
  const observed = other.router.select(f.transport, { ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1].agentId] }); assert.equal(observed.ownerAgentId, f.agent.agentId);
  assert.equal(other.router.get(f.transport, data.channelId, data.workItemId).state, "blocked");
  assert.throws(() => other.router.prepareDispatch(f.transport, data), code("CONTROL_HELD")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(fs.readFileSync(join(f.project, "unknown.txt"), "utf8"), "once");
});


test("C6 full routing reservation capacity rejects only the new work item, leaving a genuine sibling effect live", async t => {
  const f = routingFixture(t), data = f.input(); f.router.select(f.transport, data); const d = f.prepare(data); d.accept(); const runtime = d.runtime();
  const other = f.input(), sample = f.router.select(f.transport, other), snap = f.authority.routingSnapshot(f.transport), binding = snap.context.resourceBinding;
  f.authority.mutateRouting(f.transport, snap.revision, state => {
    while (state.records.length < 128) {
      const r = structuredClone(sample); r.workItemId = randomUUID(); r.workKey = agentRoutingWorkKey(binding.scopeKey, binding.generation, r.channelId, r.workItemId);
      r.requestId = r.rootRequestId = r.selectionRequestId = randomUUID(); r.commandId = randomUUID(); r.taskId = randomUUID();
      r.requestDigest = r.selectionRequestDigest = commandDigest({ channelId: r.channelId, workItemId: r.workItemId, message: other.message, explicitAgentIds: [], leadAgentId: null, businessBindingRef: null });
      state.records.push(r);
    }
    state.sequence++; return state;
  });
  assert.throws(() => f.router.select(f.transport, f.input()), error => error.field === "routing.capacity");
  assert.equal(f.authority.commandControlSourceHealthy(), true); assert.equal(f.snapshot().routing.records.length, 128);
  await runtime.call("workspace_write", { path: "after-routing-full.txt", content: "still alive" });
  assert.equal(fs.readFileSync(join(f.project, "after-routing-full.txt"), "utf8"), "still alive");
});


test("C6 human-confirmed business mapping revisions are rechecked even when the owner list returns to its old value", t => {
  const f = routingFixture(t); let revision = 1;
  const router = new WorkspaceAgentRouting({ ...f.options, businessOwners: () => ({ revision, ownerAgentIds: [f.agent.agentId] }) });
  const data = f.input("invoice", { businessBindingRef: "approved-binding" });
  assert.equal(router.select(f.transport, data).method, "business_mapping"); const d = f.prepare(data, router);
  revision = 3; assert.equal(d.accept().status, "rejected"); assert.equal(f.snapshot().control.runs.length, 0);
  assert.equal(f.authority.commandControlSourceHealthy(), true);
});
