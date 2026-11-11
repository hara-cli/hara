import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HaraStorageQuota } from "../dist/storage/quota.js";
import { bindPrivateHaraStateFile, writePrivateStateFileSync } from "../dist/security/private-state.js";

function fixture(t, limitBytes = 64 * 1024) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "quota-accounting-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const q = new HaraStorageQuota({ home, limitBytes });
  return { home, q, path: join(home, ".hara", "storage-quota", "policy.json"), lock: join(home, ".hara", "storage-quota", "global.lock") };
}

test("quota limit migration is native-authorized CAS; bound controllers adopt it and shrink preserves data", async t => {
  const f = fixture(t); await f.q.prepare();
  const peer = new HaraStorageQuota({ home: f.home, limitBytes: 64 * 1024 }); peer.run(() => {});
  const retained = join(f.home, ".hara", "retained.bin");
  f.q.run(() => { f.q.admitGrowth(20 * 1024); assert.equal(existsSync(f.lock), false); writeFileSync(retained, Buffer.alloc(20 * 1024)); f.q.recordChange(20 * 1024); });
  const policy = f.q.policy(), change = { expectedRevision: policy.revision, expectedLimitBytes: policy.limitBytes, limitBytes: 96 * 1024 };
  assert.throws(() => f.q.changeLimit(change, () => { throw new Error("no native authority"); }), /no native authority/);
  assert.deepEqual(f.q.policy(), policy);
  const grown = f.q.changeLimit(change, input => { assert.deepEqual(input, change); assert.ok(Object.isFrozen(input)); assert.equal(existsSync(f.lock), false); change.limitBytes = 128 * 1024; });
  assert.equal(grown.limitBytes, 96 * 1024, "authorization binds the immutable request, not later caller mutation");
  peer.run(() => peer.admitGrowth(64 * 1024)); assert.equal(peer.limitBytes, 96 * 1024);
  assert.throws(() => f.q.changeLimit(change, () => {}), error => error.code === "configuration_conflict");
  const shrunk = f.q.changeLimit({ expectedRevision: grown.revision, expectedLimitBytes: grown.limitBytes, limitBytes: 4096 }, () => {});
  assert.equal(shrunk.limitBytes, 4096); assert.equal(readFileSync(retained).length, 20 * 1024);
  assert.throws(() => peer.run(() => peer.admitGrowth(1)), error => error.code === "quota_exceeded");
  peer.run(() => peer.admitGrowth(256, true));
  new HaraStorageQuota({ home: f.home, limitBytes: 4096 }).run(() => {});
});

test("old policy upgrades accounting without silently widening its roots or budget", t => {
  const f = fixture(t), binding = bindPrivateHaraStateFile(f.home, ["storage-quota"], "policy.json");
  const { path, dev, ino } = bindPrivateHaraStateFile(f.home, [], "probe").directory;
  writePrivateStateFileSync(binding, JSON.stringify({ schemaVersion: 1, limitBytes: 64 * 1024, roots: [{ path, dev, ino }] }), { expectedMissing: true });
  f.q.run(() => f.q.admitGrowth(0)); const state = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(state.schemaVersion, 2); assert.equal(state.policyRevision, 1); assert.equal(state.limitBytes, 64 * 1024);
  assert.throws(() => new HaraStorageQuota({ home: f.home, limitBytes: 128 * 1024 }).run(() => {}), error => error.code === "configuration_conflict");
});

test("legacy writes are reconciled outside the lock; a racing scan cannot overwrite an admitted delta", async t => {
  const f = fixture(t, 16 * 1024); await f.q.prepare();
  const pending = f.q.refreshUsage(), managed = join(f.home, ".hara", "managed.bin");
  f.q.run(() => { f.q.admitGrowth(4096); writeFileSync(managed, Buffer.alloc(4096)); f.q.recordChange(4096); });
  assert.equal(await pending, false); assert.ok(f.q.usageBytes() >= 4096);
  writeFileSync(join(f.home, ".hara", "legacy.bin"), Buffer.alloc(20 * 1024));
  assert.equal(await f.q.refreshUsage(), true);
  assert.throws(() => f.q.run(() => f.q.admitGrowth(1)), error => error.code === "quota_exceeded");
  assert.equal(existsSync(f.lock), false);
});

test("uncertain mutation keeps its durable reservation until a fenced metadata reconciliation", async t => {
  const f = fixture(t); await f.q.prepare(); const retained = join(f.home, ".hara", "orphan.bin");
  f.q.run(() => { f.q.admitGrowth(4096); writeFileSync(retained, Buffer.alloc(2048)); f.q.uncertainMutation(); });
  let state = JSON.parse(readFileSync(f.path, "utf8")); assert.equal(state.reservations.length, 1); assert.equal(state.reservations[0].active, false);
  assert.throws(() => f.q.run(() => f.q.admitGrowth(1)), error => error.code === "unavailable");
  assert.equal(await f.q.refreshUsage(), true); state = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(state.reservations.length, 0); assert.ok(f.q.usageBytes() >= 2048);
});


test("quota transactions reject async callbacks instead of releasing a reservation across await", t => {
  const f = fixture(t); assert.throws(() => f.q.run(() => Promise.resolve()), error => error.code === "unavailable");
  assert.equal(existsSync(f.lock), false); f.q.run(() => f.q.admitGrowth(0));
});

test("a restarted Host with a new configured limit can inspect and explicitly migrate the persisted old policy", async t => {
  for (const version of [1, 2]) {
    const f = fixture(t); await f.q.prepare();
    if (version === 1) {
      const old = readFileSync(f.path, "utf8"), state = JSON.parse(old);
      writePrivateStateFileSync(bindPrivateHaraStateFile(f.home, ["storage-quota"], "policy.json"),
        JSON.stringify({ schemaVersion: 1, limitBytes: state.limitBytes, roots: state.roots }), { expectedText: old });
    }
    const restarted = new HaraStorageQuota({ home: f.home, limitBytes: 96 * 1024 });
    const old = restarted.policy(); assert.equal(old.limitBytes, 64 * 1024, "inspection cannot widen the old budget");
    const migrated = restarted.changeLimit({ expectedRevision: old.revision, expectedLimitBytes: old.limitBytes, limitBytes: 96 * 1024 }, () => {});
    assert.equal(migrated.limitBytes, 96 * 1024); await restarted.prepare();
    f.q.run(() => f.q.admitGrowth(0)); assert.equal(f.q.limitBytes, 96 * 1024);
  }
});
