import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireComputerLease, createComputerLeaseAcquirerForTests } from "../dist/security/computer-lease.js";

const moduleUrl = new URL("../dist/security/computer-lease.js", import.meta.url).href;

function fixture(t) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-computer-lease-")));
  const directory = join(home, ".hara", "computer-control");
  const file = join(directory, "desktop.json");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, directory, file };
}

function fakeRuntime(pid = 101) {
  const alive = new Set([pid]);
  return {
    alive,
    acquire: createComputerLeaseAcquirerForTests({ pid, isProcessAlive: (candidate) => alive.has(candidate) }),
  };
}

test("desktop ownership is private, tokenized, and released without removing the state directory", (t) => {
  const { home, directory, file } = fixture(t);
  const lease = acquireComputerLease({ home, runId: "first-run", sessionId: "session-one" });
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.version, 1);
  assert.match(record.token, /^[a-f0-9-]{36}$/u);
  assert.equal(record.pid, process.pid);
  assert.equal(record.runId, "first-run");
  assert.equal(record.sessionId, "session-one");
  assert.ok(record.createdAt > 0);
  assert.deepEqual(record.workerPids, []);
  assert.equal(record.pendingWorkers, 0);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  }
  lease.release();
  lease.release();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(directory), true);
  acquireComputerLease({ home, runId: "next-run", sessionId: "session-one" }).release();
});

test("a live owner is never stolen through age, session identity, or repeated run acquisition", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const lease = runtime.acquire({ home, runId: "old-run", sessionId: "shared-session" });
  const record = { ...JSON.parse(readFileSync(file, "utf8")), createdAt: 1 };
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  const before = readFileSync(file, "utf8");
  for (const runId of ["old-run", "new-run"]) {
    assert.throws(() => runtime.acquire({ home, runId, sessionId: "shared-session" }), /Computer control is busy/);
    assert.equal(readFileSync(file, "utf8"), before, "a failed acquisition never refreshes or replaces ownership");
  }
  lease.release();
});

test("dead owners recover only for a different run and stale handles cannot release the successor", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const stale = runtime.acquire({ home, runId: "dead-run" });
  runtime.alive.delete(101);
  assert.throws(() => runtime.acquire({ home, runId: "dead-run" }), /busy/);
  const nextRuntime = createComputerLeaseAcquirerForTests({ pid: 102, isProcessAlive: (pid) => pid === 102 });
  const next = nextRuntime({ home, runId: "recovered-run" });
  const successor = readFileSync(file, "utf8");
  assert.throws(() => stale.trackWorker(103), /ownership changed/);
  stale.release();
  stale.untrackWorker(103);
  assert.equal(readFileSync(file, "utf8"), successor);
  next.release();
  assert.equal(existsSync(file), false);
});

test("an orphaned live input worker prevents recovery after its owner dies", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const lease = runtime.acquire({ home, runId: "owner-run" });
  runtime.alive.add(201);
  lease.prepareWorker();
  lease.trackWorker(201);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).workerPids, [201]);
  runtime.alive.delete(101);
  const contender = createComputerLeaseAcquirerForTests({ pid: 102, isProcessAlive: (pid) => runtime.alive.has(pid) || pid === 102 });
  const before = readFileSync(file, "utf8");
  assert.throws(() => contender({ home, runId: "contender-run" }), /busy/);
  assert.equal(readFileSync(file, "utf8"), before);
  runtime.alive.delete(201);
  const recovered = contender({ home, runId: "contender-run" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, 102);
  lease.release();
  assert.equal(existsSync(file), true);
  recovered.release();
});

test("release waits for all input workers to exit and prevents new workers after cancellation", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const lease = runtime.acquire({ home, runId: "cancelled-run" });
  runtime.alive.add(201);
  runtime.alive.add(202);
  lease.prepareWorker();
  lease.trackWorker(201);
  lease.trackWorker(201);
  lease.prepareWorker();
  lease.trackWorker(202);
  lease.release();
  assert.equal(existsSync(file), true);
  assert.throws(() => lease.trackWorker(203), /released/);
  assert.throws(() => lease.untrackWorker(201), /still alive/);
  assert.throws(() => runtime.acquire({ home, runId: "next-run" }), /busy/);
  runtime.alive.delete(201);
  lease.untrackWorker(201);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).workerPids, [202]);
  runtime.alive.delete(202);
  lease.untrackWorker(202);
  assert.equal(existsSync(file), false);
  const next = runtime.acquire({ home, runId: "next-run" });
  lease.release();
  assert.equal(existsSync(file), true);
  next.release();
});

test("an owner crash between worker reservation and PID registration cannot reclaim the desktop", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const lease = runtime.acquire({ home, runId: "interrupted-spawn" });
  lease.prepareWorker();
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pendingWorkers, 1);
  runtime.alive.clear();
  const before = readFileSync(file, "utf8");
  assert.throws(() => runtime.acquire({ home, runId: "contender-run" }), /unresolved worker spawn.*diagnosis/);
  assert.equal(readFileSync(file, "utf8"), before);
  lease.release();
  assert.equal(existsSync(file), true, "a release cannot forget a possibly spawned worker");
});

