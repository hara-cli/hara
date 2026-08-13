import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, statSync, readdirSync, truncateSync, utimesSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSessionLock,
  releaseSessionLock,
  isGeneratedSessionId,
  newSessionId,
  shortId,
  resolveSessionId,
  saveSession,
  loadSession,
  deleteSession,
  ensureSessionMetadataIndex,
  findSessionMetadataByFragment,
  listSessionMetadataPage,
  listSessions,
  latestForCwd,
  titleFrom,
  deriveTitle,
  validSessionId,
  sessionFileExists,
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_JSON_DEPTH,
} from "../dist/session/store.js";
import { SessionHub } from "../dist/serve/sessions.js";

test("session id is a full UUID", () => {
  const id = newSessionId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(isGeneratedSessionId(id), true);
  assert.equal(isGeneratedSessionId("short-prefix"), false);
});

test("session ids cannot escape the private session directory", () => {
  for (const id of ["../outside", "a/b", "a\\b", "", ".", "..", `x${"y".repeat(221)}`]) {
    assert.equal(validSessionId(id), false, id);
    assert.equal(loadSession(id), null, id);
    assert.equal(acquireSessionLock(id).ok, false, id);
  }
  assert.equal(validSessionId("feishu-oc_123-uabc123-deadbe"), true);
  assert.equal(resolveSessionId("../../outside"), null);
});

test("deriveTitle: auto-summarizes the first message, keeps CJK, drops slash-commands, caps length", () => {
  assert.equal(deriveTitle("能识别图片吗"), "能识别图片吗"); // CJK preserved (not slugified to a random word)
  assert.equal(deriveTitle("/model glm-5"), "glm-5"); // leading slash-command dropped
  assert.equal(deriveTitle("  fix   the  null  check  "), "fix the null check"); // whitespace collapsed
  assert.equal(deriveTitle(""), ""); // blank → empty (caller falls back to short id)
  assert.ok(deriveTitle("x".repeat(80)).endsWith("…")); // long input capped
});

