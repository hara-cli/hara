import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";

const privateRoot = name => fs.realpathSync(fs.mkdtempSync(join(tmpdir(), name)));

test("production autonomy dispatch is closed before provider, task, lease or prompt admission", async () => {
  const root = privateRoot("hara-channel-autonomy-host-"); let calls = 0;
  const host = new LocalWorkspaceHost(root, { mode: "workspace", credentialVault: new MemoryCredentialVault(),
    providerFactory() { calls++; throw new Error("No model should start"); } });
  try {
    await host.initialize();
    for (const forged of [undefined, { origin: "autonomy", depth: 0, budget: { maxTokens: 999999 } }, { mode: "ambient", enabled: true }]) {
      assert.throws(() => host.startChannelAutonomy(forged), /ambient_disabled/);
    }
    assert.equal(calls, 0); assert.equal(host.activity().running, 0); assert.equal(host.list().workspaces.length, 0);
  } finally { await host.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("autonomy RPC edits metadata only, defaults mention and rejects ambient, lineage, budgets and foreign scope", async () => {
  const root = privateRoot("hara-channel-autonomy-rpc-"); let calls = 0;
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root, mode: "workspace", version: "fixture",
    credentialVault: new MemoryCredentialVault(), providerFactory() { calls++; throw new Error("No model should start"); } });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); socket.on("error", () => {});
  const pending = new Map(); let id = 0;
  socket.on("message", raw => { const value = JSON.parse(String(raw)), item = pending.get(value.id); if (!item) return;
    pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result); });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error("bounded RPC wait")); }, 30000);
    pending.set(current, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id: current, method, params })); });
  try {
    await once(socket, "open"); await assert.rejects(request("workspace.channels.update", {}), /unauthorized/);
    const init = await request("initialize", { token: handle.token }); assert.ok(init.capabilities.includes("workspace.channel-autonomy.v1"));
    const workspace = await request("workspace.create", { label: "Autonomy", expectedRevision: init.workspace.revision });
    const list = await request("workspace.list"); await request("workspace.select", { workspaceId: workspace.workspaceId, expectedRevision: list.revision });
    const scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration }, channelId = randomUUID();
    let catalog = await request("workspace.channels.create", { ...scope, channelId, name: "Room", memberIds: [], expectedRevision: 0 });
    const selected = await request("workspace.channels.select", { ...scope, channelId });
    assert.deepEqual(selected.channel.autonomy, { schemaVersion: 1, mode: "mention", mutedAgentIds: [], cooldownMs: 600000 });
    const metadata = { schemaVersion: 1, mode: "off", mutedAgentIds: [], cooldownMs: 600000 };
    const edit = autonomy => ({ ...scope, channelId, name: "Room", memberIds: [], expectedRevision: catalog.revision, autonomy });
    for (const autonomy of [{ ...metadata, mode: "ambient" }, { ...metadata, cooldownMs: 1 }, { ...metadata, lastAutonomousAt: {} },
      { ...metadata, budget: { maxTokens: 16000 } }, { ...metadata, depth: 0 }, { ...metadata, pausedUntil: new Date(Date.now() + 3600000).toISOString() }]) {
      await assert.rejects(request("workspace.channels.update", edit(autonomy)), /autonomy|ambient|pause|cooldown/i);
    }
    await assert.rejects(request("workspace.channels.update", { ...edit(metadata), expectedGeneration: randomUUID() }), /generation/);
    await assert.rejects(request("workspace.channels.update", { ...edit(metadata), origin: "user" }), /unsupported/);
    catalog = await request("workspace.channels.update", edit(metadata));
    assert.equal(catalog.channels[0].autonomy.mode, "off");
    const snapshot = await request("workspace.channels.snapshot", { ...scope, channelId }); assert.equal(snapshot.channel.autonomy.mode, "off");
    const requestId = randomUUID(), message = { ...scope, channelId, message: "user note", requestId, recipientIds: [] };
    for (const extra of [{ origin: "autonomy" }, { depth: 0 }, { rootTurnId: requestId }, { budget: { maxTokens: 999999 } }]) {
      await assert.rejects(request("workspace.channels.send", { ...message, ...extra }), /unsupported/);
    }
    await assert.rejects(request("workspace.channels.autonomy.start", { ...scope, channelId }), /unsupported|Unknown|unknown/);
    await request("workspace.channels.send", message);
    const note = await request("workspace.channels.snapshot", { ...scope, channelId });
    assert.equal(note.turns[0].origin, "user"); assert.equal(note.turns[0].rootTurnId, requestId);
    const other = randomUUID(); catalog = await request("workspace.channels.create", { ...scope, channelId: other, name: "Other", memberIds: [], expectedRevision: catalog.revision });
    await assert.rejects(request("workspace.channels.update", { ...scope, channelId: other, name: "Other", memberIds: [], expectedRevision: catalog.revision, autonomy: metadata }), /view/);
    assert.equal(calls, 0);
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    socket.terminate(); await handle.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});


test("real Host prefilter reads only its scoped private profiles and all-PASS creates no participant conversation", async () => {
  const root = privateRoot("hara-channel-autonomy-prefilter-"); let modelCalls = 0;
  const host = new LocalWorkspaceHost(root, { mode: "workspace", credentialVault: new MemoryCredentialVault(),
    providerFactory() { modelCalls++; throw new Error("All-PASS must not construct a model"); } });
  let originalRead;
  try {
    await host.initialize(); const workspace = host.createWorkspace("Roles", host.list().revision), workspaceId = workspace.workspaceId;
    host.select("client", workspaceId, host.list().revision);
    const resources = new WorkspaceResources(host.home, host.catalog.resolve(workspaceId).scope); resources.initialize();
    const members = ["finance invoices accounting", "illustration typography design", "javascript typescript engineering"].map((instructions, index) => resources.agents.create({
      username: `prefilter-${index}`, profile: { displayName: `Role ${index}`, title: `Specialty ${index}` }, instructions,
    }, resources.agents.list().revision).agentId);
    const channelId = randomUUID(); host.createChannel("client", workspaceId, channelId, "Roles room", members, 0);
    host.selectChannel("client", workspaceId, channelId);
    let reads = 0; originalRead = WorkspaceConversationStore.prototype.read;
    WorkspaceConversationStore.prototype.read = function () { reads++; throw new Error("All-PASS must not read a participant conversation"); };
    const requestId = randomUUID(); host.sendChannel("client", workspaceId, channelId, "analyze orbital spectroscopy", requestId, members);
    await host.waitChannel(workspaceId, channelId);
    const snapshot = host.channelSnapshot(workspaceId, channelId, "client");
    assert.equal(snapshot.state, "completed"); assert.equal(snapshot.channel.autonomy.mode, "mention");
    assert.deepEqual(snapshot.turns[0].replies.map(reply => [reply.state, reply.started, reply.depth]), members.map(() => ["passed", false, 0]));
    assert.equal(snapshot.turns[0].origin, "user"); assert.equal(snapshot.turns[0].rootTurnId, requestId);
    assert.equal(snapshot.questions.length, 0); assert.equal(snapshot.messages.length, 1); assert.equal(reads, 0); assert.equal(modelCalls, 0);
    assert.equal(/invoices|typography|typescript/.test(JSON.stringify(snapshot)), false, "private instructions never enter a snapshot");
  } finally {
    if (originalRead) WorkspaceConversationStore.prototype.read = originalRead;
    await host.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
