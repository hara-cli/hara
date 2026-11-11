import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { AgentBoundaryContractError, agentBoundaryCommandSigningText } from "../dist/workspace/agent-boundaries-contract.js";
import { WorkspaceAgentCommandControl, agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";
import { agentPolicyProposalDigest } from "../dist/workspace/agent-command-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createTaskExecution } from "../dist/session/task.js";
import { localWorkspaceFileTools } from "../dist/workspace/local-tools.js";
import { createAgentBoundaryExecutionGate } from "../dist/workspace/agent-boundary-execution.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, closeWorkspaceRunPermit, executeWorkspaceTool, assertWorkspaceRunContextCurrent } from "../dist/workspace/execution.js";

const fixtureDocs = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const code = expected => error => error instanceof AgentBoundaryContractError && error.code === expected;
function fixture(t, input = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c3-control-"))), home = join(base, "home"), project = join(base, "project");
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Personal", catalog.read().revision), resources = new WorkspaceResources(home, row.scope);
  resources.initialize(); let agent = resources.agents.initializeMain(); agent = resources.agents.setPermissionTier(agent.agentId, "controlled", agent.configRevision, agent.agentEpoch);
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize(); const connections = new WorkspaceConnectionStoreV2(storage);
  connections.add({ label: "fixture", provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "synthetic-not-real", defaultModel: "synthetic" }, 0);
  const credential = randomBytes(32).toString("hex"), transports = new AgentBoundaryTransports(credential), transport = transports.connect("owner", credential);
  const now = () => clock; let clock = Date.now(); const root = captureWorkspaceProjectIdentity(project), permits = [], leases = [];
  const names = ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"], ref = name => ({ toolId: name, connectorId: null, catalogRevision: 1 });
  const authorityOptions = { catalog, resources, storage, transports, commandControl: true, now,
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
  const draft = (operation, extras = {}) => authority.draft(transport, agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000, operation, ...extras });
  function dispatch(message = "write a private fixture", extras = {}) {
    let task = resources.agents.bindTask(createTaskExecution(message, randomUUID()), agent.agentId, agent.configRevision, agent.agentEpoch);
    const sessionId = randomUUID();
    const command = draft({ action: "task.dispatch", taskId: task.id, conversationId: sessionId, messageDigest: agentCommandMessageDigest(sessionId, message) }, extras);
    const binding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: row.scope, agent: task.workspaceAgentBinding, agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding),
      connection: connections.capture(), runtimeContract: "hara-governed-runtime-v1", project: root, sessionId, runId: randomUUID(), lineage: { rootRunId: null, parentRunId: null, depth: 0 },
      createdAt: new Date().toISOString(), host: { hostId: catalog.read().hostId, hostEpoch: 1, actorId: row.actorId, grantId: row.grantId, grantRevision: row.grantRevision, policyRevision: row.policyRevision },
      budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 32000, timeoutMs: 60000 } });
    task.workspaceRunBinding = binding;
    const lease = WorkspaceSessionLease.acquire(storage, sessionId); leases.push(lease);
    const begun = control.begin(transport, command, { message }); assert.ok(begun.intake);
    const prepared = control.prepareRun(begun.intake, binding, lease, randomUUID());
    const accept = () => control.accept(begun.intake, prepared);
    function runtime() {
      const abort = new AbortController(); let permit;
      const files = localWorkspaceFileTools(project, () => { assertWorkspaceRunContextCurrent(permit); });
      const grant = control.executionGrant(binding.runId), gate = createAgentBoundaryExecutionGate({ binding, authority, grant, control,
        tools: files.map(tool => ({ tool, reference: ref(tool.name), resources: () => (tool.kind === "edit" ? ["read", "write"] : ["read"]).map(access => ({ resourceId: "files", access })) })) });
      permit = createWorkspaceRunPermit({ binding, agentBoundary: gate, catalog, resources, storage, connections, lease, cwd: project, signal: abort.signal,
        provider: { id: "openai", model: binding.connection.model, async turn() { throw new Error("No model expected"); } }, toolNames: names,
        usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} }); permits.push(permit);
      const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: project, sessionId }, signal: abort.signal, hooks: false, approval: "auto-edit", extraTools: files,
        taskIntake: { task, current: () => task } }); beginWorkspaceGovernedRun(permit, options, "pi");
      return { permit, call: async (name, data, id = randomUUID()) => executeWorkspaceTool(permit, name,
        frozen => files.find(tool => tool.name === name).run(frozen, { cwd: project }), undefined, data, id) };
    }
    return { task, command, binding, lease, intake: begun.intake, prepared, accept, runtime, message };
  }
  function apply(command, proposal) { const begun = control.begin(transport, command, { ...(proposal ? { proposal } : {}) }); return begun.receipt ?? control.accept(begun.intake); }
  t.after(async () => { try { for (const permit of permits) await closeWorkspaceRunPermit(permit); for (const lease of leases) lease.release(); authority.close(); transports.close(); } finally { fs.rmSync(base, { recursive: true, force: true }); } });
  return { home, project, catalog, resources, storage, agent, row, connections, credential, transports, transport, authority, authorityOptions, control, draft, dispatch, apply,
    file, beforeMigration, advance(ms) { clock += ms; }, snapshot: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("C3 explicit private migration preserves policies and fences legacy writers without changing portable C0", t => {
  const f = fixture(t), before = JSON.parse(f.beforeMigration), after = f.snapshot();
  assert.equal(before.schemaVersion, 1); assert.equal(after.schemaVersion, 2); assert.deepEqual(after.policies[0].boundary, before.policies[0].boundary);
  assert.equal(after.policies[0].revision, before.policies[0].revision + 1); assert.equal(after.control.origin.sourceRevision, before.revision);
  const view = f.authority.view(f.transport, f.agent.agentId);
  assert.throws(() => f.authority.configure(f.transport, f.agent.agentId, { expectedRevision: view.revision, duty: view.policy.duty, boundary: view.policy.boundary, rights: view.policy.rights }), code("AUTHORITY_UNVERIFIED"));
  const legacy = new WorkspaceAgentBoundaryAuthority({ ...f.authorityOptions, commandControl: false });
  assert.throws(() => legacy.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 1000,
    operation: { action: "agent.pause", reason: "human_request" } }), code("AUTHORITY_UNVERIFIED"));
});

