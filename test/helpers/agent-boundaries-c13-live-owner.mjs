// Test-only real foreign process: publish genuine closure, then remain alive with the original lease.
import assert from "node:assert/strict";
import { lifecycleFixture } from "./agent-lifecycle-fixture.mjs";
import { closeWorkspaceRunPermit } from "../../dist/workspace/execution.js";
try {
  const mode = process.argv[2]; assert.ok(["terminal", "quiescence"].includes(mode));
  const f = lifecycleFixture({ after() {} }), d = f.dispatch("live original closure owner"); d.accept();
  let interrupted = false, failure;
  d.lease.release = () => { interrupted = true; throw new Error("C13 real original lease release deliberately pending"); };
  try {
    if (mode === "terminal") f.control.abortBeforeExecution(d.prepared);
    else { const runtime = d.runtime(); await closeWorkspaceRunPermit(runtime.permit); }
  } catch (error) { failure = error; }
  assert.equal(interrupted, true); assert.ok(failure); d.lease.assertCurrent();
  const row = f.snapshot().lifecycle.executions.find(row => row.runId === d.binding.runId);
  assert.equal(row.leaseReleased, false); assert.ok(mode === "terminal" ? row.terminal : row.quiescence);
  assert.equal(row.lease.ownerPid, process.pid);
  process.once("message", message => process.exit(message === "exit" ? 0 : 2));
  process.send({ ready: true, mode, home: f.home, project: f.project, workspaceId: f.row.scope.workspaceId, agentId: f.agent.agentId,
    credential: f.credential, runId: d.binding.runId, commandId: d.command.commandId });
} catch (error) {
  process.send({ ready: false, error: error.message }, () => process.exit(1));
}
