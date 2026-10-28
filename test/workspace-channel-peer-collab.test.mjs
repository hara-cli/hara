import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channelMentions } from "../dist/workspace/local-channels.js";
import { setup } from "./helpers/local-channels.mjs";

// Scripted colleagues: each agent plays its tool calls in order, one per model call, then answers in text.
// Every call records the system prompt plus the tool results it has seen so far.
const scripted = (script, calls) => (_connection, binding, context) => {
  let step = 0;
  return { id: "openai", model: binding.model, async turn(args) {
    const results = args.history.filter(row => row.role === "tool").flatMap(row => row.results);
    const name = context.agent.identity.displayName;
    const next = (script[name] ?? [])[step];
    calls.push({ agentId: context.agent.agentId, name, system: args.system, results });
    step++;
    if (next) return { text: "", toolUses: [{ id: randomUUID(), name: next.name, input: next.input }], stop: "tool_use", usage: { input: 1, output: 1 } };
    return { text: `${name} replied`, toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
  } };
};

test("channelMentions resolves @displayName and @agentId, longest first, without matching inside words or e-mail", () => {
  const members = [{ agentId: "a1", displayName: "Bob" }, { agentId: "a2", displayName: "Bobby" }, { agentId: "a3", displayName: "小明" }];
  assert.deepEqual(channelMentions("@Bobby and @bob, ping", members), ["a2", "a1"]);
  assert.deepEqual(channelMentions("@小明你好 @a1", members), ["a3", "a1"]);
  assert.deepEqual(channelMentions("mail me at x@Bob or @Bobcat", members), []);
  assert.deepEqual(channelMentions("@Bob @Bob", members), ["a1"]);
});

test("a mention widens a non-empty recipient list once and never starts an empty-recipient note", async () => {
  const calls = [], f = await setup(3, scripted({}, calls));
  try {
    const channel = f.create();
    f.host.sendChannel("client", f.id, channel, "note for @Colleague 2 later", randomUUID(), []); await f.host.waitChannel(f.id, channel);
    assert.equal(calls.length, 0, "an empty recipient list stays a note even with a mention");
    const requestId = randomUUID(), body = "@Colleague 2 and @colleague 0 please check";
    f.host.sendChannel("client", f.id, channel, body, requestId, [f.members[0]]); await f.host.waitChannel(f.id, channel);
    const view = f.host.channelSnapshot(f.id, channel, "client");
    assert.deepEqual(view.turns.at(-1).replies.map(row => row.agentId), [f.members[0], f.members[2]], "selected first, then mentioned, deduplicated");
    assert.deepEqual(calls.map(row => row.agentId), [f.members[0], f.members[2]]);
    f.host.sendChannel("client", f.id, channel, body, requestId, [f.members[0]]);
    assert.equal(calls.length, 2, "an identical retry keeps the original acceptance");
  } finally { await f.host.close(); }
});

test("a replying colleague wakes a peer into the same turn; the peer runs next and channel_sync sees the earlier reply", async () => {
  const calls = [], f = await setup(3, scripted({
    "Colleague 0": [{ name: "channel_peer_wake", input: { agentId: "Colleague 2", note: "please double-check the numbers" } },
      { name: "channel_peer_wake", input: { agentId: "@colleague 2" } }],
    "Colleague 2": [{ name: "channel_sync", input: {} }],
  }, calls));
  try {
    const channel = f.create();
    f.host.sendChannel("client", f.id, channel, "Draft the plan", randomUUID(), [f.members[0]]); await f.host.waitChannel(f.id, channel);
    const view = f.host.channelSnapshot(f.id, channel, "client"), replies = view.turns.at(-1).replies;
    assert.deepEqual(replies.map(row => row.agentId), [f.members[0], f.members[2]]);
    assert.equal(replies[1].wokenBy, f.members[0]); assert.equal(replies[0].wokenBy, undefined);
    assert.ok(!calls.some(row => row.agentId === f.members[1]), "an unwoken member stays idle");
    assert.ok(calls.findLastIndex(row => row.agentId === f.members[0]) < calls.findIndex(row => row.agentId === f.members[2]), "still serial");
    const wakes = calls.filter(row => row.agentId === f.members[0]).at(-1).results.map(row => JSON.parse(row.content));
    assert.equal(wakes[0].queued, true); assert.equal(wakes[0].alreadyQueued, false);
    assert.equal(wakes[1].alreadyQueued, true, "waking a queued peer again is idempotent");
    const woken = calls.filter(row => row.agentId === f.members[2]);
    assert.ok(woken[0].system.includes("please double-check the numbers"), "the wake note reaches the woken peer as channel data");
    const synced = JSON.parse(woken.at(-1).results.find(row => !row.isError).content);
    assert.deepEqual(Object.keys(synced).filter(key => key !== "receipt").sort(), ["channel", "members", "messages"]);
    assert.ok(synced.messages.some(row => row.sender === "Colleague 0" && row.message.role === "assistant" && row.message.text === "Colleague 0 replied"));
  } finally { await f.host.close(); }
});

test("peer wake refuses self, non-members, re-entry and colleagues outside the running reply", async () => {
  const calls = [], f = await setup(3, scripted({
    "Colleague 0": [{ name: "channel_peer_wake", input: { agentId: "Colleague 0" } }, { name: "channel_peer_wake", input: { agentId: "Colleague 1" } },
      { name: "channel_peer_wake", input: { agentId: "Colleague 2" } }],
    "Colleague 2": [{ name: "channel_peer_wake", input: { agentId: "Colleague 0" } }],
  }, calls));
  try {
    const channel = f.create("Pair", [f.members[0], f.members[2]]);
    f.host.sendChannel("client", f.id, channel, "Go", randomUUID(), [f.members[0]]); await f.host.waitChannel(f.id, channel);
    const first = calls.filter(row => row.agentId === f.members[0]).at(-1).results.map(row => JSON.parse(row.content));
    assert.match(first[0].error, /cannot wake itself/); assert.match(first[1].error, /not a member/);
    assert.equal(first[2].queued, true); assert.equal(first[2].agentId, f.members[2]);
    const second = JSON.parse(calls.filter(row => row.agentId === f.members[2]).at(-1).results[0].content);
    assert.match(second.error, /already replied in this turn/);
    const view = f.host.channelSnapshot(f.id, channel, "client");
    assert.deepEqual(view.turns.at(-1).replies.map(row => row.agentId), [f.members[0], f.members[2]], "no re-entry, no outsider");
    const rooms = f.host.localChannels(f.id);
    assert.throws(() => rooms.peerWake(channel, randomUUID(), f.members[0], f.members[2]), /currently replying/, "no wake outside an active reply");
  } finally { await f.host.close(); }
});
