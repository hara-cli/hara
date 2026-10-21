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

test("a crash between participant acceptance and room receipt preserves its reply and never replays queued colleagues", async () => {
  const f = await setup(2); let restored;
  try {
    const channel = f.create(), requestId = randomUUID(); f.host.sendChannel("client", f.id, channel, "before crash", requestId, [f.members[0]]); await f.host.waitChannel(f.id, channel);
    const before = f.host.channelSnapshot(f.id, channel, "client"); await f.host.close();
    const storage = new WorkspaceResourceStorage(f.host.home, f.host.catalog.resolve(f.id).scope); storage.initialize();
    const file = storage.run(() => join(workspaceStateHome(), ".hara", `local-channel-${channel}.json`)), raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const turn = raw.turns[0]; turn.state = "running"; turn.replies[0].state = "running"; turn.replies[0].runId = null; turn.replies[0].endIndex = null;
    turn.replies.push({ agentId: f.members[1], displayName: "Colleague 1", requestId: randomUUID(), runId: null, startIndex: 0, endIndex: null, state: "queued" });
    fs.writeFileSync(file, JSON.stringify(raw) + "\n", { mode: 0o600 });
    let calls = 0;
    restored = new LocalWorkspaceHost(f.root, { ...f.options, providerFactory(...args) { calls++; return f.options.providerFactory(...args); } }); await restored.initialize();
    const recovered = restored.channelSnapshot(f.id, channel, "new-client"); assert.equal(recovered.state, "interrupted"); assert.deepEqual(recovered.messages, before.messages); assert.equal(calls, 0);
    restored.select("new-client", f.id, restored.list().revision); restored.selectChannel("new-client", f.id, channel);
    restored.sendChannel("new-client", f.id, channel, "before crash", requestId, [f.members[0]]); assert.equal(calls, 0);
    restored.sendChannel("new-client", f.id, channel, "a new explicit turn", randomUUID(), [f.members[0]]); await restored.waitChannel(f.id, channel);
    const after = restored.channelSnapshot(f.id, channel, "new-client"); assert.equal(calls, 1);
    assert.equal(after.messages.filter(row => row.message.role === "assistant").length, 2); assert.deepEqual(after.messages.slice(0, 2), before.messages);
    assert.equal(after.turns[0].replies[1].state, "interrupted");
  } finally { await restored?.close(); await f.host.close(); }
});
test("a same-Agent journal copied from another channel fails its session binding without a Provider call", async () => {
  const f = await setup(1);
  try {
    const a = f.create("A"); f.host.sendChannel("client", f.id, a, "first room", randomUUID(), f.members); await f.host.waitChannel(f.id, a);
    const b = f.create("B"), storage = new WorkspaceResourceStorage(f.host.home, f.host.catalog.resolve(f.id).scope); storage.initialize();
    const folder = storage.run(() => join(workspaceStateHome(), ".hara"));
    const source = join(folder, `requests-${channelSessionId(a, f.members[0])}.json`), destination = join(folder, `requests-${channelSessionId(b, f.members[0])}.json`);
    fs.copyFileSync(source, destination); const original = fs.readFileSync(destination, "utf8");
    assert.throws(() => new WorkspaceRequestJournal(storage, f.members[0], b).find(randomUUID()), /invalid Workspace request journal/);
    assert.equal(fs.readFileSync(destination, "utf8"), original); assert.equal(f.calls.length, 1);
  } finally { await f.host.close(); }
});
test("a room-receipt write failure after acceptance cancels its exact run before any queued colleague starts", async () => {
  const f = await setup(3);
  try {
    const channel = f.create(), rooms = f.host.localChannels(f.id), original = rooms.changeReply;
    let writes = 0;
    rooms.changeReply = function (...args) { if (++writes === 2) throw new Error("owned fixture receipt-write failure"); return original.apply(this, args); };
    f.host.sendChannel("client", f.id, channel, "one transient receipt failure", randomUUID(), f.members); await f.host.waitChannel(f.id, channel);
    const view = f.host.channelSnapshot(f.id, channel, "client"); assert.equal(view.state, "cancelled"); assert.equal(view.turns[0].replies[0].state, "failed");
    assert.ok(view.turns[0].replies.slice(1).every(row => row.state === "cancelled")); assert.equal(f.host.activity().running, 0);
    assert.ok(f.calls.every(row => row.agentId === f.members[0])); assert.ok(f.calls.length <= 1);
  } finally { await f.host.close(); }
});
test("terminal provider recovery stays isolated between two channels and a DM, including restart and foreign evidence", async () => {
  let factories = 0, calls = 0, restored;
  const f = await setup(1, (_connection, binding, context) => {
    factories++;
    return { id: "openai", model: binding.model, async turn() {
      calls++;
      if (context.objective.startsWith("channel-")) return { text: "", toolUses: [], stop: "error",
        errorMsg: "synthetic refusal", errorMetadata: { status: context.objective === "channel-a" ? 404 : 401 } };
      return { text: "private task complete", toolUses: [], stop: "end" };
    } };
  });
  try {
    const a = f.create("A"), nonce = randomUUID();
    f.host.sendChannel("client", f.id, a, "channel-a", nonce, f.members); await f.host.waitChannel(f.id, a);
    const b = f.create("B");
    f.host.sendChannel("client", f.id, b, "channel-b", randomUUID(), f.members); await f.host.waitChannel(f.id, b);
    const storage = new WorkspaceResourceStorage(f.host.home, f.host.catalog.resolve(f.id).scope); storage.initialize();
    const read = channel => new WorkspaceConversationStore(storage, f.members[0], channel).read();
    const beforeA = read(a), beforeB = read(b);
    const resume = (host, channel) => host.start("client", f.id, f.members[0], "/continue", randomUUID(), false,
      undefined, undefined, { source: "ui", channel: "rpc", clientId: "client" }, { id: channel, context: "same local channel" });
    assert.throws(() => resume(f.host, a), /connection_model_unavailable/);
    assert.throws(() => resume(f.host, b), /connection_auth_required/);
    f.host.selectChannel("client", f.id, a); f.host.sendChannel("client", f.id, a, "channel-a", nonce, f.members);
    assert.equal(calls, 2, "denied continuations and duplicate channel delivery never call a model");
    const dm = f.host.start("client", f.id, f.members[0], "private task", randomUUID()); await f.host.wait(dm.runId);
    assert.equal(f.host.snapshot(f.id, f.members[0]).conversation.state, "completed");
    assert.deepEqual(read(a), beforeA); assert.deepEqual(read(b), beforeB);
    await f.host.close(); restored = new LocalWorkspaceHost(f.root, f.options); await restored.initialize();
    assert.throws(() => resume(restored, a), /connection_model_unavailable/);
    assert.throws(() => resume(restored, b), /connection_auth_required/);
    assert.deepEqual(read(a), beforeA); assert.deepEqual(read(b), beforeB);
    const folder = storage.run(() => join(workspaceStateHome(), ".hara"));
    const source = join(folder, `provider-recovery-${channelSessionId(a, f.members[0])}.json`);
    const destination = join(folder, `provider-recovery-${channelSessionId(b, f.members[0])}.json`);
    fs.copyFileSync(source, destination); const foreign = fs.readFileSync(destination);
    assert.throws(() => resume(restored, b), /connection_recovery_unavailable/);
    assert.equal(fs.readFileSync(destination).equals(foreign), true, "foreign evidence is retained, never silently repaired");
    assert.equal(factories, 3); assert.equal(calls, 3);
  } finally { await restored?.close(); await f.host.close(); }
});
