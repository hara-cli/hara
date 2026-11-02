import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { channelSessionId } from "../dist/workspace/channel-session.js";
import { CHANNEL_AUTONOMY_BUDGET, ChannelAutonomyGuard, ChannelAutonomyError,
  readChannelAutonomy, parseChannelAutonomyUpdate, assertChannelAutonomyProductionDispatch } from "../dist/workspace/channel-autonomy.js";

// These fixtures acquire real isolated resource/room leases, but create no LocalWorkspaceHost,
// provider, model, native runtime, conversation, execution permit or fake runtime-stage identity.
const at = Date.parse("2026-11-03T00:00:00.000Z");
const fails = reason => error => error instanceof ChannelAutonomyError && error.reason === reason;
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-channel-autonomy-")));
  const catalog = new LocalWorkspaceCatalog(root), row = catalog.create("Autonomy guard fixture", catalog.read().revision);
  const f = { root, channelId: randomUUID(), roster: Array.from({ length: 6 }, () => "ag_" + randomUUID()), now: at, revoked: false };
  f.storage = new WorkspaceResourceStorage(root, row.scope, () => { if (f.revoked) throw new Error("fixture resource revoked"); });
  f.storage.initialize();
  f.policy = { schemaVersion: 1, mode: "ambient", mutedAgentIds: [], cooldownMs: 600000 };
  const leases = [];
  f.open = () => {
    f.lease = WorkspaceSessionLease.acquire(f.storage, channelSessionId(f.channelId, "room-queue")); leases.push(f.lease);
    f.guard = new ChannelAutonomyGuard(f.storage, f.channelId,
      { policy: () => f.policy, members: () => f.roster, lease: f.lease, now: () => f.now });
    return f.guard;
  };
  f.ledgerPath = f.storage.run(() => join(workspaceStateHome(), ".hara", `local-channel-autonomy-${f.channelId}.json`));
  f.open();
  t.after(() => { f.revoked = false; for (const lease of leases) lease.release(); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
function admit(f, agentIndex = 0) {
  const turnId = randomUUID(), source = f.guard.acceptUserTurn(turnId), result = f.guard.admitSynthetic(source, f.roster[agentIndex]);
  assert.equal(result.accepted, true); return { turnId, source, admission: result.admission };
}

test("policy defaults to mention, retains inert historical ambient and enforces public settings", () => {
  const ids = ["ag_" + randomUUID()], base = { schemaVersion: 1, mode: "mention" };
  assert.deepEqual(readChannelAutonomy(undefined, ids), { ...base, mutedAgentIds: [], cooldownMs: 600000 });
  assert.equal(readChannelAutonomy({ ...base, mode: "ambient" }, ids).mode, "ambient");
  const input = { ...base, mutedAgentIds: [...ids] }, parsed = parseChannelAutonomyUpdate(input, ids, at);
  input.mutedAgentIds.length = 0; assert.deepEqual(parsed.mutedAgentIds, ids, "callers cannot mutate an accepted policy by alias");
  assert.equal(parseChannelAutonomyUpdate({ ...base, pausedUntil: new Date(at + 1800000).toISOString() }, ids, at).pausedUntil,
    new Date(at + 1800000).toISOString());
  assert.throws(() => parseChannelAutonomyUpdate({ ...base, mode: "ambient" }, ids, at), fails("ambient_disabled"));
  for (const bad of [undefined, null, { ...base, cooldownMs: 0 }, { ...base, cooldownMs: 599999 },
    { ...base, lastAutonomousAt: {} }, { ...base, depth: 0 }, { ...base, budget: { maxTokens: 999999 } },
    { ...base, mutedAgentIds: ["ag_" + randomUUID()] }, { ...base, mutedAgentIds: [...ids, ...ids] },
    { ...base, pausedUntil: "2026-02-30T00:00:00.000Z" },
    { ...base, pausedUntil: new Date(at + 1800001).toISOString() }]) {
    assert.throws(() => parseChannelAutonomyUpdate(bad, ids, at), fails("invalid_channel_autonomy"));
  }
  assert.throws(() => readChannelAutonomy({ ...base, mode: { toString: () => "mention" } }, ids), fails("invalid_channel_autonomy"));
});

test("production dispatch is unconditionally closed even for a forged enabling argument", () => {
  assert.throws(() => assertChannelAutonomyProductionDispatch(), fails("ambient_disabled"));
  assert.throws(() => assertChannelAutonomyProductionDispatch({ enabled: true, mode: "ambient", origin: "user", depth: 0,
    rootTurnId: randomUUID(), budget: CHANNEL_AUTONOMY_BUDGET }), fails("ambient_disabled"));
});

test("only this guard's live opaque witnesses authorize synthetic admission", t => {
  const f = fixture(t), one = admit(f), description = f.guard.describe(one.admission);
  assert.deepEqual(description, { origin: "autonomy", rootTurnId: one.turnId, depth: 1, budget: { maxRounds: 3, maxToolCalls: 32, maxTokens: 16000, timeoutMs: 60000 } });
  assert.ok(Object.isFrozen(description)); assert.ok(Object.isFrozen(description.budget));
  assert.ok(!["runId", "attemptId", "sessionId"].some(key => key in description));
  for (const source of [{}, structuredClone(one.source), JSON.parse(JSON.stringify(one.source)), description,
    { origin: "user", rootTurnId: one.turnId, depth: 0 }]) {
    assert.equal(f.guard.admitSynthetic(source, f.roster[1]).reason, "untrusted_source");
  }
  const other = new ChannelAutonomyGuard(f.storage, f.channelId,
    { policy: () => f.policy, members: () => f.roster, lease: f.lease, now: () => f.now });
  assert.equal(other.admitSynthetic(one.source, f.roster[1]).reason, "untrusted_source");
  assert.throws(() => other.beforeModel(one.admission), fails("untrusted_admission"));
  assert.throws(() => f.guard.beforeModel(description), fails("untrusted_admission"));
});

test("one colleague speech and one autonomous hop share the user root; depth one never propagates", t => {
  const f = fixture(t), root = randomUUID(), source = f.guard.acceptUserTurn(root, [f.roster[0]]);
  assert.equal(f.guard.admitSynthetic(source, f.roster[0]).reason, "already_spoken", "ordinary user-directed speech also occupies its colleague slot");
  const result = f.guard.admitSynthetic(source, f.roster[1]); assert.equal(result.accepted, true);
  assert.equal(f.guard.admitSynthetic(source, f.roster[1]).reason, "already_spoken");
  assert.equal(f.guard.admitSynthetic(source, f.roster[2]).reason, "hop_limit");
  assert.equal(f.guard.admitSynthetic(f.guard.autonomousSource(result.admission), f.roster[2]).reason, "depth_limit");
});

test("cooldown survives completion, settings changes and reopening without replaying a user root", t => {
  const f = fixture(t), one = admit(f);
  f.guard.acceptBrief(one.admission, "answer"); f.guard.complete(one.admission);
  f.lease.release(); f.open();
  assert.throws(() => f.guard.acceptUserTurn(one.turnId), fails("root_turn_replayed"));
  assert.equal(f.guard.admitSynthetic(one.source, f.roster[0]).reason, "untrusted_source");
  const next = f.guard.acceptUserTurn(randomUUID());
  f.policy = { ...f.policy, mode: "off" }; assert.equal(f.guard.admitSynthetic(next, f.roster[0]).reason, "mode_off");
  f.policy = { ...f.policy, mode: "mention" }; assert.equal(f.guard.admitSynthetic(next, f.roster[0]).reason, "mention_only");
  f.policy = { ...f.policy, mode: "ambient" }; f.now += 599999;
  assert.equal(f.guard.admitSynthetic(next, f.roster[0]).reason, "cooldown");
  f.now++; assert.equal(f.guard.admitSynthetic(next, f.roster[0]).accepted, true, "the ten-minute boundary is inclusive");
});

test("unknown or failed work is never refunded and three starts occupy a sliding minute", t => {
  const f = fixture(t), first = admit(f, 0);
  f.guard.beforeModel(first.admission);
  assert.throws(() => f.guard.recordUsage(first.admission, undefined, 10), fails("unknown_usage"));
  const repeated = f.guard.acceptUserTurn(randomUUID());
  assert.equal(f.guard.admitSynthetic(repeated, f.roster[0]).reason, "cooldown");
  admit(f, 1); admit(f, 2);
  const fourth = f.guard.acceptUserTurn(randomUUID());
  assert.equal(f.guard.admitSynthetic(fourth, f.roster[3]).reason, "channel_rate");
  f.now += 59999; assert.equal(f.guard.admitSynthetic(fourth, f.roster[3]).reason, "channel_rate");
  f.now++; assert.equal(f.guard.admitSynthetic(fourth, f.roster[3]).accepted, true);
});

test("synthetic work requires an answer brief and rejects writes, propagation and unknown tools", t => {
  const f = fixture(t), one = admit(f);
  assert.throws(() => f.guard.complete(one.admission), fails("brief_required"));
  assert.throws(() => f.guard.beforeTool(one.admission, "workspace_read"), fails("brief_required"));
  f.guard.beforeTool(one.admission, "task_intake"); f.guard.acceptBrief(one.admission, "answer");
  f.guard.beforeTool(one.admission, "workspace_read");
  for (const name of ["workspace_write", "channel_peer_wake", "agent_contact", "agent_create", "agent_rename", "ask_user", "bash", "fake_read"])
    assert.throws(() => f.guard.beforeTool(one.admission, name), fails("tool_forbidden"));
  assert.throws(() => f.guard.acceptBrief(one.admission, "change"), fails("answer_only"));
  assert.throws(() => f.guard.beforeTool(one.admission, "workspace_read"), fails("admission_closed"));
  const two = admit(f, 1);
  assert.throws(() => f.guard.acceptBrief(two.admission, "investigate"), fails("answer_only"));
});

test("synthetic accounting stops at three model rounds, sixteen thousand tokens and known usage", t => {
  const f = fixture(t), one = admit(f); f.guard.acceptBrief(one.admission, "answer");
  for (let round = 0; round < 3; round++) { f.guard.beforeModel(one.admission); f.guard.recordUsage(one.admission, 100, 10); }
  assert.throws(() => f.guard.beforeModel(one.admission), fails("round_budget"));
  const two = admit(f, 1); f.guard.acceptBrief(two.admission, "answer");
  f.guard.beforeModel(two.admission); f.guard.recordUsage(two.admission, 15999, 1);
  assert.throws(() => f.guard.beforeModel(two.admission), fails("token_budget"));
  assert.throws(() => f.guard.beforeTool(two.admission, "workspace_read"), fails("token_budget"));
  const three = admit(f, 2); f.guard.acceptBrief(three.admission, "answer"); f.guard.beforeModel(three.admission);
  assert.throws(() => f.guard.recordUsage(three.admission, 16000, 1), fails("token_budget"));
  assert.throws(() => f.guard.complete(three.admission), fails("admission_closed"));
});

test("synthetic model accounting cannot overlap, repeat telemetry or exceed the tool-call ceiling", t => {
  const f = fixture(t), one = admit(f); f.guard.acceptBrief(one.admission, "answer");
  f.guard.beforeModel(one.admission);
  assert.throws(() => f.guard.beforeModel(one.admission), fails("model_pending"));
  assert.throws(() => f.guard.beforeTool(one.admission, "workspace_read"), fails("model_pending"));
  f.guard.recordUsage(one.admission, 100, 10);
  assert.throws(() => f.guard.recordUsage(one.admission, 100, 10), fails("no_model_pending"));
  for (let call = 0; call < 32; call++) f.guard.beforeTool(one.admission, "workspace_read");
  assert.throws(() => f.guard.beforeTool(one.admission, "workspace_read"), fails("tool_budget"));
});

test("the sixty-second deadline is exact and a clock rollback seals an admission", t => {
  const f = fixture(t), one = admit(f); f.guard.acceptBrief(one.admission, "answer");
  f.now += 59999; f.guard.beforeTool(one.admission, "workspace_read");
  f.now++; assert.throws(() => f.guard.beforeTool(one.admission, "workspace_read"), fails("deadline"));
  const two = admit(f, 1); f.guard.acceptBrief(two.admission, "answer");
  f.now += 50000; f.guard.beforeTool(two.admission, "workspace_read");
  f.now -= 1000; assert.throws(() => f.guard.beforeTool(two.admission, "workspace_read"), fails("clock_regressed"));
  f.now += 1000; assert.throws(() => f.guard.complete(two.admission), fails("admission_closed"));
});

test("mute, pause and membership are rechecked before every synthetic action", t => {
  const f = fixture(t), source = f.guard.acceptUserTurn(randomUUID());
  f.policy = { ...f.policy, mutedAgentIds: [f.roster[0]] };
  assert.equal(f.guard.admitSynthetic(source, f.roster[0]).reason, "muted");
  f.policy = { ...f.policy, mutedAgentIds: [], pausedUntil: new Date(f.now + 1000).toISOString() };
  assert.equal(f.guard.admitSynthetic(source, f.roster[0]).reason, "paused");
  f.now += 1000; const result = f.guard.admitSynthetic(source, f.roster[0]); assert.equal(result.accepted, true);
  f.guard.acceptBrief(result.admission, "answer"); f.policy = { ...f.policy, mutedAgentIds: [f.roster[0]] };
  assert.throws(() => f.guard.beforeModel(result.admission), fails("muted"));
  f.policy = { ...f.policy, mutedAgentIds: [] };
  assert.throws(() => f.guard.beforeModel(result.admission), fails("admission_closed"));
  const other = admit(f, 1); f.guard.acceptBrief(other.admission, "answer"); f.roster = f.roster.filter((_, index) => index !== 1);
  assert.throws(() => f.guard.beforeTool(other.admission, "workspace_read"), fails("not_member"));
});

test("valid-looking disk rollback cannot clear a live owner's reservations", t => {
  const f = fixture(t), one = admit(f), data = JSON.parse(fs.readFileSync(f.ledgerPath, "utf8"));
  data.roots[0].hops = 0; data.roots[0].spokenAgentIds = []; data.lastAutonomousAt = {}; data.starts = [];
  fs.writeFileSync(f.ledgerPath, JSON.stringify(data) + "\n", { mode: 0o600 });
  assert.throws(() => f.guard.admitSynthetic(one.source, f.roster[1]), /ledger changed outside its owner/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.ledgerPath, "utf8")), data, "tampered evidence is retained without replacement");
});

