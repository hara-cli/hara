import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceJsonState } from "../dist/workspace/local-state.js";
import { WorkspaceLocalChannels, LOCAL_CHANNEL_QUEUE_LIMIT } from "../dist/workspace/local-channels.js";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { channelRoleUnrelated } from "../dist/workspace/channel-prefilter.js";

// This suite tests the room scheduler with a receipt-writing mock host. It never constructs a
// provider, LocalWorkspaceHost, credential vault, real CLI runtime or model run. Attempt-state
// validation remains in the existing conversation/host suites; here an absent attempt settles a
// dispatched reply as failed while still allowing the room to advance.
function fixture(t, { auto = false, profiles = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-channel-interjection-")));
  const catalog = new LocalWorkspaceCatalog(root), owners = [], engines = [];
  const agentIds = Array.from({ length: 3 }, () => "ag_" + randomUUID());
  const identities = [
    { displayName: "Analyst", title: "Finance", instructions: "finance budgets invoices accounting" },
    { displayName: "Designer", title: "Design", instructions: "design illustration typography colors" },
    { displayName: "Engineer", title: "Engineering", instructions: "engineering javascript typescript runtime" },
  ];
  function newWorkspace() {
    const row = catalog.create("Scheduler fixture", catalog.read().revision);
    const storage = new WorkspaceResourceStorage(root, row.scope); storage.initialize();
    const roster = agentIds.map((agentId, index) => ({
      workspaceId: row.scope.workspaceId, agentId, username: "member-" + index, kind: "colleague", state: "active",
      agentEpoch: 1, configRevision: 1, description: identities[index].title,
      identity: { version: 1, source: "hara", displayName: identities[index].displayName, title: identities[index].title },
      runtime: { id: "pi", label: "Pi", available: true, recommended: true },
    }));
    const calls = [], records = new Map(), cancelled = [], maximum = new Map();
    const f = { root, storage, roster, members: agentIds, calls, cancelled, maximum, accepting: true, failStartOn: 0 };
    const host = {
      agents: () => roster,
      ...(profiles ? { prefilterProfiles: () => roster.map((member, index) => ({
        agentId: member.agentId, title: identities[index].title,
        instructions: identities[index].instructions, aliases: [member.identity.displayName, member.username],
      })) } : {}),
      start(agentId, body, requestId, channelId, context, clientId, questionId) {
        const runId = randomUUID(), store = new WorkspaceConversationStore(storage, agentId, channelId), state = store.read();
        state.history.push({ role: "user", content: body });
        state.requests.push({ requestId, digest: createHash("sha256").update(body).digest("hex"), taskId: randomUUID(), runId });
        store.save(state.revision, state);
        let resolve;
        const done = new Promise(next => { resolve = next; });
        records.set(runId, { agentId, body, channelId, done, resolve, settled: false });
        calls.push({ agentId, body, requestId, runId, channelId, context: JSON.parse(context), clientId, questionId });
        const live = [...records.values()].filter(record => !record.settled && record.channelId === channelId).length;
        maximum.set(channelId, Math.max(maximum.get(channelId) ?? 0, live));
        if (f.failStartOn === calls.length) throw new Error("mock accepted the request before losing its start response");
        if (auto) queueMicrotask(() => f.finish(runId));
        return { runId };
      },
      wait(runId) { const record = records.get(runId); assert.ok(record, "wait has an accepted run"); return record.done; },
      cancel(agentId, runId) { assert.equal(records.get(runId)?.agentId, agentId); cancelled.push(runId); f.finish(runId, false); },
      changed() {},
      accepting: () => f.accepting,
    };
    f.finish = (runId = calls.at(-1)?.runId, answer = true) => {
      const record = records.get(runId); assert.ok(record, "finish has an accepted run");
      if (record.settled) return;
      if (answer) {
        const store = new WorkspaceConversationStore(storage, record.agentId, record.channelId), state = store.read();
        state.history.push({ role: "assistant", text: "answer: " + record.body, toolUses: [] });
        store.save(state.revision, state);
      }
      record.settled = true; record.resolve();
    };
    f.liveCount = () => [...records.values()].filter(record => !record.settled).length;
    f.reopen = () => { f.rooms = new WorkspaceLocalChannels(storage, host); engines.push(f.rooms); return f.rooms; };
    f.create = (channelId = randomUUID()) => {
      f.rooms.create(channelId, "Planning", agentIds, f.rooms.list().revision); return channelId;
    };
    f.history = channelId => new WorkspaceJsonState(storage, "local-channel-" + channelId + ".json", value => value, () => { throw new Error("missing fixture history"); });
    f.reopen(); owners.push(f); return f;
  }
  const f = newWorkspace(); f.otherWorkspace = newWorkspace;
  t.after(async () => {
    await Promise.all(engines.map(engine => engine.close()));
    for (const owner of owners) assert.equal(owner.liveCount(), 0, "fixture retains no live mock runs");
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}
async function until(read) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("bounded mock channel scheduler wait");
}
const send = (f, channelId, body, recipients = [f.members[0]], clientId = "client", requestId = randomUUID()) =>
  f.rooms.send(clientId, channelId, body, requestId, recipients);
const userBodies = context => context.messages.filter(row => row.message.role === "user").map(row => row.message.content);

test("L0 keeps role matches, explicit aliases and uncertain evidence without a model", () => {
  const profile = { agentId: "unused", title: "Finance", instructions: "Invoices and budgeting", aliases: ["Ada"] };
  assert.equal(channelRoleUnrelated("review invoice", profile), false, "suffix variants match role keywords");
  assert.equal(channelRoleUnrelated("Ada please review orbital spectroscopy", profile), false, "exact aliases preserve attention");
  assert.equal(channelRoleUnrelated("review orbital spectroscopy", profile), true);
  assert.equal(channelRoleUnrelated("please help", profile), false, "generic input stays conservative");
  assert.equal(channelRoleUnrelated("review orbital spectroscopy", { agentId: "unused" }), false, "empty role stays conservative");
  assert.equal(channelRoleUnrelated("review orbital spectroscopy", undefined), false);
  assert.equal(channelRoleUnrelated("請核對發票金額", { agentId: "unused", title: "發票會計" }), false, "CJK role overlap is recognized");
});

test("three unrelated recipients PASS with zero host starts and zero conversation reads", async t => {
  const f = fixture(t), channelId = f.create(), store = new WorkspaceConversationStore(f.storage, f.members[0], channelId);
  const prior = store.read(); prior.history.push({ role: "user", content: "retained" }, { role: "assistant", text: "retained answer", toolUses: [] });
  store.save(prior.revision, prior); const before = store.read();
  const original = WorkspaceConversationStore.prototype.read; let reads = 0;
  WorkspaceConversationStore.prototype.read = function () { reads++; throw new Error("PASS must not read conversations"); };
  try {
    const receipt = send(f, channelId, "analyze orbital spectroscopy", f.members);
    assert.deepEqual({ accepted: receipt.accepted, queued: receipt.queued, position: receipt.position }, { accepted: true, queued: false, position: 0 });
    await f.rooms.wait(channelId);
    const snapshot = f.rooms.snapshot(channelId);
    assert.equal(snapshot.state, "completed"); assert.equal(snapshot.pendingCount, 0); assert.equal(snapshot.queueNeedsResume, false);
    assert.equal(f.calls.length, 0); assert.equal(reads, 0);
    assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.messages[0].message.role, "user");
    assert.deepEqual(snapshot.turns[0].replies.map(reply => [reply.state, reply.passedBy, reply.passReason, reply.started]),
      f.members.map(() => ["passed", "prefilter", "role_unrelated", false]));
    assert.ok(!JSON.stringify(snapshot).includes("budgets"), "private persona text is absent from public reasons");
  } finally { WorkspaceConversationStore.prototype.read = original; }
  assert.deepEqual(store.read(), before, "PASS preserves existing assistant history and revision");
});

test("@ always starts its member, small recipient lists stay explicit and empty lists remain notes", async t => {
  const f = fixture(t, { auto: true }), channelId = f.create();
  send(f, channelId, "@Designer analyze orbital spectroscopy", f.members); await f.rooms.wait(channelId);
  assert.deepEqual(f.calls.map(call => call.agentId), [f.members[1]]);
  assert.deepEqual(f.rooms.snapshot(channelId).turns[0].replies.map(reply => reply.state), ["passed", "failed", "passed"]);
  send(f, channelId, "analyze orbital spectroscopy", [f.members[0], f.members[2]]); await f.rooms.wait(channelId);
  assert.deepEqual(f.calls.slice(1).map(call => call.agentId), [f.members[0], f.members[2]]);
  send(f, channelId, "@Engineer this is a note", []); await f.rooms.wait(channelId);
  assert.equal(f.calls.length, 3); assert.equal(f.rooms.snapshot(channelId).turns.at(-1).replies.length, 0);
  const oldHost = fixture(t, { auto: true, profiles: false }), oldChannel = oldHost.create();
  send(oldHost, oldChannel, "analyze orbital spectroscopy", oldHost.members); await oldHost.rooms.wait(oldChannel);
  assert.equal(oldHost.calls.length, 3, "a legacy host without routing evidence keeps all explicit recipients");
});

test("peer wake reactivates PASS on the frozen current turn and excludes future queued context", async t => {
  const f = fixture(t), channelId = f.create(), firstId = randomUUID(), futureId = randomUUID();
  send(f, channelId, "@Engineer analyze orbital spectroscopy", f.members, "original-client", firstId);
  assert.equal(f.calls.length, 1); const first = f.calls[0];
  send(f, channelId, "FUTURE_BUFFER_ONLY", [f.members[1]], "future-client", futureId);
  const result = f.rooms.peerWake(channelId, first.runId, f.members[2], f.members[0], "need a finance check");
  assert.equal(result.ok, true); assert.equal(result.alreadyQueued, false);
  const live = f.rooms.snapshot(channelId);
  const woken = live.turns.find(turn => turn.id === firstId).replies.find(reply => reply.agentId === f.members[0]);
  assert.equal(woken.state, "queued"); assert.equal(woken.wokenBy, f.members[2]); assert.equal(woken.passedBy, undefined);
  assert.equal(live.turns.find(turn => turn.id === futureId).replies.length, 1, "wake never edits the future queue");
  assert.ok(!userBodies(JSON.parse(f.rooms.sync(channelId))).includes("FUTURE_BUFFER_ONLY"));
  f.finish(first.runId); await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].agentId, f.members[0]); assert.equal(f.calls[1].clientId, "original-client");
  assert.equal(f.calls[1].context.wokenBy.agentId, f.members[2]);
  assert.ok(!userBodies(f.calls[1].context).includes("FUTURE_BUFFER_ONLY"));
  assert.equal(f.rooms.peerWake(channelId, f.calls[1].runId, f.members[0], f.members[2]).ok, false, "no re-entry");
  f.finish(f.calls[1].runId); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].body, "FUTURE_BUFFER_ONLY"); assert.equal(f.calls[2].clientId, "future-client");
  f.finish(f.calls[2].runId); await f.rooms.wait(channelId); assert.equal(f.maximum.get(channelId), 1);
});

