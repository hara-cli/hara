// hara cron 0.108: timezone matching, the deterministic command lane, delivery + failure alerts,
// and the model-facing cronjob tool with its recursion guard. Hermetic via $HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hara-cron-home-")); // BEFORE importing cron modules
process.env.USERPROFILE = process.env.HOME;
const { cronMatches, validTz, zoneOffsetMs } = await import("../dist/cron/schedule.js");
const {
  addJob,
  loadJobs,
  recordRun,
  recordRunStart,
  enqueueOutcomeNotifications,
  recoverInterruptedRuns,
  findJob,
  saveJobs,
  logPath,
  cronDir,
  MAX_CRON_RUNNING_AGE_MS,
  MAX_CRON_PENDING_NOTIFICATIONS,
  MAX_CRON_STORE_BYTES,
} = await import("../dist/cron/store.js");
const {
  runJobOnce,
  runJobTracked,
  deliverOutcome,
  deliverPendingNotifications,
  runTick,
  cronJobTimeoutMs,
  cronTickTimeoutMs,
  DEFAULT_CRON_JOB_TIMEOUT_MS,
  DEFAULT_CRON_TICK_TIMEOUT_MS,
  MAX_CRON_JOB_TIMEOUT_MS,
  MAX_CRON_TICK_TIMEOUT_MS,
} = await import("../dist/cron/runner.js");
const { parseDeliver } = await import("../dist/cron/deliver.js");
const { defaultProcessIdentity } = await import("../dist/process-identity.js");
const { getTool } = await import("../dist/tools/registry.js");
await import("../dist/tools/cron.js");
const processBirthIdentityAvailable = defaultProcessIdentity(process.pid) !== null;

test("timezone: '0 9 * * *' @ Asia/Shanghai fires at 01:00 UTC, not at 09:00 UTC", () => {
  assert.ok(validTz("Asia/Shanghai") && !validTz("Not/AZone"), "tz validation");
  assert.equal(zoneOffsetMs("Asia/Shanghai", Date.UTC(2026, 6, 5)) / 3_600_000, 8, "CST = UTC+8");
  const oneUtc = new Date(Date.UTC(2026, 6, 6, 1, 0)); // 09:00 Beijing
  const nineUtc = new Date(Date.UTC(2026, 6, 6, 9, 0)); // 17:00 Beijing
  assert.equal(cronMatches("0 9 * * *", oneUtc, "Asia/Shanghai"), true, "matches Beijing 9am");
  assert.equal(cronMatches("0 9 * * *", nineUtc, "Asia/Shanghai"), false, "does not match Beijing 5pm");
});

test("command mode: runs the task as a shell command — deterministic, exit code honored, output captured", async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  // CI itself runs under a macOS sandbox that rejects nested sandbox-exec. These commands contain no file
  // access; protected-path behavior is covered by the next test with the waiver removed.
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  try {
    const ok = addJob({ name: "echo", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "echo deterministic-$((6*7))", mode: "command", cwd: process.cwd(), createdAt: Date.now() });
    const r = await runJobOnce(ok);
    assert.equal(r.ok, true);
    assert.ok(r.output.includes("deterministic-42"), "stdout captured for delivery");
    assert.ok(r.stdout.includes("deterministic-42"), "stdout is tracked separately for on-output delivery");
    const stderrOnly = addJob({
      name: "stderr-only",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stderr.write('diagnostic-only')")}`,
      mode: "command",
      cwd: process.cwd(),
      createdAt: Date.now(),
    });
    const stderrResult = await runJobOnce(stderrOnly);
    assert.equal(stderrResult.ok, true);
    assert.match(stderrResult.output, /diagnostic-only/);
    assert.equal(stderrResult.stdout, "", "stderr must not make an on-output job noisy");
    const bad = addJob({ name: "boom", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "exit 3", mode: "command", cwd: process.cwd(), createdAt: Date.now() });
    const rb = await runJobOnce(bad);
    assert.equal(rb.ok, false);
    assert.match(rb.error, /exited 3/);
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});