test("lease and resource revocation stop synthetic work; a foreign same-room lease is insufficient", t => {
  const f = fixture(t), one = admit(f); f.guard.acceptBrief(one.admission, "answer");
  assert.throws(() => new ChannelAutonomyGuard(f.storage, f.channelId, { policy: () => f.policy, members: () => f.roster,
    lease: { sessionId: f.lease.sessionId, attemptId: f.lease.attemptId, assertCurrent() {} } }), fails("invalid_channel_autonomy"));
  f.revoked = true; assert.throws(() => f.guard.beforeModel(one.admission), /fixture resource revoked/); f.revoked = false;
  const otherRow = new LocalWorkspaceCatalog(f.root).create("Foreign scope", new LocalWorkspaceCatalog(f.root).read().revision);
  const otherStorage = new WorkspaceResourceStorage(f.root, otherRow.scope); otherStorage.initialize();
  const foreign = WorkspaceSessionLease.acquire(otherStorage, channelSessionId(f.channelId, "room-queue"));
  try {
    assert.throws(() => new ChannelAutonomyGuard(f.storage, f.channelId,
      { policy: () => f.policy, members: () => f.roster, lease: foreign, now: () => f.now }), /current room lease/);
  } finally { foreign.release(); }
  f.lease.release(); assert.throws(() => f.guard.beforeTool(one.admission, "workspace_read"), /lease was released/);
});
