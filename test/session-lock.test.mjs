// Session single-writer lock — stops two hara processes from resuming the SAME session and corrupting
// its append-only history by racing writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireSessionLock, releaseSessionLock } from "../dist/session/store.js";

const lockPath = (id) => join(homedir(), ".hara", "sessions", `${id}.lock`);

test("acquire on a fresh id succeeds and writes a lock; release removes it", () => {
  const id = `t-lock-fresh-${process.pid}`;
  try {
    assert.equal(acquireSessionLock(id).ok, true);
    assert.ok(existsSync(lockPath(id)), "lock file written");
    releaseSessionLock(id);
    assert.ok(!existsSync(lockPath(id)), "lock file removed on release");
  } finally {
    rmSync(lockPath(id), { force: true });
  }
});

test("re-acquiring our OWN lock succeeds (same pid → re-claim, not a self-block)", () => {
  const id = `t-lock-self-${process.pid}`;
  try {
    assert.equal(acquireSessionLock(id).ok, true);
    assert.equal(acquireSessionLock(id).ok, true, "same process can re-claim");
  } finally {
    releaseSessionLock(id);
    rmSync(lockPath(id), { force: true });
  }
});

test("a lock held by a LIVE other process is refused (the double-resume guard)", () => {
  const id = `t-lock-live-${process.pid}`;
  try {
    writeFileSync(lockPath(id), JSON.stringify({ pid: 1, startedAt: Date.now() })); // pid 1 = init, always alive
    const r = acquireSessionLock(id);
    assert.equal(r.ok, false, "refused — another live process holds it");
    assert.equal(r.pid, 1);
  } finally {
    rmSync(lockPath(id), { force: true });
  }
});

test("a STALE lock (dead pid) is taken over", () => {
  const id = `t-lock-stale-${process.pid}`;
  try {
    writeFileSync(lockPath(id), JSON.stringify({ pid: 999999, startedAt: Date.now() })); // very unlikely to be alive
    assert.equal(acquireSessionLock(id).ok, true, "dead holder → take over");
  } finally {
    releaseSessionLock(id);
    rmSync(lockPath(id), { force: true });
  }
});

test("release only removes OUR lock, never steals another process's", () => {
  const id = `t-lock-norob-${process.pid}`;
  try {
    writeFileSync(lockPath(id), JSON.stringify({ pid: 1, startedAt: Date.now() }));
    releaseSessionLock(id); // we don't hold it — must NOT delete
    assert.ok(existsSync(lockPath(id)), "another process's lock left intact");
  } finally {
    rmSync(lockPath(id), { force: true });
  }
});
