import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
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
import { agentPolicyProposalDigest, assertAgentCommandTransition } from "../dist/workspace/agent-command-state.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createTaskExecution } from "../dist/session/task.js";
import { localWorkspaceFileTools } from "../dist/workspace/local-tools.js";
import { createAgentBoundaryExecutionGate } from "../dist/workspace/agent-boundary-execution.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, closeWorkspaceRunPermit, workspaceRunDrainProof, executeWorkspaceTool, assertWorkspaceRunContextCurrent } from "../dist/workspace/execution.js";

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
      control.attachRuntime(binding.runId, permit);
      const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: project, sessionId }, signal: abort.signal, hooks: false, approval: "auto-edit", extraTools: files,
        taskIntake: { task, current: () => task } }); beginWorkspaceGovernedRun(permit, options, "pi");
      return { permit, files, call: async (name, data, id = randomUUID()) => executeWorkspaceTool(permit, name,
        frozen => files.find(tool => tool.name === name).run(frozen, { cwd: project }), undefined, data, id) };
    }
    return { task, command, binding, lease, intake: begun.intake, prepared, accept, runtime, message };
  }
  function apply(command, proposal) { const begun = control.begin(transport, command, { ...(proposal ? { proposal } : {}) }); return begun.receipt ?? control.accept(begun.intake); }
  t.after(async () => { try { for (const permit of permits) await closeWorkspaceRunPermit(permit); for (const lease of leases) lease.release(); authority.close(); transports.close(); } finally { fs.rmSync(base, { recursive: true, force: true }); } });
  return { home, project, catalog, resources, storage, agent, row, connections, credential, transports, transport, authority, authorityOptions, control, draft, dispatch, apply,
    file, beforeMigration, trackLease(lease) { leases.push(lease); return lease; }, advance(ms) { clock += ms; }, snapshot: () => JSON.parse(fs.readFileSync(file, "utf8")) };
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

for (const failure of ["expired intake", "released preparation lease", "post-accept grant expiry"]) test(`C3 ${failure} rejection preserves healthy sibling effects and fresh stop/pause`, async t => {
  const f = fixture(t), healthy = f.dispatch("healthy sibling"); healthy.accept(); const runtime = healthy.runtime();
  const rejected = f.dispatch("only this command must fail", { lifetimeMs: 1000 }), before = fs.readFileSync(f.file, "utf8");
  if (failure === "expired intake") f.advance(1001);
  else if (failure === "released preparation lease") rejected.lease.release();
  if (failure === "post-accept grant expiry") {
    const admit = f.authority.admit.bind(f.authority);
    f.authority.admit = (transport, command) => { if (command.commandId === rejected.command.commandId) f.advance(1001); return admit(transport, command); };
    try { assert.equal(rejected.accept().status, "accepted"); } finally { f.authority.admit = admit; }
    const original = f.control.begin(f.transport, rejected.command, { message: rejected.message });
    assert.equal(original.receipt.status, "unknown"); assert.equal(original.intake, undefined);
    assert.throws(() => f.control.executionGrant(rejected.binding.runId), code("AUTHORITY_UNVERIFIED"));
    assert.equal(f.snapshot().control.runs.find(run => run.runId === rejected.binding.runId).state, "accepted");
  } else {
    assert.throws(() => rejected.accept(), code("AUTHORITY_UNVERIFIED"));
    assert.equal(fs.readFileSync(f.file, "utf8"), before);
  }
  assert.equal(f.authority.commandControlSourceHealthy(), true);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).sourceAvailableHere, true);
  await runtime.call("workspace_write", { path: "healthy-after-rejection.txt", content: failure });
  assert.equal(fs.readFileSync(join(f.project, "healthy-after-rejection.txt"), "utf8"), failure);
  const stopped = f.apply(f.draft({ action: "task.stop", taskId: healthy.task.id, runId: healthy.binding.runId, claimRevision: 1 }));
  assert.ok(stopped.control.holdId); assert.notEqual(stopped.status, "rejected");
  const paused = f.apply(f.draft({ action: "agent.pause", reason: "human_request" }));
  assert.ok(paused.control.holdId); assert.notEqual(paused.status, "rejected");
  await assert.rejects(runtime.call("workspace_write", { path: "held-after-rejection.txt", content: "no" }), code("CONTROL_HELD"));
  assert.equal(fs.existsSync(join(f.project, "held-after-rejection.txt")), false);
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
  const receipt = restarted.readReceipt(f.transport, f.agent.agentId, d.command.commandId);
  assert.equal(receipt.status, "unknown"); assert.equal(receipt.error.code, "AUTHORITY_UNVERIFIED");
  assert.equal(receipt.execution.effect, "none");
  assert.equal(restarted.inspect(f.transport, f.agent.agentId).runs[0].controlledHere, false);
  assert.throws(() => restarted.bind(d.command, d.binding), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => restarted.executionGrant(d.binding.runId), code("AUTHORITY_UNVERIFIED"));
});

