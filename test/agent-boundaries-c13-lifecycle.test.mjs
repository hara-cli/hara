import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { lifecycleFixture } from "./helpers/agent-lifecycle-fixture.mjs";
import { routingConnect } from "./helpers/agent-routing-host-fixture.mjs";
import { AgentBoundaryContractError } from "../dist/workspace/agent-boundaries-contract.js";
import { agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";
import { commandDigest } from "../dist/workspace/agent-command-state.js";
import { closeWorkspaceRunPermit, workspaceRunDrainProof } from "../dist/workspace/execution.js";
import { currentWorkspaceResourceBinding } from "../dist/workspace/resource-context.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
const code = expected => error => error instanceof AgentBoundaryContractError && error.code === expected;

function manualRecovery(agentId, run, command) {
  return { schemaVersion: 1, kind: "agent-lifecycle-recovery", operationId: randomUUID(), agentId, taskId: run.taskId,
    previousRunId: run.runId, expectedClaimRevision: run.claimRevision, proofDigest: commandDigest(null),
    commandId: command.commandId, rootRequestId: command.rootRequestId };
}
function assertIssuedWithoutTerminal(run, execution) {
  assert.equal(execution.phase, "issued"); assert.equal(execution.terminal, null); assert.ok(execution.quiescence);
  assert.equal(execution.leaseReleased, true); assert.equal(run.effect, "none");
}
async function issuedWithoutEffects(f) {
  const d = f.dispatch("stop wins before actual runtime attach"); d.accept();
  const original = f.control.attachRuntime.bind(f.control); let permit;
  f.control.attachRuntime = (runId, actual) => {
    permit = actual; // Genuine runtime, never a JSON substitute or claimed zero counter.
    const run = f.snapshot().control.runs.find(row => row.runId === runId);
    const stop = f.apply(f.draft({ action: "task.stop", taskId: run.taskId, runId, claimRevision: run.claimRevision }));
    assert.ok(stop.control.holdId); assert.equal(f.snapshot().control.runs.find(row => row.runId === runId).hold.holdId, stop.control.holdId);
    return original(runId, actual); // Captures the original closer, then refuses admission due to the real hold.
  };
  try { assert.throws(() => d.runtime(), code("CONTROL_HELD")); }
  finally { f.control.attachRuntime = original; }
  assert.ok(permit);
  await closeWorkspaceRunPermit(permit); f.control.observeDrained(workspaceRunDrainProof(permit));
  const state = f.snapshot(), run = state.control.runs.find(row => row.runId === d.binding.runId), execution = state.lifecycle.executions.find(row => row.runId === run.runId);
  assertIssuedWithoutTerminal(run, execution); return { d, run, execution };
}

test("C13 F3 genuine beginRecovery rejects a hand-built issued/null-terminal proof despite positive quiescence and released lease", async t => {
  const f = lifecycleFixture(t), { run } = await issuedWithoutEffects(f);
  const message = "new explicit recovery request", command = f.draft({ action: "task.dispatch", taskId: run.taskId,
    conversationId: run.binding.sessionId, messageDigest: agentCommandMessageDigest(run.binding.sessionId, message) });
  const recovery = manualRecovery(f.agent.agentId, run, command), before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => f.control.beginRecovery(f.transport, recovery, command, { message }), code("CONTROL_HELD"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before, "refusal must not write any new claim, terminal fact, command or issuance");
  assert.throws(() => f.control.executionGrant(run.runId)); assert.equal(f.authority.commandControlSourceHealthy(), true);
});

test("C13 F3 real WS recovery.submit refuses the same manual issued/null-terminal proof without another provider or claim", async t => {
  const f = lifecycleFixture(t, { devRoot: true }), { run } = await issuedWithoutEffects(f); let providers = 0, calls = 0;
  // Same real catalog/state as the original runtime; only a new authenticated reader/command connection.
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: f.project }, {
    root: dirname(f.home), version: "C13-F3-synthetic", agentBoundaries: { ownerCredential: f.credential, commandControl: true, lifecycleControl: true },
    providerFactory: (connection, binding) => { providers++; return { id: "openai", model: binding.model, async turn() { calls++; throw new Error("No recovery provider is allowed"); } }; },
  });
  const owner = await routingConnect(handle);
  try {
    await owner.request("initialize", { token: handle.token, boundaryCredential: f.credential });
    const params = { workspaceId: f.row.scope.workspaceId, expectedGeneration: f.storage.run(() => currentWorkspaceResourceBinding()).generation, agentId: f.agent.agentId };
    const message = "manual recovery on original task", command = await owner.request("workspace.boundaries.draft", { ...params,
      commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
      operation: { action: "task.dispatch", taskId: run.taskId, conversationId: run.binding.sessionId, messageDigest: agentCommandMessageDigest(run.binding.sessionId, message) } });
    const recovery = manualRecovery(f.agent.agentId, run, command), before = fs.readFileSync(f.file, "utf8");
    await assert.rejects(owner.request("workspace.boundaries.lifecycle.recovery.submit", { ...params, recovery, command, message }),
      error => error.data?.boundary?.code === "CONTROL_HELD");
    assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(providers, 0); assert.equal(calls, 0);
    assert.equal(f.snapshot().control.runs.length, 1); assertIssuedWithoutTerminal(f.snapshot().control.runs[0], f.snapshot().lifecycle.executions[0]);
  } finally { await owner.close(); await handle.close(); }
});
