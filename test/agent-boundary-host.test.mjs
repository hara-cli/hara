import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceAgentBoundaryAuthority } from "../dist/workspace/agent-boundary-authority.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { parseAgentBoundaryDocument, parseAgentHubDocument, agentBoundaryCommandSigningText } from "../dist/workspace/agent-boundaries-contract.js";
import { createC0AgentHubStore, startC0AgentHubIngress } from "../dist/agent-hub/c0-adapter.js";
import { HaraStorageQuota } from "../dist/storage/quota.js";

const fixtureDocuments = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const secret = () => randomBytes(32).toString("hex");
const allRights = { manage: true, invoke: true, privateRead: true, nodeUse: true };
const denied = promise => assert.rejects(promise, error => error.data?.boundary?.code === "AUTHORITY_UNVERIFIED");
async function connect(handle) {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`), pending = new Map(); let serial = 0;
  socket.on("error", () => {});
  socket.on("message", raw => {
    const value = JSON.parse(raw.toString()), waiter = pending.get(value.id); if (!waiter) return;
    pending.delete(value.id); clearTimeout(waiter.timer);
    if (value.error) waiter.reject(Object.assign(new Error(value.error.message), { data: value.error.data, rpcCode: value.error.code })); else waiter.resolve(value.result);
  });
  await once(socket, "open");
  return { request(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error("C1 RPC deadline")); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }); }, async close() { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, "close"); socket.close(); await closed; } };
}
async function fixture(t, enabled = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c1-host-"))), ownerCredential = secret(); let activations = 0;
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root, version: "C1-synthetic",
    ...(enabled ? { agentBoundaries: { ownerCredential } } : {}), providerFactory() { activations++; throw new Error("C1 must not activate a provider"); } });
  const clients = [], open = async () => { const client = await connect(handle); clients.push(client); return client; };
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await handle.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = await open(), init = await owner.request("initialize", { token: handle.token, ...(enabled ? { boundaryCredential: ownerCredential } : {}) });
  const created = await owner.request("workspace.create", { label: "Personal", expectedRevision: init.workspace.revision });
  const params = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration, agentId: created.selectedAgentId };
  return { root, home: join(root, "home"), handle, ownerCredential, owner, init, params, open, activations: () => activations };
}
async function configure(f) {
  const view = await f.owner.request("workspace.boundaries.prepareProject", f.params);
  const copy = name => structuredClone(fixtureDocuments.valid.find(row => row.name === name).document);
  const duty = copy("duty"), boundary = copy("boundary");
  for (const document of [duty, boundary]) { document.context = view.context; document.agentId = f.params.agentId; }
  boundary.resources = [{ resourceId: view.resources[0].resourceId, access: ["read"] }]; boundary.tools = { allow: [], deny: [], readOnly: true };
  return f.owner.request("workspace.boundaries.configure", { ...f.params, expectedRevision: view.revision, duty, boundary, rights: allRights });
}
const draftParams = f => ({ ...f.params, commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30_000,
  operation: { action: "task.dispatch", taskId: "task", conversationId: "conversation", messageDigest: "c".repeat(64) } });
async function noEffects(f) {
  const snapshot = await f.owner.request("workspace.snapshot", { workspaceId: f.params.workspaceId, agentId: f.params.agentId });
  assert.equal(f.activations(), 0); assert.equal(snapshot.conversation.usage.modelCalls, 0);
  assert.deepEqual(snapshot.conversation.history, []); assert.deepEqual(snapshot.approvals, []);
}

test("C1 hard gate: Host derives provenance from the verified connection, ordinary local socket cannot self-claim human", async t => {
  const f = await fixture(t); await configure(f);
  const view = await f.owner.request("workspace.boundaries.get", { workspaceId: f.params.workspaceId, agentId: f.params.agentId });
  const command = await f.owner.request("workspace.boundaries.draft", draftParams(f));
  assert.deepEqual(command.provenance, view.provenance); assert.equal(command.actorChain.requestedBy, view.context.humanSubjectId);
  assert.equal(command.intentDigest, createHash("sha256").update(agentBoundaryCommandSigningText(command)).digest("hex"));
  const checked = await f.owner.request("workspace.boundaries.check", { ...f.params, command });
  assert.equal(checked.executable, false); assert.equal(checked.effect, "none");
  const guest = await f.open();
  // Same socket endpoint and generic transport credential, with every relevant origin claim.
  await guest.request("initialize", { token: f.handle.token, source: "local_human", principal: view.context.humanSubjectId,
    provenance: view.provenance, clientName: "Hara Desktop", clientCapabilities: ["workspace.agent-boundaries.authority.v1"] });
  await denied(guest.request("workspace.boundaries.check", { ...f.params, command }));
  await denied(guest.request("workspace.boundaries.get", { workspaceId: "unknown-but-must-not-be-looked-up", agentId: f.params.agentId }));
  await assert.rejects(f.owner.request("workspace.boundaries.draft", { ...draftParams(f), provenance: { channel: "signed_device", proofRef: "claimed" } }), /unsupported/);
  const forged = structuredClone(command); forged.provenance.proofRef = "self-reported-proof";
  forged.intentDigest = createHash("sha256").update(agentBoundaryCommandSigningText(forged)).digest("hex");
  await denied(f.owner.request("workspace.boundaries.check", { ...f.params, command: forged }));
  await noEffects(f);
});

test("C1 hard gate: real passive Hub stores a valid human-command body as external text and cannot execute it", async t => {
  const f = await fixture(t); await configure(f);
  const command = await f.owner.request("workspace.boundaries.draft", draftParams(f)); assert.equal(parseAgentBoundaryDocument(command).kind, "command");
  const catalog = new LocalWorkspaceCatalog(f.home), row = catalog.resolve(f.params.workspaceId);
  const storage = new WorkspaceResourceStorage(f.home, row.scope); storage.initialize();
  const resources = new WorkspaceResources(f.home, row.scope); resources.initialize();
  // Real C1 catalog/grant/generation fence, not an unconditional mock callback.
  const authority = new WorkspaceAgentBoundaryAuthority({ catalog, resources, storage, transports: new AgentBoundaryTransports(secret()) });
  const external = { agentId: "registered-external", instanceId: "boot-external", alias: "external", displayName: "Hara owner", engine: "codex" };
  const hub = createC0AgentHubStore({ home: f.home, directory: { registeredAgent: id => id === external.agentId ? external : null },
    globalQuota: new HaraStorageQuota({ home: f.home, limitBytes: 64 * 1024 * 1024 }),
    scopeKey: command.context.resourceBinding.scopeKey, generation: command.context.resourceBinding.generation,
    assertCurrent: () => authority.assertHostCurrent() });
  const grant = hub.issueGrant(external.agentId), ingress = await startC0AgentHubIngress(hub); t.after(() => ingress.close());
  const text = JSON.stringify(command), requestId = randomUUID(), headers = { "Content-Type": "application/json", Authorization: `Bearer ${grant.token}` };
  const response = await fetch(ingress.endpoint + "/v1/agent-hub/messages", { method: "POST", headers,
    body: JSON.stringify({ requestId, from: external.alias, text, attachments: [] }) });
  assert.equal(response.status, 200); const receipt = parseAgentHubDocument(await response.json()); assert.equal(receipt.status, "saved");
  const message = hub.messages(grant.connectionId)[0], source = parseAgentHubDocument(message.source);
  assert.equal(source.actor.kind, "external-agent"); assert.equal(source.humanPrincipal, null); assert.equal(source.use, "display-only"); assert.equal(source.contentTrust, "untrusted-reference");
  assert.equal(hub.readText(grant.connectionId, receipt.messageId), text);
  const guest = await f.open(); await guest.request("initialize", { token: f.handle.token, provenance: command.provenance });
  await denied(guest.request("workspace.boundaries.check", { ...f.params, command: JSON.parse(text) }));
  const hubOnly = await f.open(); await assert.rejects(hubOnly.request("initialize", { token: grant.token }), /unauthorized/);
  const wrongRoute = await fetch(ingress.endpoint + "/workspace.boundaries.check", { method: "POST", headers, body: text }); assert.equal(wrongRoute.status, 400);
  await noEffects(f);
  // Removing the actual parent Workspace grant also seals new passive admissions.
  catalog.revoke(f.params.workspaceId, catalog.read().revision);
  const revoked = await fetch(ingress.endpoint + "/v1/agent-hub/messages", { method: "POST", headers,
    body: JSON.stringify({ requestId: randomUUID(), from: external.alias, text: "after revocation", attachments: [] }) });
  assert.equal(revoked.status, 401); assert.deepEqual(await revoked.json(), { code: "unauthorized", retry: "none" });
});

test("C1 discovery never exposes the owner credential; default Serve has no C1 authority", async t => {
  const f = await fixture(t), discovery = fs.readFileSync(join(f.home, ".hara", "workspace-local-dev", "serve-v2.json"), "utf8");
  assert.equal(discovery.includes(f.ownerCredential), false); assert.equal(JSON.stringify(f.handle).includes(f.ownerCredential), false);
  assert.ok(f.init.capabilities.includes("workspace.agent-boundaries.authority.v1"));
  const disabled = await fixture(t, false); assert.equal(disabled.init.capabilities.includes("workspace.agent-boundaries.authority.v1"), false);
  await denied(disabled.owner.request("workspace.boundaries.get", { workspaceId: disabled.params.workspaceId, agentId: disabled.params.agentId }));
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c1-bad-bootstrap-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credential = secret();
  await assert.rejects(startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root, token: credential },
    { root, version: "C1-synthetic", agentBoundaries: { ownerCredential: credential } }), error => error.code === "AUTHORITY_UNVERIFIED");
  assert.deepEqual(fs.readdirSync(root), []);
});

test("C1 connection replay, reauthentication failure and resource replacement revoke command admission", async t => {
  const f = await fixture(t); await configure(f); const command = await f.owner.request("workspace.boundaries.draft", draftParams(f));
  const second = await f.open(); await second.request("initialize", { token: f.handle.token, boundaryCredential: f.ownerCredential });
  await denied(second.request("workspace.boundaries.check", { ...f.params, command }));
  await denied(f.owner.request("initialize", { token: f.handle.token, boundaryCredential: secret() }));
  await assert.rejects(f.owner.request("workspace.boundaries.check", { ...f.params, command }), /unauthorized/);
  await f.owner.request("initialize", { token: f.handle.token, boundaryCredential: f.ownerCredential });
  await denied(f.owner.request("workspace.boundaries.check", { ...f.params, command }));
  const fresh = await f.owner.request("workspace.boundaries.draft", draftParams(f));
  const project = join(f.root, "project", f.params.workspaceId, "colleagues", f.params.agentId), retained = project + ".retained";
  fs.renameSync(project, retained); fs.mkdirSync(project, { mode: 0o700 });
  await assert.rejects(f.owner.request("workspace.boundaries.check", { ...f.params, command: fresh }), error => error.data?.boundary?.code === "AUTHORIZATION_DENIED");
  assert.ok(fs.existsSync(retained)); await noEffects(f);
});
