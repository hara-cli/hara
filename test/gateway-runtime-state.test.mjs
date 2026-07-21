import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  acquireGatewayInstance,
  gatewayRuntimeScope,
  GatewayEventSpool,
  GatewayFlowRunStore,
  GatewayInboundTracker,
  GatewayMessageDeduper,
  GatewayRuntimeReporter,
  GatewayRunOutcomeStore,
  inspectGatewayRuntime,
} from "../dist/gateway/runtime-state.js";
import { compareProcessIdentity, defaultProcessIdentity } from "../dist/process-identity.js";
import { executeDurableGatewayEffect, gatewayStatus } from "../dist/gateway/serve.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "hara-gateway-runtime-"));
}

test("gateway runtime scopes collide for the same bot but isolate different credentials without exposing them", () => {
  const first = gatewayRuntimeScope("telegram", "12345:top-secret-a");
  assert.equal(first, gatewayRuntimeScope("telegram", "12345:top-secret-a"));
  assert.notEqual(first, gatewayRuntimeScope("telegram", "67890:top-secret-b"));
  assert.match(first, /^telegram-[a-f0-9]{16}$/);
  assert.equal(first.includes("12345"), false);
  assert.equal(first.includes("secret"), false);
});

test("gateway instance lease rejects a second live process and releases idempotently", () => {
  const home = temporaryHome();
  try {
    const release = acquireGatewayInstance("feishu", { home });
    assert.throws(
      () => acquireGatewayInstance("feishu", { home }),
      /already running \(pid \d+\)/,
    );
    release();
    release();

    const releaseAgain = acquireGatewayInstance("feishu", { home });
    releaseAgain();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway runtime status reports a live PID and redacted poll/error history, then stops cleanly", async () => {
  const home = temporaryHome();
  const connectionIdentity = "app-id:must-never-be-persisted";
  const scope = gatewayRuntimeScope("weixin", connectionIdentity);
  let now = 1_000;
  try {
    const release = acquireGatewayInstance(scope, { home, displayPlatform: "weixin", now: () => now });
    const reporter = await GatewayRuntimeReporter.open(scope, "weixin", { home, now: () => now });
    now = 2_000;
    reporter.connected();
    now = 3_000;
    reporter.poll();
    now = 4_000;
    reporter.error("session-expired");
    await reporter.flush();

    const live = await inspectGatewayRuntime("weixin", [scope], { home });
    assert.equal(live.running, true);
    assert.equal(live.runningInstances, 1);
    assert.equal(live.pid, process.pid);
    assert.equal(live.state, "degraded");
    assert.equal(live.lastPollAt, 3_000);
    assert.equal(live.lastErrorAt, 4_000);
    assert.equal(live.lastErrorCode, "session-expired");
    const persisted = readFileSync(join(home, ".hara", "gateway", `status-${scope}.json`), "utf8");
    assert.equal(persisted.includes(connectionIdentity), false);
    assert.equal(persisted.includes("token"), false);

    release();
    now = 5_000;
    reporter.stopped();
    await reporter.flush();
    const stopped = await inspectGatewayRuntime("weixin", [scope], { home });
    assert.equal(stopped.running, false);
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.pid, undefined);
    assert.equal(stopped.lastErrorCode, "session-expired");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway runtime inspection fails closed on a linked status file without reading its target", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX symlink assertion");
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const outside = join(home, "outside.json");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(outside, JSON.stringify({ secret: "do-not-read" }), { mode: 0o600 });
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(dir, "status-weixin-deadbeefdeadbeef.json"));
    const status = await inspectGatewayRuntime("weixin", [], { home });
    assert.equal(status.running, false);
    assert.equal(status.state, "unreadable");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway status marks environment credentials as process-only and does not repeat a recovered error", async () => {
  const home = temporaryHome();
  const savedHome = process.env.HOME;
  const savedAppId = process.env.HARA_FEISHU_APP_ID;
  const savedSecret = process.env.HARA_FEISHU_APP_SECRET;
  const scope = gatewayRuntimeScope("feishu", "credential-owned-by-another-process");
  let now = 1_000;
  try {
    process.env.HOME = home;
    delete process.env.HARA_FEISHU_APP_ID;
    delete process.env.HARA_FEISHU_APP_SECRET;
    const release = acquireGatewayInstance(scope, { home, displayPlatform: "feishu", now: () => now });
    const reporter = await GatewayRuntimeReporter.open(scope, "feishu", { home, now: () => now });
    now = 2_000;
    reporter.error("network");
    now = 3_000;
    reporter.connected();
    await reporter.flush();

    const status = await gatewayStatus("feishu");
    assert.equal(status.configuration, "process-only");
    assert.equal(status.running, true);
    assert.equal(status.runtimeState, "connected");
    assert.equal(status.lastErrorCode, "network", "last error remains available as resolved history");
    assert.equal(status.recommendation, "none");

    release();
    reporter.stopped();
    await reporter.flush();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedAppId === undefined) delete process.env.HARA_FEISHU_APP_ID;
    else process.env.HARA_FEISHU_APP_ID = savedAppId;
    if (savedSecret === undefined) delete process.env.HARA_FEISHU_APP_SECRET;
    else process.env.HARA_FEISHU_APP_SECRET = savedSecret;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway instance lease reclaims a proven-dead owner but never unlinks a replacement", () => {
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const lock = join(dir, "instance-feishu.lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lock, JSON.stringify({
      pid: 2_147_483_647,
      token: "a".repeat(32),
      startedAt: 1,
      platform: "feishu",
    }), { mode: 0o600 });

    const release = acquireGatewayInstance("feishu", { home, pidAlive: () => false });
    const owned = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(owned.pid, process.pid);

    unlinkSync(lock);
    const replacement = {
      pid: process.pid,
      token: "b".repeat(32),
      startedAt: Date.now(),
      platform: "feishu",
    };
    writeFileSync(lock, JSON.stringify(replacement), { mode: 0o600 });
    release();
    assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), replacement);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway instance lease recovers an atomically-published lock whose staging link survived a crash", () => {
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const lock = join(dir, "instance-feishu.lock");
  const record = {
    pid: 2_147_483_647,
    token: "c".repeat(32),
    startedAt: 1,
    platform: "feishu",
  };
  const staging = `${lock}.${record.pid}.${record.token}.pending`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(staging, JSON.stringify(record), { mode: 0o600 });
    linkSync(staging, lock);
    assert.equal(statSync(lock).nlink, 2);

    const release = acquireGatewayInstance("feishu", { home, pidAlive: () => false });
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid);
    assert.equal(existsSync(staging), false);
    release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway instance lease fails closed on malformed or aliased state", () => {
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const lock = join(dir, "instance-feishu.lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lock, "not-json", { mode: 0o600 });
    assert.throws(() => acquireGatewayInstance("feishu", { home }), /malformed gateway instance lock/);
    assert.throws(() => acquireGatewayInstance("../feishu", { home }), /invalid gateway platform/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway instance lock rejects a FIFO without blocking startup", (t) => {
  if (process.platform === "win32") return t.skip("POSIX FIFO assertion");
  const mkfifo = ["/usr/bin/mkfifo", "/bin/mkfifo"].find(existsSync);
  if (!mkfifo) return t.skip("mkfifo is unavailable");
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const lock = join(dir, "instance-feishu.lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const made = spawnSync(mkfifo, [lock], { timeout: 1_000 });
    assert.equal(made.status, 0, made.stderr?.toString());
    const started = Date.now();
    assert.throws(() => acquireGatewayInstance("feishu", { home }), /malformed gateway instance lock/);
    assert.ok(Date.now() - started < 1_000, "special files cannot pin lock acquisition");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway instance lease reclaims a recycled PID using process birth identity", () => {
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const lock = join(dir, "instance-feishu.lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      token: "d".repeat(32),
      startedAt: 1,
      platform: "feishu",
      birthIdentity: "test:previous-process",
    }), { mode: 0o600 });
    const release = acquireGatewayInstance("feishu", {
      home,
      pidAlive: () => true,
      processIdentity: () => "test:current-process",
    });
    const owned = JSON.parse(readFileSync(lock, "utf8"));
    assert.equal(owned.pid, process.pid);
    assert.equal(owned.birthIdentity, "test:current-process");
    release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("process identity only treats same-version unequal values as PID reuse", () => {
  assert.equal(compareProcessIdentity("linux-v1:boot:1", "linux-v1:boot:1"), "same");
  assert.equal(compareProcessIdentity("linux-v1:boot:1", "linux-v1:boot:2"), "different");
  assert.equal(compareProcessIdentity("linux-v1:boot:1", "linux-v2:boot:2"), "unknown");
  assert.equal(compareProcessIdentity(undefined, "linux-v1:boot:2"), "unknown");
  assert.equal(compareProcessIdentity("linux-v1:boot:1", null), "unknown");
});

test("gateway instance lease fails closed across an identity format upgrade", () => {
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  const lock = join(dir, "instance-feishu.lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const legacy = {
      pid: process.pid,
      token: "e".repeat(32),
      startedAt: 1,
      platform: "feishu",
      birthIdentity: "test-v1:previous-format",
    };
    writeFileSync(lock, JSON.stringify(legacy), { mode: 0o600 });
    assert.throws(() => acquireGatewayInstance("feishu", {
      home,
      pidAlive: () => true,
      processIdentity: () => "test-v2:current-format",
    }), /already running/);
    assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), legacy, "unknown identity versions are never stale evidence");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("macOS process identity is stable across caller timezone changes", {
  skip: process.platform !== "darwin",
}, () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utc = defaultProcessIdentity(process.pid);
    process.env.TZ = "Asia/Shanghai";
    const shanghai = defaultProcessIdentity(process.pid);
    assert.ok(utc);
    assert.equal(shanghai, utc);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("gateway message ids persist across restart, reject stale replay, expire, and stay bounded", async () => {
  const home = temporaryHome();
  let now = 1_800_000_000_000;
  const options = { home, now: () => now, ttlMs: 1_000, capacity: 2, startupGraceMs: 30_000 };
  try {
    const first = await GatewayMessageDeduper.open("feishu", options);
    const failed = await first.claim("om_first", now);
    assert.ok(failed);
    let duplicateSettled = false;
    const duplicate = first.claim("om_first", now).then((claim) => {
      duplicateSettled = true;
      return claim;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(duplicateSettled, false, "an in-flight duplicate waits for the owner instead of being acknowledged");
    await failed.release();
    const completed = await duplicate;
    assert.ok(completed, "a waiting duplicate takes over after failed delivery");
    await completed.complete();
    assert.equal(await first.claim("om_first", now), null);
    assert.equal(await first.claim("om_stale", now - 30_001), null);
    const durableOld = await first.claim("om_durable_old", now - 30_001, { durable: true });
    assert.ok(durableOld, "a locally durable spool/outcome bypasses startup age filtering");
    await durableOld.release();

    const restarted = await GatewayMessageDeduper.open("feishu", options);
    assert.equal(await restarted.claim("om_first", now), null, "restart keeps the recent completed id");

    now += 1_001;
    const expired = await restarted.claim("om_first", now);
    assert.ok(expired, "expired ids can be accepted again");
    await expired.complete();
    now++;
    const second = await restarted.claim("om_second", now);
    assert.ok(second);
    await second.complete();
    now++;
    const third = await restarted.claim("om_third", now);
    assert.ok(third);
    await third.complete();

    const file = join(home, ".hara", "gateway", "processed-feishu.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored.messages.map((entry) => entry.id), ["om_second", "om_third"]);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").includes("om_stale"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("only one waiting duplicate takes over a failed claim and the rest observe its success", async () => {
  const home = temporaryHome();
  try {
    let deduper = await GatewayMessageDeduper.open("telegram", { home });
    const owner = await deduper.claim("42");
    assert.ok(owner);
    const firstWaiter = deduper.claim("42");
    const secondWaiter = deduper.claim("42");
    await owner.release();

    const winner = await Promise.race([firstWaiter, secondWaiter]);
    assert.ok(winner, "one waiter claims the retry");
    await winner.complete();
    const outcomes = await Promise.all([firstWaiter, secondWaiter]);
    assert.equal(outcomes.filter(Boolean).length, 1);
    assert.equal(outcomes.filter((claim) => claim === null).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway dead-letters one stable poison event after three real failures but not shutdown releases", async () => {
  const home = temporaryHome();
  const savedError = console.error;
  const errors = [];
  try {
    console.error = (...args) => errors.push(args.map(String).join(" "));
    let deduper = await GatewayMessageDeduper.open("telegram", { home });

    const shutdown = await deduper.claim("shutdown-event");
    assert.ok(shutdown);
    await shutdown.release();
    const afterShutdown = await deduper.claim("shutdown-event");
    assert.ok(afterShutdown, "a shutdown release does not consume the poison budget");
    await afterShutdown.complete();

    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = await deduper.claim("sensitive-platform-message-id");
      assert.ok(claim);
      assert.equal(await claim.fail(), attempt === 3, `attempt ${attempt} exhaustion status`);
      if (attempt < 3) deduper = await GatewayMessageDeduper.open("telegram", { home });
    }
    assert.equal(await deduper.claim("sensitive-platform-message-id"), null);
    assert.equal(errors.filter((line) => line.includes("ALERT inbound event")).length, 1);
    assert.ok(errors.every((line) => !line.includes("sensitive-platform-message-id")), "the alarm logs only an opaque digest");

    const restarted = await GatewayMessageDeduper.open("telegram", { home });
    assert.equal(await restarted.claim("sensitive-platform-message-id"), null, "dead-letter consumption survives restart");
  } finally {
    console.error = savedError;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway event spool persists before ACK, deduplicates, backs off, and recovers after restart", async () => {
  const home = temporaryHome();
  let now = 1_800_000_000_000;
  const options = { home, now: () => now };
  const scope = gatewayRuntimeScope("feishu-inbound", "private-app-id");
  try {
    const first = await GatewayEventSpool.open(scope, options);
    assert.equal(await first.enqueue("event-1", { message: { message_id: "event-1", content: "private text" } }), true);
    assert.equal(await first.enqueue("event-1", { message: { message_id: "event-1", content: "duplicate" } }), false);
    const leased = await first.nextReady();
    assert.equal(leased.id, "event-1");
    assert.equal(await first.nextReady(), null, "one process cannot lease the same durable item twice");
    await first.release("event-1");

    const retry = await first.retry("event-1");
    assert.deepEqual(retry, { exhausted: false, attempts: 1, retryAfterMs: 2_000 });
    assert.equal(await first.nextReady(), null);

    now += 2_001;
    const restarted = await GatewayEventSpool.open(scope, options);
    assert.equal((await restarted.nextReady()).id, "event-1", "queued payload and backoff survive restart");
    await restarted.complete("event-1");
    assert.equal(await (await GatewayEventSpool.open(scope, options)).nextReady(), null);

    const file = join(home, ".hara", "gateway", `inbound-${scope}.json`);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").includes("private-app-id"), false, "credential identity is absent from spool state");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway flow runs persist one immutable decision and one retry budget across restarts", async () => {
  const home = temporaryHome();
  let now = 1_900_000_000_000;
  const options = { home, now: () => now };
  const scope = gatewayRuntimeScope("flow-runs", "credential-that-must-stay-opaque");
  const runKey = "a".repeat(64);
  const sourceKey = "b".repeat(64);
  try {
    const firstStore = await GatewayFlowRunStore.open(scope, options);
    const firstAdmission = await firstStore.claim(runKey, sourceKey);
    assert.equal(firstAdmission.kind, "claim");
    assert.equal(firstAdmission.claim.retry, false);
    assert.equal(firstAdmission.claim.output, undefined);
    await firstAdmission.claim.saveOutput("immutable model decision");
    assert.deepEqual(await firstAdmission.claim.fail(), { exhausted: false, alarm: false });

    const duringBackoff = await GatewayFlowRunStore.open(scope, options);
    const deferred = await duringBackoff.claim(runKey, sourceKey);
    assert.equal(deferred.kind, "backoff");
    assert.ok(deferred.retryAfterMs > 0);

    now += 2_001;
    const secondStore = await GatewayFlowRunStore.open(scope, options);
    const secondAdmission = await secondStore.claim(runKey, sourceKey);
    assert.equal(secondAdmission.kind, "claim");
    assert.equal(secondAdmission.claim.retry, true);
    assert.equal(secondAdmission.claim.output, "immutable model decision");
    await assert.rejects(
      secondAdmission.claim.saveOutput("changed model decision"),
      /immutable across retries/,
    );
    assert.deepEqual(await secondAdmission.claim.fail(), { exhausted: false, alarm: false });

    now += 4_001;
    const thirdStore = await GatewayFlowRunStore.open(scope, options);
    const thirdAdmission = await thirdStore.claim(runKey, sourceKey);
    assert.equal(thirdAdmission.kind, "claim");
    assert.equal(thirdAdmission.claim.output, "immutable model decision");
    assert.deepEqual(await thirdAdmission.claim.fail(), { exhausted: true, alarm: true });
    await thirdAdmission.claim.markAlarmed();

    const exhaustedStore = await GatewayFlowRunStore.open(scope, options);
    assert.deepEqual(await exhaustedStore.claim(runKey, sourceKey), { kind: "exhausted", alarm: false });
    assert.deepEqual(await exhaustedStore.load(runKey), {
      status: "exhausted",
      attempts: 3,
      output: "immutable model decision",
      alarmed: true,
    });

    await exhaustedStore.removeSource(sourceKey);
    assert.equal(await exhaustedStore.load(runKey), null, "platform ACK cleanup removes every rule for the source");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway run outcomes persist a started tombstone and immutable result so restart never reruns coding", async () => {
  const home = temporaryHome();
  const scope = gatewayRuntimeScope("run-cache", "credential-that-must-not-be-stored");
  try {
    const first = await GatewayRunOutcomeStore.open(scope, { home });
    assert.equal(await first.start("platform-message-id-secret"), null);

    const afterCrash = await GatewayRunOutcomeStore.open(scope, { home });
    assert.deepEqual(await afterCrash.load("platform-message-id-secret"), { status: "running" });
    assert.deepEqual(await afterCrash.start("platform-message-id-secret"), { status: "running" });

    const root = join(home, ".hara", "gateway");
    const outcomeDir = readdirSync(root).find((name) => name.startsWith("run-outcomes-"));
    assert.ok(outcomeDir);
    const names = readdirSync(join(root, outcomeDir));
    assert.equal(names.length, 1);
    const stale = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(join(root, outcomeDir, names[0]), stale, stale);
    const afterLongOffline = await GatewayRunOutcomeStore.open(scope, { home });
    assert.deepEqual(
      await afterLongOffline.load("platform-message-id-secret"),
      { status: "running" },
      "an unfinished execution marker survives restart beyond the result-payload TTL",
    );

    await afterLongOffline.finish("platform-message-id-secret", {
      reply: "completed answer",
      files: [{ safeName: "report.txt", bytes: Buffer.from("immutable attachment") }],
      voice: { safeName: "reply.m4a", bytes: Buffer.from("immutable voice") },
    });
    await first.finish("platform-message-id-secret", {
      reply: "must not replace first execution",
      files: [],
    });

    const restarted = await GatewayRunOutcomeStore.open(scope, { home });
    const cached = await restarted.load("platform-message-id-secret");
    assert.equal(cached.status, "complete");
    assert.equal(cached.reply, "completed answer");
    assert.equal(cached.files[0].safeName, "report.txt");
    assert.equal(cached.files[0].bytes.toString(), "immutable attachment");
    assert.equal(cached.voice.safeName, "reply.m4a");
    assert.equal(cached.voice.bytes.toString(), "immutable voice");

    assert.match(names[0], /^[a-f0-9]{64}\.json$/);
    assert.doesNotMatch(`${outcomeDir}/${names[0]}`, /credential-that|platform-message/);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(root, outcomeDir)).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, outcomeDir, names[0])).mode & 0o777, 0o600);
    }

    utimesSync(join(root, outcomeDir, names[0]), stale, stale);
    const afterCompletedPayloadTtl = await GatewayRunOutcomeStore.open(scope, { home });
    assert.deepEqual(
      await afterCompletedPayloadTtl.load("platform-message-id-secret"),
      { status: "terminal" },
      "expired reply/file bytes are dropped but the terminal execution marker is never silently deleted",
    );

    await afterCompletedPayloadTtl.remove("platform-message-id-secret");
    assert.equal(await afterCompletedPayloadTtl.load("platform-message-id-secret"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("completed run outcomes compact safely at capacity while ambiguous runs require explicit recovery", async () => {
  const home = temporaryHome();
  const completedScope = gatewayRuntimeScope("run-cache", "completed-capacity");
  const interruptedScope = gatewayRuntimeScope("run-cache", "interrupted-capacity");
  try {
    const completed = await GatewayRunOutcomeStore.open(completedScope, { home });
    for (let index = 0; index < 32; index++) {
      const id = `completed-${index}`;
      assert.equal(await completed.start(id), null);
      await completed.finish(id, { reply: `answer-${index}`, files: [] });
    }
    assert.equal(await completed.start("overflow"), null, "an old completed payload compacts to a fail-closed tombstone");
    const compactedIds = [];
    for (let index = 0; index < 32; index++) {
      if ((await completed.load(`completed-${index}`))?.status === "terminal") compactedIds.push(`completed-${index}`);
    }
    assert.equal(compactedIds.length, 1);
    let reruns = 0;
    const recovery = await executeDurableGatewayEffect(completed, compactedIds[0], async () => {
      reruns++;
      return { reply: "unsafe rerun", files: [] };
    });
    assert.equal(reruns, 0, "payload compaction never grants permission to rerun coding");
    assert.match(recovery.reply, /已经执行过/);
    assert.match(recovery.reply, /缓存回收/);
    assert.match(recovery.reply, /没有自动重跑/);

    const interrupted = await GatewayRunOutcomeStore.open(interruptedScope, { home });
    for (let index = 0; index < 32; index++) assert.equal(await interrupted.start(`interrupted-${index}`), null);
    await assert.rejects(
      interrupted.start("blocked-until-reviewed"),
      /32 ambiguous interrupted runs[\s\S]*will not rerun or delete[\s\S]*terminalize:<id>/i,
    );
    for (let index = 0; index < 32; index++) {
      assert.deepEqual(await interrupted.load(`interrupted-${index}`), { status: "running" });
    }
    assert.equal(
      await interrupted.recover("interrupted-0", "terminalize:interrupted-0"),
      "terminalized",
      "explicit recovery frees one active slot without deleting the no-rerun marker",
    );
    assert.deepEqual(await interrupted.load("interrupted-0"), { status: "terminal" });
    assert.equal(await interrupted.start("blocked-until-reviewed"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("run outcome recovery is single-id, confirmation-bound, and never deletes a running marker", async () => {
  const home = temporaryHome();
  const scope = gatewayRuntimeScope("run-cache", "operator-recovery");
  try {
    const store = await GatewayRunOutcomeStore.open(scope, { home });
    await store.start("reviewed-running");
    await store.start("unrelated-running");

    await assert.rejects(
      store.recover("reviewed-running", "terminalize:different-id"),
      /confirmation must exactly match/,
    );
    await assert.rejects(
      store.recover("reviewed-running", "delete-terminal:reviewed-running"),
      /refusing to delete an ambiguous running outcome/,
    );
    assert.deepEqual(await store.load("reviewed-running"), { status: "running" });

    assert.equal(await store.recover("reviewed-running", "terminalize:reviewed-running"), "terminalized");
    assert.equal(
      await store.recover("reviewed-running", "terminalize:reviewed-running"),
      "already-terminal",
      "repeating the running-recovery action is harmless",
    );
    assert.deepEqual(await store.load("reviewed-running"), { status: "terminal" });
    assert.deepEqual(await store.load("unrelated-running"), { status: "running" }, "no bulk recovery occurs");

    assert.equal(await store.recover("reviewed-running", "delete-terminal:reviewed-running"), "removed");
    assert.equal(await store.load("reviewed-running"), null);
    assert.equal(await store.recover("reviewed-running", "delete-terminal:reviewed-running"), "missing");

    await store.finish("unrelated-running", { reply: "deliverable result", files: [] });
    await assert.rejects(
      store.recover("unrelated-running", "delete-terminal:unrelated-running"),
      /refusing to discard a completed gateway outcome/,
      "a cached result awaiting acknowledgement is never discarded by recovery",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway CLI recovery locates one opaque marker from the original message id", async () => {
  const home = temporaryHome();
  const appId = "cli-recovery-test-app";
  const runtimeScope = gatewayRuntimeScope("feishu", appId);
  const scope = gatewayRuntimeScope("run-cache", runtimeScope);
  const messageId = "om_cli_recovery_original";
  const unrelatedId = "om_cli_recovery_unrelated";
  const cli = join(process.cwd(), "dist", "index.js");
  const run = (confirmation) => spawnSync(
    process.execPath,
    [cli, "gateway", "--platform", "feishu", "--recover-outcome", messageId, "--confirm-recovery", confirmation],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HARA_FEISHU_APP_ID: appId,
        HARA_FEISHU_APP_SECRET: "test-secret-never-written",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  try {
    const store = await GatewayRunOutcomeStore.open(scope, { home });
    await store.start(messageId);
    await store.start(unrelatedId);

    const releaseGateway = acquireGatewayInstance(runtimeScope, { home, displayPlatform: "feishu" });
    const whileLive = run(`terminalize:${messageId}`);
    releaseGateway();
    assert.notEqual(whileLive.status, 0);
    assert.match(whileLive.stdout + whileLive.stderr, /already running/);
    assert.deepEqual(await store.load(messageId), { status: "running" }, "recovery cannot race a live gateway");

    const unsafeDelete = run(`delete-terminal:${messageId}`);
    assert.notEqual(unsafeDelete.status, 0);
    assert.match(unsafeDelete.stdout + unsafeDelete.stderr, /refusing to delete an ambiguous running outcome/);
    assert.deepEqual(await store.load(messageId), { status: "running" });

    const terminalized = run(`terminalize:${messageId}`);
    assert.equal(terminalized.status, 0, terminalized.stderr || terminalized.stdout);
    assert.match(terminalized.stdout, /converted to terminal/);
    assert.deepEqual(await store.load(messageId), { status: "terminal" });
    assert.deepEqual(await store.load(unrelatedId), { status: "running" });

    const removed = run(`delete-terminal:${messageId}`);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.match(removed.stdout, /no longer protected/);
    assert.equal(await store.load(messageId), null);
    assert.deepEqual(await store.load(unrelatedId), { status: "running" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway status CLI accepts the documented subcommand order and returns one redacted platform", () => {
  const home = temporaryHome();
  const cli = join(process.cwd(), "dist", "index.js");
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "gateway", "status", "--platform", "weixin", "--json"],
      {
        cwd: home,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const status = JSON.parse(result.stdout);
    assert.equal(status.platform, "weixin");
    assert.equal(status.configuration, "missing");
    assert.equal("gateways" in status, false, "--platform returns one object, not an accidental all-platform list");
    assert.equal(JSON.stringify(status).includes("token"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("default voice transport retry reuses durable audio without rerunning coding or TTS", async () => {
  const home = temporaryHome();
  const scope = gatewayRuntimeScope("run-cache", "side-effect-test-credential");
  try {
    const firstStore = await GatewayRunOutcomeStore.open(scope, { home });
    const receiptScope = gatewayRuntimeScope("effect-receipts", "side-effect-test-credential");
    const firstReceipts = await GatewayMessageDeduper.open(receiptScope, { home });
    let codingCalls = 0;
    let ttsCalls = 0;
    const first = await executeDurableGatewayEffect(firstStore, "voice-message", async () => {
      codingCalls++;
      ttsCalls++;
      return {
        reply: "completed answer",
        files: [],
        voice: { safeName: "speech.opus", bytes: Buffer.from("tts-snapshot"), snapshotPath: "" },
      };
    });

    let replyTransportCalls = 0;
    let voiceTransportCalls = 0;
    const runReceipt = async (receipts, key, effect) => {
      const claim = await receipts.claim(key);
      if (!claim) return;
      try {
        await effect();
        await claim.complete();
      } catch (error) {
        await claim.release();
        throw error;
      }
    };
    await runReceipt(firstReceipts, "reply-receipt", async () => { replyTransportCalls++; });
    await assert.rejects(
      runReceipt(firstReceipts, "voice-receipt", async () => {
        voiceTransportCalls++;
        throw new Error("first voice upload failed");
      }),
      /first voice upload failed/,
    );

    // Model platform redelivery after the reply receipt succeeded but the voice upload failed. Neither the
    // coding callback nor synthesis may run; only transport receives the immutable cached bytes.
    const restarted = await GatewayRunOutcomeStore.open(scope, { home });
    const retry = await executeDurableGatewayEffect(restarted, "voice-message", async () => {
      codingCalls++;
      ttsCalls++;
      return { reply: "wrong repeated effect", files: [] };
    });
    assert.equal(codingCalls, 1);
    assert.equal(ttsCalls, 1);
    assert.equal(retry.reply, "completed answer");
    assert.equal(retry.voice.bytes.toString(), "tts-snapshot", "cached audio replaces repeated TTS");
    const restartedReceipts = await GatewayMessageDeduper.open(receiptScope, { home });
    await runReceipt(restartedReceipts, "reply-receipt", async () => { replyTransportCalls++; });
    await runReceipt(restartedReceipts, "voice-receipt", async () => {
      voiceTransportCalls++;
      assert.equal(retry.voice.bytes.toString(), "tts-snapshot");
    });
    assert.equal(replyTransportCalls, 1, "a completed reply receipt suppresses duplicate text delivery");
    assert.equal(voiceTransportCalls, 2, "redelivery retries only the failed voice transport");

    // The same at-most-once store protects tmux injection and every durable stateful command too.

    await restarted.start("tmux-interrupted");
    let injections = 0;
    const interrupted = await executeDurableGatewayEffect(restarted, "tmux-interrupted", async () => {
      injections++;
      return { reply: "must not run", files: [] };
    });
    assert.equal(injections, 0, "a started tombstone never reinjects an ambiguous tmux command");
    assert.match(interrupted.reply, /没有自动重跑/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway dedupe store prunes by serialized bytes as well as entry count", async () => {
  const home = temporaryHome();
  const file = join(home, ".hara", "gateway", "processed-feishu.json");
  try {
    const deduper = await GatewayMessageDeduper.open("feishu", { home, capacity: 128 });
    for (let index = 0; index < 100; index++) {
      const prefix = `${index}:`;
      const claim = await deduper.claim(prefix + "\u0001".repeat(512 - prefix.length));
      assert.ok(claim);
      await claim.complete();
    }
    assert.ok(statSync(file).size <= 256 * 1024);
    assert.ok(JSON.parse(readFileSync(file, "utf8")).messages.length < 100);
    await GatewayMessageDeduper.open("feishu", { home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway inbound tracker drains callbacks and reports a bounded shutdown timeout", async () => {
  const tracker = new GatewayInboundTracker();
  let finishFirst;
  const first = new Promise((resolve) => { finishFirst = resolve; });
  tracker.track(first);
  setTimeout(finishFirst, 5);
  assert.equal(await tracker.drain(1_000), true);
  assert.equal(tracker.size, 0);

  let finishBlocked;
  const blocked = new Promise((resolve) => { finishBlocked = resolve; });
  tracker.track(blocked);
  assert.equal(await tracker.drain(1), false);
  assert.equal(tracker.size, 1);
  finishBlocked();
  await tracker.waitForIdle();
  assert.equal(tracker.size, 0);
});

test("gateway message dedupe state rejects malformed files instead of silently replaying", async () => {
  const home = temporaryHome();
  const dir = join(home, ".hara", "gateway");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "processed-feishu.json"), '{"version":1,"messages":"bad"}', { mode: 0o600 });
    await assert.rejects(() => GatewayMessageDeduper.open("feishu", { home }), /invalid gateway message dedupe store/);
    assert.equal(existsSync(join(dir, "processed-feishu.json")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
