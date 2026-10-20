import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION, createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { WorkspaceRequestJournal } from "../dist/workspace/request-journal.js";

const temporary = [];
after(() => { for (const p of temporary) fs.rmSync(p, { recursive: true, force: true }); });
async function setup(count = 3, providerFactory) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-local-channel-"))); temporary.push(root);
  const calls = [], options = { mode: "workspace", credentialVault: new MemoryCredentialVault(), providerFactory: providerFactory ?? ((_connection, binding, context) => ({
    id: "openai", model: binding.model, async turn(args) {
      calls.push({ agentId: context.agent.agentId, objective: context.objective, system: args.system, history: structuredClone(args.history) });
      return { text: `${context.agent.identity.displayName}: ${context.objective}`, toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
    },
  })) }, host = new LocalWorkspaceHost(root, options);
  await host.initialize(); const workspace = host.createWorkspace("Local personal", host.list().revision), id = workspace.workspaceId;
  host.configureConnection(id, { ...SYNTHETIC_CONNECTION }, 0); host.select("client", id, host.list().revision);
  const resources = new WorkspaceResources(host.home, host.catalog.resolve(id).scope); resources.initialize();
  const members = [];
  for (let i = 0; i < count; i++) members.push(resources.agents.create({ username: `colleague-${i}`, profile: { displayName: `Colleague ${i}` } }, resources.agents.list().revision).agentId);
  const create = (name = "Local planning", memberIds = members) => {
    const channelId = randomUUID(); host.createChannel("client", id, channelId, name, memberIds, host.listChannels(id).revision); host.selectChannel("client", id, channelId); return channelId;
  };
  return { root, host, options, id, workspace, resources, members, create, calls };
}
async function until(read) { for (let n = 0; n < 150; n++) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 30)); } throw new Error("bounded local channel wait"); }

test("local channels support more than ten colleagues, one user turn and ordered replies without cloud login", async () => {
  const f = await setup(13);
  try {
    const channel = f.create(); f.host.sendChannel("client", f.id, channel, "hello group", randomUUID(), f.members);
    await f.host.waitChannel(f.id, channel); const view = f.host.channelSnapshot(f.id, channel, "client");
    assert.equal(view.channel.memberIds.length, 13); assert.equal(view.state, "completed");
    assert.equal(view.messages.filter(row => row.message.role === "user").length, 1);
    assert.equal(view.messages.filter(row => row.message.role === "assistant").length, 13);
    assert.deepEqual(f.calls.map(row => row.agentId), f.members);
    assert.ok(f.calls[1].system.includes("Colleague 0: hello group"), "later colleagues see earlier group responses");
    assert.equal(f.host.activity().running, 0);
  } finally { await f.host.close(); }
});
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
