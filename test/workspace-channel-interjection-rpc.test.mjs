import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";

test("channel queue actions retain authentication, generation and selected-room fences without a model call", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-channel-interjection-rpc-")));
  let calls = 0;
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root, mode: "workspace", version: "fixture",
    credentialVault: new MemoryCredentialVault(), providerFactory() { calls++; throw new Error("No model should start"); } });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); socket.on("error", () => {});
  const pending = new Map(); let id = 0;
  socket.on("message", raw => { const response = JSON.parse(String(raw)), item = pending.get(response.id); if (!item) return;
    pending.delete(response.id); clearTimeout(item.timer); response.error ? item.reject(new Error(response.error.message)) : item.resolve(response.result); });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error("bounded RPC wait")); }, 30000);
    pending.set(current, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id: current, method, params })); });
  try {
    await once(socket, "open");
    await assert.rejects(request("workspace.channels.resumeQueue", {}), /unauthorized/);
    const init = await request("initialize", { token: handle.token });
    assert(init.capabilities.includes("workspace.channel-pass.v1")); assert(init.capabilities.includes("workspace.channel-queue.v1"));
    const workspace = await request("workspace.create", { label: "Queue", expectedRevision: init.workspace.revision });
    const list = await request("workspace.list"); await request("workspace.select", { workspaceId: workspace.workspaceId, expectedRevision: list.revision });
    const scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration }, channelId = randomUUID();
    const catalog = await request("workspace.channels.create", { ...scope, channelId, name: "Room", memberIds: [], expectedRevision: 0 });
    await request("workspace.channels.select", { ...scope, channelId });
    for (const method of ["workspace.channels.resumeQueue", "workspace.channels.clearQueue"]) {
      const snapshot = await request(method, { ...scope, channelId });
      assert.equal(snapshot.workspaceId, scope.workspaceId); assert.equal(snapshot.resourceGeneration, scope.expectedGeneration);
      assert.equal(snapshot.channel.id, channelId); assert.equal(snapshot.pendingCount, 0);
      await assert.rejects(request(method, { ...scope, expectedGeneration: randomUUID(), channelId }), /generation/);
      await assert.rejects(request(method, { ...scope, channelId, passed: true }), /unsupported/);
    }
    const other = randomUUID();
    await request("workspace.channels.create", { ...scope, channelId: other, name: "Other", memberIds: [], expectedRevision: catalog.revision });
    await assert.rejects(request("workspace.channels.clearQueue", { ...scope, channelId: other }), /view/);
    await assert.rejects(request("workspace.channels.send", { ...scope, channelId, message: "note", requestId: randomUUID(), recipientIds: [], passed: true }), /unsupported/);
    assert.equal(calls, 0);
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    socket.terminate(); await handle.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
