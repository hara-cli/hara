import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseChatScheduleTime, MAX_CHAT_SCHEDULES_PER_AGENT } from "../dist/workspace/chat-schedule.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceFeatures } from "../dist/workspace/features.js";
import { WorkspaceScheduler } from "../dist/workspace/scheduler.js";
const roots = [], dir = () => { const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-chat-schedule-"))); roots.push(root); return root; };
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const storage = new WorkspaceResourceStorage(dir(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  return { storage, features: new WorkspaceFeatures(storage, dir(), storage.scope.workspaceId) };
}
function input(f, time, agentId = "colleague-one") { return { title: "Fixture reminder", task: "Report fixture state", agentId, time,
  anchor: { workspaceId: f.storage.scope.workspaceId, conversationId: "conversation-one", messageId: randomUUID(), agentId, runtimeId: "pi", configRevision: 1, agentEpoch: 1,
    connection: { connectionId: `mc_${randomUUID()}`, credentialGeneration: `gen_${randomUUID()}`, connectionRevision: 1, model: "synthetic", reasoning: null } } }; }
test("delay, UTC fire time, every, daily and weekly forms validate time zone and repeat floor", () => {
  const now = Date.parse("2026-11-03T08:00:00.000Z");
  const delay = parseChatScheduleTime({ delay_seconds: 30 }, now, "Asia/Taipei");
  assert.equal(delay.schedule.runAt, now + 30000); assert.equal(delay.tz, "Asia/Taipei"); assert.equal(delay.repeated, false);
  assert.equal(parseChatScheduleTime({ fire_at: "2026-11-04T08:00:00Z", tz: "UTC" }, now).schedule.runAt, now + 86400000);
  assert.equal(parseChatScheduleTime({ repeat: "every:15m" }, now, "UTC").schedule.everyMs, 900000);
  assert.equal(parseChatScheduleTime({ repeat: "daily@09:00", tz: "Asia/Taipei" }, now).schedule.expr, "0 9 * * *");
  assert.equal(parseChatScheduleTime({ repeat: "weekly:mon,fri@09:00" }, now, "UTC").schedule.expr, "0 9 * * 1,5");
  for (const value of [{ repeat: "every:14m" }, { repeat: "daily@24:00" }, { repeat: "weekly:mon,mon@09:00" },
    { fire_at: "2026-11-02T08:00:00Z" }, { fire_at: "2026-11-04T08:00:00+08:00" },
    { delay_seconds: 0 }, { repeat: "daily@09:00", delay_seconds: 5 }, { repeat: "daily@09:00", tz: "Invalid/Zone" }]) {
    assert.throws(() => parseChatScheduleTime(value, now, "UTC"));
  }
});
test("chat schedules share durable Workspace storage, enforce owner and count limits, and survive restart", () => {
  const f = fixture(), time = parseChatScheduleTime({ repeat: "every:15m", tz: "UTC" });
  for (let n = 0; n < MAX_CHAT_SCHEDULES_PER_AGENT; n++) f.features.createChatSchedule(input(f, time));
  assert.throws(() => f.features.createChatSchedule(input(f, time)), /limit/);
  const other = f.features.createChatSchedule(input(f, time, "colleague-two"));
  const restarted = new WorkspaceFeatures(f.storage, dir(), f.storage.scope.workspaceId);
  assert.equal(restarted.schedules().length, MAX_CHAT_SCHEDULES_PER_AGENT + 1);
  assert.equal(restarted.list().schedules.find(row => row.id === other).anchor.agentId, "colleague-two");
  assert.throws(() => restarted.saveSchedule({ id: other, name: "Stolen", task: "x", agentId: "colleague-one", schedule: time.schedule, enabled: true }, restarted.list().revision), /owner/);
  assert.throws(() => restarted.saveSchedule({ id: other, name: "Too fast", task: "x", agentId: "colleague-two", schedule: { kind: "every", everyMs: 60000, display: "every:1m" }, enabled: true }, restarted.list().revision), /timing/);
});
test("scheduler defers busy colleague, runs into anchored row, and never replays completed or blocked claims after restart", async () => {
  const f = fixture(), now = Date.now(), time = parseChatScheduleTime({ delay_seconds: 1 }, now, "UTC");
  const id = f.features.createChatSchedule(input(f, time)), calls = []; let busy = true, missing = false;
  const executor = { available: () => !busy, validateAnchor: () => missing ? "chat_conversation_missing" : null,
    async execute(agent, task, requestId, row) { calls.push({ agent, task, requestId, row }); return { runId: randomUUID(), completed: true }; } };
  const scheduler = new WorkspaceScheduler(f.storage, f.features, executor);
  await scheduler.tick("main", now + 2000); assert.equal(calls.length, 0); assert.equal(scheduler.list().runs.length, 0);
  busy = false; await scheduler.tick("main", now + 2000); assert.equal(calls.length, 1); assert.equal(calls[0].row.id, id);
  const restarted = new WorkspaceScheduler(f.storage, f.features, executor); await restarted.tick("main", now + 3000); assert.equal(calls.length, 1);
  const second = f.features.createChatSchedule(input(f, parseChatScheduleTime({ delay_seconds: 1 }, now, "UTC"), "colleague-two"));
  missing = true; await restarted.tick("main", now + 4000); assert.equal(calls.length, 1);
  assert.equal(restarted.list().runs.find(row => row.scheduleId === second).reason, "chat_conversation_missing");
  const again = new WorkspaceScheduler(f.storage, f.features, executor); await again.tick("main", now + 5000);
  assert.equal(again.list().runs.filter(row => row.scheduleId === second).length, 1);
});
test("workspace-wide schedule cap applies before adding a chat schedule", () => {
  const f = fixture();
  const rows = Array.from({ length: 256 }, (_, n) => ({ id: `legacy-${n}`, name: `Legacy ${n}`, schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: false,
    workspaceId: f.storage.scope.workspaceId, migrationId: `legacy-${n}`, source: "legacy-fixture", definition: { task: "fixture", mode: "print" } }));
  f.features.importLegacy(rows);
  assert.throws(() => f.features.createChatSchedule(input(f, parseChatScheduleTime({ delay_seconds: 60 }, Date.now(), "UTC"))), /limit/);
});
test("a missing conversation blocks a repeated schedule once until its definition is reviewed", async () => {
  const f = fixture(), time = parseChatScheduleTime({ repeat: "every:15m" }, Date.now(), "UTC"), id = f.features.createChatSchedule(input(f, time));
  const executor = { available: () => true, validateAnchor: () => "chat_conversation_missing", async execute() { assert.fail("missing conversation must not run"); } };
  const scheduler = new WorkspaceScheduler(f.storage, f.features, executor), first = Date.now() + 16 * 60_000;
  await scheduler.tick("main", first); await scheduler.tick("main", first + 15 * 60_000);
  assert.equal(scheduler.list().runs.filter(row => row.scheduleId === id).length, 1);
  assert.equal(scheduler.list().runs.find(row => row.scheduleId === id).state, "blocked");
});