test("C3 default control remains closed until explicit owner initialization", t => {
  const f = fixture(t, { noInitialize: true });
  assert.throws(() => f.control.inspect(f.transport, f.agent.agentId), code("AUTHORITY_UNVERIFIED"));
  assert.equal(f.snapshot().schemaVersion, 1);
});

test("C3 real runtime permit, C1 policy and persisted C3 source execute an admitted file effect", async t => {
  const f = fixture(t), d = f.dispatch(); assert.equal(d.accept().status, "accepted"); const r = d.runtime();
  await r.call("workspace_write", { path: "ok.txt", content: "only once" }); assert.equal(fs.readFileSync(join(f.project, "ok.txt"), "utf8"), "only once");
  assert.equal(f.snapshot().control.commands.length, 1); assert.equal(f.snapshot().control.runs.length, 1);
  assert.ok(f.snapshot().control.audit.every(event => event.actorId === f.row.actorId));
});

test("C3 original ID duplicates and reconnect/expired receipt reads do not mint another execution", t => {
  const f = fixture(t), d = f.dispatch(); const receipt = d.accept(); f.advance(60000);
  assert.deepEqual(f.control.begin(f.transport, d.command, { message: d.message }), { receipt });
  const another = f.transports.connect("owner-again", f.credential);
  assert.deepEqual(f.control.begin(another, d.command, { message: d.message }), { receipt });
  assert.throws(() => f.authority.check(another, d.command), code("AUTHORITY_UNVERIFIED"));
  const changed = structuredClone(d.command); changed.operation.messageDigest = "b".repeat(64);
  assert.throws(() => f.control.begin(another, changed, { message: d.message }), code("COMMAND_ID_CONFLICT"));
  assert.equal(f.snapshot().control.runs.length, 1);
});

test("C3 opaque intake and genuine prepared lease cannot be replaced by JSON approved objects", t => {
  const f = fixture(t), d = f.dispatch();
  assert.throws(() => f.control.accept({ approved: true }, d.prepared), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.accept(d.intake, { approved: true }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.prepareRun(d.intake, d.binding, { sessionId: d.binding.sessionId, assertCurrent() {} }, randomUUID()), code("CONTEXT_MISMATCH"));
  assert.equal(f.snapshot().control.commands.length, 0);
});

test("C3 guest/source spoof is rejected before returning a private command receipt", t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const guest = f.transports.connect("guest", undefined);
  assert.throws(() => f.control.begin(guest, d.command, { message: d.message }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => f.control.readReceipt(guest, f.agent.agentId, d.command.commandId), code("AUTHORITY_UNVERIFIED"));
});

test("C3 stop after dispatch durably fences only the exact run; sibling work can still write", async t => {
  const f = fixture(t), first = f.dispatch("first"), second = f.dispatch("second"); first.accept(); second.accept(); const a = first.runtime(), b = second.runtime();
  const stop = f.draft({ action: "task.stop", taskId: first.task.id, runId: first.binding.runId, claimRevision: 1 });
  assert.equal(f.apply(stop).control.holdId.startsWith("hold_"), true);
  await assert.rejects(a.call("workspace_write", { path: "blocked.txt", content: "no" }), code("CONTROL_HELD"));
  await b.call("workspace_write", { path: "sibling.txt", content: "yes" });
  assert.equal(fs.existsSync(join(f.project, "blocked.txt")), false); assert.equal(fs.readFileSync(join(f.project, "sibling.txt"), "utf8"), "yes");
});

test("C3 pause before dispatch rejects the old command, while resume only permits fresh dispatch", async t => {
  const f = fixture(t), old = f.dispatch("old");
  const pause = f.draft({ action: "agent.pause", reason: "human_request" }), held = f.apply(pause);
  assert.equal(old.accept().status, "rejected"); assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, old.command.commandId).error.code, "STALE_REVISION");
  const resume = f.draft({ action: "agent.resume", holdId: held.control.holdId }); assert.equal(resume.expected.controlEpoch, 1);
  assert.equal(f.apply(resume).status, "applied");
  const fresh = f.dispatch("fresh"); assert.equal(fresh.command.expected.controlEpoch, 2); fresh.accept();
  await fresh.runtime().call("workspace_write", { path: "fresh.txt", content: "yes" });
  assert.deepEqual(f.control.begin(f.transport, old.command, { message: old.message }).receipt.status, "rejected");
});

