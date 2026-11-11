import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../dist/workspace/agent-boundary-transport.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { agentCommandMessageDigest } from "../dist/workspace/agent-command-control.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
const docs = JSON.parse(fs.readFileSync(new URL("./fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const copy = name => structuredClone(docs.valid.find(row => row.name === name).document);
const boundaryCode = code => error => error.data?.boundary?.code === code;
async function connect(handle) {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`), pending = new Map(); let serial = 0;
  socket.on("error", () => {});
  socket.on("message", raw => { const value = JSON.parse(raw.toString()), waiter = pending.get(value.id); if (!waiter) return;
    pending.delete(value.id); clearTimeout(waiter.timer);
    value.error ? waiter.reject(Object.assign(new Error(value.error.message), { data: value.error.data })) : waiter.resolve(value.result);
  });
  await once(socket, "open");
  return { request(method, params = {}) { return new Promise((resolve, reject) => { const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("C3 RPC deadline")); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }); }, async close() { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, "close"); socket.close(); await closed; } };
}
async function until(read) {
  // Actual governed IO completes around 20s with four concurrent security suites on this host.
  // This observation window does not change command/runtime budgets or any safety assertion.
  const end = Date.now() + 30000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("C3 observable state deadline");
}
async function fixture(t, input = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c3-host-"))), ownerCredential = randomBytes(32).toString("hex");
  let calls = 0, providers = 0;
  const providerFactory = (connection, binding, context) => { providers++;
    const provider = input.provider?.(binding) ?? createWorkspaceSyntheticProvider(connection, binding, context);
    return { ...provider, async turn(args) { calls++; return provider.turn(args); } };
  };
  const bootstrap = { root, version: "C3-synthetic", agentBoundaries: { commandControl: true, ownerCredential }, providerFactory };
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, bootstrap), clients = [];
  const open = async () => { const client = await connect(handle); clients.push(client); return client; };
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await handle.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = await open(), init = await owner.request("initialize", { token: handle.token, boundaryCredential: ownerCredential });
  const created = await owner.request("workspace.create", { label: "Personal", expectedRevision: init.workspace.revision });
  const params = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration, agentId: created.selectedAgentId };
  await owner.request("workspace.connection.synthetic", { workspaceId: params.workspaceId, expectedGeneration: params.expectedGeneration, expectedRevision: 0 });
  const snapshot = await owner.request("workspace.snapshot", { workspaceId: params.workspaceId, agentId: params.agentId }), agent = snapshot.agents.find(row => row.agentId === params.agentId);
  await owner.request("workspace.agents.setPermissionTier", { ...params, permissionTier: "controlled", configRevision: agent.configRevision, agentEpoch: agent.agentEpoch });
  const view = await owner.request("workspace.boundaries.prepareProject", params), duty = copy("duty"), boundary = copy("boundary");
  for (const doc of [duty, boundary]) { doc.context = view.context; doc.agentId = params.agentId; }
  boundary.resources = [{ resourceId: view.resources[0].resourceId, access: ["read", "write"] }];
  boundary.tools = { allow: ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"]
    .map(toolId => ({ toolId, connectorId: null, catalogRevision: 1 })), deny: [], readOnly: false };
  boundary.approvalRequired = []; boundary.budget = { budgetRef: "synthetic-c3", maxModelCalls: 16, maxToolEffects: 32 };
  await owner.request("workspace.boundaries.configure", { ...params, expectedRevision: view.revision, duty, boundary,
    rights: { manage: true, invoke: true, privateRead: true, nodeUse: true, ...input.rights } });
  await owner.request("workspace.boundaries.control.initialize", params);
  const draft = (operation, client = owner, extra = {}) => client.request("workspace.boundaries.draft", { ...params,
    commandId: randomUUID(), rootRequestId: randomUUID(), operation, lifetimeMs: 30000, ...extra });
  const dispatch = async (message = "Write hello.md and verify the file") => ({ message, command: await draft({ action: "task.dispatch", taskId: randomUUID(),
    conversationId: params.agentId.slice(3), messageDigest: agentCommandMessageDigest(params.agentId.slice(3), message) }) });
  const submit = (command, message, client = owner) => client.request("workspace.boundaries.control.submit", { ...params, command, ...(message === undefined ? {} : { message }) });
  const receipt = command => owner.request("workspace.boundaries.control.receipt", { ...params, commandId: command.commandId });
  return { root, handle, bootstrap, init, owner, ownerCredential, params, open, draft, dispatch, submit, receipt,
    providers: () => providers, calls: () => calls,
    snapshot: () => owner.request("workspace.snapshot", { workspaceId: params.workspaceId, agentId: params.agentId }),
    inspect: () => owner.request("workspace.boundaries.control.inspect", params) };
}

test("C3 actual WS Host combines C1, persisted C3, C2 and RunPermit for a scoped file task", async t => {
  const f = await fixture(t); assert.ok(f.init.capabilities.includes("workspace.agent-command-control.v1"));
  const d = await f.dispatch(), accepted = await f.submit(d.command, d.message);
  assert.equal(accepted.commandId, d.command.commandId); assert.equal(accepted.status, "accepted");
  let lastReceipt, drained;
  try { drained = await until(async () => { lastReceipt = await f.receipt(d.command); return lastReceipt.execution.drain === "observed" && lastReceipt; }); }
  catch (error) { throw new Error(`${error.message}; last receipt ${JSON.stringify(lastReceipt)}; control ${JSON.stringify(await f.inspect())}`); }
  assert.equal(drained.execution.effect, "completed"); assert.equal(drained.status, "drained");
  const snapshot = await f.snapshot(); assert.equal(snapshot.conversation.taskState, "completed");
  assert.equal((await f.inspect()).runs[0].taskId, d.command.operation.taskId);
  assert.equal(fs.readFileSync(join(f.root, "project", f.params.workspaceId, "hello.md"), "utf8"), "hello workspace\n");
  const calls = f.calls(), providers = f.providers();
  assert.deepEqual(await f.submit(d.command, d.message), drained);
  await assert.rejects(f.submit(d.command, d.message + " changed"), boundaryCode("COMMAND_ID_CONFLICT"));
  assert.equal(f.calls(), calls); assert.equal(f.providers(), providers);
  const audit = await f.owner.request("workspace.boundaries.control.audit", f.params);
  assert.equal(audit.filter(row => row.action === "task.dispatch").length, 1);
  assert.ok(!JSON.stringify(audit).includes(d.message));
});

test("C3 owner authentication precedes metadata and protected legacy/control JSON cannot bypass the ledger", async t => {
  const f = await fixture(t), guest = await f.open();
  await assert.rejects(guest.request("initialize", { token: f.handle.token, source: "local_human" }), boundaryCode("AUTHORITY_UNVERIFIED"));
  await assert.rejects(guest.request("workspace.snapshot", { workspaceId: "secret-existence", agentId: "hidden" }), /unauthorized/);
  const d = await f.dispatch();
  for (const method of ["workspace.session.send", "workspace.session.resume", "workspace.session.cancel", "workspace.session.new", "workspace.agents.setArchived", "workspace.agents.setPermissionTier", "workspace.approval.respond"])
    await assert.rejects(f.owner.request(method, { ...f.params, message: d.message, requestId: randomUUID(), approved: true }), boundaryCode("RUNTIME_UNSUPPORTED"));
  await assert.rejects(f.owner.request("workspace.boundaries.control.submit", { ...f.params, ...d, approved: true }), /unsupported/);
  await assert.rejects(f.owner.request("workspace.boundaries.control.submit", { ...f.params, ...d, source: { approved: true } }), /unsupported/);
  assert.equal(f.calls(), 0); assert.equal(f.providers(), 0); assert.deepEqual((await f.snapshot()).conversation.history, []);
});

test("C3 two real owner connections: persistent pause wins over an old dispatch; resume never replays it", async t => {
  const f = await fixture(t), second = await f.open(); await second.request("initialize", { token: f.handle.token, boundaryCredential: f.ownerCredential });
  const old = await f.dispatch(), pause = await f.draft({ action: "agent.pause", reason: "human_request" }, second);
  const held = await f.submit(pause, undefined, second); assert.ok(held.control.holdId);
  const stale = await f.submit(old.command, old.message); assert.equal(stale.status, "rejected"); assert.equal(stale.error.code, "STALE_REVISION");
  const resume = await f.draft({ action: "agent.resume", holdId: held.control.holdId }, second); assert.equal((await f.submit(resume, undefined, second)).status, "applied");
  assert.deepEqual(await f.submit(old.command, old.message), stale); assert.equal(f.calls(), 0); assert.equal(f.providers(), 0);
  const fresh = await f.dispatch("hello"); await f.submit(fresh.command, fresh.message);
  await until(async () => (await f.receipt(fresh.command)).execution.drain === "observed"); assert.equal(f.providers(), 1);
});

test("C3 stop fences an actual pending model call but cannot report drain until its Promise finishes", async t => {
  let release, entered; const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, { provider: binding => ({ id: "openai", model: binding.model, async turn() { entered(); await waiting;
    return { text: "late result", toolUses: [], stop: "end", usage: { input: 1, output: 1 } }; } }) });
  const second = await f.open(); await second.request("initialize", { token: f.handle.token, boundaryCredential: f.ownerCredential });
  const d = await f.dispatch("hello"), accepted = await f.submit(d.command, d.message); assert.equal(accepted.status, "accepted"); await ready;
  const run = (await f.inspect()).runs[0], stop = await f.draft({ action: "task.stop", taskId: run.taskId, runId: run.runId, claimRevision: run.claimRevision }, second);
  const stopped = await f.submit(stop, undefined, second); assert.ok(stopped.control.holdId); assert.equal(stopped.execution.drain, "pending");
  assert.notEqual((await f.receipt(stop)).execution.drain, "observed");
  await assert.rejects(f.owner.request("workspace.session.cancel", { ...f.params, runId: run.runId }), boundaryCode("RUNTIME_UNSUPPORTED"));
  release(); await until(async () => (await f.receipt(stop)).execution.drain === "observed"); assert.equal(f.calls(), 1);
  assert.equal((await f.inspect()).runs[0].hold.holdId, stopped.control.holdId);
});

test("C3 management permission does not imply private history read permission", async t => {
  const f = await fixture(t, { rights: { privateRead: false } });
  assert.equal((await f.inspect()).agent.epoch, 0);
  await assert.rejects(f.snapshot(), boundaryCode("AUTHORIZATION_DENIED"));
  assert.equal((await f.submit(await f.draft({ action: "agent.pause", reason: "human_request" }))).status, "accepted");
  assert.equal(f.providers(), 0);
});

test("C3 a second actual Host reads the old acceptance without taking its live lease or minting a permit", async t => {
  let release, entered; const waiting = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const f = await fixture(t, { provider: binding => ({ id: "openai", model: binding.model, async turn() { entered(); await waiting;
    return { text: "original owner only", toolUses: [], stop: "end", usage: { input: 1, output: 1 } }; } }) });
  const d = await f.dispatch("hello"); await f.submit(d.command, d.message); await ready;
  const transports = new AgentBoundaryTransports(f.ownerCredential), transport = transports.connect("other-host", f.ownerCredential);
  const peer = new LocalWorkspaceHost(f.root, { boundaryTransports: transports, boundaryCommandControl: true,
    providerFactory() { throw new Error("Foreign Host must not prepare a provider"); } });
  try {
    await peer.initialize();
    const status = peer.agentCommandStatus(transport, f.params.workspaceId, f.params.agentId);
    assert.equal(status.runs[0].controlledHere, false); assert.ok(status.runs[0].recovery.includes("query_original"));
    const receipt = peer.submitAgentBoundaryCommand("other-host", transport, f.params.workspaceId, f.params.agentId, d.command, { message: d.message });
    assert.equal(receipt.status, "unknown"); assert.equal(receipt.error.code, "AUTHORITY_UNVERIFIED");
    const other = peer.draftAgentBoundaryCommand(transport, f.params.workspaceId, f.params.agentId, { commandId: randomUUID(), rootRequestId: randomUUID(), lifetimeMs: 30000,
      operation: { action: "task.dispatch", taskId: randomUUID(), conversationId: f.params.agentId.slice(3), messageDigest: agentCommandMessageDigest(f.params.agentId.slice(3), "hello") } });
    assert.throws(() => peer.submitAgentBoundaryCommand("other-host", transport, f.params.workspaceId, f.params.agentId, other, { message: "hello" }), /busy|owner death/);
    assert.equal(f.calls(), 1); release(); await until(async () => (await f.receipt(d.command)).execution.drain === "observed");
  } finally { release(); await peer.close(); transports.close(); }
});

test("C3 reopening a protected scope with bootstrap disabled cannot revive the generic transport route", async t => {
  const f = await fixture(t); await f.owner.close(); await f.handle.close();
  const reopened = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: f.root }, { root: f.root, version: "disabled-bootstrap",
    providerFactory() { throw new Error("No legacy provider expected"); } });
  const client = await connect(reopened);
  try {
    await assert.rejects(client.request("initialize", { token: reopened.token, boundaryCredential: f.ownerCredential, source: "local_human" }), boundaryCode("AUTHORITY_UNVERIFIED"));
    await assert.rejects(client.request("workspace.session.send", { ...f.params, message: "hello", requestId: randomUUID() }), /unauthorized/);
    assert.equal(f.calls(), 0);
  } finally { await client.close(); await reopened.close(); }
});