test("busy sends drain FIFO with original clients, a cap of five and digest idempotency before capacity", async t => {
  const f = fixture(t), channelId = f.create(), requests = Array.from({ length: LOCAL_CHANNEL_QUEUE_LIMIT }, () => randomUUID());
  send(f, channelId, "first", [f.members[0]], "first-client");
  for (let index = 0; index < requests.length; index++) {
    const result = send(f, channelId, "queued-" + index, [f.members[0]], "client-" + index, requests[index]);
    assert.equal(result.queued, true); assert.equal(result.position, index + 1);
  }
  const before = f.rooms.snapshot(channelId); assert.equal(before.pendingCount, 5); assert.equal(before.queueNeedsResume, false);
  const duplicate = send(f, channelId, "queued-4", [f.members[0]], "retry-client", requests[4]);
  assert.equal(duplicate.position, 5); assert.equal(f.rooms.snapshot(channelId).revision, before.revision);
  assert.throws(() => send(f, channelId, "changed", [f.members[0]], "client", requests[4]), /identity already used/);
  assert.throws(() => send(f, channelId, "overflow"), /queue is full/);
  assert.deepEqual(userBodies(JSON.parse(f.rooms.sync(channelId))), ["first"]);
  for (let index = 0; index < 6; index++) {
    f.finish(f.calls[index].runId);
    if (index < 5) await until(() => f.calls.length === index + 2);
  }
  await f.rooms.wait(channelId);
  assert.deepEqual(f.calls.map(call => call.body), ["first", "queued-0", "queued-1", "queued-2", "queued-3", "queued-4"]);
  assert.deepEqual(f.calls.map(call => call.clientId), ["first-client", "client-0", "client-1", "client-2", "client-3", "client-4"]);
  assert.equal(f.maximum.get(channelId), 1); assert.equal(f.rooms.snapshot(channelId).pendingCount, 0);
  assert.equal(f.rooms.receipt(channelId, requests[4]).queued, false);
});

