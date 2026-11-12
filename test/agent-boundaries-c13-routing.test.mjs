import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { WorkspaceAgentCommandControl } from "../dist/workspace/agent-command-control.js";
import { agentPolicyProposalDigest } from "../dist/workspace/agent-command-state.js";
import { routingHostFixture, routingUntil, boundary } from "./helpers/agent-routing-host-fixture.mjs";

for (const state of ["needs_owner", "selected", "claimed"]) {
  test(`C13 F1 real WS refuses changed work-item body in ${state} without replacing its original facts`, async t => {
    let release; const pending = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const f = await routingHostFixture(t, { turn: async () => { await pending; return { text: "original owner only", toolUses: [], stop: "end" }; } });
    try {
      const data = f.data(state === "needs_owner" ? "unspecified C13 work" : "invoice status");
      if (state === "selected") {
        // A real revoked connection fails before C3 acceptance, leaving the genuine selected record.
        const connections = new WorkspaceConnectionStoreV2(f.storage), before = connections.list();
        connections.revoke(before.defaultConnectionId, before.revision); // Private synthetic fixture setup uses the real connection-store CAS.
        await assert.rejects(f.submit(data));
      } else {
        const result = await f.submit(data); assert.equal(result.state, state);
        if (state === "claimed") await routingUntil(() => f.calls.length === 1);
      }
      const before = f.state(), record = before.routing.records[0]; assert.equal(record.state, state);
      const providers = [...f.providers], calls = f.calls.length;
      await assert.rejects(f.submit({ ...data, requestId: randomUUID(), message: "compile a different work item", explicitAgentIds: [f.members[1]] }), boundary("COMMAND_ID_CONFLICT"));
      const after = f.state();
      assert.deepEqual(after.routing, before.routing, "body conflict must not rewrite original root/owner/claim/classification");
      assert.deepEqual(after.control, before.control, "body conflict must not create a command, run, receipt or claim");
      assert.deepEqual(after.lifecycle, before.lifecycle, "body conflict must not alter execution or UNKNOWN facts");
      assert.deepEqual(f.providers, providers); assert.equal(f.calls.length, calls);
      assert.equal(after.routing.records.length, 1);
      const observed = await f.read(data); assert.equal(observed.workItemId, data.workItemId);
      if (state === "selected") await assert.rejects(f.submit(data));
      else {
        const duplicate = await f.submit(data); assert.equal(duplicate.ownerAgentId, observed.ownerAgentId); assert.deepEqual(duplicate.claim, observed.claim);
      }
      assert.deepEqual(f.state().routing, before.routing, "same original request stays idempotent");
      assert.deepEqual(f.providers, providers); assert.equal(f.calls.length, calls);
      release();
      if (state === "claimed") await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed");
    } finally { release(); }
  });
}

for (const race of ["policy", "audience"]) {
  test(`C13 F2 real WS preserves the original C3 rejection code after a genuine ${race} race`, async t => {
    const f = await routingHostFixture(t), data = f.data();
    const originalBegin = WorkspaceAgentCommandControl.prototype.begin, originalPrepare = WorkspaceAgentCommandControl.prototype.prepareRun;
    const admitted = new WeakMap(); let injected = 0;
    WorkspaceAgentCommandControl.prototype.begin = function (transport, command, input) {
      const value = originalBegin.call(this, transport, command, input);
      if (command.operation.action === "task.dispatch" && value.intake) admitted.set(this, { transport, command });
      return value;
    };
    WorkspaceAgentCommandControl.prototype.prepareRun = function (...args) {
      const prepared = originalPrepare.apply(this, args), intent = admitted.get(this);
      if (!intent || injected) return prepared;
      injected++;
      if (race === "policy") {
        // A genuine, authenticated C3 policy command wins after task preparation, before task acceptance.
        const authority = this.authority, current = authority.view(intent.transport, intent.command.agentId);
        const proposal = { duty: current.policy.duty, boundary: current.policy.boundary, rights: { ...current.policy.rights, invoke: false } };
        const update = authority.draft(intent.transport, intent.command.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
          operation: { action: "boundary.update", proposedBoundaryDigest: agentPolicyProposalDigest(proposal) } });
        const begun = originalBegin.call(this, intent.transport, update, { proposal }); assert.ok(begun.intake);
        assert.equal(this.accept(begun.intake).status, "applied", "the competing policy command must genuinely apply");
      } else {
        // Real channel CAS removes the selected owner; no injected error substitutes for audience revalidation.
        f.rooms.update(f.channelId, "Owner removed during admission", f.members.slice(1), f.rooms.list().revision);
      }
      return prepared;
    };
    try {
      let failure;
      try { await f.submit(data); } catch (error) { failure = error; }
      assert.equal(injected, 1, "the race must cross the real Host preparation");
      const state = f.state(), original = state.routing.records[0];
      const rejection = state.control.commands.find(row => row.command.commandId === original.commandId)?.receipt;
      assert.equal(rejection?.status, "rejected", "the actual C3 rejection must be persisted");
      assert.ok(rejection.error?.code); assert.equal(state.control.runs.length, 0); assert.equal(state.lifecycle.executions.length, 0);
      assert.equal(f.providers.length, 0); assert.equal(f.calls.length, 0);
      assert.ok(failure, "a rejected original command must not be reported as successful routing submission");
      assert.equal(failure.data?.boundary?.code, rejection.error.code, "the RPC must retain the original canonical C3 error code");
      const retry = await f.submit({ ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1]] });
      assert.equal(retry.state, "blocked"); assert.deepEqual(retry.receipt, rejection);
      assert.equal(f.state().routing.records[0].commandId, original.commandId); assert.equal(f.state().routing.records[0].taskId, original.taskId);
      assert.equal(f.providers.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.state().control.runs.length, 0);
    } finally {
      WorkspaceAgentCommandControl.prototype.begin = originalBegin; WorkspaceAgentCommandControl.prototype.prepareRun = originalPrepare;
    }
  });
}
