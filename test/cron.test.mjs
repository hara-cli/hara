import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durationToMs, parseSchedule, parseCron, cronMatches, isDue, nextRun } from "../dist/cron/schedule.js";
import { dueJobs, selfArgv, selfInvocation } from "../dist/cron/runner.js";
import { addJob, cronDir, findJob, loadJobs, recordRunStart, resolveJob, saveJobs, setEnabled } from "../dist/cron/store.js";
import { renderLaunchdPlist } from "../dist/cron/install.js";
import { defaultProcessIdentity } from "../dist/process-identity.js";

test("durationToMs", () => {
  assert.equal(durationToMs("45s"), 45_000);
  assert.equal(durationToMs("30m"), 1_800_000);
  assert.equal(durationToMs("2h"), 7_200_000);
  assert.equal(durationToMs("1d"), 86_400_000);
  assert.equal(durationToMs("nope"), null);
});

test("macOS cron uses calendar-minute events instead of a coalescible StartInterval timer", () => {
  const plist = renderLaunchdPlist(["/Applications/Hara & Tools/hara", "cron", "tick"]);
  assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key><array>/);
  assert.equal((plist.match(/<key>Minute<\/key>/g) ?? []).length, 60);
  for (let minute = 0; minute < 60; minute++) {
    assert.match(plist, new RegExp(`<key>Minute</key><integer>${minute}</integer>`));
  }
  assert.match(plist, /<string>\/Applications\/Hara &amp; Tools\/hara<\/string>/);
});

test("parseSchedule: the three forms + errors", () => {
  assert.deepEqual(parseSchedule("every 30m", 0), { kind: "every", everyMs: 1_800_000, display: "every 30m" });
  const once = parseSchedule("in 2h", 1000);
  assert.equal(once.kind, "once");
  assert.equal(once.runAt, 1000 + 7_200_000);
  assert.deepEqual(parseSchedule("0 9 * * *", 0), { kind: "cron", expr: "0 9 * * *" });
  assert.equal(parseSchedule("garbage here", 0).error !== undefined, true);
  assert.equal(parseSchedule("99 99 * * *", 0).error !== undefined, true, "out-of-range cron rejected");
  assert.match(parseSchedule("2020-01-01T00:00", Date.UTC(2026, 0, 1)).error, /past/i, "past absolute one-shot rejected");
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
  assert.equal(nextRun({ schedule: { kind: "once", runAt: 9000, display: "x" }, createdAt: 0 }, from), from, "overdue persisted one-shot is due now, never displayed in the past");
});

test("nextRun: a matching current cron minute stays due now instead of jumping to tomorrow", () => {
  const from = new Date(2026, 0, 5, 9, 0, 37).getTime();
  const job = { schedule: { kind: "cron", expr: "0 9 * * *" }, createdAt: from, pendingDueAt: from };
  assert.equal(nextRun(job, from), from);
  const nextTick = new Date(2026, 0, 5, 9, 1, 0).getTime();
  assert.equal(isDue(job, nextTick), true, "the next OS tick catches the creation-minute occurrence");
  assert.equal(isDue({ ...job, lastRunAt: nextTick }, nextTick + 60_000), false, "the catch-up is consumed exactly once");
  assert.ok(nextRun({ ...job, lastRunAt: from }, from) > from, "after this minute ran, next moves forward");
});

