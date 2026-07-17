import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, statSync, readdirSync, truncateSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSessionLock,
  releaseSessionLock,
  newSessionId,
  shortId,
  resolveSessionId,
  saveSession,
  loadSession,
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
  assert.match(newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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
    for (const id of ["bad4", "bad5", "bad6", "bad7", "bad8", "bad9", "bad10", "spoofed", "oversized", "too-deep"]) {
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
    assert.equal(resolveSessionId("shared-prefix-l"), second, "a unique prefix resolves");
    assert.equal(resolveSessionId("shared"), null, "an ambiguous prefix fails closed");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
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
      { role: "assistant", text: "done", toolUses: [] },
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