test("C3 unreadable private store blocks new effects and preserves corruption", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), original = fs.readFileSync(f.file, "utf8");
  fs.writeFileSync(f.file, "CORRUPT_RETAINED", { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "no.txt", content: "no" }));
  assert.equal(fs.readFileSync(f.file, "utf8"), "CORRUPT_RETAINED"); assert.equal(fs.existsSync(join(f.project, "no.txt")), false);
  fs.writeFileSync(f.file, original, { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "still-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "still-no.txt")), false);
});

test("C3 counter exhaustion never resets the epoch or writes a false successful receipt", t => {
  const f = fixture(t), state = f.snapshot(); state.control.agents[0].epoch = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 }); const before = fs.readFileSync(f.file, "utf8");
  const command = f.draft({ action: "agent.pause", reason: "human_request" });
  assert.throws(() => f.apply(command), code("COUNTER_EXHAUSTED")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});


test("C3 drained requires a genuine post-drain runtime proof; JSON and abort are not observation", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  assert.throws(() => f.control.observeDrained({ approved: true }), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => workspaceRunDrainProof(runtime.permit), code("AUTHORITY_UNVERIFIED"));
  await runtime.call("workspace_write", { path: "observed.txt", content: "yes" });
  await closeWorkspaceRunPermit(runtime.permit);
  const proof = workspaceRunDrainProof(runtime.permit); f.control.observeDrained(proof); f.control.observeDrained(proof);
  const receipt = f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId);
  assert.equal(receipt.status, "drained"); assert.equal(receipt.execution.drain, "observed"); assert.ok(receipt.execution.drainProofRef);
  assert.equal(receipt.execution.effect, "completed");
  assert.equal(f.snapshot().control.audit.filter(row => row.action === "runtime.drained").length, 1);
});

test("C3 drain owner alone rejects a genuine proof paired with another genuine permit", async t => {
  const f = fixture(t), a = f.dispatch("original drain"), b = f.dispatch("different permit"); a.accept(); b.accept();
  const first = a.runtime(), other = b.runtime(); await closeWorkspaceRunPermit(first.permit);
  const proof = workspaceRunDrainProof(first.permit), before = fs.readFileSync(f.file, "utf8");
  // Fault injection isolates the owner defense: binding/attempt still match A, only its private permit slot is B.
  // Both handles are real. No test capability or production injection API is introduced.
  const live = f.control.live.get(a.binding.runId); live.permit = other.permit;
  try { assert.throws(() => f.control.observeDrained(proof), code("AUTHORITY_UNVERIFIED")); }
  finally { live.permit = first.permit; }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).pendingDrainObservations, 0);
});

test("C3 transition independently refuses erasing UNKNOWN effect with the drained state unchanged", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  await assert.rejects(executeWorkspaceTool(runtime.permit, "workspace_write", async () => { throw new Error("synthetic unknown outcome"); }, undefined,
    { path: "unknown-transition.txt", content: "no replay" }, "unknown-transition"));
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  const before = f.snapshot().control, next = structuredClone(before); assert.equal(before.runs[0].state, "drained");
  assert.equal(before.runs[0].effect, "unknown"); next.runs[0].effect = "completed";
  assert.throws(() => assertAgentCommandTransition(before, next), code("AUTHORITY_UNVERIFIED"));
});

test("C3 persisted unknown run cannot return to execution but genuine drain remains observable", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), state = f.snapshot();
  state.control.runs[0].state = "unknown"; fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 });
  const before = f.authority.commandControlState().control;
  for (const oldPhase of ["unknown", "draining"]) for (const phase of ["accepted", "bound", "running"]) {
    const original = structuredClone(before); original.runs[0].state = oldPhase;
    const next = structuredClone(original); next.runs[0].state = phase;
    assert.throws(() => assertAgentCommandTransition(original, next), code("AUTHORITY_UNVERIFIED"));
  }
  await assert.rejects(runtime.call("workspace_write", { path: "unknown-state-no.txt", content: "no" }), code("CONTROL_HELD"));
  assert.equal(fs.existsSync(join(f.project, "unknown-state-no.txt")), false);
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  assert.equal(f.snapshot().control.runs[0].state, "drained");
});

