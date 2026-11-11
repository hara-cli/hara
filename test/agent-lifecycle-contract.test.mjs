import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryContractError } from "../dist/workspace/agent-boundaries-contract.js";
import { parseAgentLifecycleState, parseAgentLifecycleRecovery, migrateAgentLifecycleState, assertAgentLifecycleTransition } from "../dist/workspace/agent-lifecycle-state.js";
import { workspaceAgentCommandProtected } from "../dist/workspace/agent-command-protection.js";
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-lifecycle-v1.json", import.meta.url), "utf8"));
const code = value => error => error instanceof AgentBoundaryContractError && error.code === value;

test("C4 explicit migration retains the complete C3 aggregate and invalidates old policies", t => {
  const f = lifecycleFixture(t), before = JSON.parse(f.beforeLifecycleMigration), after = f.snapshot();
  assert.equal(before.schemaVersion, 2); assert.equal(after.schemaVersion, 3);
  assert.deepEqual(after.control, before.control);
  assert.equal(after.policies[0].revision, before.policies[0].revision + 1);
  assert.deepEqual(after.policies[0].boundary, before.policies[0].boundary);
  assert.equal(after.lifecycle.migration.fromSchema, 2);
  assert.deepEqual(after.lifecycle.executions, []);
  assert.equal(f.storage.run(() => workspaceAgentCommandProtected(f.storage)), true);
});

test("C4 missing bootstrap refuses schema3 to older C3/legacy readers and writers", t => {
  const f = lifecycleFixture(t), before = fs.readFileSync(f.file, "utf8");
  for (const commandControl of [false, true]) {
    const older = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, commandControl, lifecycleControl: false });
    assert.throws(() => older.commandControlState(), code("AUTHORITY_UNVERIFIED"));
    assert.throws(() => older.draft(f.transport, f.agent.agentId, { commandId: "old_command", rootRequestId: "old_root", lifetimeMs: 1000,
      operation: { action: "agent.pause", reason: "human_request" } }), code("AUTHORITY_UNVERIFIED"));
    older.close();
  }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("C4 migration refuses a physical lease, then preserves an old orphan as UNKNOWN rather than never-issued", t => {
  const f = lifecycleFixture(t, { lifecycleControl: false }), d = f.dispatch(); d.accept();
  const before = fs.readFileSync(f.file, "utf8"), authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, lifecycleControl: true });
  t.after(() => authority.close());
  assert.throws(() => authority.initializeAgentLifecycle(f.transport), code("CONTROL_HELD"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  d.lease.release(); const after = authority.initializeAgentLifecycle(f.transport);
  assert.deepEqual(after.control, JSON.parse(before).control);
  assert.equal(after.lifecycle.executions[0].phase, "legacy_unknown");
  assert.equal(after.lifecycle.executions[0].terminal, null);
  assert.equal(after.lifecycle.executions[0].leaseReleased, false);
  assert.throws(() => f.control.executionGrant(d.binding.runId), error => code("AUTHORITY_UNVERIFIED")(error) || error.message === "Workspace attempt lease was released");
});

test("C4 schema downgrade observed only in a real CAS remains fenced after restoration", t => {
  const f = lifecycleFixture(t), original = fs.readFileSync(f.file, "utf8"), snapshot = f.authority.commandControlState();
  const older = JSON.parse(original); older.schemaVersion = 2; delete older.lifecycle;
  fs.writeFileSync(f.file, JSON.stringify(older) + "\n");
  assert.throws(() => f.authority.observeCommandControl(snapshot.revision, state => state), code("AUTHORITY_UNVERIFIED"));
  fs.writeFileSync(f.file, original);
  assert.equal(f.authority.commandControlSourceHealthy(), false);
  assert.deepEqual(f.snapshot().lifecycle, JSON.parse(original).lifecycle);
});

test("C4 private positive/negative fixtures are separate from canonical C0", t => {
  const f = lifecycleFixture(t), control = f.authority.commandControlState().control;
  assert.deepEqual(parseAgentLifecycleState(fixture.empty, control), fixture.empty);
  assert.deepEqual(parseAgentLifecycleRecovery(fixture.recovery), fixture.recovery);
  for (const patch of fixture.invalidRecoveryPatches) assert.throws(() => parseAgentLifecycleRecovery({ ...fixture.recovery, ...patch }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => parseAgentLifecycleRecovery({ ...fixture.recovery, approved: true }), code("AUTHORITY_UNVERIFIED"));
  let getterCalls = 0; const getter = { ...fixture.recovery };
  Object.defineProperty(getter, "proofDigest", { enumerable: true, get() { getterCalls++; return "b".repeat(64); } });
  assert.throws(() => parseAgentLifecycleRecovery(getter), code("AUTHORITY_UNVERIFIED")); assert.equal(getterCalls, 0);
});

test("C4 pure migration cannot turn historical acceptance into a never-issued proof or reset history", t => {
  const f = lifecycleFixture(t), { control, lifecycle } = f.authority.commandControlState();
  const migrated = migrateAgentLifecycleState(control, "b".repeat(64), new Date().toISOString());
  assert.deepEqual(migrated.executions, []);
  const altered = structuredClone(lifecycle); altered.migration.sourceDigest = "c".repeat(64);
  assert.throws(() => assertAgentLifecycleTransition(lifecycle, altered), code("AUTHORITY_UNVERIFIED"));
  const oversized = { ...fixture.empty, segments: Array.from({ length: 65 }, () => ({})) };
  assert.throws(() => parseAgentLifecycleState(oversized, control), error => error.field === "lifecycle.capacity");
});


test("C4 a partial downgrade retaining lifecycle can never fall through the legacy protection probe", t => {
  const f = lifecycleFixture(t), original = fs.readFileSync(f.file, "utf8"), partial = JSON.parse(original);
  partial.schemaVersion = 1; delete partial.control;
  fs.writeFileSync(f.file, JSON.stringify(partial) + "\n");
  assert.throws(() => f.storage.run(() => workspaceAgentCommandProtected(f.storage)), code("AUTHORITY_UNVERIFIED"));
  fs.writeFileSync(f.file, original);
});