test("cancel preserves and holds the queue; explicit resume reauthorizes; clear only cancels unstarted turns", async t => {
  const f = fixture(t), channelId = f.create();
  send(f, channelId, "cancel current", [f.members[0], f.members[1]], "old-client");
  send(f, channelId, "kept one", [f.members[0]], "old-client");
  send(f, channelId, "kept two", [f.members[1]], "old-client");
  f.rooms.cancel(channelId); await f.rooms.wait(channelId);
  let snapshot = f.rooms.snapshot(channelId);
  assert.equal(snapshot.turns[0].state, "cancelled"); assert.equal(snapshot.turns[0].replies[1].started, false);
  assert.equal(snapshot.pendingCount, 2); assert.equal(snapshot.queueNeedsResume, true); assert.equal(f.calls.length, 1);
  assert.equal(send(f, channelId, "kept three", [f.members[2]]).position, 3); assert.equal(f.calls.length, 1, "a new send does not silently resume a held queue");
  assert.equal(f.rooms.resumeQueue("reconnected-client", channelId).resumed, true);
  assert.equal(f.calls[1].body, "kept one"); assert.equal(f.calls[1].clientId, "reconnected-client");
  assert.equal(f.rooms.clearQueue(channelId).cleared, 2); assert.equal(f.cancelled.length, 1, "clear never cancels the active run");
  const originalRead = WorkspaceConversationStore.prototype.read; let unstartedReads = 0;
  WorkspaceConversationStore.prototype.read = function () {
    if (this.agentId !== f.members[0]) { unstartedReads++; throw new Error("cleared queue must not read unstarted conversations"); }
    return originalRead.call(this);
  };
  try { snapshot = f.rooms.snapshot(channelId); } finally { WorkspaceConversationStore.prototype.read = originalRead; }
  assert.equal(unstartedReads, 0);
  const stateDir = f.storage.run(() => join(workspaceStateHome(), ".hara"));
  for (const agentId of f.members.slice(1)) assert.equal(fs.existsSync(join(stateDir, "conversation-" + channelSessionId(channelId, agentId) + ".json")), false);
  assert.equal(snapshot.turns[1].state, "running"); assert.equal(snapshot.pendingCount, 0);
  assert.ok(snapshot.turns.slice(2).every(turn => turn.state === "cancelled" && turn.replies.every(reply => !reply.started)));
  f.finish(f.calls[1].runId); await f.rooms.wait(channelId); assert.equal(f.calls.length, 2);
  assert.equal(f.rooms.resumeQueue("client", channelId).resumed, false);
});