test("automation metadata history is cursor-paged without returning every transcript", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-page-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const created = [];
    for (let index = 0; index < 8; index++) {
      const id = `paged-cron-${index}`;
      saveSession({
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: `run ${index}`,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "",
        source: index < 6 ? "cron" : "interactive",
        ...(index < 6 ? { sourceName: "paged job", jobId: "paged-job" } : {}),
      }, [
        { role: "user", content: `full transcript ${index}` },
      ]);
      const stamp = new Date(Date.UTC(2026, 6, 24, 0, 0, index));
      utimesSync(join(dir, `${id}.json`), stamp, stamp);
      if (index < 6) created.push(id);
    }

    const seen = [];
    let cursor;
    do {
      const page = listSessionMetadataPage({
        sources: ["cron"],
        cursor,
        limit: 2,
      });
      assert.ok(page.sessions.length <= 2, "one response is server-bounded");
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      assert.ok(cursor, "a non-terminal page has an opaque continuation cursor");
    } while (seen.length < 20);
    assert.deepEqual(new Set(seen), new Set(created));
    assert.equal(seen.length, created.length, "pagination never duplicates a transcript");
    assert.throws(
      () => listSessionMetadataPage({ cursor: "not-a-valid-cursor" }),
      /invalid session metadata cursor/i,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session metadata sidecars cannot overwrite or delete a legal transcript id", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-sidecar-namespace-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const meta = (id, title) => ({
      id,
      cwd: project,
      provider: "test",
      model: "test",
      title,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "",
    });

    saveSession(meta("foo.meta", "authoritative transcript"), [
      { role: "user", content: "history that must survive" },
    ]);
    saveSession(meta("foo", "neighbor session"), [
      { role: "user", content: "neighbor history" },
    ]);

    assert.equal(loadSession("foo.meta")?.history[0]?.content, "history that must survive");
    assert.deepEqual(
      new Set(listSessions().map((session) => session.id)),
      new Set(["foo.meta", "foo"]),
    );
    assert.equal(deleteSession("foo"), true);
    assert.equal(
      loadSession("foo.meta")?.history[0]?.content,
      "history that must survive",
      "deleting a neighboring session cannot unlink this transcript",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session metadata cursor uses one stable order when transcript mtimes are equal", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-page-ties-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const dir = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const ids = ["_a", "-a", "10", "2"];
    const stamp = new Date(Date.now() - 1_000);
    for (const id of ids) {
      saveSession({
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "",
        source: "cron",
        sourceName: "tie order",
        jobId: "tie-order",
      }, []);
      utimesSync(join(dir, `${id}.json`), stamp, stamp);
    }

    const seen = [];
    let cursor;
    do {
      const page = listSessionMetadataPage({ sources: ["cron"], cursor, limit: 1 });
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
      assert.ok(cursor);
    } while (seen.length < 10);

    assert.deepEqual(
      seen,
      [...ids].reverse(),
      "the append-only index has one deterministic newest-first order independent of locale collation",
    );
    assert.equal(new Set(seen).size, ids.length, "equal-mtime pagination skips and duplicates nothing");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a future-dated stale sidecar never overrides the authoritative transcript generation", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-sidecar-tie-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const id = "sidecar-generation-tie";
    const meta = {
      id,
      cwd: project,
      provider: "test",
      model: "test",
      title: "old title",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "",
      source: "cron",
      sourceName: "sidecar test",
      jobId: "sidecar-test",
    };
    saveSession(meta, [{ role: "user", content: "old transcript" }]);
    const sessions = join(home, ".hara", "sessions");
    const transcript = join(sessions, `${id}.json`);
    const sidecar = join(sessions, `${id}.metadata`);
    const staleSidecar = readFileSync(sidecar);

    meta.title = "new authoritative title";
    saveSession(meta, [{ role: "user", content: "new transcript" }]);
    writeFileSync(sidecar, staleSidecar);
    const transcriptStamp = new Date(Date.now() - 1_000);
    const futureSidecarStamp = new Date(Date.now() + 86_400_000);
    utimesSync(transcript, transcriptStamp, transcriptStamp);
    utimesSync(sidecar, futureSidecarStamp, futureSidecarStamp);

    assert.equal(listSessions().find((session) => session.id === id)?.title, "new authoritative title");
    assert.equal(
      listSessionMetadataPage({ sources: ["cron"], limit: 10 }).sessions
        .find((session) => session.id === id)?.title,
      "new authoritative title",
      "the paged index verifies the storage generation instead of trusting a restored/future mtime",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration stays incomplete while a transcript is locked and retries after release", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-held-lock-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    const id = "legacy-held-lock";
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: "held legacy",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));
    writeFileSync(join(sessions, `${id}.lock`), JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      token: "foreign-live-session-owner",
    }));

    await ensureSessionMetadataIndex({ force: true });
    assert.equal(
      existsSync(join(indexRoot, "legacy-migration.complete")),
      false,
      "a skipped live transcript cannot be hidden behind a completion marker",
    );
    assert.equal(loadSession(id)?.storageGeneration, undefined);

    rmSync(join(sessions, `${id}.lock`));
    await ensureSessionMetadataIndex();
    assert.ok(loadSession(id)?.storageGeneration, "the next ordinary call retries the skipped transcript");
    assert.equal(existsSync(join(indexRoot, "legacy-migration.complete")), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a waiter reclaims a migration lock when its owner exits without publishing a marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-dead-wait-owner-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  let owner;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    const id = "legacy-after-owner-exit";
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: "owner exit",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));
    owner = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    assert.ok(owner.pid);
    writeFileSync(join(indexRoot, "legacy-migration.lock"), JSON.stringify({
      pid: owner.pid,
      startedAt: Date.now(),
      token: "owner-that-will-exit",
    }));

    const migration = ensureSessionMetadataIndex({ force: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    owner.kill();
    await once(owner, "exit");
    owner = undefined;
    await Promise.race([
      migration,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("migration waiter did not reclaim the dead owner")),
        3_000,
      )),
    ]);
    assert.ok(loadSession(id)?.storageGeneration);
    assert.equal(existsSync(join(indexRoot, "legacy-migration.complete")), true);
  } finally {
    owner?.kill();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unsupported extended-year transcript is isolated while healthy legacy sessions migrate", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-year-boundary-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const writeLegacy = (id, updatedAt) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: updatedAt,
        updatedAt,
        source: "interactive",
      },
      history: [],
    }));
    writeLegacy("legacy-year-10000", "+010000-01-01T00:00:00.000Z");
    writeLegacy("legacy-healthy-year", "2026-07-24T00:00:00.000Z");

    await assert.doesNotReject(ensureSessionMetadataIndex({ force: true }));
    assert.ok(loadSession("legacy-healthy-year")?.storageGeneration);
    assert.equal(loadSession("legacy-year-10000"), null, "unsupported timestamps never enter an index bucket");
    assert.deepEqual(
      listSessionMetadataPage({ sources: ["interactive"], limit: 10 }).sessions.map((meta) => meta.id),
      ["legacy-healthy-year"],
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration is retryable and reclaims a complete dead-owner lock", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-migration-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, "legacy-indexed.json"), JSON.stringify({
      meta: {
        id: "legacy-indexed",
        cwd: project,
        provider: "test",
        model: "test",
        title: "legacy indexed session",
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        source: "cron",
        sourceName: "legacy cron",
      },
      history: [],
    }));
    writeFileSync(join(indexRoot, "legacy-migration.lock"), JSON.stringify({
      pid: 2_147_483_647,
      startedAt: Date.now() - 60_000,
      token: "dead-migration-owner",
    }));

    await ensureSessionMetadataIndex();
    assert.equal(
      listSessionMetadataPage({ sources: ["cron"], limit: 10 }).sessions[0]?.id,
      "legacy-indexed",
    );
    assert.equal(existsSync(join(indexRoot, "legacy-migration.complete")), true);
    assert.equal(existsSync(join(indexRoot, "legacy-migration.lock")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration rediscovers mixed-version writes and invalidates duplicate partial imports", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-mixed-writer-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexRoot, { recursive: true });
    mkdirSync(project, { recursive: true });
    const writeLegacy = (id, updatedAt) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: updatedAt,
        updatedAt,
        source: "cron",
        sourceName: "mixed writer",
        jobId: "mixed-writer",
      },
      history: [],
    }));

    const firstAt = "2026-07-23T10:00:00.000Z";
    writeLegacy("legacy-before-marker", firstAt);
    const firstBucketDir = join(indexRoot, "2026", "07", "23");
    mkdirSync(firstBucketDir, { recursive: true });
    const duplicate = `${JSON.stringify({
      v: 1,
      id: "legacy-before-marker",
      generation: "legacy",
      at: Date.parse(firstAt),
    })}\n`;
    writeFileSync(join(firstBucketDir, "10.ndjson"), duplicate + duplicate);

    await ensureSessionMetadataIndex();
    assert.ok(
      loadSession("legacy-before-marker")?.storageGeneration,
      "the compatibility import upgrades the authoritative transcript instead of appending another legacy record",
    );

    const afterAt = "2026-07-24T11:00:00.000Z";
    writeLegacy("legacy-after-marker", afterAt);
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { ensureSessionMetadataIndex } from './dist/session/store.js'; await ensureSessionMetadataIndex();",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(loadSession("legacy-after-marker")?.storageGeneration, "a later old-writer transcript is rediscovered");

    const seen = [];
    let cursor;
    do {
      const page = listSessionMetadataPage({ sources: ["cron"], cursor, limit: 1 });
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (seen.length < 10);
    assert.deepEqual(
      seen.sort(),
      ["legacy-after-marker", "legacy-before-marker"],
      "partial legacy imports cannot duplicate a session across cursor pages after conversion",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration publishes same-hour sessions in updatedAt order", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-migration-order-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const writeLegacy = (id, updatedAt) => writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: id,
        createdAt: updatedAt,
        updatedAt,
        source: "interactive",
      },
      history: [],
    }));
    writeLegacy("migration-order-a", "2026-07-24T03:10:00.000Z");
    writeLegacy("migration-order-b", "2026-07-24T03:20:00.000Z");
    const enumeration = readdirSync(sessions)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    assert.equal(enumeration.length, 2);
    // Make the first directory entry newer. An unsorted import appends it first and then incorrectly treats
    // the second entry as newest because cursor paging reads append-only shards backwards.
    const newerId = enumeration[0];
    const olderId = enumeration[1];
    writeLegacy(newerId, "2026-07-24T03:59:00.000Z");
    writeLegacy(olderId, "2026-07-24T03:01:00.000Z");

    await ensureSessionMetadataIndex();

    assert.deepEqual(
      listSessionMetadataPage({ sources: ["interactive"], limit: 2 }).sessions.map((meta) => meta.id),
      [newerId, olderId],
    );
    assert.equal(latestForCwd(project)?.meta.id, newerId);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("legacy metadata migration cannot move an older session ahead of a concurrent current save", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-concurrent-migration-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const now = new Date();
    const hourStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    )).toISOString();
    for (let index = 0; index < 32; index += 1) {
      const id = `concurrent-legacy-${String(index).padStart(2, "0")}`;
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        meta: {
          id,
          cwd: project,
          provider: "test",
          model: "test",
          title: id,
          createdAt: hourStart,
          updatedAt: hourStart,
          source: "interactive",
        },
        history: [],
      }));
    }

    const migration = ensureSessionMetadataIndex({ force: true });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    saveSession({
      id: "concurrent-current",
      cwd: project,
      provider: "test",
      model: "test",
      title: "current save",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
    }, []);
    await migration;

    assert.equal(
      latestForCwd(project)?.meta.id,
      "concurrent-current",
      "the route shard stays chronological even when migration yields to a current writer",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestForCwd continues past a full filtered index window", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-filter-window-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexDir = join(home, ".hara", "session-index", "v1", "2026", "07", "24");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const updatedAt = "2026-07-24T03:30:00.000Z";
    const writeLegacy = (id, source) => {
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        meta: {
          id,
          cwd: project,
          provider: "test",
          model: "test",
          title: id,
          createdAt: updatedAt,
          updatedAt,
          source,
          ...(source === "cron"
            ? { sourceName: "filter window", jobId: "filter-window" }
            : {}),
        },
        history: [],
      }));
      return JSON.stringify({
        v: 1,
        id,
        generation: "legacy",
        at: Date.parse(updatedAt),
      });
    };
    const records = [writeLegacy("interactive-behind-automation", "interactive")];
    for (let index = 0; index < 1_001; index += 1) {
      records.push(writeLegacy(`filtered-cron-${String(index).padStart(4, "0")}`, "cron"));
    }
    writeFileSync(join(indexDir, "03.ndjson"), `${records.join("\n")}\n`);

    const first = listSessionMetadataPage({
      cwd: project,
      sources: ["interactive"],
      limit: 1,
    });
    assert.deepEqual(first.sessions, []);
    assert.equal(first.hasMore, true);
    assert.equal(
      latestForCwd(project)?.meta.id,
      "interactive-behind-automation",
      "implicit resume follows bounded cursors instead of treating a filtered page as exhaustive",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestForCwd is independent of more than sixteen global automation pages", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-partitioned-resume-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    saveSession({
      id: "partitioned-interactive-target",
      cwd: project,
      provider: "test",
      model: "test",
      title: "interactive target",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
    }, []);
    const at = Date.now();
    const stamp = new Date(at);
    const year = String(stamp.getUTCFullYear()).padStart(4, "0");
    const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");
    const day = String(stamp.getUTCDate()).padStart(2, "0");
    const hour = String(stamp.getUTCHours()).padStart(2, "0");
    const global = join(home, ".hara", "session-index", "v1", year, month, day, `${hour}.ndjson`);
    const noise = [];
    for (let index = 0; index < 16_001; index += 1) {
      noise.push(JSON.stringify({
        v: 1,
        id: `partition-noise-${String(index).padStart(5, "0")}`,
        generation: "legacy",
        at: at + index + 1,
      }));
    }
    writeFileSync(global, `${noise.join("\n")}\n`, { flag: "a" });

    assert.equal(
      latestForCwd(project)?.meta.id,
      "partitioned-interactive-target",
      "implicit resume uses the complete source+cwd route instead of paging unrelated global records",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a durable migration marker prevents a new CLI process from sweeping transcripts again", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-marker-fast-path-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, "marker-legacy.json"), JSON.stringify({
      meta: {
        id: "marker-legacy",
        cwd: project,
        provider: "test",
        model: "test",
        title: "marker",
        createdAt: "2026-07-24T03:00:00.000Z",
        updatedAt: "2026-07-24T03:00:00.000Z",
        source: "interactive",
      },
      history: [],
    }));
    await ensureSessionMetadataIndex({ force: true });
    const marker = join(home, ".hara", "session-index", "v1", "legacy-migration.complete");
    const before = readFileSync(marker, "utf8");
    saveSession({
      id: "current-writer-after-marker",
      cwd: project,
      provider: "test",
      model: "test",
      title: "current writer",
      createdAt: "2026-07-24T03:01:00.000Z",
      updatedAt: "",
      source: "interactive",
    }, []);
    const lockedId = "locked-current-writer-after-marker";
    assert.equal(acquireSessionLock(lockedId).ok, true);
    saveSession({
      id: lockedId,
      cwd: project,
      provider: "test",
      model: "test",
      title: "locked current writer",
      createdAt: "2026-07-24T03:02:00.000Z",
      updatedAt: "",
      source: "interactive",
    }, []);
    releaseSessionLock(lockedId);
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { ensureSessionMetadataIndex } from './dist/session/store.js'; await ensureSessionMetadataIndex();",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      readFileSync(marker, "utf8"),
      before,
      "current saves and lock lifecycle advance the trusted watermark instead of forcing another sweep",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway startup imports legacy history before opening the transport", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-gateway-startup-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    const id = "feishu-oc_startup-u0123456789abcdef01234567-abcdef";
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
      meta: {
        id,
        cwd: project,
        provider: "test",
        model: "test",
        title: "legacy gateway",
        createdAt: "2026-07-24T03:00:00.000Z",
        updatedAt: "2026-07-24T03:00:00.000Z",
        source: "gateway",
        sourceName: "feishu",
      },
      history: [],
    }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.HARA_FEISHU_APP_ID;
    delete env.HARA_FEISHU_APP_SECRET;
    const child = spawnSync(process.execPath, [
      "dist/index.js",
      "gateway",
      "--platform",
      "feishu",
      "--cwd",
      project,
    ], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(child.status, 1, "the transport exits only because test credentials are intentionally absent");
    assert.match(child.stderr, /HARA_FEISHU_APP_ID/u);
    assert.ok(
      loadSession(id)?.storageGeneration,
      "legacy gateway history is migrated before transport configuration can end startup",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway fragment lookup finds an owned session older than the previous 100-session window", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-gateway-fragment-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const project = join(home, "project");
    const prefix = "feishu-oc_test-u0123456789abcdef01234567-";
    const route = `gateway-prefix-${createHash("sha256").update(prefix).digest("hex").slice(0, 32)}`;
    const routeDir = join(home, ".hara", "session-index", "v1", "routes", route, "2026", "07", "24");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(routeDir, { recursive: true });
    const records = [];
    for (let index = 0; index < 101; index += 1) {
      const id = `${prefix}abcdef${index ? `-${index}` : ""}`;
      const updatedAt = new Date(Date.UTC(2026, 6, 24, 3, 0, index)).toISOString();
      writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
        meta: {
          id,
          cwd: project,
          provider: "test",
          model: "test",
          title: id,
          createdAt: updatedAt,
          updatedAt,
          source: "gateway",
          sourceName: "feishu",
        },
        history: [],
      }));
      records.push(JSON.stringify({
        v: 1,
        id,
        generation: "legacy",
        at: Date.parse(updatedAt),
      }));
    }
    writeFileSync(join(routeDir, "03.ndjson"), `${records.join("\n")}\n`);

    const matches = findSessionMetadataByFragment("abcdef", {
      sources: ["gateway"],
      sourceName: "feishu",
      idPrefix: prefix,
      includeArchived: true,
    });
    assert.deepEqual(matches.map((meta) => meta.id), [`${prefix}abcdef`]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("metadata paging remains resumable across more empty shards than one request may inspect", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-index-empty-shards-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const sessions = join(home, ".hara", "sessions");
    const indexRoot = join(home, ".hara", "session-index", "v1");
    const project = join(home, "project");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const newest = Date.UTC(2026, 6, 24, 12);
    for (let offset = 0; offset < 300; offset++) {
      const date = new Date(newest - offset * 3_600_000);
      const year = String(date.getUTCFullYear()).padStart(4, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      const hour = String(date.getUTCHours()).padStart(2, "0");
      const dir = join(indexRoot, year, month, day);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${hour}.ndjson`), "");
    }

    const oldest = new Date(newest - 300 * 3_600_000);
    const updatedAt = oldest.toISOString();
    writeFileSync(join(sessions, "oldest-valid.json"), JSON.stringify({
      meta: {
        id: "oldest-valid",
        cwd: project,
        provider: "test",
        model: "test",
        title: "oldest valid",
        createdAt: updatedAt,
        updatedAt,
        source: "cron",
        sourceName: "empty shard test",
      },
      history: [],
    }));
    const year = String(oldest.getUTCFullYear()).padStart(4, "0");
    const month = String(oldest.getUTCMonth() + 1).padStart(2, "0");
    const day = String(oldest.getUTCDate()).padStart(2, "0");
    const hour = String(oldest.getUTCHours()).padStart(2, "0");
    const oldestDir = join(indexRoot, year, month, day);
    mkdirSync(oldestDir, { recursive: true });
    writeFileSync(join(oldestDir, `${hour}.ndjson`), `${JSON.stringify({
      v: 1,
      id: "oldest-valid",
      generation: "legacy",
      at: oldest.getTime(),
    })}\n`);

    const first = listSessionMetadataPage({ sources: ["cron"], limit: 1 });
    assert.deepEqual(first.sessions, []);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor, "the shard budget yields an opaque continuation instead of hiding older data");
    const second = listSessionMetadataPage({ sources: ["cron"], limit: 1, cursor: first.nextCursor });
    assert.equal(second.sessions[0]?.id, "oldest-valid");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestForCwd ignores a newer automation occurrence", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-session-latest-interactive-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    saveSession({
      id: "interactive-before-cron",
      cwd: project,
      provider: "test",
      model: "test",
      title: "manual work",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "interactive",
    }, []);
    saveSession({
      id: "newer-cron-occurrence",
      cwd: project,
      provider: "test",
      model: "test",
      title: "scheduled work",
      createdAt: new Date().toISOString(),
      updatedAt: "",
      source: "cron",
      sourceName: "scheduled work",
      jobId: "scheduled-work",
    }, []);

    assert.equal(
      latestForCwd(project)?.meta.id,
      "interactive-before-cron",
      "implicit continue/resume never crosses into an automation audience",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session: corrupt / malformed files don't crash load or list (audit M4)", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const dir = join(home, ".hara", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad1.json"), "{ not valid json"); // parse error
    writeFileSync(join(dir, "bad2.json"), JSON.stringify({})); // no meta/history
    writeFileSync(join(dir, "bad3.json"), JSON.stringify({ meta: { id: "bad3" }, history: "nope" })); // history not an array
    const validMeta = {
      id: "template",
      cwd: "/tmp/project",
      provider: "qwen",
      model: "glm-5",
      title: "template",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-13T08:00:00.000Z",
    };
    writeFileSync(join(dir, "bad4.json"), JSON.stringify({ meta: { ...validMeta, id: "bad4", updatedAt: 42 }, history: [] }));
    writeFileSync(join(dir, "bad5.json"), JSON.stringify({ meta: { ...validMeta, id: "bad5", createdAt: "not-a-date" }, history: [] }));
    writeFileSync(join(dir, "bad6.json"), JSON.stringify({ meta: { ...validMeta, id: "bad6", workingSet: ["ok", 42] }, history: [] }));
    writeFileSync(join(dir, "bad7.json"), JSON.stringify({ meta: { ...validMeta, id: "bad7", todos: [{ text: "x", status: "bogus" }] }, history: [] }));
    writeFileSync(join(dir, "bad8.json"), JSON.stringify({ meta: { ...validMeta, id: "bad8", archived: "yes" }, history: [] }));
    writeFileSync(join(dir, "bad9.json"), JSON.stringify({ meta: { ...validMeta, id: "bad9" }, history: [null] }));
    writeFileSync(join(dir, "bad10.json"), JSON.stringify({ meta: { ...validMeta, id: "bad10" }, history: [{ role: "assistant", text: "x" }] }));
    writeFileSync(join(dir, "bad11.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad11" },
      history: [{ role: "assistant", text: "x", toolUses: [], continuation: { type: "unknown", text: "x" } }],
    }));
    writeFileSync(join(dir, "bad12.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad12" },
      history: [{ role: "assistant", text: "x", toolUses: [], continuation: { type: "chat_reasoning", text: "x".repeat(128_001) } }],
    }));
    writeFileSync(join(dir, "bad13.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad13" },
      history: [{
        role: "assistant",
        text: "x",
        toolUses: [],
        continuation: {
          type: "responses_reasoning",
          items: Array.from({ length: 65 }, (_, index) => ({ type: "reasoning", id: `r-${index}`, summary: [] })),
        },
      }],
    }));
    writeFileSync(join(dir, "bad14.json"), JSON.stringify({
      meta: { ...validMeta, id: "bad14" },
      history: [{
        role: "assistant",
        text: "x",
        toolUses: [],
        continuation: {
          type: "responses_reasoning",
          items: [{ type: "reasoning", id: "r-1", summary: [{ type: "summary_text", text: 42 }] }],
        },
      }],
    }));
    writeFileSync(join(dir, "spoofed.json"), JSON.stringify({ meta: { ...validMeta, id: "different" }, history: [] }));
    const oversized = join(dir, "oversized.json");
    writeFileSync(oversized, "{}");
    truncateSync(oversized, MAX_SESSION_FILE_BYTES + 1);
    let nested = { leaf: true };
    for (let depth = 0; depth < MAX_SESSION_JSON_DEPTH + 2; depth += 1) nested = { next: nested };
    writeFileSync(join(dir, "too-deep.json"), JSON.stringify({
      meta: { ...validMeta, id: "too-deep" },
      history: [{ role: "assistant", text: "x", toolUses: [{ id: "t", name: "deep", input: nested }] }],
    }));
    assert.equal(loadSession("bad1"), null);
    assert.equal(sessionFileExists("bad1"), true, "callers can fail closed instead of overwriting corrupt data");
    assert.equal(sessionFileExists("missing"), false);
    assert.equal(loadSession("bad2"), null);
    assert.equal(loadSession("bad3"), null, "history must be an array");
    for (const id of ["bad4", "bad5", "bad6", "bad7", "bad8", "bad9", "bad10", "bad11", "bad12", "bad13", "bad14", "spoofed", "oversized", "too-deep"]) {
      assert.equal(loadSession(id), null, id);
    }
    assert.doesNotThrow(() => listSessions(), "metaless/corrupt files are skipped, not crashed on");
    assert.deepEqual(listSessions(), []);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveSessionId prefers an exact id and rejects ambiguous prefixes", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-prefix-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const first = "shared-prefix";
  const second = "shared-prefix-longer";
  try {
    for (const [id, minute] of [[first, "00"], [second, "01"]]) {
      saveSession({
        id,
        cwd: "/tmp/prefix",
        provider: "qwen",
        model: "glm-5",
        title: id,
        createdAt: `2026-07-13T08:${minute}:00.000Z`,
        updatedAt: "",
      }, []);
    }
    assert.equal(resolveSessionId(first), first, "an exact id wins even when it prefixes another id");
    assert.equal(
      resolveSessionId(first, { allowPrefix: false }),
      first,
      "exact-only resolution still finds an existing exact session",
    );
    assert.equal(resolveSessionId("shared-prefix-l"), second, "a unique prefix resolves");
    assert.equal(
      resolveSessionId("shared-prefix-l", { allowPrefix: false }),
      null,
      "generated exact session ids can bypass historical prefix scans",
    );
    assert.equal(resolveSessionId("shared"), null, "an ambiguous prefix fails closed");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("every displayed eight-character id remains resolvable past 8,000 obsolete generations", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-short-route-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const id = "1234abcd-0000-4000-8000-000000000001";
    saveSession({
      id,
      cwd: join(home, "project"),
      provider: "test",
      model: "test",
      title: "short route target",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "",
      source: "interactive",
    }, [{ role: "user", content: "short route target" }]);
    const data = loadSession(id);
    assert.ok(data?.storageGeneration);
    const at = Date.parse(data.meta.updatedAt);
    const date = new Date(at);
    const route = `id-short-${createHash("sha256").update(id.slice(0, 8)).digest("hex").slice(0, 32)}`;
    const routeDir = join(
      home,
      ".hara",
      "session-index",
      "v1",
      "routes",
      route,
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    const shard = join(routeDir, `${String(date.getUTCHours()).padStart(2, "0")}.ndjson`);
    const stale = JSON.stringify({
      v: 1,
      id,
      generation: "00000000-0000-4000-8000-000000000002",
      at,
    });
    writeFileSync(shard, `${Array(8_001).fill(stale).join("\n")}\n`, { flag: "a" });

    assert.equal(
      resolveSessionId(id.slice(0, 8)),
      id,
      "short-id lookup exhausts its dedicated collision route instead of stopping after eight pages",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("deriveTitle tolerates a non-string (a malformed history's content)", () => {
  assert.equal(deriveTitle(undefined), "");
  assert.equal(deriveTitle(42), "");
});

test("session: save → load round-trip, title, latestForCwd, list", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-roundtrip-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const id = newSessionId();
  const cwd = "/tmp/hara-sess-" + id;
  try {
    const history = [
      { role: "user", content: "hello world task" },
      {
        role: "assistant",
        text: "I will inspect it",
        toolUses: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }],
        continuation: {
          type: "responses_reasoning",
          items: [{
            type: "reasoning",
            id: "reason-1",
            summary: [],
            content: [{ type: "reasoning_text", text: "Inspect the requested file." }],
            status: "completed",
          }],
        },
      },
    ];
    const meta = {
      id,
      cwd,
      provider: "qwen",
      model: "glm-5",
      title: titleFrom(history),
      createdAt: new Date().toISOString(),
      updatedAt: "",
    };
    saveSession(meta, history);

    const loaded = loadSession(id);
    assert.ok(loaded);
    assert.equal(loaded.meta.id, id);
    assert.equal(loaded.meta.title, "hello world task"); // natural auto-summary (CJK-safe), not a slug
    assert.equal(loaded.history.length, 2);
    assert.deepEqual(loaded.history[1].continuation, history[1].continuation, "provider continuation survives resume exactly");
    assert.equal(latestForCwd(cwd)?.meta.id, id);
    assert.ok(listSessions(cwd).some((m) => m.id === id));
    assert.equal(resolveSessionId(shortId(id)), id); // resume by short-id prefix resolves to the full UUID
    const dir = join(home, ".hara", "sessions");
    assert.equal(statSync(dir).mode & 0o777, 0o700, "session directory is private");
    assert.equal(statSync(join(dir, `${id}.json`)).mode & 0o777, 0o600, "session file is private");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session persistence deeply redacts a copy; legacy list/load are strictly read-only", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-redact-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const id = newSessionId();
  const legacyId = newSessionId();
  const secret = "feishu-super-secret-123456";
  const legacySecret = "legacy-super-secret-987654";
  const dir = join(homedir(), ".hara", "sessions");
  const meta = {
    id,
    cwd: `/tmp/API_KEY=${secret}/hara-redaction-test`, // structural path must not be corrupted by redaction
    provider: "qwen",
    model: "glm-5",
    title: "redaction test",
    createdAt: new Date().toISOString(),
    updatedAt: "",
    source: "gateway",
    effort: "high",
    archived: true,
    gatewayOwner: "telegram:12345",
  };
  const history = [
    { role: "user", content: `FEISHU_APP_SECRET=${secret}` },
    { role: "assistant", text: "using env", toolUses: [{ id: "t1", name: "bash", input: { command: `tool --token=${secret}` } }] },
    { role: "tool", results: [{ id: "t1", name: "bash", content: `Authorization: Bearer ${secret}` }] },
  ];
  try {
    saveSession(meta, history);
    assert.ok(history[0].content.includes(secret), "live history is not mutated");
    assert.ok(history[1].toolUses[0].input.command.includes(secret), "nested live tool input is not mutated");
    const saved = readFileSync(join(dir, `${id}.json`), "utf8");
    assert.ok(!JSON.parse(saved).history.some((m) => JSON.stringify(m).includes(secret)), "new persisted history is safe");
    assert.equal(JSON.parse(saved).meta.cwd, meta.cwd, "structural cwd remains resumable byte-for-byte");
    assert.equal(JSON.parse(saved).meta.gatewayOwner, meta.gatewayOwner, "routing ownership metadata is preserved");

    const legacyMeta = { ...meta, id: legacyId };
    const legacyPath = join(dir, `${legacyId}.json`);
    const legacyRaw = JSON.stringify({ meta: legacyMeta, history: [{ role: "user", content: `API_KEY=${legacySecret}` }] }, null, 2);
    writeFileSync(legacyPath, legacyRaw);
    const loaded = loadSession(legacyId);
    assert.ok(loaded);
    assert.ok(!loaded.history[0].content.includes(legacySecret), "legacy secrets are redacted from the in-memory copy");
    listSessions();
    assert.equal(readFileSync(legacyPath, "utf8"), legacyRaw, "list/load never scrub or write a legacy file");

    saveSession(loaded.meta, loaded.history);
    assert.ok(!readFileSync(legacyPath, "utf8").includes(legacySecret), "the next explicit save redacts legacy content");
    assert.equal(statSync(legacyPath).mode & 0o777, 0o600, "explicit save also tightens a legacy file");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session lock: O_EXCL excludes another process, malformed locks fail closed, and files are private", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-lock-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const id = `lock-${newSessionId()}`;
  const malformedId = `malformed-${newSessionId()}`;
  const storeUrl = new URL("../dist/session/store.js", import.meta.url).href;
  try {
    assert.equal(acquireSessionLock(id).ok, true);
    assert.equal(acquireSessionLock(id).ok, true, "same module instance may re-enter its own tokenized lock");
    const lockPath = join(home, ".hara", "sessions", `${id}.lock`);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);

    const probe = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "const m=await import(process.env.STORE_URL); process.stdout.write(JSON.stringify(m.acquireSessionLock(process.env.LOCK_ID)));"],
      { encoding: "utf8", env: { ...process.env, HOME: home, STORE_URL: storeUrl, LOCK_ID: id } },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { ok: false, pid: process.pid }, "another process cannot pass the lock race");
    releaseSessionLock(id);

    const malformedPath = join(home, ".hara", "sessions", `${malformedId}.lock`);
    writeFileSync(malformedPath, "not-json", { mode: 0o600 });
    assert.deepEqual(acquireSessionLock(malformedId), { ok: false }, "unknown ownership fails closed");
    assert.equal(readFileSync(malformedPath, "utf8"), "not-json", "fail-closed acquisition does not destroy evidence");
  } finally {
    releaseSessionLock(id);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session save: concurrent readers observe only complete old/new JSON and no temp files survive", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sess-atomic-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const id = newSessionId();
  const meta = {
    id,
    cwd: "/tmp/hara-atomic",
    provider: "openai",
    model: "test-model",
    title: "atomic",
    createdAt: new Date().toISOString(),
    updatedAt: "",
  };
  try {
    saveSession(meta, [{ role: "user", content: "seed" }]);
    const path = join(home, ".hara", "sessions", `${id}.json`);
    const code = `
      const fs = require("node:fs");
      const path = process.env.SESSION_PATH;
      process.stdout.write("ready\\n");
      const end = Date.now() + 500;
      let error = "";
      while (Date.now() < end) {
        try { JSON.parse(fs.readFileSync(path, "utf8")); }
        catch (e) { error = String(e && e.message || e); break; }
      }
      process.stdout.write(JSON.stringify({ error }));
    `;
    const reader = spawn(process.execPath, ["-e", code], {
      env: { ...process.env, SESSION_PATH: path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    reader.stdout.setEncoding("utf8");
    reader.stderr.setEncoding("utf8");
    reader.stdout.on("data", (chunk) => { stdout += chunk; });
    reader.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = once(reader, "exit");
    while (!stdout.includes("ready\n")) await once(reader.stdout, "data");

    for (let i = 0; i < 150; i++) {
      saveSession(meta, [{ role: "user", content: `generation ${i} ${"x".repeat((i % 10) * 1000)}` }]);
    }
    const [status] = await exited;
    assert.equal(status, 0, stderr);
    const report = JSON.parse(stdout.slice(stdout.indexOf("\n") + 1));
    assert.equal(report.error, "", `reader saw a partial session: ${report.error}`);
    assert.deepEqual(readdirSync(join(home, ".hara", "sessions")).filter((name) => name.includes(".tmp")), []);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionHub acquires before load and locks offline rename/archive mutations", () => {
  const events = [];
  let locked = false;
  let data = {
    meta: {
      id: "stored",
      cwd: "/tmp/stored",
      provider: "old",
      model: "old-model",
      title: "old title",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    history: [{ role: "user", content: "latest history" }],
    task: {
      schemaVersion: 1,
      id: "task-stored",
      objective: "finish stored task",
      status: "running",
      turnId: "turn-stored",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const store = {
    acquire(id) {
      events.push(`acquire:${id}`);
      if (locked) return { ok: false, pid: 123 };
      locked = true;
      return { ok: true };
    },
    release(id) {
      events.push(`release:${id}`);
      locked = false;
    },
    load(id) {
      events.push(`load:${id}`);
      return id === data.meta.id ? structuredClone(data) : null;
    },
    save(meta, history, task) {
      events.push(`save:${meta.id}`);
      data = structuredClone({ meta, history, ...(task ? { task } : {}) });
    },
    list() { return []; },
    delete() { return false; },
  };
  const provider = { id: "new-provider", model: "new-model", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store);

  const resumed = hub.resume("stored", { provider, approval: "suggest" });
  assert.ok("session" in resumed);
  assert.deepEqual(events.slice(0, 2), ["acquire:stored", "load:stored"], "resume reads only after locking");
  assert.equal(resumed.session.meta.provider, "new-provider");
  assert.equal(resumed.session.meta.model, "old-model", "resume keeps the persisted model pin");
  assert.equal(resumed.session.continuationSession, true, "non-empty persisted history enables continuity guidance");
  assert.equal(resumed.session.task.status, "paused", "a persisted running task recovers as paused/interrupted");
  assert.equal(resumed.session.task.objective, "finish stored task", "resume keeps task identity outside history");

  events.length = 0;
  resumed.session.busy = true;
  assert.deepEqual(hub.resume("stored", { provider, approval: "suggest" }), { busy: true });
  assert.equal(hub.rename("stored", "must wait"), false);
  assert.equal(hub.setArchived("stored", true), false);
  assert.deepEqual(events, [], "busy live-session metadata never reaches persistence");
  resumed.session.busy = false;
  resumed.session.configuring = true;
  assert.deepEqual(hub.resume("stored", { provider, approval: "suggest" }), { busy: true });
  assert.equal(hub.rename("stored", "must still wait"), false);
  assert.equal(hub.setArchived("stored", true), false);
  assert.deepEqual(events, [], "configuring live-session metadata never reaches persistence");
  resumed.session.configuring = false;

  assert.equal(hub.detach("stored"), true, "failed client handshakes can detach without deleting persistence");
  assert.equal(hub.get("stored"), undefined);
  assert.equal(events.at(-1), "release:stored");

  events.length = 0;
  assert.equal(hub.rename("stored", "new title"), true);
  assert.deepEqual(events, ["acquire:stored", "load:stored", "save:stored", "release:stored"]);
  assert.equal(data.meta.title, "new title");

  events.length = 0;
  assert.equal(hub.setArchived("stored", true), true);
  assert.deepEqual(events, ["acquire:stored", "load:stored", "save:stored", "release:stored"]);
  assert.equal(data.meta.archived, true);

  data.history = [];
  events.length = 0;
  const emptyResume = hub.resume("stored", { provider, approval: "suggest" });
  assert.ok("session" in emptyResume);
  assert.equal(emptyResume.session.continuationSession, false, "an empty session does not claim an existing task");
  assert.equal(hub.detach("stored"), true);

  locked = true;
  events.length = 0;
  assert.equal(hub.rename("stored", "must not write"), false);
  assert.deepEqual(events, ["acquire:stored"], "a held lock prevents even the pre-write load");
});

test("SessionHub releaseIdle keeps in-flight locks and releases only quiescent sessions", () => {
  const released = [];
  const saved = new Map();
  const store = {
    acquire: () => ({ ok: true }),
    release: (id) => released.push(id),
    load: (id) => saved.get(id) ?? null,
    save: (meta, history) => saved.set(meta.id, structuredClone({ meta, history })),
    list: () => [],
    delete: (id) => saved.delete(id),
  };
  const provider = { id: "fake", model: "fake-1", async turn() { throw new Error("unused"); } };
  const hub = new SessionHub(store);
  const busy = hub.create({ cwd: "/tmp/busy", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  const configuring = hub.create({ cwd: "/tmp/configuring", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  const idle = hub.create({ cwd: "/tmp/idle", provider, providerId: provider.id, model: provider.model, approval: "suggest" });
  busy.busy = true;
  configuring.configuring = true;

  hub.releaseIdle();
  assert.equal(hub.get(idle.meta.id), undefined);
  assert.equal(hub.get(busy.meta.id), busy);
  assert.equal(hub.get(configuring.meta.id), configuring);
  assert.deepEqual(released, [idle.meta.id]);

  busy.busy = false;
  configuring.configuring = false;
  hub.releaseAll();
  assert.deepEqual(new Set(released), new Set([idle.meta.id, busy.meta.id, configuring.meta.id]));
});