test("C3 pause and resume never revive an old accepted gate", async t => {
  const f = fixture(t), old = f.dispatch(); old.accept(); const runtime = old.runtime();
  const held = f.apply(f.draft({ action: "agent.pause", reason: "human_request" }));
  await assert.rejects(runtime.call("workspace_write", { path: "held.txt", content: "no" }), code("CONTROL_HELD"));
  f.apply(f.draft({ action: "agent.resume", holdId: held.control.holdId }));
  await assert.rejects(runtime.call("workspace_write", { path: "still-old.txt", content: "no" }), code("STALE_REVISION"));
  assert.equal(fs.existsSync(join(f.project, "still-old.txt")), false);
});

test("C3 unauthorized stop is recorded as rejected and cannot hold an active run", t => {
  const f = fixture(t, { rights: { manage: false } }), d = f.dispatch(); d.accept();
  // Build an authenticated intent as the real connection, but alter no permission or signing bytes.
  const command = { ...structuredClone(d.command), commandId: randomUUID(), rootRequestId: randomUUID(),
    operation: { action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 } };
  command.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex");
  assert.equal(f.apply(command).error.code, "AUTHORIZATION_DENIED");
  assert.equal(f.snapshot().control.audit.at(-1).decision, "rejected");
  assert.throws(() => f.authority.draft(f.transport, f.agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 1000,
    operation: { action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 } }), code("AUTHORIZATION_DENIED"));
  assert.equal(f.snapshot().control.runs[0].hold, null); assert.equal(command.actorChain.requestedBy, f.row.actorId);
});

test("C3 same authority transaction publishes a boundary change and its original command audit", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), view = f.authority.view(f.transport, f.agent.agentId);
  const proposal = { duty: structuredClone(view.policy.duty), boundary: structuredClone(view.policy.boundary), rights: structuredClone(view.policy.rights) };
  proposal.boundary.boundaryRevision++; proposal.boundary.tools.readOnly = true;
  const command = f.draft({ action: "boundary.update", proposedBoundaryDigest: agentPolicyProposalDigest(proposal) });
  assert.equal(f.apply(command, proposal).status, "applied"); const state = f.snapshot();
  assert.equal(state.policies[0].boundary.tools.readOnly, true); assert.equal(state.control.commands.at(-1).command.commandId, command.commandId);
  assert.equal(state.control.audit.at(-1).policyRevision, state.policies[0].revision);
  await assert.rejects(runtime.call("workspace_write", { path: "revoked.txt", content: "no" }));
  assert.equal(fs.existsSync(join(f.project, "revoked.txt")), false);
});

test("C3 a mismatched policy proposal is rejected without policy publication", t => {
  const f = fixture(t), view = f.authority.view(f.transport, f.agent.agentId), proposal = { duty: view.policy.duty, boundary: view.policy.boundary, rights: view.policy.rights };
  const before = f.snapshot().policies; const command = f.draft({ action: "boundary.update", proposedBoundaryDigest: "a".repeat(64) });
  assert.equal(f.apply(command, proposal).status, "rejected"); assert.deepEqual(f.snapshot().policies, before);
});

test("C3 restart can query original receipts but cannot rebind an accepted run", t => {
  const f = fixture(t), d = f.dispatch(); d.accept();
  const restarted = new WorkspaceAgentCommandControl(f.authority);
  assert.equal(restarted.readReceipt(f.transport, f.agent.agentId, d.command.commandId).status, "accepted");
  assert.throws(() => restarted.bind(d.command, d.binding), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => restarted.executionGrant(d.binding.runId), code("AUTHORITY_UNVERIFIED"));
});

test("C3 unreadable private store blocks new effects and preserves corruption", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  fs.writeFileSync(f.file, "CORRUPT_RETAINED", { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "no.txt", content: "no" }));
  assert.equal(fs.readFileSync(f.file, "utf8"), "CORRUPT_RETAINED"); assert.equal(fs.existsSync(join(f.project, "no.txt")), false);
});

test("C3 counter exhaustion never resets the epoch or writes a false successful receipt", t => {
  const f = fixture(t), state = f.snapshot(); state.control.agents[0].epoch = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 }); const before = fs.readFileSync(f.file, "utf8");
  const command = f.draft({ action: "agent.pause", reason: "human_request" });
  assert.throws(() => f.apply(command), code("COUNTER_EXHAUSTED")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});