test("close/reopen never auto-runs queued work and old running records recover without rewriting queued records", async t => {
  const f = fixture(t), channelId = f.create();
  send(f, channelId, "interrupted old turn"); send(f, channelId, "restart queued one"); send(f, channelId, "restart queued two");
  await f.rooms.close();
  const state = f.history(channelId), value = state.read();
  state.update(value.revision, next => {
    next.turns[0].state = "running"; next.turns[0].replies[0].state = "running"; next.turns[0].replies[0].endIndex = null; next.turns[0].replies[0].runId = null; return next;
  });
  f.reopen();
  let snapshot = f.rooms.snapshot(channelId);
  assert.equal(f.calls.length, 1); assert.equal(snapshot.queueNeedsResume, true); assert.equal(snapshot.pendingCount, 2);
  assert.equal(snapshot.turns[0].state, "interrupted"); assert.equal(snapshot.turns[0].replies[0].started, true);
  assert.ok(snapshot.turns.slice(1).every(turn => turn.state === "queued" && turn.replies[0].state === "queued"));
  send(f, channelId, "restart queued three", [f.members[0]], "new-send-client"); assert.equal(f.calls.length, 1);
  f.rooms.resumeQueue("explicit-resume-client", channelId);
  assert.equal(state.read().turns[0].state, "interrupted"); assert.equal(f.calls[1].body, "restart queued one");
  for (let index = 1; index <= 3; index++) {
    assert.equal(f.calls[index].clientId, "explicit-resume-client", "restart never reuses stale queued socket identity");
    f.finish(f.calls[index].runId); if (index < 3) await until(() => f.calls.length === index + 2);
  }
  await f.rooms.wait(channelId); snapshot = f.rooms.snapshot(channelId);
  assert.equal(snapshot.pendingCount, 0); assert.equal(f.calls.filter(call => call.body === "interrupted old turn").length, 1);
});

