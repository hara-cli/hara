import assert from "node:assert/strict";
import { untilObserved } from "./observable-wait.mjs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../../dist/serve/local-workspace.js";
import { LocalWorkspaceCatalog } from "../../dist/workspace/local-catalog.js";
import { WorkspaceResources } from "../../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../../dist/workspace/resource-context.js";
import { WorkspaceLocalChannels } from "../../dist/workspace/local-channels.js";
import { WorkspaceConversationStore } from "../../dist/workspace/conversations.js";
const docs = JSON.parse(fs.readFileSync(new URL("../fixtures/agent-boundaries-v1.json", import.meta.url), "utf8"));
const copy = name => structuredClone(docs.valid.find(row => row.name === name).document);
export const boundary = code => error => error.data?.boundary?.code === code;
export async function routingConnect(handle) {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`), pending = new Map(); let serial = 0;
  socket.on("error", () => {});
  socket.on("message", raw => { const value = JSON.parse(raw.toString()), waiter = pending.get(value.id); if (!waiter) return;
    pending.delete(value.id); clearTimeout(waiter.timer);
    value.error ? waiter.reject(Object.assign(new Error(value.error.message), { data: value.error.data })) : waiter.resolve(value.result);
  });
  await once(socket, "open");
  return { request(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error("C6 RPC deadline")); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }); }, async close() { if (socket.readyState === WebSocket.CLOSED) return; const closed = once(socket, "close"); socket.close(); await closed; } };
}
export const routingUntil = (read, progress) => untilObserved(read, { label: "C6", progress, intervalMs: 50 });
/** Actual WS/Host/C1/C2/C3/C4. Only providers and initial personal setup are synthetic. */
export async function routingHostFixture(t, input = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c6-host-"))), ownerCredential = randomBytes(32).toString("hex");
  const members = [], calls = [], providers = [], clients = []; let storage;
  const bootstrap = { root, version: "C6-synthetic", providerFactory(connection, binding, context) {
    const state = JSON.parse(storage.run(() => fs.readFileSync(join(workspaceStateHome(), ".hara", "workspace-agent-authority-v1.json"), "utf8")));
    assert.equal(state.routing.records.filter(row => row.ownerAgentId === context.agent.agentId && row.state === "claimed").length > 0, true, "claim must precede business provider construction");
    providers.push(context.agent.agentId);
    input.providerCreated?.(context);
    const provider = input.provider?.(connection, binding, context);
    return { ...provider, id: "openai", model: binding.model, async turn(args) {
      calls.push({ agentId: context.agent.agentId, system: args.system, history: structuredClone(args.history) });
      return provider ? provider.turn(args) : input.turn ? input.turn(args, context) : { text: "Confirmed single owner response", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    } };
  }, agentBoundaries: { commandControl: true, lifecycleControl: true, ownerCredential,
    ...(input.disabled ? {} : { routing: { automaticAgentIds: () => members, ...(input.classifier ? { classifier: () => input.classifier } : {}) } }) } };
  let handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, bootstrap);
  const open = async () => { const client = await routingConnect(handle); clients.push(client); return client; };
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await handle.close(); }); // guard owns retained scratch.
  const owner = await open(), init = await owner.request("initialize", { token: handle.token, boundaryCredential: ownerCredential });
  const created = await owner.request("workspace.create", { label: "Personal routing", expectedRevision: init.workspace.revision });
  const common = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration };
  const catalog = new LocalWorkspaceCatalog(join(root, "home")), row = catalog.resolve(common.workspaceId), resources = new WorkspaceResources(join(root, "home"), row.scope); resources.initialize();
  storage = new WorkspaceResourceStorage(join(root, "home"), row.scope); storage.initialize();
  const roster = ["finance", "engineering", "design"].map(username => resources.agents.create({ username, profile: { displayName: username },
    instructions: `PRIVATE_${username}_PERSONA`, runtimeId: "pi", permissionTier: "controlled" }, resources.agents.list().revision)); members.push(...roster.map(agent => agent.agentId));
  await owner.request("workspace.connection.synthetic", { ...common, expectedRevision: 0 });
  await owner.request("workspace.select", { workspaceId: common.workspaceId, expectedRevision: (await owner.request("workspace.list")).revision });
  const channelId = randomUUID(); await owner.request("workspace.channels.create", { ...common, channelId, name: "Authorized team", memberIds: members, expectedRevision: 0 });
  for (const [index, agent] of roster.entries()) {
    const params = { ...common, agentId: agent.agentId }, view = await owner.request("workspace.boundaries.prepareProject", params), duty = copy("duty"), boundary = copy("boundary");
    for (const doc of [duty, boundary]) { doc.context = view.context; doc.agentId = agent.agentId; }
    duty.publicProfile = { title: agent.username, description: "Human confirmed public responsibility", owns: [input.tie && index < 2 ? "invoice" : ["invoice", "compile", "layout"][index]], rejects: index === 0 ? ["publish"] : [] };
    boundary.resources = [{ resourceId: view.resources[0].resourceId, access: ["read", "write"] }];
    boundary.tools = { allow: ["workspace_read", "workspace_write", "workspace_verify", "task_intake", "task_checkpoint", "todo_write", "ask_user"].map(toolId => ({ toolId, connectorId: null, catalogRevision: 1 })), deny: [], readOnly: false };
    boundary.approvalRequired = []; boundary.budget = { budgetRef: "synthetic-c6", maxModelCalls: 16, maxToolEffects: 32 };
    await owner.request("workspace.boundaries.configure", { ...params, expectedRevision: view.revision, duty, boundary, rights: { manage: true, invoke: true, privateRead: true, nodeUse: true } });
  }
  const manager = { ...common, agentId: members[0] };
  await owner.request("workspace.boundaries.control.initialize", manager);
  if (!input.disabled) await owner.request("workspace.boundaries.routing.initialize", manager);
  const data = (message = "invoice status", extra = {}) => ({ channelId, workItemId: randomUUID(), requestId: randomUUID(), message,
    explicitAgentIds: [], leadAgentId: null, businessBindingRef: null, expectedWorkRevision: 0, ...extra });
  const submit = (body, client = owner) => client.request("workspace.boundaries.routing.submit", { ...common, input: body });
  const read = body => owner.request("workspace.boundaries.routing.get", { ...common, channelId: body.channelId, workItemId: body.workItemId });
  const rooms = new WorkspaceLocalChannels(storage, { agents: () => resources.agents.list().agents, accepting: () => true, changed() {}, start() { throw new Error("No legacy dispatch"); }, async wait() {}, cancel() {} });
  const state = () => storage.run(() => JSON.parse(fs.readFileSync(join(workspaceStateHome(), ".hara", "workspace-agent-authority-v1.json"), "utf8")));
  const conversation = agentId => new WorkspaceConversationStore(storage, agentId, channelId).read();
  return { root, handle, bootstrap, init, owner, open, ownerCredential, common, members, roster, resources, storage, rooms, channelId, data, submit, read, state, conversation, calls, providers,
    async restart() { await Promise.all(clients.map(client => client.close())); await handle.close(); handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, bootstrap); return handle; } };
}