test("command mode turns protected-file preflight exceptions into a recorded task failure", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-cron-sensitive-"));
  try {
    writeFileSync(join(cwd, ".env"), "TOKEN=do-not-read\n");
    const job = addJob({ name: "blocked", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "cat .env", mode: "command", cwd, createdAt: Date.now() });
    const result = await runJobOnce(job);
    assert.equal(result.ok, false);
    assert.match(result.error, /protected secret boundary|protected secret/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("command mode enforces a timeout and caps a single run's log", { skip: process.platform === "win32" }, async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  try {
    const noisy = addJob({
      name: "noisy",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(20000))'`,
      mode: "command",
      cwd: process.cwd(),
      createdAt: Date.now(),
    });
    const noisyResult = await runJobOnce(noisy, { maxLogBytes: 4096 });
    assert.equal(noisyResult.ok, true);
    assert.match(readFileSync(logPath(noisy.id), "utf8"), /run log capped at 4096 bytes/);

    const slow = addJob({
      name: "slow",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 10000)'`,
      mode: "command",
      cwd: process.cwd(),
      createdAt: Date.now(),
    });
    const started = Date.now();
    const slowResult = await runJobOnce(slow, { timeoutMs: 100 });
    assert.equal(slowResult.ok, false);
    assert.match(slowResult.error, /timed out after 100ms/);
    assert.ok(Date.now() - started < 5_000, "process-tree termination must not wait for the child timer");

    const processDir = mkdtempSync(join(tmpdir(), "hara-cron-tree-"));
    const pidFile = join(processDir, "grandchild.pid");
    let grandchildPid;
    let treeRun;
    try {
      const script = [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" })',
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
        'setInterval(() => {}, 1000)',
      ].join(";");
      const tree = addJob({
        name: "quiet-tree",
        schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
        task: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        mode: "command",
        cwd: processDir,
        createdAt: Date.now(),
      });
      // Prove that the grandchild exists before the runner's deadline expires. A 150ms fixed deadline
      // raced process startup on loaded Intel macOS release runners and could make the PID assertion fail
      // without exercising process-group termination at all.
      treeRun = runJobOnce(tree, { timeoutMs: 3_000 });
      const startDeadline = Date.now() + 2_000;
      while (!grandchildPid && Date.now() < startDeadline) {
        if (existsSync(pidFile)) {
          const candidate = Number(readFileSync(pidFile, "utf8").trim());
          if (Number.isSafeInteger(candidate) && candidate > 0) grandchildPid = candidate;
        }
        if (!grandchildPid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(grandchildPid, "fixture grandchild published a valid pid before the bounded timeout");
      const treeResult = await treeRun;
      assert.equal(treeResult.ok, false);
      assert.match(treeResult.error, /timed out/);
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          process.kill(grandchildPid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") break;
          throw error;
        }
        if (Date.now() >= deadline) assert.fail(`grandchild ${grandchildPid} survived forced process-group kill`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      if (treeRun) await treeRun.catch(() => undefined);
      if (!grandchildPid && existsSync(pidFile)) {
        const candidate = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isSafeInteger(candidate) && candidate > 0) grandchildPid = candidate;
      }
      if (grandchildPid) try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      rmSync(processDir, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});

test("manual cron run cancellation settles promptly and kills its owned process tree", { skip: process.platform === "win32" }, async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  const dir = mkdtempSync(join(tmpdir(), "hara-cron-abort-"));
  const pidFile = join(dir, "child.pid");
  let pid;
  try {
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const job = addJob({
      name: "abortable",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      mode: "command",
      cwd: dir,
      createdAt: Date.now(),
    });
    const controller = new AbortController();
    const started = Date.now();
    const running = runJobOnce(job, { timeoutMs: 30_000, signal: controller.signal });
    const startDeadline = Date.now() + 2_000;
    while (!pid && Date.now() < startDeadline) {
      if (existsSync(pidFile)) {
        const candidate = Number(readFileSync(pidFile, "utf8").trim());
        if (Number.isSafeInteger(candidate) && candidate > 0) pid = candidate;
      }
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid, "fixture child published a valid pid");
    controller.abort();
    const result = await running;
    assert.equal(result.ok, false);
    assert.match(result.error, /interrupted by agent run deadline or cancellation/);
    assert.ok(Date.now() - started < 1_500, "abort does not wait for the cron timeout/grace window");
    const goneDeadline = Date.now() + 1_000;
    for (;;) {
      try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") break; throw error; }
      if (Date.now() >= goneDeadline) assert.fail(`cron child ${pid} survived cancellation`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});

test("manual run refuses to overwrite an interrupted running marker and requires an explicit retry", async () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-manual-interrupted-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const job = addJob({
      name: "ambiguous-orphan",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: "must-not-run",
      mode: "command",
      cwd: home,
      createdAt: Date.now(),
    });
    const storeUrl = new URL("../dist/cron/store.js", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const s=await import(${JSON.stringify(storeUrl)});const token=s.recordRunStart(${JSON.stringify(job.id)},Date.now());if(!token)process.exit(2);`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const interrupted = findJob(job.id);
    assert.equal(interrupted.lastStatus, "running");
    assert.equal(interrupted.runningPid, child.pid);
    const originalToken = interrupted.runningToken;

    assert.equal(recordRunStart(job.id, Date.now()), null, "any unresolved running attempt is immutable");
    assert.equal(findJob(job.id).runningToken, originalToken, "rejection does not erase the old attempt");

    const result = await runJobTracked(job, { timeoutMs: 100 });
    assert.equal(result.ok, false);
    assert.match(result.error, /interrupted.*disabled.*refused to overlap.*again explicitly/i);
    const recovered = findJob(job.id);
    assert.equal(recovered.lastStatus, "error");
    assert.equal(recovered.enabled, false);
    assert.equal(recovered.runningToken, undefined);
    assert.match(recovered.lastError, /previous Hara process exited.*orphaned child/i);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("cron timeout configuration has safe defaults, minimums, and hard upper bounds", () => {
  const previousJob = process.env.HARA_CRON_JOB_TIMEOUT_MS;
  const previousTick = process.env.HARA_CRON_TICK_TIMEOUT_MS;
  try {
    delete process.env.HARA_CRON_JOB_TIMEOUT_MS;
    delete process.env.HARA_CRON_TICK_TIMEOUT_MS;
    assert.equal(cronJobTimeoutMs(), DEFAULT_CRON_JOB_TIMEOUT_MS);
    assert.equal(cronTickTimeoutMs(), DEFAULT_CRON_TICK_TIMEOUT_MS);
    assert.equal(cronJobTimeoutMs(0), 100);
    assert.equal(cronTickTimeoutMs(0), 100);
    assert.equal(cronJobTimeoutMs(Number.MAX_SAFE_INTEGER), MAX_CRON_JOB_TIMEOUT_MS);
    assert.equal(cronTickTimeoutMs(Number.MAX_SAFE_INTEGER), MAX_CRON_TICK_TIMEOUT_MS);
    process.env.HARA_CRON_JOB_TIMEOUT_MS = "250";
    process.env.HARA_CRON_TICK_TIMEOUT_MS = "500";
    assert.equal(cronJobTimeoutMs(), 250);
    assert.equal(cronTickTimeoutMs(), 500);
    process.env.HARA_CRON_TICK_TIMEOUT_MS = "not-a-number";
    assert.equal(cronTickTimeoutMs(), DEFAULT_CRON_TICK_TIMEOUT_MS, "invalid config cannot disable the watchdog");
  } finally {
    if (previousJob === undefined) delete process.env.HARA_CRON_JOB_TIMEOUT_MS;
    else process.env.HARA_CRON_JOB_TIMEOUT_MS = previousJob;
    if (previousTick === undefined) delete process.env.HARA_CRON_TICK_TIMEOUT_MS;
    else process.env.HARA_CRON_TICK_TIMEOUT_MS = previousTick;
  }
});

test("a timed-out job is persisted and the tick continues with the next due job", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-job-deadline-"));
  process.env.HOME = home;
  try {
    const first = addJob({ name: "hang", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "hang", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const second = addJob({ name: "next", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "next", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const calls = [];
    const result = await runTick(Date.now(), async (job) => {
      calls.push(job.id);
      const running = findJob(job.id);
      assert.equal(running.lastStatus, "running", "state is durable before runner invocation");
      assert.ok(Number.isFinite(running.runningSince));
      if (job.id === first.id) return new Promise(() => {}); // deliberately ignores cancellation
      return { ok: true, output: "done" };
    }, { jobTimeoutMs: 100, tickTimeoutMs: 2_000 });

    assert.deepEqual(result.ran, [first.id, second.id]);
    assert.deepEqual(calls, [first.id, second.id], "one timeout does not starve later due jobs");
    assert.equal(result.stopped, undefined);
    const timedOut = findJob(first.id);
    assert.equal(timedOut.lastStatus, "timed_out");
    assert.match(timedOut.lastError, /timed out after 100ms/);
    assert.equal(timedOut.runningSince, undefined);
    assert.ok(timedOut.lastDurationMs >= 90);
    assert.equal(timedOut.consecutiveErrors, 1, "timeout participates in the alert failure streak");
    const completed = findJob(second.id);
    assert.equal(completed.lastStatus, "ok");
    assert.equal(completed.runningSince, undefined);
    assert.ok(Number.isFinite(completed.lastDurationMs));
    assert.equal(existsSync(join(cronDir(), ".tick.lock")), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tick watchdog aborts the current runner, skips remaining jobs, and releases its lock", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-tick-deadline-"));
  process.env.HOME = home;
  try {
    const first = addJob({ name: "hang", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "hang", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const second = addJob({ name: "must-not-start", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "next", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const calls = [];
    let observedAbort = false;
    const result = await runTick(Date.now(), (job, options) => {
      calls.push(job.id);
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve({ ok: false, error: "runner cancelled", interrupted: true });
        }, { once: true });
      });
    }, { jobTimeoutMs: 2_000, tickTimeoutMs: 100 });

    assert.deepEqual(calls, [first.id]);
    assert.deepEqual(result.ran, [first.id]);
    assert.match(result.stopped, /tick watchdog timed out after 100ms/);
    assert.equal(observedAbort, true, "watchdog signal reaches the process-owning runner");
    assert.equal(findJob(first.id).lastStatus, "timed_out");
    assert.equal(findJob(first.id).runningSince, undefined);
    assert.equal(findJob(second.id).lastStatus, undefined, "the remainder of this tick is not started");
    assert.equal(existsSync(join(cronDir(), ".tick.lock")), false, "finally releases the tick lock");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("caller cancellation is persisted as interrupted error, not misreported as a tick timeout", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-tick-cancel-"));
  process.env.HOME = home;
  try {
    const job = addJob({ name: "cancel", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "hang", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const controller = new AbortController();
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    const running = runTick(Date.now(), (_job, options) => {
      notifyStarted();
      return new Promise((resolve) => options.signal.addEventListener("abort", () => {
        resolve({ ok: false, error: "runner interrupted", interrupted: true });
      }, { once: true }));
    }, { jobTimeoutMs: 2_000, tickTimeoutMs: 2_000, signal: controller.signal });
    await started;
    controller.abort();
    const result = await running;
    assert.match(result.stopped, /cancelled by caller/);
    const saved = findJob(job.id);
    assert.equal(saved.lastStatus, "error");
    assert.match(saved.lastError, /cancelled by caller/);
    assert.equal(saved.runningSince, undefined);
    assert.equal(existsSync(join(cronDir(), ".tick.lock")), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("tick lock acquisition is atomic under concurrent invocations", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-lock-"));
  process.env.HOME = home;
  try {
    addJob({ name: "one", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "x", mode: "command", cwd: process.cwd(), createdAt: 0 });
    let release;
    let started;
    const didStart = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const first = runTick(Date.now(), async () => {
      started();
      await gate;
      return { ok: true };
    });
    await didStart;
    const second = await runTick(Date.now(), async () => ({ ok: true }));
    assert.match(second.skipped ?? "", /another tick/);
    release();
    assert.deepEqual((await first).ran.length, 1);
    assert.equal(existsSync(join(cronDir(), ".tick.lock")), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an aged live tick owner is never stolen while it can resume a stale due snapshot", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-live-aged-lock-"));
  process.env.HOME = home;
  try {
    const now = Date.now();
    const job = addJob({
      name: "sleep-safe",
      schedule: { kind: "every", everyMs: 1, display: "every 1ms" },
      task: "x",
      mode: "command",
      cwd: process.cwd(),
      deliver: "webhook:https://example.invalid",
      createdAt: 0,
    });
    enqueueOutcomeNotifications(job.id, { ok: true, output: "seed" }, now - 1, "seed");

    let entered;
    let release;
    const deliveryEntered = new Promise((resolve) => { entered = resolve; });
    const deliveryGate = new Promise((resolve) => { release = resolve; });
    const runs = [];
    let firstDeliveries = 0;
    let secondDeliveries = 0;
    const first = runTick(now, async () => {
      runs.push("first");
      return { ok: true, output: "first" };
    }, {
      tickTimeoutMs: 10_000,
      deliver: async () => {
        firstDeliveries++;
        if (firstDeliveries === 1) {
          entered();
          await deliveryGate;
        }
        return null;
      },
    });
    await deliveryEntered;

    // Simulate a host sleep/event-loop freeze while the first tick owns a valid live lock but has not started
    // its due job. Age was previously treated as PID reuse, allowing a successor to run and the old owner to
    // resume the same stale due snapshot afterwards.
    const lock = join(cronDir(), ".tick.lock");
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(lock, old, old);
    const second = await runTick(Date.now(), async () => {
      runs.push("second");
      return { ok: true, output: "second" };
    }, {
      tickTimeoutMs: 10_000,
      deliver: async () => { secondDeliveries++; return null; },
    });
    assert.match(second.skipped ?? "", /another tick is in progress/);
    assert.equal(secondDeliveries, 0, "a successor cannot redeliver the live owner's pending effect");

    release();
    assert.equal((await first).ran.length, 1);
    assert.deepEqual(runs, ["first"], "the due job runs exactly once");
    assert.equal(firstDeliveries, 2, "the owner drains the seed and its new outcome once each");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("two tick contenders cannot both take over the same stale lock", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-stale-lock-"));
  process.env.HOME = home;
  try {
    addJob({ name: "stale", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "x", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const lock = join(cronDir(), ".tick.lock");
    const takeover = join(cronDir(), ".tick.lock.takeover");
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.ok(Number.isInteger(exited.pid) && exited.pid > 0);
    writeFileSync(lock, `${exited.pid}:00000000-0000-4000-8000-000000000001`);
    utimesSync(lock, old, old);

    let calls = 0;
    const results = await Promise.all([
      runTick(Date.now(), async () => { calls++; return { ok: true }; }),
      runTick(Date.now(), async () => { calls++; return { ok: true }; }),
    ]);
    assert.equal(calls, 1, "exactly one contender runs the due job");
    assert.equal(results.filter((result) => result.ran.length === 1).length, 1);
    assert.equal(results.filter((result) => result.skipped).length, 1);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(takeover), false);

    // A fresh guard owned by a live reaper is never guessed away. This prevents check→unlink from deleting
    // a lock that another contender just installed, at the conservative cost of retrying a later tick.
    writeFileSync(lock, `${process.pid}:00000000-0000-4000-8000-000000000002`);
    utimesSync(lock, old, old);
    writeFileSync(takeover, `${process.pid}:00000000-0000-4000-8000-000000000003`);
    const guarded = await runTick(Date.now(), async () => { calls++; return { ok: true }; });
    assert.match(guarded.skipped ?? "", /taking over a stale lock/);
    assert.equal(readFileSync(lock, "utf8"), `${process.pid}:00000000-0000-4000-8000-000000000002`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a dead takeover guard is recoverable but an aged live legacy guard fails closed", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-dead-takeover-"));
  process.env.HOME = home;
  try {
    addJob({ name: "recover", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "x", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const lock = join(cronDir(), ".tick.lock");
    const takeover = join(cronDir(), ".tick.lock.takeover");
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.ok(Number.isInteger(exited.pid) && exited.pid > 0);

    writeFileSync(lock, `${exited.pid}:00000000-0000-4000-8000-000000000011`);
    utimesSync(lock, old, old);
    writeFileSync(takeover, `${exited.pid}:00000000-0000-4000-8000-000000000012`);

    let calls = 0;
    const now = Date.now() + 1_000;
    const recoveredDead = await Promise.all([
      runTick(now, async () => { calls++; return { ok: true }; }),
      runTick(now, async () => { calls++; return { ok: true }; }),
    ]);
    assert.equal(recoveredDead.filter((result) => /cleared a stale tick takeover guard/.test(result.skipped ?? "")).length, 1);
    assert.equal(calls, 1);
    assert.equal(recoveredDead.filter((result) => result.ran.length === 1).length, 1);
    assert.equal(recoveredDead.filter((result) => result.skipped).length, 1);
    assert.equal(existsSync(takeover), false);
    assert.equal(existsSync(lock), false);

    // A live identity-less legacy guard has no proof of PID reuse. Age alone cannot fence an owner paused
    // immediately before unlink/rename, so it must fail closed even after a long host sleep.
    writeFileSync(lock, `${process.pid}:00000000-0000-4000-8000-000000000013`);
    utimesSync(lock, old, old);
    writeFileSync(takeover, `${process.pid}:00000000-0000-4000-8000-000000000014`);
    utimesSync(takeover, old, old);
    const blockedLive = await Promise.all([
      runTick(now + 2_000, async () => { calls++; return { ok: true }; }),
      runTick(now + 2_000, async () => { calls++; return { ok: true }; }),
    ]);
    assert.equal(blockedLive.filter((result) => /taking over a stale lock/.test(result.skipped ?? "")).length, 2);
    assert.equal(calls, 1);
    assert.equal(existsSync(takeover), true);
    assert.equal(existsSync(lock), true);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a live tick PID with a different same-version birth identity is reclaimable", {
  // Sandboxed macOS runners may deny the nested `ps` probe. Production correctly fails closed in that
  // environment, but this specific PID-reuse assertion needs a comparable birth identity.
  skip: (process.platform !== "linux" && process.platform !== "darwin") || !processBirthIdentityAvailable,
}, async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-reused-tick-pid-"));
  process.env.HOME = home;
  try {
    addJob({ name: "reused", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "x", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const lock = join(cronDir(), ".tick.lock");
    const scheme = process.platform === "linux" ? "linux-v1" : "darwin-v1";
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000031",
      birthIdentity: `${scheme}:definitely-not-this-process`,
    }));
    let calls = 0;
    const results = await Promise.all([
      runTick(Date.now(), async () => { calls++; return { ok: true }; }),
      runTick(Date.now(), async () => { calls++; return { ok: true }; }),
    ]);
    assert.equal(calls, 1);
    assert.equal(results.filter((result) => result.ran.length === 1).length, 1);
    assert.equal(results.filter((result) => result.skipped).length, 1);
    assert.equal(existsSync(lock), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("stable malformed guard and primary records recover only after their poison windows", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-malformed-lock-"));
  process.env.HOME = home;
  try {
    addJob({ name: "malformed", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "x", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const lock = join(cronDir(), ".tick.lock");
    const takeover = join(cronDir(), ".tick.lock.takeover");
    const base = Date.now();
    const oldPrimary = new Date(base - 7 * 60 * 60_000);
    const oldGuard = new Date(base - 10 * 60_000);
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.ok(Number.isInteger(exited.pid) && exited.pid > 0);
    let calls = 0;
    const run = async () => { calls++; return { ok: true }; };

    writeFileSync(lock, `${exited.pid}:00000000-0000-4000-8000-000000000021`);
    utimesSync(lock, oldPrimary, oldPrimary);
    writeFileSync(takeover, ""); // crash after O_EXCL open, before the UUID record write
    const freshGuard = await Promise.all([runTick(base, run), runTick(base, run)]);
    assert.equal(calls, 0);
    assert.equal(freshGuard.filter((result) => result.skipped).length, 2);
    assert.equal(existsSync(takeover), true, "fresh malformed guard fails closed");
    assert.equal(existsSync(lock), true);

    utimesSync(takeover, oldGuard, oldGuard);
    const staleGuard = await Promise.all([runTick(base + 1_000, run), runTick(base + 1_000, run)]);
    assert.equal(staleGuard.filter((result) => /cleared a stale tick takeover guard/.test(result.skipped ?? "")).length, 1);
    assert.equal(staleGuard.filter((result) => result.ran.length === 1).length, 1);
    assert.equal(calls, 1, "only one contender runs after malformed guard recovery");
    assert.equal(existsSync(takeover), false);
    assert.equal(existsSync(lock), false);

    writeFileSync(lock, `${process.pid}:not-a-complete-uuid`); // crash during the primary record write
    const freshPrimary = await Promise.all([runTick(base + 2_000, run), runTick(base + 2_000, run)]);
    assert.equal(freshPrimary.filter((result) => result.skipped).length, 2);
    assert.equal(calls, 1);
    assert.equal(existsSync(lock), true, "fresh malformed primary fails closed");

    utimesSync(lock, oldPrimary, oldPrimary);
    const stalePrimary = await Promise.all([runTick(base + 3_000, run), runTick(base + 3_000, run)]);
    assert.equal(stalePrimary.filter((result) => result.ran.length === 1).length, 1);
    assert.equal(stalePrimary.filter((result) => result.skipped).length, 1);
    assert.equal(calls, 2, "only one contender runs after malformed primary recovery");
    assert.equal(existsSync(takeover), false);
    assert.equal(existsSync(lock), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
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

test("delivery modes suppress empty heartbeat noise without weakening failure alerts", async () => {
  const sent = [];
  const fakeDeliver = async (spec, text) => (sent.push({ spec, text }), null);
  const now = Date.now();
  const base = {
    schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
    task: "x",
    mode: "command",
    cwd: process.cwd(),
    deliver: "feishu:oc_test",
    createdAt: now,
  };

  const outputOnly = addJob({ ...base, name: "output-only", deliverMode: "on-output", alertAfter: 1 });
  await deliverOutcome(
    findJob(outputOnly.id),
    { ok: true, stdout: "", output: "stderr-only diagnostic" },
    fakeDeliver,
    now + 1,
  );
  assert.equal(sent.length, 0, "empty stdout success stays silent even when stderr/log output exists");

  await deliverOutcome(
    findJob(outputOnly.id),
    { ok: true, stdout: "price changed", output: "price changed" },
    fakeDeliver,
    now + 2,
  );
  assert.equal(sent.filter((entry) => entry.text.startsWith("⏰")).length, 1);

  recordRun(outputOnly.id, now + 3, "error", "feed unavailable");
  await deliverOutcome(
    findJob(outputOnly.id),
    { ok: false, error: "feed unavailable", stdout: "", output: "stderr-only" },
    fakeDeliver,
    now + 3,
  );
  assert.equal(
    sent.filter((entry) => entry.text.startsWith("🚨")).length,
    1,
    "on-output suppresses the routine outcome but alertAfter still reports a failure streak",
  );

  const errorsOnly = addJob({ ...base, name: "errors-only", deliverMode: "on-error" });
  await deliverOutcome(
    findJob(errorsOnly.id),
    { ok: true, stdout: "routine result", output: "routine result" },
    fakeDeliver,
    now + 4,
  );
  const beforeFailure = sent.length;
  await deliverOutcome(
    findJob(errorsOnly.id),
    { ok: false, error: "failed", stdout: "", output: "" },
    fakeDeliver,
    now + 5,
  );
  assert.equal(sent.length, beforeFailure + 1);
  assert.match(sent.at(-1).text, /^⏰ errors-only ✗/);

  const legacy = addJob({ ...base, name: "legacy-always" });
  const beforeLegacy = sent.length;
  await deliverOutcome(findJob(legacy.id), { ok: true, stdout: "", output: "" }, fakeDeliver, now + 6);
  assert.equal(sent.length, beforeLegacy + 1, "missing deliverMode remains backward-compatible always");
});

test("failed timeout delivery stays durable and a later tick retries the same idempotency keys", async () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-delivery-queue-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const now = Date.now();
    const job = addJob({
      name: "one-shot-timeout",
      schedule: { kind: "once", runAt: now - 1, display: "once" },
      task: "x",
      mode: "command",
      cwd: home,
      deliver: "feishu:oc_test",
      alertAfter: 1,
      createdAt: now - 2,
    });
    const failedKeys = [];
    const first = await runTick(now, async () => ({ ok: false, error: "timed out after 100ms", timedOut: true }), {
      jobTimeoutMs: 500,
      tickTimeoutMs: 2_000,
      deliver: async (_spec, _text, _signal, key) => {
        failedKeys.push(key);
        return "offline";
      },
    });
    assert.deepEqual(first.ran, [job.id]);
    const queued = findJob(job.id);
    assert.equal(queued.lastStatus, "timed_out");
    assert.equal(queued.lastAlertAt, undefined, "failed alert does not start cooldown");
    assert.deepEqual(queued.pendingNotifications.map((notification) => notification.kind).sort(), ["alert", "outcome"]);
    assert.ok(queued.pendingNotifications.every((notification) => notification.attempts === 1));

    let reran = false;
    const retryKeys = [];
    const second = await runTick(now + 60_000, async () => {
      reran = true;
      return { ok: true };
    }, {
      deliver: async (_spec, _text, _signal, key) => {
        retryKeys.push(key);
        return null;
      },
    });
    assert.deepEqual(second.ran, [], "completed one-shot is not replayed merely to retry its alarm");
    assert.equal(reran, false);
    assert.deepEqual(retryKeys.sort(), failedKeys.sort(), "retry reuses each persisted idempotency key");
    const acknowledged = findJob(job.id);
    assert.equal(acknowledged.pendingNotifications, undefined);
    assert.ok(Number.isFinite(acknowledged.lastAlertAt), "cooldown starts only with confirmed alert delivery");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("old running state is interrupted and disabled even when its PID is alive/reused", async () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-old-running-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const now = Date.now();
    const job = addJob({
      name: "reused-pid",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: "x",
      mode: "command",
      cwd: home,
      deliver: "feishu:oc_test",
      alertAfter: 1,
      createdAt: now - MAX_CRON_RUNNING_AGE_MS - 60_000,
    });
    recordRunStart(job.id, now - MAX_CRON_RUNNING_AGE_MS - 1);
    assert.equal(findJob(job.id).runningPid, process.pid, "fixture uses a definitely-live PID");
    const recovered = recoverInterruptedRuns(now);
    assert.equal(recovered.length, 1);
    const state = findJob(job.id);
    assert.equal(state.enabled, false);
    assert.equal(state.lastStatus, "error");
    assert.match(state.lastError, /exceeded the 24h maximum/);
    assert.deepEqual(state.pendingNotifications.map((notification) => notification.kind).sort(), ["alert", "outcome"], "recovery and its alarm are one durable commit");

    const sent = [];
    await deliverPendingNotifications(async (_spec, text, _signal, key) => {
      sent.push({ text, key });
      return null;
    }, now, undefined, { jobId: job.id, limit: 8 });
    assert.equal(sent.length, 2);
    assert.equal(findJob(job.id).pendingNotifications, undefined);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("delivery outage applies per-job backpressure before jobs.json can grow without bound", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-queue-bound-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const now = Date.now();
    const job = addJob({
      name: "offline-high-frequency",
      schedule: { kind: "every", everyMs: 1_000, display: "every 1s" },
      task: "x",
      mode: "command",
      cwd: home,
      deliver: "feishu:oc_test",
      alertAfter: 1_000,
      createdAt: now,
    });
    let runs = 0;
    for (let index = 0; index < MAX_CRON_PENDING_NOTIFICATIONS + 10; index++) {
      const at = now + index + 1;
      const token = recordRunStart(job.id, at, true);
      if (!token) break;
      assert.equal(recordRun(job.id, at + 1, "error", "transport offline", 1, token, {
        ok: false,
        error: "transport offline",
      }), true);
      runs++;
    }
    assert.equal(runs, MAX_CRON_PENDING_NOTIFICATIONS - 1, "two terminal-effect slots are reserved before every launch");
    const blocked = findJob(job.id);
    assert.equal(blocked.enabled, false, "backlogged job is fail-closed until an operator re-enables it");
    assert.equal(blocked.pendingNotifications.length, MAX_CRON_PENDING_NOTIFICATIONS);
    assert.equal(blocked.pendingNotifications.filter((item) => item.kind === "alert").length, 1, "queue-full disable is itself visible");
    assert.match(blocked.lastError, /delivery backlog has 63\/64.*disabled before launch/i);
    assert.equal(blocked.lastDurationMs, undefined, "a launch rejected by backpressure never reuses the previous run duration");
    assert.equal(new Set(blocked.pendingNotifications.map((item) => item.id)).size, MAX_CRON_PENDING_NOTIFICATIONS);

    const invalid = {
      ...blocked,
      pendingNotifications: Array.from({ length: MAX_CRON_PENDING_NOTIFICATIONS + 1 }, (_, index) => ({
        id: `overflow-${index}`,
        kind: "outcome",
        target: "feishu:oc_test",
        text: "bounded",
        createdAt: now + index,
        attempts: 0,
        nextAttemptAt: now,
      })),
    };
    const storePath = join(home, ".hara", "cron", "jobs.json");
    writeFileSync(storePath, JSON.stringify([invalid]));
    assert.throws(() => loadJobs(), /invalid schema/, "oversized persisted queues are rejected at the read boundary");
    truncateSync(storePath, MAX_CRON_STORE_BYTES + 1);
    assert.throws(() => loadJobs(), /safety limit/, "oversized jobs.json is rejected before it is read into memory");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("interrupted-run recovery compacts only old outcomes and preserves explicit recovery effects", () => {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-recovery-capacity-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const now = Date.now();
    const job = addJob({
      name: "recovery-at-capacity",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: "x",
      mode: "command",
      cwd: home,
      deliver: "feishu:oc_test",
      alertAfter: 1,
      createdAt: now - MAX_CRON_RUNNING_AGE_MS - 60_000,
    });
    const startedAt = now - MAX_CRON_RUNNING_AGE_MS - 1;
    const token = recordRunStart(job.id, startedAt, true);
    assert.ok(token);
    const running = findJob(job.id);
    saveJobs([{
      ...running,
      pendingNotifications: Array.from({ length: MAX_CRON_PENDING_NOTIFICATIONS }, (_, index) => ({
        id: `old-outcome-${index}`,
        kind: "outcome",
        target: "feishu:oc_test",
        text: `old ${index}`,
        // Deliberately future-dated legacy data: recovery must protect its same-attempt outcome instead of
        // selecting it as the numerically oldest item when it makes room for the critical alert.
        createdAt: now + 1_000_000 + index,
        attempts: 1,
        nextAttemptAt: now + 60_000,
      })),
    }]);

    assert.equal(recoverInterruptedRuns(now).length, 1);
    const recovered = findJob(job.id);
    assert.equal(recovered.pendingNotifications.length, MAX_CRON_PENDING_NOTIFICATIONS);
    const recoveryEffects = recovered.pendingNotifications.filter((item) => item.id.includes(token));
    assert.deepEqual(recoveryEffects.map((item) => item.kind).sort(), ["alert", "outcome"]);
    assert.ok(recoveryEffects.every((item) => /older outcome was compacted without delivery/.test(item.text)), "compaction is explicit, never silent");
    assert.equal(recovered.pendingNotifications.some((item) => item.kind === "alert"), true, "critical alert is never evicted");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a timeout can trigger alertAfter and cronjob list labels running/timed out states", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-status-"));
  process.env.HOME = home;
  try {
    const sent = [];
    const timed = addJob({
      name: "deadline",
      schedule: { kind: "every", everyMs: 60_000, display: "every 1m" },
      task: "x",
      mode: "command",
      cwd: process.cwd(),
      deliver: "telegram:123",
      alertAfter: 1,
      createdAt: Date.now(),
    });
    const startedAt = Date.now() - 5_000;
    recordRunStart(timed.id, startedAt);
    recordRun(timed.id, startedAt + 5_000, "timed_out", "timed out after 5000ms", 5_000);
    await deliverOutcome(findJob(timed.id), { ok: false, error: "timed out after 5000ms" }, async (spec, text) => (sent.push({ spec, text }), null));
    assert.equal(sent.filter((entry) => entry.text.startsWith("🚨")).length, 1, "timeout reaches the normal alert threshold");

    const running = addJob({ name: "active", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "y", mode: "command", cwd: process.cwd(), createdAt: Date.now() });
    recordRunStart(running.id, Date.now());
    const list = await getTool("cronjob").run({ action: "list" }, { cwd: process.cwd() });
    assert.match(list, /deadline[\s\S]*last timed out after 5s/);
    assert.match(list, /active[\s\S]*last running since/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseDeliver: platforms validated, Weixin requires an explicit peer", () => {
  assert.deepEqual(parseDeliver("feishu:oc_abc"), { platform: "feishu", to: "oc_abc" });
  assert.deepEqual(parseDeliver("weixin:wxid_explicit"), { platform: "weixin", to: "wxid_explicit" });
  assert.ok("error" in parseDeliver("weixin:owner"), "never guess an owner from a multi-DM cache");
  assert.ok("error" in parseDeliver("sms:123"), "unknown platform rejected");
  assert.ok("error" in parseDeliver("nonsense"), "missing colon rejected");
});

test("cronjob tool: add/list/remove work; cron-run sessions are refused (recursion guard)", async () => {
  const tool = getTool("cronjob");
  assert.ok(tool && tool.kind === "exec", "registered, approval-gated");
  const add = await tool.run({ action: "add", schedule: "0 9 * * *", task: "morning brief", tz: "Asia/Shanghai", name: "brief", alertAfter: 1 }, { cwd: process.cwd() });
  assert.match(add, /✓ scheduled/, "added");
  assert.match(add, /@ Asia\/Shanghai/, "tz echoed");
  assert.match(add, /alert ≥1/, "failure threshold echoed");
  const list = await tool.run({ action: "list" }, { cwd: process.cwd() });
  assert.ok(list.includes("brief") && list.includes("cron"), "listed");
  const id = /✓ scheduled (\S+)/.exec(add)[1];
  assert.equal(findJob(id).alertAfter, 1);
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
  const badAlert = await tool.run({ action: "add", schedule: "0 9 * * *", task: "x", alertAfter: 0 }, { cwd: process.cwd() });
  assert.match(badAlert, /alertAfter.*1 to 1000/);
  const quiet = await tool.run({
    action: "add",
    schedule: "every 5m",
    task: "check price",
    deliver: "feishu:oc_test",
    deliverMode: "on-output",
  }, { cwd: process.cwd() });
  assert.match(quiet, /on-output/);
  const quietId = /✓ scheduled (\S+)/.exec(quiet)[1];
  assert.equal(findJob(quietId).deliverMode, "on-output");
  const quietList = await tool.run({ action: "list" }, { cwd: process.cwd() });
  assert.match(quietList, /feishu:oc_test \(on-output\)/);
  assert.match(
    await tool.run({ action: "add", schedule: "every 5m", task: "x", deliverMode: "on-error" }, { cwd: process.cwd() }),
    /requires `deliver`/,
  );
  assert.match(
    await tool.run({ action: "add", schedule: "every 5m", task: "x", deliver: "feishu:oc_test", deliverMode: "sometimes" }, { cwd: process.cwd() }),
    /always, on-output, or on-error/,
  );
  assert.match(await tool.run({ action: "remove", id: quietId }, { cwd: process.cwd() }), /✓ removed/);
});

test("cronjob at Home keeps management actions but refuses to persist a new Home-root job", async () => {
  const tool = getTool("cronjob");
  const before = loadJobs().length;
  const list = await tool.run({ action: "list" }, { cwd: process.env.HOME });
  assert.doesNotMatch(list, /Refusing.*home directory/i);
  for (const action of ["remove", "enable", "disable"]) {
    const result = await tool.run({ action, id: "definitely-missing" }, { cwd: process.env.HOME });
    assert.match(result, /no job matching/i);
    assert.doesNotMatch(result, /Refusing.*home directory/i);
  }
  const add = await tool.run(
    { action: "add", schedule: "every 1h", task: "home-root task", mode: "command" },
    { cwd: process.env.HOME },
  );
  assert.match(add, /Refusing.*home directory.*cd \/path\/to\/project/i);
  assert.equal(loadJobs().length, before, "Home rejection happens before jobs.json changes");
});
