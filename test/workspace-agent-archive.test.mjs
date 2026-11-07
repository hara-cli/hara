import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";

async function until(read) {
  for (let n = 0; n < 250; n++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("archive fixture did not settle");
}
async function fixture(t, { held = false } = {}) {
  let entered, aborted = false;
  const reached = new Promise(resolve => { entered = resolve; });
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-archive-")));
  let handle, socket, serial = 0; const pending = new Map();
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error("bounded RPC timeout")); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const connect = async () => {
    handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root, version: "archive-fixture", ...(held ? { providerFactory(connection, binding, context) {
      if (context.agent.kind !== "colleague") return createWorkspaceSyntheticProvider(connection, binding, context);
      return { id: "openai", model: binding.model, async turn(args) { entered();
        await new Promise((_, reject) => { const cancel = () => { aborted = true; queueMicrotask(() => reject(new Error("synthetic turn cancelled"))); };
          if (args.signal.aborted) cancel(); else args.signal.addEventListener("abort", cancel, { once: true }); });
        throw new Error("unreachable"); } };
    } } : {}) });
    socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); socket.on("error", () => {});
    socket.on("message", raw => { const value = JSON.parse(raw.toString()), row = pending.get(value.id); if (!row) return;
      pending.delete(value.id); clearTimeout(row.timer); value.error ? row.reject(new Error(value.error.message)) : row.resolve(value.result); });
    await once(socket, "open"); return request("initialize", { token: handle.token });
  };
  const close = async () => { if (socket?.readyState === WebSocket.OPEN) { const closed = once(socket, "close"); socket.close(); await closed; } if (handle) await handle.close(); };
  t.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });
  const init = await connect(); assert(init.capabilities.includes("workspace.agents.archive.v1"));
  const w = await request("workspace.create", { label: "Archive fixture", expectedRevision: init.workspace.revision });
  const scope = { workspaceId: w.workspaceId, expectedGeneration: w.resourceGeneration };
  await request("workspace.connection.synthetic", { ...scope, expectedRevision: 0 });
  await request("workspace.select", { workspaceId: w.workspaceId, expectedRevision: (await request("workspace.list")).revision });
  const read = (id = w.selectedAgentId) => request("workspace.snapshot", { workspaceId: w.workspaceId, agentId: id });
  await request("workspace.session.send", { ...scope, agentId: w.selectedAgentId, message: "建立同事 Coder", requestId: randomUUID() });
  const card = await until(async () => (await read()).approvals[0]);
  await request("workspace.approval.respond", { ...scope, approvalId: card.id, approved: true });
  const done = await until(async () => { const value = await read(); return value.agents.some(row => row.kind === "colleague") && !["running", "draining"].includes(value.conversation.state) ? value : null; });
  const agent = done.agents.find(row => row.kind === "colleague"), main = done.agents.find(row => row.kind === "main");
  const archive = (target, archived, extra = {}) => request("workspace.agents.setArchived", { ...scope, agentId: target.agentId,
    configRevision: target.configRevision, agentEpoch: target.agentEpoch, archived, ...extra });
  const features = () => request("workspace.features.list", scope);
  const schedule = async (target, enabled = true) => { const before = await features(), id = randomUUID();
    await request("workspace.schedule.save", { ...scope, expectedRevision: before.revision, approved: true,
      input: { id, name: "Synthetic scheduled work", task: "say hello", agentId: target.agentId, enabled,
        schedule: { kind: "once", runAt: Date.now() + 3600000, display: "fixture" } } }); return id; };
  return { root, w, scope, request, read, main, agent, archive, features, schedule, reached, aborted: () => aborted, restart: async () => { await close(); await connect(); } };
}

test("archive, immediate Undo and later restore keep exact colleague and history, while schedules remain paused", async t => {
  const f = await fixture(t);
  await f.request("workspace.session.send", { ...f.scope, agentId: f.agent.agentId, message: "你好", requestId: randomUUID() });
  const before = await until(async () => { const value = await f.read(f.agent.agentId); return value.conversation.history.length && !["running", "draining"].includes(value.conversation.state) ? value : null; });
  const scheduled = await f.schedule(f.agent), disabled = await f.schedule(f.agent, false), other = await f.schedule(f.main);
  const deleted = await f.archive(f.agent, true);
  assert.equal(deleted.pausedSchedules, 1); assert.equal(deleted.agent.state, "archived");
  assert.equal(deleted.agent.agentEpoch, f.agent.agentEpoch + 1); assert.equal(deleted.agent.pausedScheduleCount, 1);
  assert(Number.isFinite(Date.parse(deleted.agent.archivedAt)));
  const rows = (await f.features()).schedules; assert.equal(rows.find(row => row.id === scheduled).enabled, false);
  assert.equal(rows.find(row => row.id === disabled).enabled, false); assert.equal(rows.find(row => row.id === other).enabled, true);
  await assert.rejects(f.request("workspace.session.send", { ...f.scope, agentId: f.agent.agentId, message: "must not start", requestId: randomUUID() }), /unavailable|active|runtime/i);
  await assert.rejects(f.request("workspace.features.update", { ...f.scope, kind: "schedule", id: scheduled, enabled: true, expectedRevision: (await f.features()).revision }), /Restore the deleted/);
  const restored = await f.archive(deleted.agent, false); assert.equal(restored.agent.agentId, f.agent.agentId); assert.equal(restored.agent.state, "active");
  assert.equal(restored.agent.archivedAt, undefined); assert.equal((await f.features()).schedules.find(row => row.id === scheduled).enabled, false);
  const restoredHistory = (await f.read(f.agent.agentId)).conversation;
  assert.equal(restoredHistory.sessionId, before.conversation.sessionId); assert.deepEqual(restoredHistory.history, before.conversation.history);
  const again = await f.archive(restored.agent, true); assert.equal(again.pausedSchedules, 0);
  await f.restart(); const persisted = (await f.read()).agents.find(row => row.agentId === f.agent.agentId);
  assert.equal(persisted.archivedAt, again.agent.archivedAt); assert.equal(persisted.pausedScheduleCount, 0);
  await f.archive(persisted, false);
  assert.deepEqual((await f.read(f.agent.agentId)).conversation.history, before.conversation.history);
  assert.equal((await f.features()).schedules.find(row => row.id === scheduled).enabled, false);
});

