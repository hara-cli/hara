import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../../dist/workspace/resource-context.js";
import { WorkspaceConnectionStoreV2 } from "../../dist/workspace/connections.js";
import { WorkspaceSessionLease } from "../../dist/workspace/session-lease.js";
import { WorkspaceAgentBoundaryAuthority } from "../../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../../dist/workspace/agent-boundary-transport.js";
import { AgentBoundaryContractError, agentBoundaryCommandSigningText } from "../../dist/workspace/agent-boundaries-contract.js";
import { WorkspaceAgentCommandControl, agentCommandMessageDigest } from "../../dist/workspace/agent-command-control.js";
import { agentPolicyProposalDigest, assertAgentCommandTransition } from "../../dist/workspace/agent-command-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../../dist/workspace/run-binding.js";
import { createTaskExecution } from "../../dist/session/task.js";
import { localWorkspaceFileTools } from "../../dist/workspace/local-tools.js";
import { createAgentBoundaryExecutionGate } from "../../dist/workspace/agent-boundary-execution.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, closeWorkspaceRunPermit, workspaceRunDrainProof, executeWorkspaceTool, assertWorkspaceRunContextCurrent } from "../../dist/workspace/execution.js";

const fixtureDocs = JSON.parse(fs.readFileSync(new URL("../fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const code = expected => error => error instanceof AgentBoundaryContractError && error.code === expected;
export function lifecycleFixture(t, input = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c3-control-"))), home = join(base, "home"), project = join(base, "project");
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Personal", catalog.read().revision), resources = new WorkspaceResources(home, row.scope);
  resources.initialize(); let agent = resources.agents.initializeMain();
  if (input.colleague) agent = resources.agents.create({ username: "lifecycle_fixture", profile: { displayName: "Lifecycle Fixture" }, runtimeId: "pi", permissionTier: "controlled" }, resources.agents.list().revision);
  else agent = resources.agents.setPermissionTier(agent.agentId, "controlled", agent.configRevision, agent.agentEpoch);
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize(); const connections = new WorkspaceConnectionStoreV2(storage);
  connections.add({ label: "fixture", provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-real", defaultModel: "synthetic" }, 0);
  const credential = randomBytes(32).toString("hex"), transports = new AgentBoundaryTransports(credential), transport = transports.connect("owner", credential);
  const now = () => clock; let clock = Date.now(); const root = captureWorkspaceProjectIdentity(project), permits = [], leases = [];
  const names = ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"], ref = name => ({ toolId: name, connectorId: null, catalogRevision: 1 });
  const authorityOptions = { catalog, resources, storage, transports, commandControl: true, lifecycleControl: input.lifecycleControl !== false, now,
    toolsForAgent: () => names.map(name => ({ ...ref(name), assertCurrent() {} })) };
  // Use the actual resource binding captured by the Agent's task registry.
  const seed = resources.agents.bindTask(createTaskExecution("seed", randomUUID()), agent.agentId, agent.configRevision, agent.agentEpoch);
  authorityOptions.resourcesForAgent = () => [{ resourceId: "files", agentId: agent.agentId, revision: 1, binding: seed.workspaceAgentBinding.resourceBinding,
    project: root, access: ["read", "write"], assertCurrent() { assert.deepEqual(captureWorkspaceProjectIdentity(project), root); } }];
  const authority = new WorkspaceAgentBoundaryAuthority(authorityOptions), view = authority.view(transport, agent.agentId);
  const document = name => structuredClone(fixtureDocs.valid.find(item => item.name === name).document), duty = document("duty"), boundary = document("boundary");
  for (const doc of [duty, boundary]) { doc.agentId = agent.agentId; doc.context = structuredClone(view.context); }
  boundary.resources = [{ resourceId: "files", access: ["read", "write"] }]; boundary.tools = { allow: names.map(ref), deny: [], readOnly: false };
  boundary.approvalRequired = []; boundary.budget = { budgetRef: "fixture", maxModelCalls: 12, maxToolEffects: 32 };
  const rights = { manage: true, invoke: true, privateRead: false, nodeUse: true, ...input.rights };
  authority.configure(transport, agent.agentId, { expectedRevision: view.revision, duty, boundary, rights });
  const control = new WorkspaceAgentCommandControl(authority, now);
  const file = storage.run(() => join(workspaceStateHome(), ".hara", "workspace-agent-authority-v1.json"));
  const beforeMigration = fs.readFileSync(file, "utf8"); if (!input.noInitialize) control.initialize(transport);
  const beforeLifecycleMigration = fs.readFileSync(file, "utf8");
  if (!input.noInitialize && !input.noLifecycleInitialize && input.lifecycleControl !== false) authority.initializeAgentLifecycle(transport);
  const draft = (operation, extras = {}) => authority.draft(transport, agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000, operation, ...extras });
  function dispatch(message = "write a private fixture", extras = {}, recoveryFrom) {
    const unbound = createTaskExecution(message, randomUUID()); if (recoveryFrom) unbound.id = recoveryFrom.task.id;
    let task = resources.agents.bindTask(unbound, agent.agentId, agent.configRevision, agent.agentEpoch);
    const sessionId = recoveryFrom?.binding.sessionId ?? (input.fixedSession ? agent.agentId.slice(3) : randomUUID());
    const expectedClaimRevision = recoveryFrom ? (control.inspect(transport, agent.agentId).runs.find(row => row.runId === recoveryFrom.binding.runId)
      ?? authority.commandControlState().lifecycle?.retiredRuns.find(row => row.runId === recoveryFrom.binding.runId)).claimRevision : 0;
    const recoveryIntent = recoveryFrom ? control.draftRecovery(transport, agent.agentId, { operationId: extras.operationId ?? randomUUID(), previousRunId: recoveryFrom.binding.runId,
      expectedClaimRevision: extras.expectedClaimRevision ?? expectedClaimRevision, commandId: extras.commandId ?? randomUUID(), rootRequestId: extras.rootRequestId ?? randomUUID(), message, lifetimeMs: extras.lifetimeMs ?? 30000 }) : null;
    const command = recoveryIntent?.command ?? draft({ action: "task.dispatch", taskId: task.id, conversationId: sessionId, messageDigest: agentCommandMessageDigest(sessionId, message) }, extras);
    const binding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: row.scope, agent: task.workspaceAgentBinding, agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding),
      connection: connections.capture(), runtimeContract: "hara-governed-runtime-v1", project: root, sessionId, runId: randomUUID(), lineage: { rootRunId: null, parentRunId: null, depth: 0 },
      createdAt: new Date().toISOString(), host: { hostId: catalog.read().hostId, hostEpoch: 1, actorId: row.actorId, grantId: row.grantId, grantRevision: row.grantRevision, policyRevision: row.policyRevision },
      budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 32000, timeoutMs: 60000 } });
    task.workspaceRunBinding = binding;
    const lease = WorkspaceSessionLease.acquire(storage, sessionId); leases.push(lease);
    const begun = recoveryIntent ? control.beginRecovery(transport, recoveryIntent.recovery, command, { message }) : control.begin(transport, command, { message }); assert.ok(begun.intake);
    const requestId = randomUUID(), prepared = control.prepareRun(begun.intake, binding, lease, requestId);
    const accept = () => control.accept(begun.intake, prepared);
    function runtime() {
      const abort = new AbortController(); let permit;
      const files = localWorkspaceFileTools(project, () => { assertWorkspaceRunContextCurrent(permit); });
      const grant = control.executionGrant(binding.runId), gate = createAgentBoundaryExecutionGate({ binding, authority, grant, control,
        tools: files.map(tool => ({ tool, reference: ref(tool.name), resources: () => (tool.kind === "edit" ? ["read", "write"] : ["read"]).map(access => ({ resourceId: "files", access })) })) });
      permit = createWorkspaceRunPermit({ binding, agentBoundary: gate, catalog, resources, storage, connections, lease, cwd: project, signal: abort.signal,
        provider: { id: "openai", model: binding.connection.model, async turn() { throw new Error("No model expected"); } }, toolNames: names,
        usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} }); permits.push(permit);
      control.attachRuntime(binding.runId, permit);
      const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: project, sessionId }, signal: abort.signal, hooks: false, approval: "auto-edit", extraTools: files,
        taskIntake: { task, current: () => task } }); beginWorkspaceGovernedRun(permit, options, "pi");
      return { permit, files, call: async (name, data, id = randomUUID()) => executeWorkspaceTool(permit, name,
        frozen => files.find(tool => tool.name === name).run(frozen, { cwd: project }), undefined, data, id) };
    }
    return { task, command, binding, lease, intake: begun.intake, prepared, accept, runtime, message, requestId, recovery: recoveryIntent?.recovery };
  }
  function apply(command, proposal) { const begun = control.begin(transport, command, { ...(proposal ? { proposal } : {}) }); return begun.receipt ?? control.accept(begun.intake); }
  t.after(async () => { try { for (const permit of permits) await closeWorkspaceRunPermit(permit); for (const lease of leases) lease.release(); authority.close(); transports.close(); } finally { fs.rmSync(base, { recursive: true, force: true }); } });
  return { home, project, catalog, resources, storage, agent, row, connections, credential, transports, transport, authority, authorityOptions, control, draft, dispatch, recover: (previous, message = "new explicit intent", options = {}) => dispatch(message, options, previous), apply,
    file, beforeMigration, beforeLifecycleMigration, duty, boundary, rights, trackLease(lease) { leases.push(lease); return lease; }, advance(ms) { clock += ms; }, snapshot: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}
