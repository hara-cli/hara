// hara cron 0.108: timezone matching, the deterministic command lane, delivery + failure alerts,
// and the model-facing cronjob tool with its recursion guard. Hermetic via $HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hara-cron-home-")); // BEFORE importing cron modules
const { cronMatches, validTz, zoneOffsetMs } = await import("../dist/cron/schedule.js");
const { addJob, loadJobs, recordRun, findJob, logPath, cronDir } = await import("../dist/cron/store.js");
const { runJobOnce, deliverOutcome, runTick } = await import("../dist/cron/runner.js");
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
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  // CI itself runs under a macOS sandbox that rejects nested sandbox-exec. These commands contain no file
  // access; protected-path behavior is covered by the next test with the waiver removed.
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  try {
    const ok = addJob({ name: "echo", schedule: { kind: "every", everyMs: 60_000, display: "every 1m" }, task: "echo deterministic-$((6*7))", mode: "command", cwd: process.cwd(), createdAt: Date.now() });
    const r = await runJobOnce(ok);
    assert.equal(r.ok, true);
    assert.ok(r.output.includes("deterministic-42"), "stdout captured for delivery");
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
      const treeResult = await runJobOnce(tree, { timeoutMs: 150 });
      assert.equal(treeResult.ok, false);
      assert.match(treeResult.error, /timed out/);
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
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
      if (grandchildPid) try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      rmSync(processDir, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
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

test("two tick contenders cannot both take over the same stale lock", async () => {
  const savedHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-cron-stale-lock-"));
  process.env.HOME = home;
  try {
    addJob({ name: "stale", schedule: { kind: "every", everyMs: 1, display: "every 1ms" }, task: "x", mode: "command", cwd: process.cwd(), createdAt: 0 });
    const lock = join(cronDir(), ".tick.lock");
    const takeover = join(cronDir(), ".tick.lock.takeover");
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    writeFileSync(lock, `${process.pid}:00000000-0000-4000-8000-000000000001`);
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

test("a dead or expired takeover guard is recoverable without letting two stale-lock contenders run", async () => {
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

    writeFileSync(lock, `${process.pid}:00000000-0000-4000-8000-000000000011`);
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

    // Also recover a guard whose PID was reused/remains alive but whose synchronous lease is impossibly old.
    writeFileSync(lock, `${process.pid}:00000000-0000-4000-8000-000000000013`);
    utimesSync(lock, old, old);
    writeFileSync(takeover, `${process.pid}:00000000-0000-4000-8000-000000000014`);
    utimesSync(takeover, old, old);
    const recoveredExpired = await Promise.all([
      runTick(now + 2_000, async () => { calls++; return { ok: true }; }),
      runTick(now + 2_000, async () => { calls++; return { ok: true }; }),
    ]);
    assert.equal(recoveredExpired.filter((result) => /cleared a stale tick takeover guard/.test(result.skipped ?? "")).length, 1);
    assert.equal(recoveredExpired.filter((result) => result.ran.length === 1).length, 1);
    assert.equal(calls, 2);
    assert.equal(existsSync(takeover), false);
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
    let calls = 0;
    const run = async () => { calls++; return { ok: true }; };

    writeFileSync(lock, `${process.pid}:00000000-0000-4000-8000-000000000021`);
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
