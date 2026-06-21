import { test } from "node:test";
import assert from "node:assert/strict";
import { durationToMs, parseSchedule, parseCron, cronMatches, isDue, nextRun } from "../dist/cron/schedule.js";
import { dueJobs } from "../dist/cron/runner.js";

test("durationToMs", () => {
  assert.equal(durationToMs("45s"), 45_000);
  assert.equal(durationToMs("30m"), 1_800_000);
  assert.equal(durationToMs("2h"), 7_200_000);
  assert.equal(durationToMs("1d"), 86_400_000);
  assert.equal(durationToMs("nope"), null);
});

test("parseSchedule: the three forms + errors", () => {
  assert.deepEqual(parseSchedule("every 30m", 0), { kind: "every", everyMs: 1_800_000, display: "every 30m" });
  const once = parseSchedule("in 2h", 1000);
  assert.equal(once.kind, "once");
  assert.equal(once.runAt, 1000 + 7_200_000);
  assert.deepEqual(parseSchedule("0 9 * * *", 0), { kind: "cron", expr: "0 9 * * *" });
  assert.equal(parseSchedule("garbage here", 0).error !== undefined, true);
  assert.equal(parseSchedule("99 99 * * *", 0).error !== undefined, true, "out-of-range cron rejected");
});

test("parseCron: validity", () => {
  assert.ok(parseCron("*/15 0-6 1,15 * 1-5"));
  assert.equal(parseCron("* * * *"), null, "needs 5 fields");
  assert.equal(parseCron("60 * * * *"), null, "minute out of range");
  assert.equal(parseCron("* 24 * * *"), null, "hour out of range");
});

test("cronMatches: minute/hour/step + day-of-week", () => {
  assert.equal(cronMatches("0 9 * * *", new Date(2026, 0, 5, 9, 0)), true);
  assert.equal(cronMatches("0 9 * * *", new Date(2026, 0, 5, 9, 1)), false);
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 0, 5, 13, 30)), true);
  assert.equal(cronMatches("*/15 * * * *", new Date(2026, 0, 5, 13, 7)), false);
  const d = new Date(2026, 0, 5, 9, 0); // whatever weekday this is
  assert.equal(cronMatches(`0 9 * * ${d.getDay()}`, d), true, "matches its own weekday");
  assert.equal(cronMatches(`0 9 * * ${(d.getDay() + 1) % 7}`, d), false, "not a different weekday (dom is *)");
});

test("isDue: cron fires once per matching minute (deduped by lastRunAt)", () => {
  const min = 60_000;
  const at = new Date(2026, 0, 5, 9, 0).getTime();
  const job = { schedule: { kind: "cron", expr: "0 9 * * *" }, createdAt: 0 };
  assert.equal(isDue(job, at), true, "due, never run");
  assert.equal(isDue({ ...job, lastRunAt: at }, at), false, "already ran this minute");
  assert.equal(isDue({ ...job, lastRunAt: at - min }, at), true, "ran a previous minute → due again");
  assert.equal(isDue(job, at + min), false, "09:01 doesn't match");
});

test("isDue: interval + one-shot", () => {
  const every = { schedule: { kind: "every", everyMs: 3_600_000, display: "every 1h" }, createdAt: 0 };
  assert.equal(isDue(every, 3_599_999), false);
  assert.equal(isDue(every, 3_600_000), true);
  assert.equal(isDue({ ...every, lastRunAt: 3_600_000 }, 3_600_000 + 3_599_999), false, "interval counts from lastRun");

  const once = { schedule: { kind: "once", runAt: 5000, display: "once" }, createdAt: 0 };
  assert.equal(isDue(once, 4999), false);
  assert.equal(isDue(once, 5000), true);
  assert.equal(isDue({ ...once, lastRunAt: 6000 }, 9999), false, "one-shot never fires twice");
});

test("nextRun: cron scans forward; interval/once compute directly", () => {
  const from = new Date(2026, 0, 5, 10, 0).getTime();
  const cronNext = nextRun({ schedule: { kind: "cron", expr: "0 9 * * *" }, createdAt: 0 }, from);
  assert.ok(cronNext && new Date(cronNext).getHours() === 9 && new Date(cronNext).getMinutes() === 0);
  assert.ok(cronNext > from, "in the future");
  assert.equal(nextRun({ schedule: { kind: "every", everyMs: 1000, display: "x" }, createdAt: 0, lastRunAt: 5000 }, from), 6000);
  assert.equal(nextRun({ schedule: { kind: "once", runAt: 9000, display: "x" }, createdAt: 0, lastRunAt: 9000 }, from), null, "already ran");
});

test("dueJobs: only enabled + due", () => {
  const at = new Date(2026, 0, 5, 9, 0).getTime();
  const mk = (id, enabled, lastRunAt) => ({ id, name: id, task: "x", mode: "print", cwd: ".", enabled, createdAt: 0, lastRunAt, schedule: { kind: "cron", expr: "0 9 * * *" } });
  const jobs = [mk("a", true), mk("b", false), mk("c", true, at)];
  assert.deepEqual(
    dueJobs(jobs, at).map((j) => j.id),
    ["a"],
    "a due; b disabled; c already ran this minute",
  );
});
