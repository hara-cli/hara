import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startJob, listJobs, tailJob, killJob, killAllJobs, onJobsChange } from "../dist/exec/jobs.js";
import { runShell } from "../dist/sandbox.js";

// The test runner itself is inside a macOS Seatbelt profile, which cannot nest sandbox-exec. These fixtures
// use only echo/sleep; protected-path background jobs are covered by sensitive-files.test.mjs.
const previousSensitiveAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
after(() => {
  killAllJobs();
  if (previousSensitiveAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  else process.env.HARA_ALLOW_SENSITIVE_FILES = previousSensitiveAllow;
});

const nodeCommand = (script, ...args) => [process.execPath, script, ...args].map((part) => JSON.stringify(part)).join(" ");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitForFile(path, ms = 1500) {
  const until = Date.now() + ms;
  while (!existsSync(path) && Date.now() < until) await sleep(20);
  assert.equal(existsSync(path), true, `expected ${path} to be created`);
}
async function assertProcessGone(pid, label) {
  const until = Date.now() + 2000;
  while (alive(pid) && Date.now() < until) await sleep(25);
  if (alive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    assert.fail(`${label} (${pid}) survived process-tree termination`);
  }
}

function processTreeFixture(dir, output = false, inheritPipes = true) {
  const script = join(dir, `${output ? "tree-output" : "tree"}-${inheritPipes ? "pipes" : "quiet"}.cjs`);
  writeFileSync(
    script,
    `const { spawn } = require("node:child_process");\n` +
      `const { writeFileSync } = require("node:fs");\n` +
      `const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ["ignore", ${inheritPipes ? '"inherit", "inherit"' : '"ignore", "ignore"'}] });\n` +
      `writeFileSync(process.argv[2], String(grandchild.pid));\n` +
      (output ? `process.stdout.write("x".repeat(128 * 1024));\n` : "") +
      `setInterval(()=>{},1000);\n`,
  );
  return script;
}

function escapedPipeFixture(dir) {
  const script = join(dir, "escaped-pipe.cjs");
  writeFileSync(
    script,
    `const { spawn } = require("node:child_process");\n` +
      `const { writeFileSync } = require("node:fs");\n` +
      `const escaped = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });\n` +
      `writeFileSync(process.argv[2], String(escaped.pid));\n` +
      `escaped.unref();\n`,
  );
  return script;
}

test("onJobsChange: fires on start, self-exit, and kill (so the UI can show bg work LIVE — incl. at idle)", async () => {
  let starts = 0;
  const off = onJobsChange(() => starts++);
  const before = starts;
  const id = startJob("sleep 20", process.cwd(), "off"); // start → fire
  await sleep(150);
  assert.ok(starts > before, "start emitted");
  const afterStart = starts;
  killJob(id); // kill → fire
  await sleep(50);
  assert.ok(starts > afterStart, "kill emitted");
  const afterKill = starts;
  off(); // unsubscribe → no more fires
  startJob("echo x", process.cwd(), "off");
  await sleep(200);
  assert.equal(starts, afterKill, "no fire after unsubscribe");
});

test("onJobsChange: a job finishing on its own (idle case) emits so the indicator clears", async () => {
  let fires = 0;
  const off = onJobsChange(() => fires++);
  startJob("echo done", process.cwd(), "off"); // will exit on its own shortly
  await sleep(400);
  off();
  assert.ok(fires >= 2, "at least start + self-exit emitted (the exit is the idle-clears case)");
});

test("startJob: captures output, lists, tails, exits 0", async () => {
  const id = startJob("echo hello-job; echo line2", process.cwd(), "off");
  assert.match(id, /^j\d+$/);
  await sleep(400); // let it run + exit
  const t = tailJob(id, 10);
  assert.match(t, /hello-job/);
  assert.match(t, /line2/);
  const j = listJobs().find((x) => x.id === id);
  assert.ok(j, "job is listed");
  assert.equal(j.status, "exited");
  assert.equal(j.code, 0);
  assert.equal(tailJob("nope"), null); // unknown id → null
});

test("killJob: terminates a long-running job; idempotent", async () => {
  const id = startJob("sleep 30", process.cwd(), "off");
  await sleep(200);
  assert.equal(listJobs().find((x) => x.id === id).status, "running");
  assert.equal(killJob(id), true);
  await sleep(150);
  assert.equal(listJobs().find((x) => x.id === id).status, "killed");
  assert.equal(killJob(id), false); // already killed → false
  assert.equal(killJob("nope"), false); // unknown id → false
});

test("runShell timeout is wall-clock bounded and kills a SIGTERM-resistant grandchild", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shell-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  try {
    const script = processTreeFixture(dir);
    const started = Date.now();
    await assert.rejects(
      runShell(nodeCommand(script, pidFile), dir, "off", { timeout: 200, maxBuffer: 64 * 1024 }),
      /timed out after 200ms/,
    );
    assert.ok(Date.now() - started >= 400, "runShell waits until forced tree termination is issued before settling");
    assert.ok(Date.now() - started < 2500, "descendant-held pipes cannot extend the wall-clock timeout indefinitely");
    await waitForFile(pidFile);
    await assertProcessGone(Number(readFileSync(pidFile, "utf8")), "runShell grandchild");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TERM escalation still kills a quiet grandchild after the direct shell has closed", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shell-quiet-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  try {
    const script = processTreeFixture(dir, false, false);
    await assert.rejects(
      runShell(nodeCommand(script, pidFile), dir, "off", { timeout: 200, maxBuffer: 64 * 1024 }),
      /timed out after 200ms/,
    );
    await waitForFile(pidFile);
    await assertProcessGone(Number(readFileSync(pidFile, "utf8")), "quiet grandchild after shell close");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell output cap kills the entire process tree and retains a bounded diagnostic", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shell-cap-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  try {
    const script = processTreeFixture(dir, true);
    let liveBytes = 0;
    const result = await runShell(nodeCommand(script, pidFile), dir, "off", {
      timeout: 10_000,
      maxBuffer: 1024,
      onData: (chunk) => { liveBytes += Buffer.byteLength(chunk); },
    });
    assert.ok(result.stdout.length <= 1024, "captured stdout remains bounded");
    assert.ok(liveBytes <= 1024, "output past the cap is not streamed to the UI during termination grace");
    assert.match(result.stderr, /output truncated.*process tree killed/i);
    await waitForFile(pidFile);
    await assertProcessGone(Number(readFileSync(pidFile, "utf8")), "output-capped grandchild");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell accepts output exactly equal to maxBuffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shell-exact-cap-"));
  try {
    const script = join(dir, "exact-cap.cjs");
    writeFileSync(script, `process.stdout.write("x".repeat(1024));\n`);
    const result = await runShell(nodeCommand(script), dir, "off", { timeout: 5_000, maxBuffer: 1024 });
    assert.equal(result.stdout.length, 1024);
    assert.doesNotMatch(result.stderr, /output truncated/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell hard fallback settles even if a daemon escaped the owned process group with a pipe", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-shell-fallback-"));
  const pidFile = join(dir, "escaped.pid");
  let escapedPid = 0;
  try {
    const script = escapedPipeFixture(dir);
    const started = Date.now();
    await assert.rejects(
      runShell(nodeCommand(script, pidFile), dir, "off", { timeout: 150, maxBuffer: 64 * 1024 }),
      /timed out after 150ms/,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1000 && elapsed < 2500, `hard fallback should settle predictably, got ${elapsed}ms`);
    await waitForFile(pidFile);
    escapedPid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(escapedPid), true, "fixture escaped the original group so the fallback path was exercised");
  } finally {
    if (escapedPid) {
      try { process.kill(-escapedPid, "SIGKILL"); } catch {
        try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killJob and exit cleanup kill grandchildren, not just the direct shell", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-job-tree-"));
  try {
    const script = processTreeFixture(dir, false, false);
    const firstPidFile = join(dir, "first.pid");
    const first = startJob(nodeCommand(script, firstPidFile), dir, "off");
    await waitForFile(firstPidFile);
    assert.equal(killJob(first), true);
    await assertProcessGone(Number(readFileSync(firstPidFile, "utf8")), "killed job grandchild");

    const exitPidFile = join(dir, "exit.pid");
    const second = startJob(nodeCommand(script, exitPidFile), dir, "off");
    await waitForFile(exitPidFile);
    killAllJobs();
    await assertProcessGone(Number(readFileSync(exitPidFile, "utf8")), "exit-cleanup grandchild");
    assert.equal(listJobs().find((job) => job.id === second)?.status, "killed");
  } finally {
    killAllJobs();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background jobs store only redacted commands and output", async () => {
  const token = "opaque-hara-job-value-1234567890";
  const previous = process.env.HARA_JOB_TEST_TOKEN;
  process.env.HARA_JOB_TEST_TOKEN = token;
  try {
    const id = startJob(`printf '%s\\n' '${token}'`, process.cwd(), "off");
    await sleep(300);
    const info = listJobs().find((job) => job.id === id);
    const tail = tailJob(id, 10) ?? "";
    assert.ok(info);
    assert.ok(!info.command.includes(token));
    assert.ok(!tail.includes(token));
    assert.match(info.command, /\*\*\*/);
    assert.match(tail, /\*\*\*/);
  } finally {
    if (previous === undefined) delete process.env.HARA_JOB_TEST_TOKEN;
    else process.env.HARA_JOB_TEST_TOKEN = previous;
  }
});

test("finished background-job history is bounded", async () => {
  for (let batch = 0; batch < 15; batch++) {
    for (let i = 0; i < 16; i++) startJob("true", process.cwd(), "off");
    const until = Date.now() + 2_000;
    while (listJobs().some((job) => job.status === "running") && Date.now() < until) await sleep(10);
    assert.equal(listJobs().some((job) => job.status === "running"), false, "short jobs must drain between batches");
  }
  // Starting one more job performs deterministic oldest-finished eviction. The running-job ceiling is
  // separate, so a burst cannot hide still-live processes merely to stay under the history cap.
  startJob("true", process.cwd(), "off");
  await sleep(100);
  assert.ok(listJobs().length <= 200);
});