test("room leases fence other instances while rooms and Workspaces keep independent queues and context", async t => {
  const f = fixture(t), channelId = f.create();
  send(f, channelId, "workspace one current"); send(f, channelId, "workspace one future");
  const owning = f.rooms; f.reopen(); const contender = f.rooms;
  assert.throws(() => send(f, channelId, "contender write"), /busy|owner death/);
  assert.throws(() => contender.clearQueue(channelId), /busy|owner death/);
  assert.throws(() => contender.resumeQueue("contender", channelId), /busy|owner death/);
  const otherRoom = f.create(); send(f, otherRoom, "other room current");
  const otherWorkspace = f.otherWorkspace(); otherWorkspace.create(channelId);
  send(otherWorkspace, channelId, "workspace two same room identity");
  assert.equal(otherWorkspace.calls.length, 1, "the same room identity in another Workspace has its own lease");
  assert.deepEqual(userBodies(JSON.parse(otherWorkspace.rooms.sync(channelId))), ["workspace two same room identity"]);
  assert.deepEqual(userBodies(JSON.parse(contender.sync(otherRoom))), ["other room current"]);
  f.rooms = owning;
  f.finish(f.calls[0].runId); await until(() => f.calls.length === 3);
  assert.equal(f.calls[2].body, "workspace one future");
  f.finish(f.calls[2].runId); await owning.wait(channelId);
  f.finish(f.calls[1].runId); await contender.wait(otherRoom);
  otherWorkspace.finish(); await otherWorkspace.rooms.wait(channelId);
  assert.equal(f.maximum.get(channelId), 1); assert.equal(f.maximum.get(otherRoom), 1);
});

test("dispatch rechecks colleague activity and host acceptance before starting later work", async t => {
  const f = fixture(t), channelId = f.create();
  send(f, channelId, "current two recipients", [f.members[0], f.members[1]]);
  send(f, channelId, "valid queued one", [f.members[2]]); send(f, channelId, "held by shutdown", [f.members[2]]);
  f.roster[1].state = "archived"; f.finish(f.calls[0].runId);
  await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].agentId, f.members[2], "archived colleague was not started");
  f.accepting = false; f.finish(f.calls[1].runId); await f.rooms.wait(channelId);
  const snapshot = f.rooms.snapshot(channelId);
  assert.equal(f.calls.length, 2); assert.equal(snapshot.pendingCount, 1); assert.equal(snapshot.queueNeedsResume, true);
  assert.throws(() => f.rooms.resumeQueue("client", channelId), /not accepting/);
});

test("an accepted start with a lost response stops the pump and never replays that request", async t => {
  const f = fixture(t), channelId = f.create();
  send(f, channelId, "first known"); send(f, channelId, "accepted but response lost"); send(f, channelId, "held after uncertainty");
  f.failStartOn = 2; f.finish(f.calls[0].runId); await f.rooms.wait(channelId);
  const snapshot = f.rooms.snapshot(channelId);
  assert.equal(f.calls.length, 2); assert.equal(f.cancelled.length, 1); assert.equal(f.cancelled[0], f.calls[1].runId);
  assert.equal(snapshot.pendingCount, 1); assert.equal(snapshot.queueNeedsResume, true);
  f.rooms.resumeQueue("fresh-client", channelId); assert.equal(f.calls[2].body, "held after uncertainty");
  assert.equal(f.calls[2].clientId, "fresh-client"); f.finish(f.calls[2].runId); await f.rooms.wait(channelId);
  assert.equal(f.calls.filter(call => call.body === "accepted but response lost").length, 1); assert.equal(f.maximum.get(channelId), 1);
});
