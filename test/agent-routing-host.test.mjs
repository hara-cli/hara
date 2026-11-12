import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { routingHostFixture, routingUntil, boundary } from "./helpers/agent-routing-host-fixture.mjs";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceAgentStore } from "../dist/workspace/agents.js";
import { WorkspaceColleagueHomes } from "../dist/workspace/colleague-homes.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { routingFixture } from "./helpers/agent-routing-fixture.mjs";

test("C6 real WS starts one original C3 owner before any business provider and uses the physical channel session", async t => {
  const f = await routingHostFixture(t), data = f.data();
  assert.equal(f.init.capabilities.includes("workspace.agent-routing.v1"), true);
  const accepted = await f.submit(data); assert.equal(accepted.state, "claimed"); assert.equal(accepted.ownerAgentId, f.members[0]);
  await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed");
  assert.deepEqual(f.providers, [f.members[0]]); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].agentId, f.members[0]);
  const state = f.state(); assert.equal(state.control.runs.length, 1); assert.equal(state.routing.records.length, 1);
  assert.equal(state.control.runs[0].binding.sessionId, channelSessionId(f.channelId, f.members[0]));
  assert.equal(state.control.commands[0].command.operation.conversationId, channelSessionId(f.channelId, f.members[0]));
  assert.equal(f.conversation(f.members[0]).history.filter(row => row.role === "assistant").length, 1);
  for (const id of f.members.slice(1)) assert.equal(f.conversation(id).history.length, 0);
  assert.ok(!f.calls[0].system.includes("PRIVATE_engineering_PERSONA")); assert.ok(!f.calls[0].system.includes("PRIVATE_design_PERSONA"));
  assert.ok(f.calls[0].system.includes("single claimed owner")); assert.ok(!f.calls[0].system.includes("use channel_peer_wake"));
  const original = await f.read(data), duplicate = await f.submit(data);
  assert.deepEqual(duplicate.claim, original.claim);
  const later = await f.submit({ ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1]], message: "compile this instead" });
  assert.deepEqual(later.claim, original.claim); assert.equal(later.ownerAgentId, f.members[0]); assert.equal(f.calls.length, 1); assert.equal(f.providers.length, 1);
});

test("C6 real WS audience and syntax denial read zero private conversation, home or business context", async t => {
  const f = await routingHostFixture(t); let reads = 0, homes = 0;
  const read = WorkspaceConversationStore.prototype.read, ensure = WorkspaceColleagueHomes.prototype.ensure;
  WorkspaceConversationStore.prototype.read = function (...args) { reads++; return read.apply(this, args); };
  WorkspaceColleagueHomes.prototype.ensure = function (...args) { homes++; return ensure.apply(this, args); };
  try {
    await assert.rejects(f.submit(f.data("invoice", { explicitAgentIds: [`ag_${randomUUID()}`] })), boundary("AUTHORIZATION_DENIED"));
    for (const extra of [{ provenance: { channel: "local_human" } }, { actorChain: { approvedBy: "owner" } }, { approved: true }])
      await assert.rejects(f.submit({ ...f.data(), ...extra }), boundary("INVALID_DOCUMENT"));
    await assert.rejects(f.owner.request("workspace.boundaries.routing.directory", { ...f.common, channelId: randomUUID() }));
    assert.equal(reads, 0); assert.equal(homes, 0); assert.equal(f.providers.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.state().routing.records.length, 0);
  } finally { WorkspaceConversationStore.prototype.read = read; WorkspaceColleagueHomes.prototype.ensure = ensure; }
});

test("C6 real WS no match, multi-mention and tied duties return NEEDS_OWNER without provider fanout", async t => {
  const f = await routingHostFixture(t, { tie: true });
  for (const data of [f.data("invoice"), f.data("unspecified work"), f.data("layout", { explicitAgentIds: [f.members[0], f.members[2]] })]) {
    const view = await f.submit(data); assert.equal(view.code, "NEEDS_OWNER"); assert.equal(view.state, "needs_owner"); assert.equal(view.ownerAgentId, null); assert.equal(view.claim, null);
  }
  assert.equal(f.providers.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.state().control.runs.length, 0);
});

