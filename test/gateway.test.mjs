import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTelegramUpdate, chunkText, photoFileId } from "../dist/gateway/telegram.js";
import { parseCommand, isAllowed, resolveAllowlist, cleanReply } from "../dist/gateway/serve.js";
import { chatContext, chatCd, newChatSession, setChatSession, cwdTag, toggleVoice } from "../dist/gateway/sessions.js";
import { randomWechatUin, envelope, buildSendBody, extractText, guessChatType, parseWeixinMessage, isSessionExpired, apiAesKey, audioFileItem, imageInlineItem, parseAesKey, inboundMediaRefs } from "../dist/gateway/weixin.js";
import { ttsConfigFromEnv, ttsCleanText } from "../dist/gateway/tts.js";

test("parseTelegramUpdate: text message → InboundMsg; non-text → null", () => {
  const m = parseTelegramUpdate({ update_id: 5, message: { text: "hi", chat: { id: 42 }, from: { id: 7, username: "jeff" } } });
  assert.deepEqual(m, { chatId: 42, userId: 7, userName: "jeff", text: "hi" });
  assert.equal(parseTelegramUpdate({ update_id: 6, message: { photo: [], chat: { id: 1 } } }), null); // empty photo array
  assert.equal(parseTelegramUpdate({}), null);
});