test("C3 UNKNOWN can be queried and manually stopped; drain/ack cannot erase or replay it", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), input = { path: "unknown.txt", content: "accepted" };
  await assert.rejects(executeWorkspaceTool(runtime.permit, "workspace_write", async frozen => {
    await runtime.files.find(tool => tool.name === "workspace_write").run(frozen, { cwd: f.project }); throw new Error("synthetic response lost");
  }, undefined, input, "unknown-effect"), /response lost/);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).execution.effect, "unknown");
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 }), stopped = f.apply(stop);
  assert.equal(stopped.status, "unknown"); assert.equal(stopped.execution.drain, "observed"); assert.equal(stopped.execution.effect, "unknown");
  assert.ok(stopped.control.holdId); assert.equal(f.snapshot().control.runs[0].effect, "unknown");
  assert.ok(f.control.inspect(f.transport, f.agent.agentId).runs[0].recovery.includes("query_original"));
  assert.equal(fs.readFileSync(join(f.project, "unknown.txt"), "utf8"), "accepted");
  const retry = { ...structuredClone(d.command), commandId: randomUUID() };
  retry.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(retry)).digest("hex");
  const begun = f.control.begin(f.transport, retry, { message: d.message });
  const retryLease = f.trackLease(WorkspaceSessionLease.acquire(f.storage, d.binding.sessionId));
  const prepared = f.control.prepareRun(begun.intake, { ...d.binding, runId: randomUUID() }, retryLease, randomUUID());
  // Original accepted root/task remain non-replayable even with a new command/run ID.
  const result = f.control.accept(begun.intake, prepared); assert.equal(result.status, "rejected"); assert.equal(result.error.code, "COMMAND_ID_CONFLICT");
});

test("C3 audit outbox acknowledgments are durable and idempotent without changing UNKNOWN/control", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  await assert.rejects(executeWorkspaceTool(runtime.permit, "workspace_write", async () => { throw new Error("uncertain"); }, undefined,
    { path: "unknown-audit.txt", content: "do not replay" }, "unknown-audit"));
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  const before = f.snapshot(), events = f.control.audit(f.transport, f.agent.agentId), ids = events.map(row => row.eventId);
  assert.ok(events.every(row => !row.acknowledged));
  assert.throws(() => f.control.acknowledgeAudit(f.transport, f.agent.agentId, ["foreign-event"]), code("AUTHORIZATION_DENIED"));
  const ack = f.control.acknowledgeAudit(f.transport, f.agent.agentId, ids); assert.ok(ack.every(row => row.acknowledged));
  const after = f.snapshot(); assert.deepEqual(after.control.runs, before.control.runs); assert.deepEqual(after.control.commands, before.control.commands);
  assert.equal(after.control.runs[0].effect, "unknown");
  assert.deepEqual(f.control.acknowledgeAudit(f.transport, f.agent.agentId, ids), ack); assert.equal(f.snapshot().revision, after.revision);
});

test("C3 observation write failure retains the genuine proof and reconciles only its publication", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(); await runtime.call("workspace_write", { path: "once.txt", content: "once" });
  await Promise.all([closeWorkspaceRunPermit(runtime.permit), closeWorkspaceRunPermit(runtime.permit)]);
  const proof = workspaceRunDrainProof(runtime.permit), original = f.authority.observeCommandControl.bind(f.authority), before = fs.readFileSync(f.file, "utf8");
  f.authority.observeCommandControl = () => { throw new Error("synthetic unavailable writer"); };
  assert.throws(() => f.control.observeDrained(proof), /unavailable writer/); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).pendingDrainObservations, 1);
  f.authority.observeCommandControl = original;
  f.control.reconcileDrainObservations(f.transport, f.agent.agentId);
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, d.command.commandId).execution.drain, "observed");
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).pendingDrainObservations, 0);
  f.control.observeDrained(proof); assert.equal(f.snapshot().control.audit.filter(row => row.action === "runtime.drained").length, 1);
  assert.equal(fs.readFileSync(join(f.project, "once.txt"), "utf8"), "once");
});

