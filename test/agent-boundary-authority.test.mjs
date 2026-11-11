import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, currentWorkspaceResourceBinding, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { AgentBoundaryContractError, agentBoundaryCommandSigningText } from "../dist/workspace/agent-boundaries-contract.js";

const fixtures = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const allRights = { manage: true, invoke: true, privateRead: true, nodeUse: true };
const secret = () => randomBytes(32).toString("hex");
const deny = (fn, code) => assert.throws(fn, error => error instanceof AgentBoundaryContractError && error.code === code);
function docs(view, resources = []) {
  const source = name => structuredClone(fixtures.valid.find(row => row.name === name).document);
  const duty = source("duty"), boundary = source("boundary");
  for (const document of [duty, boundary]) { document.agentId = view.agent.agentId; document.context = structuredClone(view.context); }
  boundary.resources = resources; boundary.tools = { allow: [], deny: [], readOnly: false };
  return { duty, boundary };
}
function fixture(t, extra = {}) {
  const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c1-authority-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Same label", catalog.read().revision);
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize();
  const resources = new WorkspaceResources(home, row.scope); resources.initialize();
  const agent = resources.agents.initializeMain({ profile: { displayName: "Same name" } });
  const ownerCredential = secret(), transports = new AgentBoundaryTransports(ownerCredential), transport = transports.connect("owner", ownerCredential);
  let clock = Date.parse("2026-11-11T01:00:00.000Z");
  const options = { catalog, resources, storage, transports, now: () => clock, ...extra };
  const authority = new WorkspaceAgentBoundaryAuthority(options);
  const policyFile = storage.run(() => join(workspaceStateHome(), ".hara", "workspace-agent-authority-v1.json"));
  const configure = (rights = allRights, documents) => {
    const view = authority.view(transport, agent.agentId);
    return authority.configure(transport, agent.agentId, { expectedRevision: view.revision, ...documents ?? docs(view), rights });
  };
  const draft = (operation = { action: "task.dispatch", taskId: "task", conversationId: "conversation", messageDigest: "a".repeat(64) }) =>
    authority.draft(transport, agent.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), operation, lifetimeMs: 30_000 });
  return { home, catalog, row, storage, resources, agent, ownerCredential, transports, transport, options, authority, policyFile, configure, draft,
    advance: ms => { clock += ms; } };
}

test("C1 uses the existing local owner, node, grant and generation; absent policy grants nothing", t => {
  const f = fixture(t), view = f.authority.view(f.transport, f.agent.agentId), catalog = f.catalog.read();
  assert.equal(view.context.humanSubjectId, f.row.actorId); assert.equal(view.context.nodeId, catalog.hostId);
  assert.equal(view.context.localGrant.grantId, f.row.grantId);
  assert.deepEqual(view.context.resourceBinding, f.storage.run(() => currentWorkspaceResourceBinding()));
  assert.equal(view.configured, false); assert.equal(view.runtimeEnforced, false); assert.equal(fs.existsSync(f.policyFile), false);
  deny(() => f.draft(), "BOUNDARY_CONFIRMATION_REQUIRED");
  assert.deepEqual(view.identityReservations, { account: null, device: null, membership: null, remoteExecution: false });
  assert.ok(Object.values(view.context.collaboration).every(value => value === null));
});

