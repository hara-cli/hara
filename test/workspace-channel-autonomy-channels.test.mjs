import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceJsonState } from "../dist/workspace/local-state.js";
import { WorkspaceLocalChannels } from "../dist/workspace/local-channels.js";

// Policy/channel integration only: no provider, real runtime, credential access or production HOME.
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-channel-autonomy-")));
  const catalog = new LocalWorkspaceCatalog(root), engines = [], members = Array.from({ length: 2 }, () => "ag_" + randomUUID());
  function newWorkspace() {
    const row = catalog.create("Policy fixture", catalog.read().revision), storage = new WorkspaceResourceStorage(root, row.scope);
    storage.initialize();
    const calls = [], runs = new Map(), roster = members.map((agentId, index) => ({
      agentId, kind: "colleague", state: "active", identity: { displayName: index ? "ColleagueB" : "ColleagueA" },
    }));
    const f = { storage, members, calls };
    const host = {
      agents: () => roster, accepting: () => true, changed() {},
      start(agentId, body, requestId, channelId, context, clientId, questionId) {
        const runId = randomUUID(), store = new WorkspaceConversationStore(storage, agentId, channelId), value = store.read();
        value.history.push({ role: "user", content: body });
        value.requests.push({ requestId, digest: createHash("sha256").update(body).digest("hex"), taskId: randomUUID(), runId });
        store.save(value.revision, value);
        let resolve; const promise = new Promise(done => { resolve = done; });
        runs.set(runId, { promise, resolve }); calls.push({ agentId, body, requestId, runId, channelId, clientId, questionId, context: JSON.parse(context) });
        return { runId };
      },
      wait: runId => runs.get(runId).promise,
      cancel: (_agentId, runId) => runs.get(runId).resolve(),
    };
    f.finish = (runId = calls.at(-1).runId) => runs.get(runId).resolve();
    f.reopen = () => { f.rooms = new WorkspaceLocalChannels(storage, host); engines.push(f.rooms); return f.rooms; };
    f.reopen();
    f.create = (channelId = randomUUID()) => { f.rooms.create(channelId, "Planning", members, f.rooms.list().revision); return channelId; };
    f.state = filename => new WorkspaceJsonState(storage, filename, value => value, () => { throw new Error("missing fixture state"); });
    f.history = channelId => f.state("local-channel-" + channelId + ".json");
    f.update = (channelId, autonomy, name = "Planning", memberIds = members) =>
      f.rooms.update(channelId, name, memberIds, f.rooms.list().revision, autonomy);
    f.send = (channelId, body, recipients = [members[0]], requestId = randomUUID(), questionId) =>
      f.rooms.send("client", channelId, body, requestId, recipients, questionId);
    return f;
  }
  const f = newWorkspace(); f.otherWorkspace = newWorkspace;
  t.after(async () => { await Promise.all(engines.map(engine => engine.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
async function until(read) {
  for (let count = 0; count < 120; count++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("bounded policy scheduler wait");
}
const policy = (mode = "mention", mutedAgentIds = [], pausedUntil) => ({
  schemaVersion: 1, mode, mutedAgentIds, cooldownMs: 600000, ...(pausedUntil ? { pausedUntil } : {}),
});
const ambientDisabled = error => error?.reason === "ambient_disabled";

test("new and legacy channels project mention by default and metadata remains scoped to its room and Workspace", async t => {
  const f = fixture(t), channelId = f.create(), otherRoom = f.create(), another = f.otherWorkspace();
  another.create(channelId);
  assert.deepEqual(f.rooms.get(channelId).autonomy, policy());
  const catalog = f.state("local-channels.json"), value = catalog.read();
  catalog.update(value.revision, next => { delete next.channels.find(channel => channel.id === channelId).autonomy; return next; });
  assert.deepEqual(f.rooms.get(channelId).autonomy, policy(), "old catalog rows need no on-disk rewrite to get the default");
  assert.equal(catalog.read().channels.find(channel => channel.id === channelId).autonomy, undefined);
  f.update(channelId, policy("off", [f.members[0]]));
  assert.deepEqual(f.rooms.snapshot(channelId).channel.autonomy, policy("off", [f.members[0]]));
  assert.deepEqual(f.rooms.get(otherRoom).autonomy, policy()); assert.deepEqual(another.rooms.get(channelId).autonomy, policy());
  f.update(channelId, undefined, "Renamed", [f.members[1]]);
  assert.deepEqual(f.rooms.get(channelId).autonomy, policy("off"), "removed members are pruned from the retained mute list");
});

test("busy autonomy-only updates use the owned lease while name/member changes and other instances stay fenced", async t => {
  const f = fixture(t), channelId = f.create(); f.send(channelId, "currently replying");
  const current = f.rooms, revision = current.list().revision, pausedUntil = new Date(Date.now() + 60_000).toISOString();
  const updated = f.update(channelId, policy("off", [f.members[1]], pausedUntil));
  assert.equal(updated.revision, revision + 1); assert.equal(current.running(), 1);
  assert.deepEqual(current.get(channelId).autonomy, policy("off", [f.members[1]], pausedUntil));
  assert.throws(() => f.update(channelId, policy(), "Renamed"), /busy/);
  assert.throws(() => f.update(channelId, policy(), "Planning", [f.members[0]]), /busy/);
  assert.throws(() => f.update(channelId, undefined), /busy/);
  assert.throws(() => current.update(channelId, "Planning", f.members, revision, policy()), /state changed/);
  f.reopen();
  assert.throws(() => f.update(channelId, policy("off")), /busy|owner death/);
  assert.equal(f.calls.length, 1); f.finish(); await current.wait(channelId);
});

test("off, pause and mute never block explicit recipients, @ or same-turn peer wake and do not create ambient replies", async t => {
  const f = fixture(t), channelId = f.create(), pausedUntil = new Date(Date.now() + 60_000).toISOString();
  f.update(channelId, policy("off", f.members, pausedUntil));
  const firstId = randomUUID(); f.send(channelId, "explicit request", [f.members[0]], firstId);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].agentId, f.members[0]);
  assert.equal(f.rooms.peerWake(channelId, f.calls[0].runId, f.members[0], f.members[1]).ok, true);
  f.finish(f.calls[0].runId); await until(() => f.calls.length === 2); assert.equal(f.calls[1].agentId, f.members[1]);
  f.finish(f.calls[1].runId); await f.rooms.wait(channelId);
  let turn = f.rooms.snapshot(channelId).turns[0];
  assert.equal(turn.origin, "user"); assert.equal(turn.rootTurnId, firstId); assert.deepEqual(turn.replies.map(reply => reply.depth), [0, 0]);
  const persisted = f.history(channelId).read().turns[0];
  assert.equal(persisted.origin, "user"); assert.equal(persisted.rootTurnId, firstId); assert.ok(persisted.replies.every(reply => reply.depth === 0));
  f.send(channelId, "@ColleagueB explicit mention", [f.members[0]]);
  assert.equal(f.calls.length, 3); f.finish(f.calls[2].runId); await until(() => f.calls.length === 4);
  assert.equal(f.calls[3].agentId, f.members[1]); f.finish(f.calls[3].runId); await f.rooms.wait(channelId);
  f.send(channelId, "@ColleagueB note only", []); await f.rooms.wait(channelId);
  assert.equal(f.calls.length, 4, "metadata alone never activates an ambient router, even for mentions in notes");
  turn = f.rooms.snapshot(channelId).turns.at(-1); assert.equal(turn.origin, "user"); assert.equal(turn.replies.length, 0);
});

test("legacy user turns and depth-less replies still resume as user/self/depth zero", async t => {
  const f = fixture(t), channelId = f.create();
  f.send(channelId, "old current"); const queued = f.send(channelId, "old queued");
  f.rooms.cancel(channelId); await f.rooms.wait(channelId);
  const history = f.history(channelId), before = history.read();
  history.update(before.revision, next => {
    for (const turn of next.turns) { delete turn.origin; delete turn.rootTurnId; for (const reply of turn.replies) delete reply.depth; }
    return next;
  });
  const view = f.rooms.snapshot(channelId).turns;
  assert.ok(view.every(turn => turn.origin === "user" && turn.rootTurnId === turn.id && turn.replies.every(reply => reply.depth === 0)));
  f.rooms.resumeQueue("new-client", channelId); assert.equal(f.calls[1].body, "old queued"); assert.equal(f.calls[1].clientId, "new-client");
  f.finish(f.calls[1].runId); await f.rooms.wait(channelId);
  assert.equal(f.rooms.receipt(channelId, queued.requestId).queued, false);
});

test("read-compatible historical ambient settings cannot enable ambient through update or ordinary sends", async t => {
  const f = fixture(t), channelId = f.create(), catalog = f.state("local-channels.json"), value = catalog.read();
  catalog.update(value.revision, next => { next.channels[0].autonomy = policy("ambient"); return next; });
  assert.equal(f.rooms.get(channelId).autonomy.mode, "ambient");
  const before = f.rooms.list().revision;
  assert.throws(() => f.update(channelId, policy("ambient")), ambientDisabled);
  assert.equal(f.rooms.list().revision, before);
  f.send(channelId, "undirected message", []); await f.rooms.wait(channelId); assert.equal(f.calls.length, 0);
  f.send(channelId, "explicit request"); assert.equal(f.calls.length, 1); f.finish(); await f.rooms.wait(channelId);
  assert.equal(f.rooms.snapshot(channelId).turns.at(-1).origin, "user");
});

test("persisted autonomy/depth-one queued turns are readable but hard-rejected before any ordinary host start", async t => {
  for (const origin of ["autonomy", "user"]) {
    const f = fixture(t), channelId = f.create();
    f.send(channelId, "current"); f.send(channelId, "forged queued");
    f.rooms.cancel(channelId); await f.rooms.wait(channelId);
    const history = f.history(channelId), before = history.read();
    history.update(before.revision, next => {
      const queued = next.turns[1]; queued.origin = origin; queued.rootTurnId = origin === "autonomy" ? next.turns[0].id : queued.id;
      queued.replies[0].depth = 1; return next;
    });
    f.reopen(); const view = f.rooms.snapshot(channelId);
    assert.equal(view.turns[1].origin, origin); assert.equal(view.turns[1].replies[0].depth, 1); assert.equal(view.queueNeedsResume, true);
    const beforeResume = history.read().revision;
    assert.throws(() => f.rooms.resumeQueue("resumer", channelId), ambientDisabled);
    assert.equal(f.calls.length, 1); assert.equal(history.read().revision, beforeResume, "rejected lineage stays held and is not rewritten as a user turn");
    assert.equal(f.rooms.snapshot(channelId).pendingCount, 1);
    assert.equal(f.rooms.clearQueue(channelId).cleared, 1);
  }
});

test("question answers refuse busy and held queues while an already accepted nonce stays idempotent", async t => {
  const f = fixture(t), channelId = f.create(), questionId = randomUUID(), answerId = randomUUID();
  f.send(channelId, "current"); f.send(channelId, "ordinary queued");
  let before = f.rooms.snapshot(channelId);
  assert.throws(() => f.send(channelId, "answer", [f.members[0]], answerId, questionId), /question answers cannot be queued/);
  assert.equal(f.rooms.receipt(channelId, answerId).state, "unknown"); assert.equal(f.rooms.snapshot(channelId).revision, before.revision);
  f.rooms.cancel(channelId); await f.rooms.wait(channelId); before = f.rooms.snapshot(channelId);
  assert.throws(() => f.send(channelId, "answer", [f.members[0]], answerId, questionId), /question answers cannot be queued/);
  assert.equal(f.rooms.snapshot(channelId).revision, before.revision); assert.equal(f.rooms.receipt(channelId, answerId).state, "unknown");
  f.rooms.clearQueue(channelId);
  assert.equal(f.send(channelId, "answer", [f.members[0]], answerId, questionId).accepted, true);
  before = f.rooms.snapshot(channelId);
  assert.equal(f.send(channelId, "answer", [f.members[0]], answerId, questionId).accepted, true, "duplicate precedes the busy guard");
  assert.equal(f.rooms.snapshot(channelId).revision, before.revision); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].questionId, questionId);
  f.finish(f.calls[1].runId); await f.rooms.wait(channelId);
});