test("C3 capacity refuses new work before effects and retains reserved slots for an authorized stop", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), state = f.snapshot();
  // Preload valid retained historical rejections; then exercise actual disk CAS at the capacity edge.
  const source = state.control.commands[0];
  while (state.control.commands.length < 252) {
    const command = structuredClone(source.command); command.commandId = randomUUID(); command.rootRequestId = randomUUID();
    command.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex");
    const receipt = { ...structuredClone(source.receipt), commandId: command.commandId, rootRequestId: command.rootRequestId,
      intentDigest: command.intentDigest, status: "rejected", error: { code: "AUTHORIZATION_DENIED", retry: "never" } };
    const sequence = ++state.control.sequence;
    state.control.commands.push({ command, receipt, sequence });
    state.control.audit.push({ ...structuredClone(state.control.audit[0]), eventId: `audit_${sequence}`, sequence, commandId: command.commandId,
      decision: "rejected", code: "AUTHORIZATION_DENIED" });
  }
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 });
  const before = fs.readFileSync(f.file, "utf8"), blocked = f.dispatch("must not start a new model or effect");
  assert.throws(() => blocked.accept(), code("AUTHORITY_UNVERIFIED")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(f.authority.commandControlSourceHealthy(), true);
  assert.equal(f.control.inspect(f.transport, f.agent.agentId).sourceAvailableHere, true);
  await runtime.call("workspace_write", { path: "capacity-healthy.txt", content: "already admitted" });
  assert.equal(fs.readFileSync(join(f.project, "capacity-healthy.txt"), "utf8"), "already admitted");
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 });
  const stopped = f.apply(stop); assert.notEqual(stopped.status, "rejected"); assert.ok(stopped.control.holdId);
  assert.ok(f.apply(f.draft({ action: "agent.pause", reason: "human_request" })).control.holdId);
  await closeWorkspaceRunPermit(runtime.permit); f.control.observeDrained(workspaceRunDrainProof(runtime.permit));
  assert.equal(f.control.readReceipt(f.transport, f.agent.agentId, stop.commandId).execution.drain, "observed");
});

