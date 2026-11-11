import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, currentWorkspaceResourceBinding } from "../dist/workspace/resource-context.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { WorkspaceAgentCommandControl } from "../dist/workspace/agent-command-control.js";
import { captureWorkspaceProjectIdentity } from "../dist/workspace/run-binding.js";

for (const mode of ["terminal", "quiescence", "issued"]) test(`C4 actual process exit after ${mode} retains the durable barrier and only positive original facts reconcile`, { timeout: 45000 }, async t => {
  const child = fork(new URL("./helpers/agent-lifecycle-crash-owner.mjs", import.meta.url), [mode], { execArgv: [], silent: true }); let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const [input] = await once(child, "message"); assert.equal(input.ready, true, errors);
  const base = dirname(input.home); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const exit = once(child, "exit"); child.send("go"); const [result] = await exit; assert.equal(result, 0, errors);
  const catalog = new LocalWorkspaceCatalog(input.home), row = catalog.resolve(input.workspaceId), storage = new WorkspaceResourceStorage(input.home, row.scope), resources = new WorkspaceResources(input.home, row.scope);
  resources.initialize(); storage.initialize();
  const transports = new AgentBoundaryTransports(input.credential), transport = transports.connect("restarted_owner", input.credential), root = captureWorkspaceProjectIdentity(input.project), binding = storage.run(() => currentWorkspaceResourceBinding());
  const names = ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"];
  const authority = new WorkspaceAgentBoundaryAuthority({ catalog, resources, storage, transports, commandControl: true, lifecycleControl: true,
    toolsForAgent: () => names.map(toolId => ({ toolId, connectorId: null, catalogRevision: 1, assertCurrent() {} })),
    resourcesForAgent: () => [{ resourceId: "files", agentId: input.agentId, revision: 1, binding, project: root, access: ["read", "write"], assertCurrent() {} }] });
  t.after(() => { authority.close(); transports.close(); }); const control = new WorkspaceAgentCommandControl(authority), before = authority.commandControlState();
  const execution = before.lifecycle.executions[0]; assert.equal(execution.leaseReleased, false);
  if (mode === "issued") {
    assert.equal(execution.phase, "issued"); assert.equal(execution.terminal, null); assert.equal(execution.quiescence, null);
    assert.throws(() => control.reconcileLifecycleLease(transport, input.runId)); assert.equal(authority.commandControlState().lifecycle.executions[0].leaseReleased, false);
    assert.equal(control.archiveLifecycleHistory(transport, input.agentId).published, 0); assert.throws(() => control.executionGrant(input.runId));
    assert.equal(control.readReceipt(transport, input.agentId, input.commandId).status, "unknown");
  } else {
    if (mode === "terminal") { assert.equal(execution.phase, "aborted_before_execution"); assert.ok(execution.terminal); }
    else { assert.equal(execution.phase, "issued"); assert.ok(execution.quiescence); }
    control.reconcileLifecycleLease(transport, input.runId);
    const after = authority.commandControlState(); assert.equal(after.lifecycle.executions[0].leaseReleased, true);
    assert.deepEqual(after.lifecycle.executions[0].terminal, execution.terminal); assert.deepEqual(after.lifecycle.executions[0].quiescence, execution.quiescence);
    assert.throws(() => control.executionGrant(input.runId));
    if (mode === "quiescence") { assert.equal(after.control.runs[0].effect, "unknown"); assert.equal(fs.readFileSync(join(input.project, "once-before-crash.txt"), "utf8"), "one"); }
  }
});
