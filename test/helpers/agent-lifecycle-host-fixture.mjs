import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { AgentBoundaryTransports } from "../../dist/workspace/agent-boundary-transport.js";
import { startLocalWorkspaceServe } from "../../dist/serve/local-workspace.js";
import { agentCommandMessageDigest } from "../../dist/workspace/agent-command-control.js";
import { createWorkspaceSyntheticProvider } from "../../dist/workspace/synthetic-provider.js";
const docs = JSON.parse(fs.readFileSync(new URL("../fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
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
export async function until(read) {
  // Actual governed IO completes around 20s with four concurrent security suites on this host.
  // This observation window does not change command/runtime budgets or any safety assertion.
  const end = Date.now() + 30000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("C3 observable state deadline");
}
export async function lifecycleHostFixture(t, input = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c3-host-"))), ownerCredential = randomBytes(32).toString("hex");
  let calls = 0, providers = 0;
  const providerFactory = (connection, binding, context) => { providers++;
    const provider = input.provider?.(binding) ?? createWorkspaceSyntheticProvider(connection, binding, context);
    return { ...provider, async turn(args) { calls++; return provider.turn(args); } };
  };
  const bootstrap = { root, version: "C3-synthetic", agentBoundaries: { commandControl: true, lifecycleControl: true, ownerCredential }, providerFactory };
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