test("main protection, exact revision/epoch, generation, workspace and strict RPC fields reject before any schedule pause", async t => {
  const f = await fixture(t), id = await f.schedule(f.agent), before = await f.features();
  await assert.rejects(f.archive(f.main, true), /main Hara cannot/);
  await assert.rejects(f.archive(f.agent, true, { agentEpoch: f.agent.agentEpoch + 1 }), /changed/);
  await assert.rejects(f.archive(f.agent, true, { configRevision: f.agent.configRevision + 1 }), /changed/);
  await assert.rejects(f.archive(f.agent, true, { expectedGeneration: randomUUID() }), /generation/);
  await assert.rejects(f.archive(f.agent, true, { grant: true }), /unsupported/);
  const other = await f.request("workspace.create", { label: "Other", expectedRevision: (await f.request("workspace.list")).revision });
  await assert.rejects(f.archive(f.agent, true, { workspaceId: other.workspaceId, expectedGeneration: other.resourceGeneration }), /changed/);
  assert.equal((await f.features()).revision, before.revision); assert.equal((await f.features()).schedules.find(row => row.id === id).enabled, true);
  const deleted = await f.archive(f.agent, true);
  await assert.rejects(f.archive(f.agent, false), /changed/);
  await assert.rejects(f.archive(deleted.agent, true), /already changed/);
  assert.equal((await f.read()).agents.find(row => row.agentId === f.agent.agentId).state, "archived");
});


test("deleting a running colleague drains its attempt before epoch invalidation and admits no new turn", async t => {
  const f = await fixture(t, { held: true });
  await f.request("workspace.session.send", { ...f.scope, agentId: f.agent.agentId, message: "synthetic greeting", requestId: randomUUID() });
  await f.reached;
  await assert.rejects(f.archive(f.agent,true),/confirm/);assert.equal(f.aborted(),false);
  const preview=await f.request("workspace.agents.archiveStatus",{...f.scope,agentId:f.agent.agentId,configRevision:f.agent.configRevision,agentEpoch:f.agent.agentEpoch});
  assert.equal(preview.runs.length,1);assert.equal(preview.runs[0].kind,"chat");assert(preview.runs[0].title.includes("synthetic greeting"));
  await assert.rejects(f.archive(f.agent,true,{confirmedRunIds:[randomUUID()]}),/confirm/);assert.equal(f.aborted(),false);
  const deletion = f.archive(f.agent, true,{confirmedRunIds:preview.runs.map(row=>row.runId)});
  const denied = assert.rejects(f.request("workspace.session.send", { ...f.scope, agentId: f.agent.agentId, message: "must not enter", requestId: randomUUID() }), /lifecycle|unavailable|active/i);
  const result = await deletion; await denied; assert(f.aborted()); assert.equal(result.agent.state, "archived");
  const after = await f.read(f.agent.agentId); assert.notEqual(after.conversation.state, "needs_recovery");
  assert(!["running", "draining"].includes(after.conversation.state));
  await f.archive(result.agent, false);
  assert.notEqual((await f.read(f.agent.agentId)).conversation.state, "needs_recovery");
});

test("workspace rename is metadata-only, scoped, revision-fenced and survives restart", async t => {
  const f = await fixture(t), before = await f.read(), list = await f.request("workspace.list");
  const params = { ...f.scope, label: "Renamed Lab", expectedRevision: list.revision };
  await assert.rejects(f.request("workspace.rename", { ...params, expectedRevision: list.revision + 1 }), /changed|revision/);
  await assert.rejects(f.request("workspace.rename", { ...params, expectedGeneration: randomUUID() }), /generation/);
  await assert.rejects(f.request("workspace.rename", { ...params, root: f.root }), /unsupported/);
  await assert.rejects(f.request("workspace.rename", { ...params, label: "" }), /label|invalid/i);
  const renamed = await f.request("workspace.rename", params);
  assert.equal(renamed.workspaces.find(row => row.workspaceId === f.w.workspaceId).label, "Renamed Lab");
  const after = await f.read(); assert.equal(after.resourceGeneration, before.resourceGeneration);
  assert.deepEqual(after.agents, before.agents); assert.deepEqual(after.conversation, before.conversation);
  await f.restart(); assert.equal((await f.read()).label, "Renamed Lab");
});
