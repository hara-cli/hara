// hara cron 0.108: timezone matching, the deterministic command lane, delivery + failure alerts,
// and the model-facing cronjob tool with its recursion guard. Hermetic via $HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hara-cron-home-")); // BEFORE importing cron modules
const { cronMatches, validTz, zoneOffsetMs } = await import("../dist/cron/schedule.js");
const { addJob, loadJobs, recordRun, findJob } = await import("../dist/cron/store.js");
const { runJobOnce, deliverOutcome } = await import("../dist/cron/runner.js");
const { parseDeliver } = await import("../dist/cron/deliver.js");
const { getTool } = await import("../dist/tools/registry.js");
await import("../dist/tools/cron.js");

test("timezone: '0 9 * * *' @ Asia/Shanghai fires at 01:00 UTC, not at 09:00 UTC", () => {
  assert.ok(validTz("Asia/Shanghai") && !validTz("Not/AZone"), "tz validation");
  assert.equal(zoneOffsetMs("Asia/Shanghai", Date.UTC(2026, 6, 5)) / 3_600_000, 8, "CST = UTC+8");
  const oneUtc = new Date(Date.UTC(2026, 6, 6, 1, 0)); // 09:00 Beijing
  const nineUtc = new Date(Date.UTC(2026, 6, 6, 9, 0)); // 17:00 Beijing
  assert.equal(cronMatches("0 9 * * *", oneUtc, "Asia/Shanghai"), true, "matches Beijing 9am");
  assert.equal(cronMatches("0 9 * * *", nineUtc, "Asia/Shanghai"), false, "does not match Beijing 5pm");
});

test("command mode: runs the task as a shell command — deterministic, exit code honored, output captured", async () => {
  const ok = addJob({ name: "echo", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "echo deterministic-$((6*7))", mode: "command", cwd: process.cwd(), createdAt: Date.now() });
  const r = await runJobOnce(ok);
  assert.equal(r.ok, true);
  assert.ok(r.output.includes("deterministic-42"), "stdout captured for delivery");
  const bad = addJob({ name: "boom", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "exit 3", mode: "command", cwd: process.cwd(), createdAt: Date.now() });
  const rb = await runJobOnce(bad);
  assert.equal(rb.ok, false);
  assert.match(rb.error, /exited 3/);
});

test("delivery + failure alert: outcome pushed; 🚨 fires at the threshold with cooldown", async () => {
  const sent = [];
  const fakeDeliver = async (spec, text) => (sent.push({ spec, text }), null);
  const job = addJob({ name: "watch", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "x", mode: "command", cwd: process.cwd(), deliver: "telegram:123", createdAt: Date.now() });
  const now = Date.now();
  // three consecutive failures → outcome each time, alert on the 3rd
  for (let i = 1; i <= 3; i++) {
    recordRun(job.id, now + i, "error", "exited 1");
    await deliverOutcome(findJob(job.id), { ok: false, error: "exited 1", output: "boom" }, fakeDeliver, now + i);
  }
  const outcomes = sent.filter((s) => s.text.startsWith("⏰"));
  const alerts = sent.filter((s) => s.text.startsWith("🚨"));
  assert.equal(outcomes.length, 3, "every run's outcome delivered");
  assert.equal(alerts.length, 1, "alert exactly once at threshold (cooldown gates repeats)");
  assert.match(alerts[0].text, /failed 3× in a row/);
  // 4th failure within cooldown → no second alert
  recordRun(job.id, now + 4, "error", "exited 1");
  await deliverOutcome(findJob(job.id), { ok: false, error: "exited 1" }, fakeDeliver, now + 4);
  assert.equal(sent.filter((s) => s.text.startsWith("🚨")).length, 1, "cooldown respected");
  // success resets the streak
  recordRun(job.id, now + 5, "ok");
  assert.equal(findJob(job.id).consecutiveErrors, 0, "streak reset on success");
});

test("parseDeliver: platforms validated, wechat clearly rejected", () => {
  assert.deepEqual(parseDeliver("feishu:oc_abc"), { platform: "feishu", to: "oc_abc" });
  assert.ok("error" in parseDeliver("weixin:me"), "wechat unsupported (needs live gateway)");
  assert.ok("error" in parseDeliver("nonsense"), "missing colon rejected");
});

test("cronjob tool: add/list/remove work; cron-run sessions are refused (recursion guard)", async () => {
  const tool = getTool("cronjob");
  assert.ok(tool && tool.kind === "exec", "registered, approval-gated");
  const add = await tool.run({ action: "add", schedule: "0 9 * * *", task: "morning brief", tz: "Asia/Shanghai", name: "brief" }, { cwd: process.cwd() });
  assert.match(add, /✓ scheduled/, "added");
  assert.match(add, /@ Asia\/Shanghai/, "tz echoed");
  const list = await tool.run({ action: "list" }, { cwd: process.cwd() });
  assert.ok(list.includes("brief") && list.includes("cron"), "listed");
  const id = /✓ scheduled (\S+)/.exec(add)[1];
  const rm = await tool.run({ action: "remove", id }, { cwd: process.cwd() });
  assert.match(rm, /✓ removed/, "removed");
  // recursion guard
  process.env.HARA_CRON = "1";
  const blocked = await tool.run({ action: "add", schedule: "every 1m", task: "loop" }, { cwd: process.cwd() });
  assert.match(blocked, /recursion guard/, "cron-run session refused");
  delete process.env.HARA_CRON;
  // bad tz fails loudly at add time
  const badTz = await tool.run({ action: "add", schedule: "0 9 * * *", task: "x", tz: "Mars/Olympus" }, { cwd: process.cwd() });
  assert.match(badTz, /invalid timezone/);
});
