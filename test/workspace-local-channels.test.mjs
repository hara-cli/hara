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
import { localChannelTiming } from "./helpers/local-channel-timing.mjs";

test("local channels support more than ten colleagues, one user turn and ordered replies without cloud login", async () => {
  const timing = localChannelTiming();
  let f;
  try {
    f = await timing.async("setup", () => setup(13, undefined, "controlled")); timing.observe(f);
    const channel = timing.sync("create", () => f.create());
    timing.sync("send", () => f.host.sendChannel("client", f.id, channel, "hello group", randomUUID(), f.members));
    await timing.async("wait", () => f.host.waitChannel(f.id, channel)); timing.emit("commit", { event: "room-settled" });
    const view = timing.sync("snapshot", () => f.host.channelSnapshot(f.id, channel, "client"));
    assert.equal(view.channel.memberIds.length, 13); assert.equal(view.state, "completed");
    assert.equal(view.messages.filter(row => row.message.role === "user").length, 1);
    assert.equal(view.messages.filter(row => row.message.role === "assistant").length, 13);
    assert.deepEqual(f.calls.map(row => row.agentId), f.members);
    assert.ok(f.calls[1].system.includes("Colleague 0: hello group"), "later colleagues see earlier group responses");
    assert.equal(f.host.activity().running, 0);
  } finally {
    try { if (f) await timing.async("close", () => f.host.close()); }
    finally { timing.close(); }
  }
});

test("roster activity uses actual persisted messages and no fabricated empty preview", async () => {
  const f = await setup(2, undefined, "controlled");
  try {
    const id = f.create(), empty = f.host.listChannels(f.id).channels.find(row => row.id === id);
    assert.equal(empty.messageCount, 0); assert.equal(empty.activityAvailable, true); assert.equal(empty.lastMessageAt, undefined); assert.equal(empty.preview, undefined);
    f.host.sendChannel("client", f.id, id, "Synthetic roster activity", randomUUID(), f.members); await f.host.waitChannel(f.id, id);
    const snapshot = f.host.channelSnapshot(f.id, id, "client"), row = f.host.listChannels(f.id).channels.find(row => row.id === id);
    const messages = snapshot.messages.filter(item => item.message.role !== "tool"), last = messages.at(-1);
    assert.equal(row.messageCount, messages.length); assert.equal(row.lastMessageAt, last.createdAt);
    assert.match(row.preview, /Synthetic roster activity/); assert.equal(row.activityAvailable, true);
  } finally { await f.host.close(); }
});

test("archiving preserves group history and metadata while archived colleagues cannot be added or dispatched", async () => {
 const f=await setup(2,undefined,"controlled");
 try{
  const id=f.create(), peer=f.create("Other",[f.members[1]]), target=f.resources.agents.get(f.members[0]);
  f.host.selectChannel("client",f.id,id);
  f.host.sendChannel("client",f.id,id,"Retained group history",randomUUID(),f.members);await f.host.waitChannel(f.id,id);
  const before=f.host.channelSnapshot(f.id,id,"client"), deleted=await f.host.setAgentArchived(f.id,target.agentId,true,target.configRevision,target.agentEpoch);
  assert.deepEqual(f.host.channelSnapshot(f.id,id,"client").messages,before.messages);
  const updated=f.host.updateChannel("client",f.id,id,"Renamed retained group",f.members,f.host.listChannels(f.id).revision);
  assert.deepEqual(updated.channels.find(row=>row.id===id).memberIds,f.members);
  f.host.selectChannel("client",f.id,peer);
  assert.throws(()=>f.host.updateChannel("client",f.id,peer,"Other",f.members,f.host.listChannels(f.id).revision),/member|active|colleague/i);
  assert.throws(()=>f.create("Forbidden",[target.agentId]),/member|active|colleague/i);
  f.host.selectChannel("client",f.id,id);
  assert.throws(()=>f.host.sendChannel("client",f.id,id,"Must not dispatch deleted colleague",randomUUID(),[target.agentId]),/member|active|colleague/i);
  f.host.selectChannel("client",f.id,id);
  const calls=f.calls.length;f.host.sendChannel("client",f.id,id,"Active member only",randomUUID(),[f.members[1]]);await f.host.waitChannel(f.id,id);
  assert.deepEqual(f.calls.slice(calls).map(row=>row.agentId),[f.members[1]]);
  await f.host.setAgentArchived(f.id,target.agentId,false,deleted.agent.configRevision,deleted.agent.agentEpoch);
  assert.deepEqual(f.host.listChannels(f.id).channels.find(row=>row.id===id).memberIds,f.members);
 }finally{await f.host.close();}
});
