import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync, statSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  newSessionId,
  shortId,
  resolveSessionId,
  saveSession,
  loadSession,
  listSessions,
  latestForCwd,
  titleFrom,
  deriveTitle,
} from "../dist/session/store.js";

test("session id is a full UUID", () => {
  assert.match(newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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
    assert.equal(loadSession("bad1"), null);
    assert.equal(loadSession("bad2"), null);
    assert.equal(loadSession("bad3"), null, "history must be an array");
    assert.doesNotThrow(() => listSessions(), "metaless/corrupt files are skipped, not crashed on");
    assert.deepEqual(listSessions(), []);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
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
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session persistence redacts user text/tool data and safely migrates legacy content on next save", () => {
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
    cwd: "/tmp/hara-redaction-test",
    provider: "qwen",
    model: "glm-5",
    title: "redaction test",
    createdAt: new Date().toISOString(),
    updatedAt: "",
  };
  const history = [
    { role: "user", content: `FEISHU_APP_SECRET=${secret}` },
    { role: "assistant", text: "using env", toolUses: [{ id: "t1", name: "bash", input: { command: `tool --token=${secret}` } }] },
    { role: "tool", results: [{ id: "t1", name: "bash", content: `Authorization: Bearer ${secret}` }] },
  ];
  try {
    saveSession(meta, history);
    assert.ok(history[0].content.includes(secret), "live history is not mutated");
    assert.ok(!readFileSync(join(dir, `${id}.json`), "utf8").includes(secret), "new session file is safe");

    const legacyMeta = { ...meta, id: legacyId };
    writeFileSync(join(dir, `${legacyId}.json`), JSON.stringify({ meta: legacyMeta, history: [{ role: "user", content: `API_KEY=${legacySecret}` }] }, null, 2));
    const loaded = loadSession(legacyId);
    assert.ok(loaded);
    assert.ok(!loaded.history[0].content.includes(legacySecret));
    assert.ok(readFileSync(join(dir, `${legacyId}.json`), "utf8").includes(legacySecret), "a read does not race by rewriting the legacy file");
    saveSession(loaded.meta, loaded.history);
    const migrated = join(dir, `${legacyId}.json`);
    assert.ok(!readFileSync(migrated, "utf8").includes(legacySecret), "the next explicit save migrates the file");
    assert.equal(statSync(migrated).mode & 0o777, 0o600, "session file is private");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
