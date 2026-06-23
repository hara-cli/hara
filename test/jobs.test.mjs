import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { startJob, listJobs, tailJob, killJob } from "../dist/exec/jobs.js";

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
