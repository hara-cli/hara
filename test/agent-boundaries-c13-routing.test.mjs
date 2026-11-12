import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
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