test("C3 independent processes compete through real private CAS; only one old-epoch pause wins", async t => {
  const f = fixture(t), children = [];
  const launch = () => {
    const child = fork(new URL("./helpers/agent-command-competitor.mjs", import.meta.url), [], { execArgv: [], silent: true }); children.push(child);
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    const messages = [], waiters = [];
    child.on("message", value => { const waiter = waiters.shift(); if (waiter) waiter(value); else messages.push(value); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CAS competitor deadline: ${stderr}`)), 10000);
      waiters.push(value => { clearTimeout(timer); resolve(value); });
    });
    const exited = once(child, "exit");
    child.stdin.end(JSON.stringify({ home: f.home, project: f.project, workspaceId: f.row.scope.workspaceId, credential: f.credential,
      agentId: f.agent.agentId, names: ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"] }));
    return { child, next, exited };
  };
  const a = launch(), b = launch();
  t.after(() => { for (const child of children) if (child.exitCode === null && !child.killed) child.kill(); });
  assert.deepEqual(await a.next(), { ready: true }); assert.deepEqual(await b.next(), { ready: true });
  a.child.send("go"); b.child.send("go");
  const results = await Promise.all([a.next(), b.next()]); await Promise.all([a.exited, b.exited]);
  assert.equal(results.filter(row => row.receipt?.status === "accepted").length, 1);
  assert.equal(results.filter(row => row.receipt?.error?.code === "STALE_REVISION").length, 1);
  const state = f.snapshot(); assert.equal(state.control.agents[0].epoch, 1); assert.equal(state.control.commands.length, 2);
  assert.equal(state.control.audit.filter(row => row.decision === "allowed").length, 1);
  assert.equal(state.control.audit.filter(row => row.decision === "rejected").length, 1);
  assert.equal(new Set(state.control.audit.map(row => row.sequence)).size, 2);
});

test("C3 first migration refuses any physical lease and preserves the v1 policy until actual release", t => {
  const f = fixture(t, { noInitialize: true }), lease = f.trackLease(WorkspaceSessionLease.acquire(f.storage, randomUUID()));
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => f.control.initialize(f.transport), code("CONTROL_HELD")); assert.equal(fs.readFileSync(f.file, "utf8"), before);
  lease.release(); f.control.initialize(f.transport); assert.equal(f.snapshot().schemaVersion, 2);
});

test("C3 persisted protection revokes a legacy opaque RunPermit and cannot be disabled by omitting C3", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const protectedState = fs.readFileSync(f.file, "utf8"), legacy = JSON.parse(protectedState);
  legacy.schemaVersion = 1; delete legacy.control; fs.writeFileSync(f.file, JSON.stringify(legacy)+"\n", { mode: 0o600 });
  const abort = new AbortController(); let modelCalls = 0;
  const permit = createWorkspaceRunPermit({ binding: d.binding, catalog: f.catalog, resources: f.resources, storage: f.storage,
    connections: f.connections, lease: d.lease, cwd: f.project, signal: abort.signal,
    provider: { id: "openai", model: d.binding.connection.model, async turn() { modelCalls++; throw new Error("must not dispatch"); } },
    toolNames: [], usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} });
  const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: f.project, sessionId: d.binding.sessionId }, signal: abort.signal, hooks: false, approval: "auto-edit",
    taskIntake: { task: d.task, current: () => d.task } }); beginWorkspaceGovernedRun(permit, options, "pi");
  // Independent fence even if a legacy permit already exists in another process's memory.
  fs.writeFileSync(f.file, protectedState, { mode: 0o600 });
  assert.throws(() => assertWorkspaceRunContextCurrent(permit), code("AUTHORITY_UNVERIFIED"));
  assert.throws(() => executeWorkspaceTool(permit, "workspace_write", async () => { throw new Error("must not enter"); }, undefined,
    { path: "legacy-no.txt", content: "no" }, "legacy-no"), code("AUTHORITY_UNVERIFIED"));
  assert.equal(modelCalls, 0); assert.equal(fs.existsSync(join(f.project, "legacy-no.txt")), false);
  await closeWorkspaceRunPermit(permit);
});

for (const altered of ["claimRevision", "requestId", "originalIntent"]) test(`C3 each effect rejects a structurally valid altered original ${altered}`, async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime(), state = f.snapshot();
  if (altered === "claimRevision") state.control.runs[0].claimRevision++;
  else if (altered === "requestId") state.control.runs[0].requestId = randomUUID();
  else {
    const record = state.control.commands[0]; record.command.operation.messageDigest = "b".repeat(64);
    record.command.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(record.command)).digest("hex");
    record.receipt.intentDigest = record.command.intentDigest;
  }
  fs.writeFileSync(f.file, JSON.stringify(state)+"\n", { mode: 0o600 });
  await assert.rejects(runtime.call("workspace_write", { path: "altered-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "altered-no.txt")), false);
});

test("C3 downgrade observed only inside CAS stays fenced after the original file is restored", async t => {
  const f = fixture(t), healthy = f.dispatch(); healthy.accept(); const runtime = healthy.runtime(), next = f.dispatch("after cut");
  const before = fs.readFileSync(f.file, "utf8"), update = f.authority.state.update.bind(f.authority.state);
  // Inject the cross-file cut after preflight reads and restore before the caller catches it.
  f.authority.state.update = (revision, change) => {
    fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(f.beforeMigration), revision })+"\n", { mode: 0o600 });
    try { return update(revision, change); }
    finally { fs.writeFileSync(f.file, before, { mode: 0o600 }); f.authority.state.update = update; }
  };
  assert.throws(() => next.accept(), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.authority.commandControlSourceHealthy(), false);
  await assert.rejects(runtime.call("workspace_write", { path: "restored-cut-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "restored-cut-no.txt")), false);
  assert.ok(f.apply(f.draft({ action: "task.stop", taskId: healthy.task.id, runId: healthy.binding.runId, claimRevision: 1 })).control.holdId);
});

test("C3 an invalid trusted transition still permanently fences the source and healthy effects", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  const before = fs.readFileSync(f.file, "utf8"), snapshot = f.authority.commandControlState();
  assert.throws(() => f.authority.observeCommandControl(snapshot.revision, state => {
    state.runs[0].requestId = randomUUID(); return state;
  }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.authority.commandControlSourceHealthy(), false);
  await assert.rejects(runtime.call("workspace_write", { path: "invalid-transition-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "invalid-transition-no.txt")), false);
});

test("C3 a real private-lock publication failure preserves the ledger and permanently fences old effects", async t => {
  const f = fixture(t), d = f.dispatch(); d.accept(); const runtime = d.runtime();
  const pause = f.draft({ action: "agent.pause", reason: "human_request" }), lockPath = join(f.file, "..", "workspace-agent-authority-v1.lock"), before = fs.readFileSync(f.file, "utf8");
  // The real CAS writer must refuse a non-file in its exact private lock slot.
  fs.mkdirSync(lockPath, { mode: 0o700 });
  try { assert.throws(() => f.apply(pause), code("AUTHORITY_UNVERIFIED")); }
  finally { fs.rmdirSync(lockPath); }
  assert.equal(fs.readFileSync(f.file, "utf8"), before); assert.equal(f.authority.commandControlSourceHealthy(), false);
  await assert.rejects(runtime.call("workspace_write", { path: "failed-writer-no.txt", content: "no" }), code("AUTHORITY_UNVERIFIED"));
  assert.equal(fs.existsSync(join(f.project, "failed-writer-no.txt")), false);
  const stop = f.draft({ action: "task.stop", taskId: d.task.id, runId: d.binding.runId, claimRevision: 1 });
  assert.ok(f.apply(stop).control.holdId); assert.equal(f.control.inspect(f.transport, f.agent.agentId).sourceAvailableHere, false);
});
