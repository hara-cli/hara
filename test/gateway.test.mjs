import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTelegramUpdate, chunkText } from "../dist/gateway/telegram.js";
import { parseCommand, isAllowed, resolveAllowlist } from "../dist/gateway/serve.js";
import { chatSessionId, newChatSession, setChatSession } from "../dist/gateway/sessions.js";
import { randomWechatUin, envelope, buildSendBody, extractText, guessChatType, parseWeixinMessage, isSessionExpired } from "../dist/gateway/weixin.js";

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

test("resolveAllowlist: env ids ∪ bot owner (weixin auto-allows the scanner)", () => {
  assert.deepEqual([...resolveAllowlist("a,b", "owner")].sort(), ["a", "b", "owner"]);
  assert.deepEqual([...resolveAllowlist("", "owner")], ["owner"]); // owner alone — no env needed
  assert.deepEqual([...resolveAllowlist("a, a ", undefined)], ["a"]); // trims + dedups, no owner
  assert.equal(resolveAllowlist("", undefined).size, 0); // telegram, no env = nobody
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

// ── WeChat (iLink) protocol helpers ──────────────────────────────────────────

test("weixin randomWechatUin: base64 of the decimal string of a uint32", () => {
  const uin = randomWechatUin();
  const decoded = Buffer.from(uin, "base64").toString("utf8");
  assert.match(decoded, /^\d+$/); // pure decimal
  assert.ok(Number(decoded) >= 0 && Number(decoded) <= 0xffffffff);
});

test("weixin envelope: merges base_info.channel_version, compact JSON", () => {
  const s = envelope({ get_updates_buf: "abc" });
  assert.equal(s, '{"get_updates_buf":"abc","base_info":{"channel_version":"2.2.0"}}');
});

test("weixin buildSendBody: nested msg/item_list; context_token only when set; client_id passthrough", () => {
  const withTok = buildSendBody("wxid_peer", "hi", "ctx123", "cid-1");
  assert.deepEqual(withTok, {
    msg: {
      from_user_id: "",
      to_user_id: "wxid_peer",
      client_id: "cid-1",
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: "hi" } }],
      context_token: "ctx123",
    },
  });
  const noTok = buildSendBody("wxid_peer", "hi", "", "cid-1");
  assert.equal("context_token" in noTok.msg, false); // omitted when falsy
});

test("weixin extractText: text item (type 1), voice fallback (type 3), else empty", () => {
  assert.equal(extractText([{ type: 1, text_item: { text: "hello" } }]), "hello");
  assert.equal(extractText([{ type: 3, voice_item: { text: "transcribed" } }]), "transcribed");
  assert.equal(extractText([{ type: 99 }]), "");
  assert.equal(extractText(undefined), "");
});

test("weixin guessChatType: room_id ⇒ group; else DM keyed by from_user_id", () => {
  assert.deepEqual(guessChatType({ from_user_id: "u1" }, "bot"), { kind: "dm", id: "u1" });
  assert.deepEqual(guessChatType({ from_user_id: "u1", room_id: "r9" }, "bot"), { kind: "group", id: "r9" });
});

test("weixin parseWeixinMessage: valid DM; null for own echo / group / non-text", () => {
  assert.deepEqual(
    parseWeixinMessage({ from_user_id: "u1", item_list: [{ type: 1, text_item: { text: "yo" } }], context_token: "t1" }, "bot"),
    { inbound: { chatId: "u1", userId: "u1", userName: "u1", text: "yo" }, contextToken: "t1" },
  );
  assert.equal(parseWeixinMessage({ from_user_id: "bot", item_list: [{ type: 1, text_item: { text: "echo" } }] }, "bot"), null); // own send echoed back
  assert.equal(parseWeixinMessage({ from_user_id: "u1", room_id: "r9", item_list: [{ type: 1, text_item: { text: "x" } }] }, "bot"), null); // group
  assert.equal(parseWeixinMessage({ from_user_id: "u1", item_list: [{ type: 99 }] }, "bot"), null); // non-text
});

test("weixin isSessionExpired: -14, or -2 + 'unknown error'; genuine -2 rate-limit is not expiry", () => {
  assert.equal(isSessionExpired(-14, 0, ""), true);
  assert.equal(isSessionExpired(0, -14, ""), true);
  assert.equal(isSessionExpired(-2, 0, "unknown error"), true); // stale session masquerading as rate-limit
  assert.equal(isSessionExpired(-2, 0, "UNKNOWN ERROR"), true); // case-insensitive
  assert.equal(isSessionExpired(-2, 0, "freq limit"), false); // genuine rate limit
  assert.equal(isSessionExpired(0, 0, ""), false);
});