test("C1 command grants are opaque, issuer-local, current and never runtime permits", t => {
  const f = fixture(t); f.configure(); const command = f.draft(), grant = f.authority.admit(f.transport, command);
  assert.equal(command.provenance.channel, "local_human");
  assert.equal(createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex"), command.intentDigest);
  const facts = f.authority.grantFacts(grant); assert.equal(facts.executionPermit, false); assert.equal(facts.controlVerified, false);
  deny(() => f.authority.grantFacts(JSON.parse(JSON.stringify(grant))), "AUTHORITY_UNVERIFIED");
  const other = new WorkspaceAgentBoundaryAuthority(f.options); deny(() => other.grantFacts(grant), "AUTHORITY_UNVERIFIED");
  f.authority.retire(grant); deny(() => f.authority.grantFacts(grant), "AUTHORITY_UNVERIFIED");
  assert.equal(f.authority.check(f.transport, command).effect, "none");
  const reopened = new WorkspaceAgentBoundaryAuthority(f.options);
  assert.equal(reopened.view(f.transport, f.agent.agentId).current, true);
  assert.equal(reopened.check(f.transport, command).executable, false);
});

test("C1 ordinary, foreign, cloned, disconnected and failed-bootstrap transports cannot impersonate owner", t => {
  const f = fixture(t); f.configure(); const command = f.draft();
  const guest = f.transports.connect("same-local-socket", undefined);
  for (const handle of [guest, {}, structuredClone(f.transport), new AgentBoundaryTransports(f.ownerCredential).connect("foreign", f.ownerCredential)]) {
    deny(() => f.authority.check(handle, command), "AUTHORITY_UNVERIFIED");
  }
  deny(() => f.transports.connect("bad", secret()), "AUTHORITY_UNVERIFIED");
  const grant = f.authority.admit(f.transport, command); f.transports.disconnect(f.transport);
  deny(() => f.authority.grantFacts(grant), "AUTHORITY_UNVERIFIED");
});

test("C1 independently checks exact provenance, original digest, deadline and current context", t => {
  const f = fixture(t); f.configure(); const command = f.draft();
  for (const change of [v => v.provenance.proofRef = "claimed-proof", v => v.operation.messageDigest = "b".repeat(64)]) {
    const forged = structuredClone(command); change(forged); deny(() => f.authority.check(f.transport, forged), "AUTHORITY_UNVERIFIED");
  }
  const human = structuredClone(command); human.context.humanSubjectId = human.context.localGrant.humanSubjectId = human.actorChain.requestedBy = "other-person";
  deny(() => f.authority.check(f.transport, human), "CONTEXT_MISMATCH");
  const device = structuredClone(command); device.provenance.channel = "signed_device"; device.context.deviceId = "claimed-device";
  device.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(device)).digest("hex");
  deny(() => f.authority.check(f.transport, device), "AUTHORITY_UNVERIFIED");
  f.advance(30_000); deny(() => f.authority.check(f.transport, command), "AUTHORITY_UNVERIFIED");
});

test("C1 manage, invocation, private read and node use do not imply each other", t => {
  const f = fixture(t);
  for (const enabled of ["manage", "invoke", "privateRead", "nodeUse"]) {
    const rights = Object.fromEntries(Object.keys(allRights).map(key => [key, key === enabled])); f.configure(rights);
    deny(() => f.draft(), "AUTHORIZATION_DENIED");
    const manage = () => f.draft({ action: "agent.pause", reason: "human_request" });
    if (enabled === "manage") assert.equal(manage().operation.action, "agent.pause"); else deny(manage, "AUTHORIZATION_DENIED");
  }
  f.configure({ manage: false, invoke: true, privateRead: false, nodeUse: true }); assert.equal(f.draft().operation.action, "task.dispatch");
  deny(() => f.draft({ action: "agent.pause", reason: "human_request" }), "AUTHORIZATION_DENIED");
});

test("C1 fresh policy, Agent configuration, parent grant and transport fences invalidate outstanding grants", async t => {
  for (const change of [
    f => f.configure({ ...allRights, invoke: false }),
    f => f.resources.agents.updatePersona(f.agent.agentId, { profile: { displayName: "Changed" } }, f.agent.configRevision, f.agent.agentEpoch),
    f => f.catalog.revoke(f.row.scope.workspaceId, f.catalog.read().revision),
    f => f.transports.close(),
    f => f.authority.close(),
  ]) await t.test("fresh authority denies after change", t => {
    const f = fixture(t); f.configure(); const grant = f.authority.admit(f.transport, f.draft()); change(f);
    assert.throws(() => f.authority.grantFacts(grant));
  });
});

