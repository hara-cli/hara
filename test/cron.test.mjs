import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durationToMs, parseSchedule, parseCron, cronMatches, isDue, nextRun } from "../dist/cron/schedule.js";
import { dueJobs, selfArgv } from "../dist/cron/runner.js";
import { resolveJob } from "../dist/cron/store.js";

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
  const everyNext = nextRun({ schedule: { kind: "every", everyMs: 1000, display: "x" }, createdAt: 0, lastRunAt: 5000 }, from);
  assert.ok(everyNext > from && everyNext % 1000 === 0 && everyNext - from <= 1000, "next grid boundary after `from` (never in the past)");
  assert.equal(nextRun({ schedule: { kind: "once", runAt: 9000, display: "x" }, createdAt: 0, lastRunAt: 9000 }, from), null, "already ran");
});

test("hardening: malformed cron is rejected, not silently mis-scheduled", () => {
  assert.equal(parseCron("0 9 * * 1,"), null, "trailing comma");
  assert.equal(parseCron("/5 * * * *"), null, "step with no range");
  assert.equal(parseCron("5/ * * * *"), null, "empty step");
  assert.equal(parseCron("x 9 * * *"), null, "non-numeric value");
  assert.equal(parseCron("0 9 * * 1/x"), null, "non-numeric step");
  assert.ok(parseCron("*/5 0-6 1,15 * 1-5"), "a valid expr still parses");
  assert.ok(parseSchedule("0 9 * * 1,", 0).error !== undefined, "a bad cron surfaces an error (not a quietly-wrong job)");
});

test("hardening: Vixie `N/step` extends to max (minute 5/15 = 5,20,35,50)", () => {
  assert.equal(cronMatches("5/15 * * * *", new Date(2026, 0, 5, 9, 5)), true);
  assert.equal(cronMatches("5/15 * * * *", new Date(2026, 0, 5, 9, 20)), true);
  assert.equal(cronMatches("5/15 * * * *", new Date(2026, 0, 5, 9, 6)), false);
});

test("hardening: interval grid-anchor — an early-landing tick still counts its slot (no halving)", () => {
  const e = { schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, createdAt: 0 };
  assert.equal(isDue({ ...e, lastRunAt: 600_000 }, 659_500), false, "still the same minute-slot → not yet");
  assert.equal(isDue({ ...e, lastRunAt: 600_000 }, 660_000), true, "next slot → due (even though it's <60s past a slightly-late lastRun)");
});

test("hardening: resolveJob — exact wins, unique prefix resolves, ambiguous never guesses", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cron-store-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".hara", "cron"), { recursive: true });
    const j = (id) => ({ id, name: id, task: "x", mode: "print", cwd: ".", enabled: true, createdAt: 0, schedule: { kind: "every", everyMs: 1000, display: "x" } });
    writeFileSync(join(home, ".hara", "cron", "jobs.json"), JSON.stringify([j("abc12345"), j("abc99999"), j("def00000")]));
    assert.equal(resolveJob("def")?.id, "def00000", "unique prefix resolves");
    assert.equal(resolveJob("abc12345")?.id, "abc12345", "exact id wins");
    assert.equal(resolveJob("abc"), "ambiguous", "ambiguous prefix is flagged, not guessed");
    assert.equal(resolveJob("zzz"), undefined, "no match");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("selfArgv: under node re-invokes the entry (script OR bin symlink); compiled binary re-invokes itself", () => {
  const savedArgv = process.argv[1];
  const savedExec = process.execPath;
  try {
    process.execPath = "/usr/bin/node";
    process.argv[1] = "/x/dist/index.js";
    assert.deepEqual(selfArgv(), ["/usr/bin/node", "/x/dist/index.js"], "node + .js script");
    // the installed `hara` bin symlink has no .js extension — the case that broke the gateway spawn
    process.argv[1] = "/Users/me/.nvm/bin/hara";
    assert.deepEqual(selfArgv(), ["/usr/bin/node", "/Users/me/.nvm/bin/hara"], "node + bin symlink");
    // compiled single-binary: execPath IS hara (not node), so re-invoke it directly
    process.execPath = "/usr/local/bin/hara";
    process.argv[1] = "gateway";
    assert.deepEqual(selfArgv(), ["/usr/local/bin/hara"], "compiled binary re-invokes itself");
  } finally {
    process.argv[1] = savedArgv;
    process.execPath = savedExec;
  }
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