test("a synchronously failed spawn cancels its reservation and completes pending release", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const lease = runtime.acquire({ home, runId: "failed-spawn" });
  assert.throws(() => lease.trackWorker(201), /not prepared before spawning/);
  lease.prepareWorker();
  lease.release();
  assert.throws(() => lease.prepareWorker(), /released/);
  lease.cancelPreparedWorker();
  assert.equal(existsSync(file), false);
  runtime.acquire({ home, runId: "next-run" }).release();
});

test("a prepared worker can record its PID during pending release but cannot outlive desktop ownership", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  const lease = runtime.acquire({ home, runId: "cancel-during-spawn" });
  lease.prepareWorker();
  lease.release();
  runtime.alive.add(201);
  lease.trackWorker(201);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pendingWorkers, 0);
  assert.throws(() => runtime.acquire({ home, runId: "next-run" }), /busy/);
  runtime.alive.delete(201);
  lease.untrackWorker(201);
  assert.equal(existsSync(file), false);
});

test("unknown PID probe failures fail closed without replacing ownership", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  runtime.acquire({ home, runId: "held-run" });
  const before = readFileSync(file, "utf8");
  const failing = createComputerLeaseAcquirerForTests({
    pid: 102, isProcessAlive() { throw new Error("PID probe unavailable"); },
  });
  assert.throws(() => failing({ home, runId: "new-run" }), /probe unavailable/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("malformed lease records fail closed instead of guessing dead ownership", (t) => {
  const { home, file } = fixture(t);
  const runtime = fakeRuntime();
  runtime.acquire({ home, runId: "held-run" });
  const record = JSON.parse(readFileSync(file, "utf8"));
  runtime.alive.clear();
  for (const text of [
    "not-json", "null", "[]", JSON.stringify({ ...record, pid: 0 }),
    JSON.stringify({ ...record, workerPids: ["201"] }),
    JSON.stringify({ ...record, workerPids: [201, 201] }),
    JSON.stringify({ ...record, token: "untrusted-token" }),
    JSON.stringify({ ...record, pendingWorkers: -1 }),
    JSON.stringify({ ...record, pendingWorkers: "0" }),
  ]) {
    writeFileSync(file, text, { mode: 0o600 });
    assert.throws(() => runtime.acquire({ home, runId: "new-run" }), /lease is invalid/);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("symlink and hard-link lease files preserve external data", { skip: process.platform === "win32" }, (t) => {
  for (const kind of ["symlink", "hard-link"]) {
    const { home, directory, file } = fixture(t);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const external = join(home, "outside.json");
    const before = '{"outside":"preserved"}\n';
    writeFileSync(external, before, { mode: 0o640 });
    const beforeMode = lstatSync(external).mode & 0o777;
    if (kind === "symlink") symlinkSync(external, file);
    else linkSync(external, file);
    assert.throws(() => acquireComputerLease({ home, runId: "blocked-run" }), /symbolic link|hard link|multiple links/i);
    assert.equal(readFileSync(external, "utf8"), before);
    assert.equal(lstatSync(external).mode & 0o777, beforeMode);
  }
});

test("a symlinked control directory cannot redirect desktop ownership", { skip: process.platform === "win32" }, (t) => {
  const { home, directory } = fixture(t);
  const external = join(home, "outside");
  mkdirSync(join(home, ".hara"), { mode: 0o700 });
  mkdirSync(external, { mode: 0o755 });
  symlinkSync(external, directory);
  assert.throws(() => acquireComputerLease({ home, runId: "blocked-run" }), /not a real directory/);
  assert.equal(existsSync(join(external, "desktop.json")), false);
  assert.equal(lstatSync(external).mode & 0o777, 0o755);
});

function contender(home, runId) {
  const script = `
    const { acquireComputerLease } = await import(${JSON.stringify(moduleUrl)});
    try {
      const lease = acquireComputerLease({ home: ${JSON.stringify(home)}, runId: ${JSON.stringify(runId)} });
      process.stdout.write("acquired\\n");
      process.stdin.once("data", () => { lease.release(); process.exit(0); });
    } catch (error) {
      if (!/Computer control is busy/.test(error.message)) throw error;
      process.stdout.write("busy\\n");
    }
  `;
  const child = spawn(process.execPath, [
    ...(moduleUrl.endsWith(".ts") ? ["--import", "tsx"] : []), "--input-type=module", "-e", script,
  ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const verdict = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("\n")) resolve(output.trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (!output.includes("\n")) reject(new Error(`lease contender exited ${code}: ${errors}`)); });
  });
  return { child, verdict };
}

test("independent processes racing for one physical desktop have exactly one owner", { timeout: 10_000 }, async (t) => {
  const { home, file } = fixture(t);
  const contenders = [contender(home, "process-one"), contender(home, "process-two")];
  t.after(() => { for (const { child } of contenders) if (child.exitCode === null) child.kill(); });
  const verdicts = await Promise.all(contenders.map(({ verdict }) => verdict));
  assert.deepEqual([...verdicts].sort(), ["acquired", "busy"]);
  const winner = contenders[verdicts.indexOf("acquired")].child;
  assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, winner.pid);
  assert.throws(() => acquireComputerLease({ home, runId: "parent-run" }), /busy/);
  const exited = once(winner, "exit");
  winner.stdin.write("release\n");
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(existsSync(file), false);
  acquireComputerLease({ home, runId: "parent-run" }).release();
});
