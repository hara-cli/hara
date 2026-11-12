import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, currentWorkspaceResourceBinding, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { WorkspaceAgentCommandControl } from "../dist/workspace/agent-command-control.js";
import { WorkspaceAgentRouting } from "../dist/workspace/agent-routing.js";
import { captureWorkspaceProjectIdentity } from "../dist/workspace/run-binding.js";

for (const mode of ["classificationJournal", "classificationSubmitted", "classificationPublication", "selected", "accepted", "issued", "unknown"])
  test(`C6 actual process exit at ${mode} preserves original work and never buys or executes a replacement`, { timeout: 45000 }, async t => {
    const child = fork(new URL("./helpers/agent-routing-crash-owner.mjs", import.meta.url), [mode], { execArgv: [], silent: true }); let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    const [input] = await once(child, "message"); assert.equal(input.ready, true, errors);
    const exit = once(child, "exit"); child.send("go"); const [result, signal] = await exit; assert.equal(result, 0, errors); assert.equal(signal, null);
    const catalog = new LocalWorkspaceCatalog(input.home), row = catalog.resolve(input.workspaceId), storage = new WorkspaceResourceStorage(input.home, row.scope), resources = new WorkspaceResources(input.home, row.scope);
    resources.initialize(); storage.initialize(); const binding = storage.run(() => currentWorkspaceResourceBinding()), root = captureWorkspaceProjectIdentity(input.project);
    const transports = new AgentBoundaryTransports(input.credential), transport = transports.connect("new_actual_owner_connection", input.credential);
    const names = ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"];
    const authority = new WorkspaceAgentBoundaryAuthority({ catalog, resources, storage, transports, commandControl: true, lifecycleControl: true, routingControl: true,
      toolsForAgent: () => names.map(toolId => ({ toolId, connectorId: null, catalogRevision: 1, assertCurrent() {} })),
      resourcesForAgent: agentId => agentId === input.agentId ? [{ resourceId: "files", agentId, revision: 1, binding, project: root, access: ["read", "write"], assertCurrent() {} }] : [] });
    t.after(() => { authority.close(); transports.close(); }); const control = new WorkspaceAgentCommandControl(authority); let calls = 0;
    const router = new WorkspaceAgentRouting({ authority, control, automaticAgentIds: () => input.members,
      audience: channelId => { assert.equal(channelId, input.data.channelId); return { channelId, revision: 0, memberIds: input.members }; },
      classifier: { providerRef: "synthetic-origin-v1", budgetRef: "routing-fixture", timeoutMs: 10000, maxInputBytes: 8192, maxOutputTokens: 64,
        async invoke() { calls++; return { text: JSON.stringify({ candidateId: input.agentId }), toolUses: [], providerRequestRef: null }; } } });
    t.after(() => router.close());
    const path = storage.run(() => join(workspaceStateHome(), ".hara", "workspace-agent-authority-v1.json")), before = fs.readFileSync(path, "utf8"), original = authority.routingSnapshot(transport).routing.records[0];
    const observed = await router.classify(transport, input.data); assert.equal(calls, 0); assert.equal(fs.readFileSync(path, "utf8"), before);
    if (mode.startsWith("classification")) {
      assert.equal(original.classification.phase, "submission_started"); assert.equal(observed.classification.phase, "unknown"); assert.equal(observed.code, "NEEDS_OWNER");
      assert.equal(observed.classification.requestId, original.classification.requestId); assert.equal(observed.ownerAgentId, null); assert.equal(authority.commandControlState().control.runs.length, 0);
      const next = { ...input.data, requestId: randomUUID(), expectedWorkRevision: original.revision };
      await router.classify(transport, next); assert.equal(calls, 0); assert.equal(authority.routingSnapshot(transport).routing.records[0].classification.requestId, original.classification.requestId);
      const file = join(input.project, "classification-submissions.txt"); assert.equal(fs.existsSync(file), mode !== "classificationJournal");
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8"), "one\n");
    } else {
      const later = router.select(transport, { ...input.data, requestId: randomUUID(), message: "compile instead", explicitAgentIds: [input.members[1]] });
      assert.equal(later.ownerAgentId, original.ownerAgentId); assert.equal(later.taskId, original.taskId); assert.equal(later.commandId, original.commandId);
      if (mode !== "selected") {
        assert.equal(observed.claim.taskId, original.claim.taskId); assert.equal(authority.commandControlState().control.runs.length, 1);
        assert.throws(() => router.prepareDispatch(transport, input.data)); assert.throws(() => control.executionGrant(original.claim.runId));
      } else { assert.equal(observed.claim, null); assert.equal(authority.commandControlState().control.runs.length, 0); }
      if (mode === "unknown") { assert.equal(observed.effectObservation, "unknown"); assert.equal(observed.receipt.status, "unknown"); assert.equal(observed.state, "blocked"); assert.equal(fs.readFileSync(join(input.project, "one-effect.txt"), "utf8"), "once"); }
    }
    assert.equal(authority.commandControlSourceHealthy(), true);
  });
