import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { WorkspaceRequestJournal } from "../dist/workspace/request-journal.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { setup, until } from "./helpers/local-channels.mjs";

test("DMs, two channels and another Workspace retain separate sessions; only explicit recipients run", async () => {
  const f = await setup();
  try {
    const dm = f.host.start("client", f.id, f.members[0], "PRIVATE_DM_MARKER", randomUUID()); await f.host.wait(dm.runId);
    const privateHistory = f.host.snapshot(f.id, f.members[0]).conversation;
    const a = f.create("Channel A"); f.host.sendChannel("client", f.id, a, "CHANNEL_A_MARKER", randomUUID(), [f.members[0]]); await f.host.waitChannel(f.id, a);
    const b = f.create("Channel B"); f.host.sendChannel("client", f.id, b, "CHANNEL_B_MARKER", randomUUID(), [f.members[0]]); await f.host.waitChannel(f.id, b);
    const latest = f.calls.at(-1); assert.equal(JSON.stringify(latest).includes("PRIVATE_DM_MARKER"), false); assert.equal(JSON.stringify(latest).includes("CHANNEL_A_MARKER"), false);
    assert.deepEqual(f.host.snapshot(f.id, f.members[0]).conversation, privateHistory);
    assert.notEqual(channelSessionId(a, f.members[0]), channelSessionId(b, f.members[0]));
    assert.notEqual(channelSessionId(a, f.members[0]), privateHistory.sessionId);
    const other = f.host.createWorkspace("Other", f.host.list().revision);
    assert.throws(() => f.host.channelSnapshot(other.workspaceId, a, "client"), /not in this Workspace/);
    assert.throws(() => f.host.createChannel("client", other.workspaceId, randomUUID(), "Foreign", f.members, 0), /another view/);
    assert.equal(f.host.listChannels(other.workspaceId).channels.length, 0);
    assert.equal(f.calls.length, 3);
  } finally { await f.host.close(); }
});
test("channel creation is idempotent, membership is validated, updates preserve history and restart never calls a model", async () => {
  const f = await setup(); let restored;
  try {
    const channel = f.create(); const count = f.host.listChannels(f.id).channels.length;
    f.host.createChannel("client", f.id, channel, "Local planning", f.members, 0); assert.equal(f.host.listChannels(f.id).channels.length, count);
    assert.throws(() => f.host.createChannel("client", f.id, channel, "Changed", f.members, 0), /identity already used/);
    assert.throws(() => f.create("Bad", [f.workspace.selectedAgentId]), /active colleagues/);
    assert.throws(() => f.create("Bad", [`ag_${randomUUID()}`]), /active colleagues/);
    f.host.selectChannel("client", f.id, channel);
    const requestId = randomUUID(); f.host.sendChannel("client", f.id, channel, "persisted group", requestId, [f.members[1]]); await f.host.waitChannel(f.id, channel);
    const before = f.host.channelSnapshot(f.id, channel, "client");
    f.host.sendChannel("client", f.id, channel, "persisted group", requestId, [f.members[1]]); assert.equal(f.calls.length, 1);
    assert.equal(f.host.channelReceipt(f.id, channel, requestId).state, "accepted"); assert.equal(f.host.channelReceipt(f.id, channel, randomUUID()).state, "unknown");
    assert.throws(() => f.host.sendChannel("client", f.id, channel, "changed text", requestId, [f.members[1]]), /identity already used/);
    f.host.updateChannel("client", f.id, channel, "Renamed", [f.members[2]], f.host.listChannels(f.id).revision);
    assert.deepEqual(f.host.channelSnapshot(f.id, channel, "client").messages, before.messages);
    await f.host.close(); restored = new LocalWorkspaceHost(f.root, { ...f.options, providerFactory() { assert.fail("a reopen must never construct a Provider"); } }); await restored.initialize();
    assert.equal(restored.listChannels(f.id).channels[0].name, "Renamed"); assert.deepEqual(restored.channelSnapshot(f.id, channel, "new-client").messages, before.messages);
    const storage = new WorkspaceResourceStorage(restored.home, restored.catalog.resolve(f.id).scope); storage.initialize();
    const folder = storage.run(() => join(workspaceStateHome(), ".hara"));
    for (const name of fs.readdirSync(folder).filter(name => /^local-channel/.test(name))) assert.equal(fs.statSync(join(folder, name)).mode & 0o777, 0o600);
  } finally { await restored?.close(); await f.host.close(); }
});
test("stopping a channel aborts the current request and skips queued colleagues; verification and reconnect never replay", async () => {
  let entered, calls = 0; const ready = new Promise(r => entered = r);
  const f = await setup(3, (_connection, binding) => ({ id: "openai", model: binding.model, async turn(args) { calls++; entered();
    await new Promise((_, reject) => { if (args.signal?.aborted) reject(new Error("stopped")); else args.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); });
    return { text: "late", toolUses: [], stop: "end" };
  } }));
  try {
    const channel = f.create(), nonce = randomUUID(); f.host.sendChannel("client", f.id, channel, "wait", nonce, f.members); await ready;
    assert.throws(() => f.host.updateChannel("client", f.id, channel, "Edit while busy", [], f.host.listChannels(f.id).revision), /busy/);
    f.host.cancelChannel("client", f.id, channel); await f.host.waitChannel(f.id, channel);
    const snapshot = f.host.channelSnapshot(f.id, channel, "client"); assert.equal(snapshot.state, "cancelled"); assert.equal(calls, 1);
    assert.ok(snapshot.turns[0].replies.slice(1).every(row => row.state === "cancelled"));
    for (let i = 0; i < 3; i++) f.host.channelReceipt(f.id, channel, nonce); assert.equal(calls, 1);
    f.host.sendChannel("client", f.id, channel, "wait", nonce, f.members); assert.equal(calls, 1);
  } finally { await f.host.close(); }
});
test("channel membership never grants a colleague the main Hara's Agent-creation authority", async () => {
  const f = await setup(1, (connection, binding, context) => createWorkspaceSyntheticProvider(connection, binding, { ...context, agent: { ...context.agent, kind: "main" } }));
  try {
    const channel = f.create(); f.host.sendChannel("client", f.id, channel, "建立同事 Coder", randomUUID(), f.members);
    await f.host.waitChannel(f.id, channel);
    const view = f.host.channelSnapshot(f.id, channel, "client");
    assert.equal(view.approvals.length, 0); assert.equal(f.host.snapshot(f.id, f.members[0], "client").approvals.length, 0);
    assert.equal(f.host.snapshot(f.id).agents.filter(row => row.kind === "colleague").length, 1);
    assert.ok(view.messages.some(row => row.message.role === "tool" && row.message.results.some(result => result.name === "agent_create" && result.isError)));
  } finally { await f.host.close(); }
});
test("personal notes need no model; malformed identifiers and unsafe channel metadata never create files", async () => {
  const f = await setup(0);
  try {
    const connection = f.host.snapshot(f.id).connections; f.host.revokeConnection(f.id, connection.defaultConnectionId, connection.revision);
    assert.equal(f.host.snapshot(f.id).connections.defaultConnectionId, null);
    const channel = f.create("Notes", []), nonce = randomUUID(); f.host.sendChannel("client", f.id, channel, "just me\nlocal note", nonce, []); await f.host.waitChannel(f.id, channel);
    const view = f.host.channelSnapshot(f.id, channel, "client"); assert.equal(view.messages.length, 1); assert.equal(f.calls.length, 0);
    assert.throws(() => f.host.channelSnapshot(f.id, "../escape", "client"), /invalid/);
    assert.throws(() => f.create("unsafe\nname", []), /invalid/);
    assert.equal(f.host.listChannels(f.id).channels.length, 1);
  } finally { await f.host.close(); }
});
