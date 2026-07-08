import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startJob, listJobs, tailJob, killJob, onJobsChange } from "../dist/exec/jobs.js";

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
