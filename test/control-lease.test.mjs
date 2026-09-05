import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlLeaseError, ControlLeaseRegistry } from "../dist/serve/control-lease.js";

const ownerA = {};
const ownerB = {};

test("control leases keep reads compatible but fence every writer after acquisition", () => {
  let nextId = 0;
  const leases = new ControlLeaseRegistry({ idFactory: () => `lease-${++nextId}` });
  assert.equal(leases.authorize("session:a", ownerA), "legacy");

  const acquired = leases.acquire("session:a", ownerA);
  assert.deepEqual(acquired.lease, { leaseId: "lease-1", epoch: 1 });
  assert.equal(leases.authorize("session:a", ownerA, acquired.lease), "leased");
  assert.throws(
    () => leases.authorize("session:a", ownerB),
    (error) => error instanceof ControlLeaseError && error.reason === "required",
  );
  assert.throws(
    () => leases.authorize("session:a", ownerB, acquired.lease),
    (error) => error instanceof ControlLeaseError && error.reason === "stale",
  );

  const repeated = leases.acquire("session:a", ownerA);
  assert.equal(repeated.acquired, false);
  assert.deepEqual(repeated.lease, acquired.lease);
});

test("takeover rotates the epoch and makes delayed commands from the old controller harmless", () => {
  let nextId = 0;
  const leases = new ControlLeaseRegistry({ idFactory: () => `lease-${++nextId}` });
  const oldLease = leases.acquire("session:a", ownerA).lease;
  assert.throws(
    () => leases.acquire("session:a", ownerB),
    (error) => error instanceof ControlLeaseError && error.reason === "held",
  );
  const takeover = leases.acquire("session:a", ownerB, true);
  assert.equal(takeover.previousOwner, ownerA);
  assert.deepEqual(takeover.lease, { leaseId: "lease-2", epoch: 2 });
  assert.throws(() => leases.authorize("session:a", ownerA, oldLease), /control lease changed/);
  assert.equal(leases.authorize("session:a", ownerB, takeover.lease), "leased");
});

test("socket close releases owned leases while preserving a newer epoch fence", () => {
  let nextId = 0;
  const leases = new ControlLeaseRegistry({ idFactory: () => `lease-${++nextId}` });
  const first = leases.acquire("session:a", ownerA).lease;
  leases.acquire("session:b", ownerA);
  assert.deepEqual(leases.releaseOwner(ownerA), [
    { resourceId: "session:a", epoch: 1 },
    { resourceId: "session:b", epoch: 1 },
  ]);
  assert.equal(leases.authorize("session:a", ownerB), "legacy");
  assert.throws(() => leases.authorize("session:a", ownerB, first), /no longer active/);
  assert.deepEqual(leases.acquire("session:a", ownerB).lease, { leaseId: "lease-3", epoch: 2 });
});

test("control lease state is bounded and never evicts a live owner", () => {
  const leases = new ControlLeaseRegistry({ maxResources: 2, idFactory: () => "lease" });
  leases.acquire("session:a", ownerA);
  leases.acquire("session:b", ownerB);
  assert.throws(
    () => leases.acquire("session:c", {}),
    (error) => error instanceof ControlLeaseError && error.reason === "capacity",
  );
  leases.release("session:a", ownerA);
  assert.deepEqual(leases.acquire("session:c", {}).lease, { leaseId: "lease", epoch: 1 });
});