test("parseTelegramUpdate: photo message → caption (or [图片]) text; photoFileId picks the largest", () => {
  const photo = [{ file_id: "small" }, { file_id: "big" }]; // Telegram sends ascending sizes
  const withCaption = parseTelegramUpdate({ message: { photo, caption: "look", chat: { id: 9 }, from: { id: 1, first_name: "J" } } });
  assert.deepEqual(withCaption, { chatId: 9, userId: 1, userName: "J", text: "look" });
  const noCaption = parseTelegramUpdate({ message: { photo, chat: { id: 9 }, from: { id: 1, username: "j" } } });
  assert.equal(noCaption.text, "[图片]");
  assert.equal(photoFileId({ message: { photo } }), "big"); // largest = last
  assert.equal(photoFileId({ message: { text: "hi" } }), null);
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

test("cleanReply: strips mcp status lines + token footer, keeps the answer", () => {
  const raw = [
    "mcp: browser → 23 tool(s)",
    "mcp: wechat failed (spawn pyweixin-rpa ENOENT)",
    "你好！有什么我可以帮你的吗？",
    "  glm-5 · ↑8163 ↓54 tok",
  ].join("\n");
  assert.equal(cleanReply(raw), "你好！有什么我可以帮你的吗？");
  assert.equal(cleanReply("mcp: x → 1 tool(s)\n\npong\n  glm-5 · ↑1 ↓2 tok"), "pong"); // blank lines collapse via trim
  assert.equal(cleanReply("just an answer\nwith two lines"), "just an answer\nwith two lines"); // no chrome → untouched
});

test("chat ctx: cwd-scoped session; /cd switches project+thread, /new forks, /resume sets id+cwd (isolated HOME)", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gw-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const def = "/work/default";
    const a = chatContext("telegram", 42, def);
    assert.equal(a.cwd, def);
    assert.equal(a.sessionId, `telegram-42-${cwdTag(def)}`);
    assert.deepEqual(chatContext("telegram", 42, def), a); // stable

    const projSid = chatCd("telegram", 42, "/work/projB"); // /cd → that project's own thread
    assert.equal(projSid, `telegram-42-${cwdTag("/work/projB")}`);
    assert.notEqual(cwdTag("/work/projB"), cwdTag(def)); // different dirs → different threads
    const b = chatContext("telegram", 42, def);
    assert.equal(b.cwd, "/work/projB");
    assert.equal(b.sessionId, projSid);

    const forked = newChatSession("telegram", 42, def); // /new forks the CURRENT dir's thread
    assert.equal(forked, `telegram-42-${cwdTag("/work/projB")}-1`);
    assert.equal(chatContext("telegram", 42, def).sessionId, forked);

    setChatSession("telegram", 42, "explicit-session", "/work/other"); // /resume sets id + follows its cwd
    const c = chatContext("telegram", 42, def);
    assert.equal(c.sessionId, "explicit-session");
    assert.equal(c.cwd, "/work/other");

    assert.equal(chatContext("telegram", 42, def).voice, false); // /voice off by default
    assert.equal(toggleVoice("telegram", 42), true); // toggles on
    assert.equal(chatContext("telegram", 42, def).voice, true);
    assert.equal(toggleVoice("telegram", 42), false); // and back off
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
  // a transcribed voice message (type 3, no text item) is prefixed with an explicit "already transcribed" note
  const v = parseWeixinMessage({ from_user_id: "u1", item_list: [{ type: 3, voice_item: { text: "在吗" } }] }, "bot").inbound.text;
  assert.match(v, /transcribed/); // tells hara it's transcribed, not raw audio
  assert.ok(v.endsWith("在吗")); // the actual transcription is preserved at the end
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

test("weixin apiAesKey: base64 of the hex string's ASCII bytes — NOT base64 of the raw key", () => {
  const keyHex = "00112233445566778899aabbccddeeff";
  assert.equal(apiAesKey(keyHex), Buffer.from(keyHex, "ascii").toString("base64"));
  assert.notEqual(apiAesKey(keyHex), Buffer.from(keyHex, "hex").toString("base64")); // the classic mistake
});

test("weixin audioFileItem: file_item shape — string len, encrypt_type 1, type 4", () => {
  assert.deepEqual(audioFileItem("ENC", "AESB64", 12345, "reply.m4a"), {
    type: 4,
    file_item: {
      media: { encrypt_query_param: "ENC", aes_key: "AESB64", encrypt_type: 1 },
      file_name: "reply.m4a",
      len: "12345",
    },
  });
});

test("weixin imageInlineItem: image_item shape — mid_size is the ciphertext size (int), type 2", () => {
  assert.deepEqual(imageInlineItem("ENC", "AESB64", 4096), {
    type: 2,
    image_item: { media: { encrypt_query_param: "ENC", aes_key: "AESB64", encrypt_type: 1 }, mid_size: 4096 },
  });
});

test("weixin parseAesKey: recovers 16 raw key bytes from apiAesKey(hex), and from raw-16 base64", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex"); // 16 bytes
  assert.deepEqual(parseAesKey(apiAesKey(key.toString("hex"))), key); // base64(ascii(hex)) → hex branch
  assert.deepEqual(parseAesKey(key.toString("base64")), key); // raw-16 branch
});

test("weixin inboundMediaRefs: image/file/(untranscribed)voice; skips text + transcribed voice", () => {
  const refs = inboundMediaRefs([
    { type: 1, text_item: { text: "hi" } },
    { type: 2, image_item: { media: { encrypt_query_param: "e1", aes_key: "k1" } } },
    { type: 4, file_item: { file_name: "a.zip", media: { full_url: "https://novac2c.cdn.weixin.qq.com/x", aes_key: "k2" } } },
    { type: 3, voice_item: { text: "已转写" } }, // transcribed → surfaced as text, not downloaded
    { type: 3, voice_item: { media: { encrypt_query_param: "e3", aes_key: "k3" } } },
  ]);
  assert.deepEqual(refs.map((r) => r.kind), ["image", "file", "voice"]);
  assert.equal(refs[1].fileName, "a.zip");
  assert.equal(refs[2].encryptQueryParam, "e3");
});

test("weixin inboundMediaRefs: image aeskey hex-hack re-encodes to base64(ascii(hex))", () => {
  const hex = "00112233445566778899aabbccddeeff";
  const [ref] = inboundMediaRefs([{ type: 2, image_item: { aeskey: hex, media: { encrypt_query_param: "e" } } }]);
  assert.equal(ref.aesKeyB64, Buffer.from(hex, "ascii").toString("base64"));
});

test("tts: ttsConfigFromEnv defaults + ttsCleanText (collapse ws, strip fences, cap)", () => {
  assert.equal(ttsConfigFromEnv({}).provider, "say"); // default provider
  assert.equal(ttsConfigFromEnv({ HARA_TTS_PROVIDER: "openai", HARA_TTS_VOICE: "alloy" }).voice, "alloy");
  assert.equal(ttsCleanText("  hello\n\nworld  "), "hello world");
  assert.match(ttsCleanText("a ```code\nblock``` b"), /code omitted/);
  assert.ok(ttsCleanText("x".repeat(5000)).length <= 1200);
});