test("creation-minute catch-up is explicit, consumed on start, and abandoned on disable", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cron-pending-due-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const createdAt = new Date(2026, 0, 5, 9, 0, 37).getTime();
    const later = new Date(2026, 1, 5, 15, 42).getTime();
    const enabled = addJob({ name: "enabled", schedule: { kind: "cron", expr: "0 9 * * *" }, task: "x", mode: "print", cwd: home, createdAt });
    assert.equal(enabled.pendingDueAt, createdAt);
    assert.equal(isDue(enabled, new Date(2026, 0, 5, 9, 1).getTime()), true, "next OS tick catches exactly the persisted occurrence");
    const token = recordRunStart(enabled.id, createdAt + 60_000);
    assert.ok(token);
    assert.equal(findJob(enabled.id).pendingDueAt, undefined, "starting the attempt consumes catch-up before side effects");

    const abandoned = addJob({ name: "abandoned", schedule: { kind: "cron", expr: "0 9 * * *" }, task: "x", mode: "print", cwd: home, createdAt });
    assert.equal(setEnabled(abandoned.id, false), true);
    assert.equal(setEnabled(abandoned.id, true), true);
    assert.equal(findJob(abandoned.id).pendingDueAt, undefined);
    assert.equal(isDue(findJob(abandoned.id), later), false, "re-enable never replays the old creation minute");

    const bornDisabled = addJob({ name: "born-off", schedule: { kind: "cron", expr: "0 9 * * *" }, task: "x", mode: "print", cwd: home, enabled: false, createdAt });
    assert.equal(bornDisabled.pendingDueAt, undefined);
    setEnabled(bornDisabled.id, true);
    assert.equal(isDue(findJob(bornDisabled.id), later), false, "disabled creation never mints catch-up debt");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
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

test("cron store bounds poison recovery and never age-steals a live identity-less commit guard", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cron-poison-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const makeJob = (name) => ({ name, schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "ok", mode: "command", cwd: home, createdAt: Date.now() });
  try {
    mkdirSync(cronDir(), { recursive: true });
    for (const suffix of ["", ".reclaim"]) {
      const poison = join(cronDir(), `.jobs.lock${suffix}`);
      writeFileSync(poison, "");
      const started = Date.now();
      addJob(makeJob(`after-poison-${suffix || "primary"}`));
      assert.ok(Date.now() - started >= 400, "fresh malformed evidence is not deleted immediately");
    }
    assert.equal(loadJobs().length, 2);

    const stale = join(cronDir(), ".jobs.lock");
    writeFileSync(stale, "{");
    utimesSync(stale, new Date(0), new Date(0));
    addJob(makeJob("stale-fast"));
    assert.equal(
      loadJobs().some((job) => job.name === "stale-fast"),
      true,
      "stable old malformed evidence is recoverable without a permanent busy state",
    );

    const reusedPid = join(cronDir(), ".jobs.lock");
    writeFileSync(reusedPid, JSON.stringify({ pid: process.pid, token: "00000000-0000-4000-8000-000000000099" }));
    utimesSync(reusedPid, new Date(0), new Date(0));
    addJob(makeJob("stale-live-pid"));
    assert.equal(
      loadJobs().some((job) => job.name === "stale-live-pid"),
      true,
      "expired synchronous lease is reclaimed even when its PID was reused by a live process",
    );

    if (process.platform === "linux" || process.platform === "darwin") {
      const legacyGuard = join(cronDir(), ".jobs.lock.reclaim");
      writeFileSync(legacyGuard, JSON.stringify({ pid: process.pid, token: "00000000-0000-4000-8000-000000000098" }));
      utimesSync(legacyGuard, new Date(0), new Date(0));
      assert.throws(
        () => addJob(makeJob("must-not-steal-legacy-live-guard")),
        /commit fence is busy|store is busy/,
        "a live legacy guard fails closed because age cannot fence an owner paused immediately before rename",
      );
      assert.equal(existsSync(legacyGuard), true);
      rmSync(legacyGuard);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cron store reclaims a fresh guard whose live PID has a mismatched OS birth identity", {
  skip: process.platform !== "linux" && process.platform !== "darwin",
}, (t) => {
  const currentBirthIdentity = defaultProcessIdentity(process.pid);
  if (!currentBirthIdentity) {
    t.skip("the host cannot provide a process birth identity");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "hara-cron-reused-guard-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    mkdirSync(cronDir(), { recursive: true });
    const guard = join(cronDir(), ".jobs.lock.reclaim");
    const scheme = currentBirthIdentity.slice(0, currentBirthIdentity.indexOf(":"));
    writeFileSync(guard, JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000097",
      birthIdentity: `${scheme}:definitely-not-this-process`,
    }));
    addJob({
      name: "reused-guard",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: "ok",
      mode: "command",
      cwd: home,
      createdAt: Date.now(),
    });
    assert.equal(loadJobs().length, 1);
    assert.equal(existsSync(guard), false, "the mismatched live PID guard is reclaimed");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cron store transaction lock preserves concurrent adds", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cron-concurrent-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const count = 12;
  try {
    const script = [
      'import { addJob } from "./dist/cron/store.js";',
      'addJob({ name: process.argv[1], schedule: { kind: "every", everyMs: 60000, display: "every 1m" }, task: "ok", mode: "command", cwd: process.cwd(), createdAt: Date.now() });',
    ].join("");
    await Promise.all(Array.from({ length: count }, (_, index) => new Promise((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, `job-${index}`], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", rejectChild);
      child.once("close", (code) => code === 0 ? resolveChild() : rejectChild(new Error(`child ${index} exited ${code}: ${stderr}`)));
    })));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.equal(loadJobs().length, count, "no concurrent add is overwritten by a stale read-modify-write snapshot");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an expired old owner is fenced from overwriting its lease successor", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-cron-fenced-owner-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    addJob({ name: "seed", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "seed", mode: "command", cwd: home, createdAt: Date.now() });
    let successorRan = false;
    const staleJob = {
      id: "stale001",
      name: "stale-owner",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: "must-not-overwrite",
      mode: "command",
      cwd: home,
      enabled: true,
      createdAt: Date.now(),
      toJSON() {
        // `saveJobs` already owns .jobs.lock here. Expire it while this owner is synchronously preparing its
        // temp file, then let another process reclaim/commit. The resumed owner must fail its token fence.
        const primary = join(cronDir(), ".jobs.lock");
        utimesSync(primary, new Date(0), new Date(0));
        const script = [
          'import { addJob } from "./dist/cron/store.js";',
          'addJob({ name: "successor", schedule: { kind: "every", everyMs: 60000, display: "every 1m" }, task: "new", mode: "command", cwd: process.env.HOME, createdAt: Date.now() });',
        ].join("");
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, USERPROFILE: home },
          encoding: "utf8",
        });
        assert.equal(child.status, 0, child.stderr);
        successorRan = true;
        return { id: this.id, name: this.name, schedule: this.schedule, task: this.task, mode: this.mode, cwd: this.cwd, enabled: this.enabled, createdAt: this.createdAt };
      },
    };
    assert.throws(() => saveJobs([staleJob]), /lease was replaced before commit/);
    assert.equal(successorRan, true);
    const names = loadJobs().map((job) => job.name);
    assert.ok(names.includes("successor"), "successor commit survives");
    assert.equal(names.includes("stale-owner"), false, "resumed old owner cannot overwrite successor state");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
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
    assert.deepEqual(
      selfInvocation(["--resume", "session-1"]),
      { command: "/usr/bin/node", args: ["/x/dist/index.js", "--resume", "session-1"] },
      "resume keeps the Node entry before user args",
    );
    // the installed `hara` bin symlink has no .js extension — the case that broke the gateway spawn
    process.argv[1] = "/Users/me/.nvm/bin/hara";
    assert.deepEqual(selfArgv(), ["/usr/bin/node", "/Users/me/.nvm/bin/hara"], "node + bin symlink");
    // compiled single-binary: execPath IS hara (not node), so re-invoke it directly
    process.execPath = "/usr/local/bin/hara";
    process.argv[1] = "gateway";
    assert.deepEqual(selfArgv(), ["/usr/local/bin/hara"], "compiled binary re-invokes itself");
    assert.deepEqual(
      selfInvocation(["--resume", "session-1"]),
      { command: "/usr/local/bin/hara", args: ["--resume", "session-1"] },
      "compiled resume never treats Bun's virtual/user argv[1] as an entry script",
    );
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
