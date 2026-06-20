import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
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

test("session: save → load round-trip, title, latestForCwd, list", () => {
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
    rmSync(join(homedir(), ".hara", "sessions", `${id}.json`), { force: true });
  }
});