test("C1 same-named workspaces and Agents cannot borrow each other's policy or grants", t => {
  const a = fixture(t), b = fixture(t); a.configure(); b.configure();
  assert.notEqual(a.row.actorId, b.row.actorId); assert.notEqual(a.agent.agentId, b.agent.agentId);
  deny(() => b.authority.check(b.transport, a.draft()), "AUTHORITY_UNVERIFIED");
  const wrong = docs(a.authority.view(a.transport, a.agent.agentId));
  wrong.duty.agentId = wrong.boundary.agentId = b.agent.agentId;
  deny(() => b.authority.configure(b.transport, b.agent.agentId, { expectedRevision: 1, ...wrong, rights: allRights }), "CONTEXT_MISMATCH");
  deny(() => a.authority.view(a.transport, "Same name"), "INVALID_DOCUMENT");
});

test("C1 missing/corrupt policy fails closed, preserves evidence and never imports owns/persona permissions", t => {
  const f = fixture(t); f.configure(); const command = f.draft(), grant = f.authority.admit(f.transport, command);
  const original = fs.readFileSync(f.policyFile); fs.writeFileSync(f.policyFile, "{corrupt", { mode: 0o600 });
  deny(() => f.authority.check(f.transport, command), "AUTHORITY_UNVERIFIED"); assert.equal(fs.readFileSync(f.policyFile, "utf8"), "{corrupt");
  fs.writeFileSync(f.policyFile, original, { mode: 0o600 }); assert.equal(f.authority.check(f.transport, command).effect, "none");
  fs.renameSync(f.policyFile, f.policyFile + ".retained");
  deny(() => f.authority.grantFacts(grant), "BOUNDARY_CONFIRMATION_REQUIRED"); assert.equal(fs.existsSync(f.policyFile), false);
  assert.deepEqual(fs.readFileSync(f.policyFile + ".retained"), original);
});

test("C1 CAS, document revisions, counters and accessor rejection preserve the last good policy", t => {
  const f = fixture(t), configured = f.configure(), original = fs.readFileSync(f.policyFile);
  deny(() => f.authority.configure(f.transport, f.agent.agentId, { expectedRevision: 0, ...docs(configured), rights: allRights }), "STALE_REVISION");
  const skipped = docs(configured); skipped.duty.dutyRevision = 3;
  deny(() => f.authority.configure(f.transport, f.agent.agentId, { expectedRevision: 1, ...skipped, rights: allRights }), "STALE_REVISION");
  let getterCalls = 0;
  const accessor = { expectedRevision: 1, ...docs(configured), get rights() { getterCalls++; return allRights; } };
  deny(() => f.authority.configure(f.transport, f.agent.agentId, accessor), "INVALID_DOCUMENT"); assert.equal(getterCalls, 0);
  assert.deepEqual(fs.readFileSync(f.policyFile), original);
  const state = JSON.parse(original); state.revision = Number.MAX_SAFE_INTEGER; fs.writeFileSync(f.policyFile, JSON.stringify(state), { mode: 0o600 });
  deny(() => f.authority.configure(f.transport, f.agent.agentId, { expectedRevision: state.revision, ...docs(configured), rights: allRights }), "COUNTER_EXHAUSTED");
});

test("C1 resource and tool bindings come from current Host registries, not paths or matching names", t => {
  let live = true, resourceRevision = 1;
  const f = fixture(t, { resourcesForAgent(agentId) { return [{ resourceId: "project-reference", agentId, revision: resourceRevision,
    binding: f.storage.run(() => currentWorkspaceResourceBinding()), access: ["read"], assertCurrent() { if (!live) throw new AgentBoundaryContractError("GRANT_REVOKED", "authority.resource"); } }]; } });
  const view = f.authority.view(f.transport, f.agent.agentId), documents = docs(view, [{ resourceId: "project-reference", access: ["read"] }]);
  f.configure(allRights, documents); const grant = f.authority.admit(f.transport, f.draft()); resourceRevision++;
  deny(() => f.authority.grantFacts(grant), "STALE_REVISION"); resourceRevision--; live = false;
  deny(() => f.authority.grantFacts(grant), "GRANT_REVOKED"); live = true;
  const excess = docs(view, [{ resourceId: "project-reference", access: ["write"] }]); excess.boundary.boundaryRevision = 2;
  deny(() => f.configure(allRights, excess), "AUTHORIZATION_DENIED");
  const unknown = docs(view, [{ resourceId: "path-looking-reference", access: ["read"] }]); unknown.boundary.boundaryRevision = 2;
  deny(() => f.configure(allRights, unknown), "AUTHORIZATION_DENIED");
  const tools = docs(view); tools.boundary.boundaryRevision = 2; tools.boundary.tools.allow = [{ toolId: "unregistered-tool", connectorId: null, catalogRevision: 1 }];
  deny(() => f.configure(allRights, tools), "AUTHORIZATION_DENIED");
});

