import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lifecycleFixture } from "./agent-lifecycle-fixture.mjs";
import { WorkspaceAgentRouting } from "../../dist/workspace/agent-routing.js";
import { WorkspaceAgentBoundaryAuthority } from "../../dist/workspace/agent-boundary-authority.js";
import { WorkspaceAgentCommandControl } from "../../dist/workspace/agent-command-control.js";
import { WorkspaceSessionLease } from "../../dist/workspace/session-lease.js";
import { createTaskExecution } from "../../dist/session/task.js";
import { freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../../dist/workspace/run-binding.js";
import { localWorkspaceFileTools } from "../../dist/workspace/local-tools.js";
import { createAgentBoundaryExecutionGate } from "../../dist/workspace/agent-boundary-execution.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, assertWorkspaceRunContextCurrent, executeWorkspaceTool } from "../../dist/workspace/execution.js";

export function routingFixture(t) {
  const f = lifecycleFixture(t, { noInitialize: true, colleague: true }); f.authorityOptions.routingControl = true;
  const originalResources = f.authorityOptions.resourcesForAgent;
  f.authorityOptions.resourcesForAgent = agentId => agentId === f.agent.agentId ? originalResources(agentId) : [];
  const members = [f.agent];
  for (const name of ["engineering", "design"]) members.push(f.resources.agents.create({ username: name, profile: { displayName: name }, runtimeId: "pi", permissionTier: "controlled" }, f.resources.agents.list().revision));
  for (const [index, agent] of members.entries()) {
    const view = f.authority.view(f.transport, agent.agentId), duty = structuredClone(f.duty), boundary = structuredClone(f.boundary);
    duty.context = structuredClone(view.context); duty.agentId = agent.agentId; duty.dutyRevision = index === 0 ? 2 : 1;
    duty.publicProfile = { title: ["Finance", "Engineering", "Design"][index], description: "Confirmed public fixture duty", owns: [["invoice"], ["compile"], ["layout"]][index], rejects: index === 0 ? ["publish"] : [] };
    boundary.context = structuredClone(view.context); boundary.agentId = agent.agentId;
    if (index) { boundary.resources = []; boundary.tools = { allow: [], deny: [], readOnly: true }; }
    f.authority.configure(f.transport, agent.agentId, { expectedRevision: view.revision, duty, boundary, rights: f.rights });
  }
  f.control.initialize(f.transport); f.authority.initializeAgentLifecycle(f.transport); f.authority.initializeAgentRouting(f.transport, f.agent.agentId);
  let denied = false, audience = { channelId: randomUUID(), revision: 0, memberIds: members.map(row => row.agentId) }, directoryReads = 0;
  const original = f.authority.routingDirectory.bind(f.authority); f.authority.routingDirectory = (...args) => { directoryReads++; return original(...args); };
  const options = { authority: f.authority, control: f.control, automaticAgentIds: () => members.map(row => row.agentId),
    audience(channelId) { if (denied || channelId !== audience.channelId) throw Object.assign(new Error("Audience denied"), { code: "AUTHORIZATION_DENIED" }); return structuredClone(audience); } };
  const router = new WorkspaceAgentRouting(options);
  const input = (message = "invoice status", extra = {}) => ({ channelId: audience.channelId, workItemId: randomUUID(), requestId: randomUUID(), message,
    explicitAgentIds: [], leadAgentId: null, businessBindingRef: null, expectedWorkRevision: 0, ...extra });
  function prepare(data, controller = router, authority = f.authority, control = f.control) {
    const intent = controller.prepareDispatch(f.transport, data), command = intent.command, agent = f.resources.agents.get(command.agentId);
    const unbound = createTaskExecution(data.message, randomUUID()); unbound.id = command.operation.taskId;
    const task = f.resources.agents.bindTask(unbound, agent.agentId, agent.configRevision, agent.agentEpoch), project = f.authorityOptions.resourcesForAgent(f.agent.agentId)[0].project;
    const binding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: f.row.scope, agent: task.workspaceAgentBinding, agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding),
      connection: f.connections.capture(), runtimeContract: "hara-governed-runtime-v1", project, sessionId: command.operation.conversationId, runId: randomUUID(), lineage: { rootRunId: null, parentRunId: null, depth: 0 },
      createdAt: new Date().toISOString(), host: { hostId: f.catalog.read().hostId, hostEpoch: f.catalog.read().hostEpoch, actorId: f.row.actorId, grantId: f.row.grantId, grantRevision: f.row.grantRevision, policyRevision: f.row.policyRevision },
      budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 32000, timeoutMs: 60000 } });
    task.workspaceRunBinding = binding; const lease = f.trackLease(WorkspaceSessionLease.acquire(f.storage, binding.sessionId));
    const begun = control.begin(f.transport, command, { message: data.message, routing: intent.routing }); assert.ok(begun.intake);
    const requestId = randomUUID(), prepared = control.prepareRun(begun.intake, binding, lease, requestId);
    function runtime() {
      let permit; const abort = new AbortController(), files = localWorkspaceFileTools(f.project, () => assertWorkspaceRunContextCurrent(permit));
      const grant = control.executionGrant(binding.runId), gate = createAgentBoundaryExecutionGate({ binding, authority, grant, control,
        tools: files.map(tool => ({ tool, reference: { toolId: tool.name, connectorId: null, catalogRevision: 1 }, resources: () => (tool.kind === "edit" ? ["read", "write"] : ["read"]).map(access => ({ resourceId: "files", access })) })) });
      permit = f.trackPermit(createWorkspaceRunPermit({ binding, agentBoundary: gate, catalog: f.catalog, resources: f.resources, storage: f.storage, connections: f.connections, lease, cwd: f.project, signal: abort.signal,
        provider: { id: "openai", model: binding.connection.model, async turn() { throw new Error("No model expected"); } }, toolNames: files.map(row => row.name), usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} }));
      control.attachRuntime(binding.runId, permit);
      const runOptions = bindWorkspaceRunOptions(permit, { ctx: { cwd: f.project, sessionId: binding.sessionId }, signal: abort.signal, hooks: false, approval: "auto-edit", extraTools: files, taskIntake: { task, current: () => task } });
      beginWorkspaceGovernedRun(permit, runOptions, "pi");
      return { permit, files, call: (name, value, id = randomUUID(), invoke) => executeWorkspaceTool(permit, name,
        invoke ?? (frozen => files.find(tool => tool.name === name).run(frozen, { cwd: f.project })), undefined, value, id) };
    }
    return { ...intent, binding, task, lease, intake: begun.intake, prepared, accept: () => control.accept(begun.intake, prepared), runtime };
  }
  function competitor() {
    const authority = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions }), control = new WorkspaceAgentCommandControl(authority); t.after(() => authority.close());
    return { authority, control, router: new WorkspaceAgentRouting({ ...options, authority, control }) };
  }
  return { ...f, router, options, members, input, prepare, competitor, directoryReads: () => directoryReads,
    denyAudience(value = true) { denied = value; }, changeAudience(change) { audience = { ...audience, ...change, revision: audience.revision + 1 }; } };
}
