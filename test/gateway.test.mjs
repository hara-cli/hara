import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTelegramUpdate, chunkText } from "../dist/gateway/telegram.js";
import { parseCommand, isAllowed } from "../dist/gateway/serve.js";
import { chatSessionId, newChatSession, setChatSession } from "../dist/gateway/sessions.js";

test("parseTelegramUpdate: text message → InboundMsg; non-text → null", () => {
  const m = parseTelegramUpdate({ update_id: 5, message: { text: "hi", chat: { id: 42 }, from: { id: 7, username: "jeff" } } });
  assert.deepEqual(m, { chatId: 42, userId: 7, userName: "jeff", text: "hi" });
  assert.equal(parseTelegramUpdate({ update_id: 6, message: { photo: [], chat: { id: 1 } } }), null);
  assert.equal(parseTelegramUpdate({}), null);
});

test("chunkText: splits at the Telegram limit", () => {
  assert.deepEqual(chunkText("short"), ["short"]);
  const big = "x".repeat(9000);
  const parts = chunkText(big, 4000);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), big);
});

test("parseCommand: leading /word → {cmd,arg}; else null", () => {
  assert.deepEqual(parseCommand("/resume tg-42-1"), { cmd: "resume", arg: "tg-42-1" });
  assert.deepEqual(parseCommand("/new"), { cmd: "new", arg: "" });
  assert.equal(parseCommand("just a task"), null);
  assert.deepEqual(parseCommand("/help"), { cmd: "help", arg: "" });
  // an unknown slash-word still parses (e.g. "/foo"); the gateway routes unknown commands to a normal task run
});

test("isAllowed: empty allowlist = nobody (safe); else membership", () => {
  assert.equal(isAllowed(7, new Set()), false); // never wide-open
  assert.equal(isAllowed(7, new Set(["7"])), true);
  assert.equal(isAllowed(8, new Set(["7"])), false);
});

test("chat→session map: stable id, /new forks, /resume sets (isolated HOME)", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gw-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(chatSessionId("telegram", 42), "telegram-42");
    assert.equal(chatSessionId("telegram", 42), "telegram-42"); // stable
    assert.equal(newChatSession("telegram", 42), "telegram-42-1"); // /new forks
    assert.equal(chatSessionId("telegram", 42), "telegram-42-1"); // now the forked one
    setChatSession("telegram", 42, "some-other-session");
    assert.equal(chatSessionId("telegram", 42), "some-other-session"); // /resume points elsewhere
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