test("C6 real WS another authenticated connection observes the original claim, while a guest cannot self-report origin", async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = await routingHostFixture(t, { turn: async () => { await pending; return { text: "once", toolUses: [], stop: "end" }; } });
  const second = await f.open(); await second.request("initialize", { token: f.handle.token, boundaryCredential: f.ownerCredential });
  const data = f.data(), views = await Promise.all([f.submit(data), f.submit(data, second)]);
  assert.equal(views[0].ownerAgentId, views[1].ownerAgentId); assert.deepEqual(views[0].claim, views[1].claim); assert.equal(f.providers.length, 1);
  const guest = await f.open(); await assert.rejects(guest.request("initialize", { token: f.handle.token, source: "local_human" }), boundary("AUTHORITY_UNVERIFIED"));
  await assert.rejects(guest.request("workspace.boundaries.routing.submit", { ...f.common, input: data }), /unauthorized/);
  release(); await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed"); assert.equal(f.calls.length, 1);
});

test("C6 persisted audience epoch isolates unrelated channels and never revives a removed/re-added owner", async t => {
  const f = await routingHostFixture(t), original = f.rooms.routingAudience(f.channelId), other = randomUUID();
  assert.equal(Object.hasOwn(f.rooms.get(f.channelId), "audienceRevision"), false);
  f.rooms.create(other, "Other room", [f.members[1]], f.rooms.list().revision);
  f.rooms.update(other, "Unrelated change", [f.members[1], f.members[2]], f.rooms.list().revision);
  assert.deepEqual(f.rooms.routingAudience(f.channelId), original);
  const data = f.data(); await f.submit(data); await routingUntil(async () => (await f.read(data)).receipt.execution.drain === "observed");
  f.rooms.update(f.channelId, "Authorized team", f.members.slice(1), f.rooms.list().revision);
  f.rooms.update(f.channelId, "Authorized team", f.members, f.rooms.list().revision);
  assert.equal(f.rooms.routingAudience(f.channelId).revision, original.revision + 2);
  const result = await f.read(data); assert.equal(result.state, "blocked"); assert.equal(result.reason, "audience_changed");
  await f.submit({ ...data, requestId: randomUUID(), explicitAgentIds: [f.members[1]] }); assert.equal(f.providers.length, 1);
});

test("C6 public directory never consults execution resources or private persona as a fallback", t => {
  let personaReads = 0; const original = WorkspaceAgentStore.prototype.channelPrefilterProfiles;
  WorkspaceAgentStore.prototype.channelPrefilterProfiles = function () { personaReads++; return original.call(this); };
  t.after(() => { WorkspaceAgentStore.prototype.channelPrefilterProfiles = original; });
  const f = routingFixture(t); personaReads = 0; f.authorityOptions.resourcesForAgent = () => { throw new Error("Private resource reader must not be used for public nomination"); };
  let directory; assert.doesNotThrow(() => { directory = f.router.directory(f.transport, f.input().channelId); }); assert.equal(directory.length, 3); assert.equal(personaReads, 0);
  assert.ok(directory.every(row => Object.keys(row.publicProfile).sort().join(",") === "description,owns,rejects,title"));
  assert.ok(!JSON.stringify(directory).includes("instructions"));
});

test("C6 default and invalid bootstrap stay closed, with no RPC/prompt enable switch", async t => {
  const f = await routingHostFixture(t, { disabled: true }); assert.equal(f.init.capabilities.includes("workspace.agent-routing.v1"), false);
  await assert.rejects(f.submit(f.data()), boundary("RUNTIME_UNSUPPORTED")); assert.equal(f.providers.length, 0);
  const invalid = join(f.root, "invalid"), routing = { automaticAgentIds: () => [] };
  assert.throws(() => new LocalWorkspaceHost(invalid, { boundaryRouting: routing }), error => error.field === "routing.bootstrap"); assert.equal(fs.existsSync(invalid), false);
  await assert.rejects(startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: invalid }, { root: invalid, version: "C6-off", agentBoundaries: { ownerCredential: randomBytes(32).toString("hex"), routing } }));
  assert.equal(fs.existsSync(invalid), false);
});
