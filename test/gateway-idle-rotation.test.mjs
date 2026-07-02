// Gateway session hygiene: a chat idle past HARA_GATEWAY_IDLE_HOURS auto-rotates to a fresh session
// (same mechanics as /new), returning the old id so the user can /resume it. Hermetic via $HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "hara-gw-home-")); // BEFORE importing sessions.js
const { chatContext, idleRotationMs } = await import("../dist/gateway/sessions.js");

const chatsFile = () => join(process.env.HOME, ".hara", "gateway", "chats.json");
const setLastUsed = (ts) => {
  const m = JSON.parse(readFileSync(chatsFile(), "utf8"));
  for (const k of Object.keys(m)) m[k].lastUsed = ts;
  writeFileSync(chatsFile(), JSON.stringify(m));
};

test("idleRotationMs: default 8h, env-tunable, 0/garbage disables", () => {
  delete process.env.HARA_GATEWAY_IDLE_HOURS;
  assert.equal(idleRotationMs(), 8 * 3_600_000, "default 8h");
  process.env.HARA_GATEWAY_IDLE_HOURS = "2";
  assert.equal(idleRotationMs(), 2 * 3_600_000);
  process.env.HARA_GATEWAY_IDLE_HOURS = "0";
  assert.equal(idleRotationMs(), 0, "0 → disabled");
  process.env.HARA_GATEWAY_IDLE_HOURS = "abc";
  assert.equal(idleRotationMs(), 0, "garbage → disabled (never surprise-rotate on bad config)");
  delete process.env.HARA_GATEWAY_IDLE_HOURS;
});

test("chat idle past the window rotates to a fresh session and hands back the old id", () => {
  delete process.env.HARA_GATEWAY_IDLE_HOURS; // 8h default
  const first = chatContext("weixin", "chat1", "/tmp/proj");
  assert.ok(first.sessionId && !first.rotatedFrom, "first contact: fresh entry, no rotation");
  // Same-afternoon follow-up (1h idle) → same thread.
  setLastUsed(Date.now() - 1 * 3_600_000);
  const soon = chatContext("weixin", "chat1", "/tmp/proj");
  assert.equal(soon.sessionId, first.sessionId, "within the window → same session");
  assert.ok(!soon.rotatedFrom, "no rotation flag");
  // Overnight (9h idle) → rotate.
  setLastUsed(Date.now() - 9 * 3_600_000);
  const rotated = chatContext("weixin", "chat1", "/tmp/proj");
  assert.notEqual(rotated.sessionId, first.sessionId, "idle past window → fresh session id");
  assert.equal(rotated.rotatedFrom, first.sessionId, "old id returned for /resume");
  // Immediately after: stable again.
  const after = chatContext("weixin", "chat1", "/tmp/proj");
  assert.equal(after.sessionId, rotated.sessionId, "post-rotation calls stay on the new thread");
  assert.ok(!after.rotatedFrom, "rotation fires once, not on every call");
});

test("disabled (HARA_GATEWAY_IDLE_HOURS=0): even week-old chats keep their thread", () => {
  process.env.HARA_GATEWAY_IDLE_HOURS = "0";
  const before = chatContext("feishu", "chat2", "/tmp/proj");
  setLastUsed(Date.now() - 7 * 24 * 3_600_000);
  const later = chatContext("feishu", "chat2", "/tmp/proj");
  assert.equal(later.sessionId, before.sessionId, "no rotation when disabled");
  assert.ok(!later.rotatedFrom);
  delete process.env.HARA_GATEWAY_IDLE_HOURS;
});