test("C1 external executors require a registered exact pair and remain uncontrolled metadata", t => {
  const registered = { agentId: "external-agent", instanceId: "boot-1", alias: "external", displayName: "Same name", engine: "codex" };
  const f = fixture(t, { externalDirectory: { registeredAgent: id => id === registered.agentId ? registered : null } }); f.configure();
  const input = { expectedRevision: 1, externalAgentId: registered.agentId, instanceId: registered.instanceId, agentId: f.agent.agentId, resourceId: null };
  const linked = f.authority.linkExternal(f.transport, input); assert.equal(linked.controlled, false);
  assert.equal(f.resources.agents.list().agents.length, 1);
  const before = fs.readFileSync(f.policyFile);
  deny(() => f.authority.linkExternal(f.transport, { ...input, expectedRevision: 2, instanceId: "old-boot" }), "AUTHORITY_UNVERIFIED");
  deny(() => f.authority.linkExternal(f.transport, { ...input, expectedRevision: 2, externalAgentId: "unknown" }), "AUTHORITY_UNVERIFIED");
  assert.deepEqual(fs.readFileSync(f.policyFile), before);
  assert.equal(f.authority.view(f.transport, f.agent.agentId).executors[0].currentRegistration, true);
  registered.instanceId = "boot-2";
  const retained = f.authority.view(f.transport, f.agent.agentId).executors[0];
  assert.equal(retained.currentRegistration, false); assert.equal(retained.controlled, false);
});

test("C1 same Host and owner connection still enforce distinct Workspace scope, subject and resource generation", t => {
  const f = fixture(t); f.configure(); const command = f.draft();
  const row = f.catalog.create("Same label", f.catalog.read().revision), storage = new WorkspaceResourceStorage(f.home, row.scope); storage.initialize();
  const resources = new WorkspaceResources(f.home, row.scope); resources.initialize(); const agent = resources.agents.initializeMain({ profile: { displayName: "Same name" } });
  const other = new WorkspaceAgentBoundaryAuthority({ catalog: f.catalog, storage, resources, transports: f.transports, now: f.options.now });
  const view = other.view(f.transport, agent.agentId);
  assert.notEqual(view.context.humanSubjectId, command.context.humanSubjectId); assert.notEqual(view.context.resourceBinding.scopeKey, command.context.resourceBinding.scopeKey);
  other.configure(f.transport, agent.agentId, { expectedRevision: 0, ...docs(view), rights: allRights });
  deny(() => other.check(f.transport, command), "CONTEXT_MISMATCH");
  assert.equal(f.authority.check(f.transport, command).effect, "none");
});

test("C1 tool allow references require the exact live catalog revision and deny never grants", t => {
  let catalogRevision = 1, live = true;
  const f = fixture(t, { toolsForAgent: () => [{ toolId: "registered-tool", connectorId: null, catalogRevision,
    assertCurrent() { if (!live) throw new AgentBoundaryContractError("GRANT_REVOKED", "authority.tool"); } }] });
  const view = f.authority.view(f.transport, f.agent.agentId), documents = docs(view);
  const tool = { toolId: "registered-tool", connectorId: null, catalogRevision: 1 }; documents.boundary.tools.allow = [tool];
  f.configure(allRights, documents); const grant = f.authority.admit(f.transport, f.draft());
  catalogRevision++; deny(() => f.authority.grantFacts(grant), "AUTHORIZATION_DENIED"); catalogRevision--;
  live = false; deny(() => f.authority.grantFacts(grant), "GRANT_REVOKED"); live = true;
  const conflict = structuredClone(documents); conflict.boundary.boundaryRevision++; conflict.boundary.tools.deny = [tool];
  deny(() => f.configure(allRights, conflict), "AUTHORIZATION_DENIED");
});
