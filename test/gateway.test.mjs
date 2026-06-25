import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTelegramUpdate, chunkText, photoFileId } from "../dist/gateway/telegram.js";
import { parseDiscordMessage } from "../dist/gateway/discord.js";
import { parseFeishuContent, flattenPost } from "../dist/gateway/feishu.js";
import { parseSlackEvent } from "../dist/gateway/slack.js";
import { parseMattermostPost } from "../dist/gateway/mattermost.js";
import { parseMatrixEvent, parseMxc } from "../dist/gateway/matrix.js";
import { parseDingtalkMessage } from "../dist/gateway/dingtalk.js";
import { parseSignalMessage } from "../dist/gateway/signal.js";
import { parseWecomMessage } from "../dist/gateway/wecom.js";
import { pickRoute, outputDelta } from "../dist/gateway/tmux-routes.js";
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

test("parseDiscordMessage: ignores self+bots, parses text, surfaces image attachments", () => {
  const self = "999";
  assert.equal(parseDiscordMessage({ channel_id: "c", author: { id: "999" }, content: "hi" }, self), null); // own message
  assert.equal(parseDiscordMessage({ channel_id: "c", author: { id: "5", bot: true }, content: "hi" }, self), null); // another bot
  assert.equal(parseDiscordMessage({ channel_id: "c", author: { id: "5" }, content: "" }, self), null); // empty, no media

  const txt = parseDiscordMessage({ channel_id: "c1", author: { id: "5", username: "jeff" }, content: "yo" }, self);
  assert.deepEqual(txt.msg, { chatId: "c1", userId: "5", userName: "jeff", text: "yo" });
  assert.deepEqual(txt.imageUrls, []);

  const img = parseDiscordMessage(
    { channel_id: "c1", author: { id: "5", global_name: "Jeff" }, content: "", attachments: [{ url: "https://cdn/x.png", filename: "x.png", content_type: "image/png" }, { url: "https://cdn/d.pdf", filename: "d.pdf", content_type: "application/pdf" }] },
    self,
  );
  assert.equal(img.msg.text, "[图片]");
  assert.equal(img.msg.userName, "Jeff");
  assert.deepEqual(img.imageUrls, [{ url: "https://cdn/x.png", name: "x.png" }]); // pdf excluded
});

test("parseFeishuContent: text/image/file/audio/post normalization", () => {
  assert.deepEqual(parseFeishuContent("text", { text: "hello" }), { text: "hello" });
  assert.deepEqual(parseFeishuContent("image", { image_key: "img_k" }), { text: "", imageKey: "img_k" });
  assert.deepEqual(parseFeishuContent("file", { file_key: "f_k", file_name: "a.pdf" }), { text: "", fileKey: "f_k", fileName: "a.pdf" });
  assert.deepEqual(parseFeishuContent("audio", { file_key: "v_k" }), { text: "", fileKey: "v_k", fileName: "audio" });
  assert.equal(parseFeishuContent("sticker", {}).text, ""); // unknown type → empty
});

test("flattenPost: rich-text post → joined text runs", () => {
  const post = { title: "t", content: [[{ tag: "text", text: "hi" }, { tag: "a", text: "link" }], [{ tag: "text", text: "line2" }]] };
  assert.equal(flattenPost(post), "hi link line2");
  assert.equal(flattenPost({ zh_cn: { content: [[{ tag: "text", text: "中文" }]] } }), "中文"); // locale-wrapped
  assert.equal(flattenPost({}), "");
});

test("parseSlackEvent: filters non-messages/bots/subtypes, parses text + image file_share", () => {
  const self = "UBOT";
  assert.equal(parseSlackEvent({ type: "reaction_added" }, self), null);
  assert.equal(parseSlackEvent({ type: "message", bot_id: "B1", channel: "C", user: "U1", text: "hi" }, self), null);
  assert.equal(parseSlackEvent({ type: "message", user: "UBOT", channel: "C", text: "hi" }, self), null); // self
  assert.equal(parseSlackEvent({ type: "message", subtype: "message_changed", channel: "C", user: "U1", text: "x" }, self), null);
  const t = parseSlackEvent({ type: "message", channel: "C9", user: "U1", text: "yo" }, self);
  assert.deepEqual(t.msg, { chatId: "C9", userId: "U1", userName: "U1", text: "yo" });
  const img = parseSlackEvent({ type: "message", subtype: "file_share", channel: "C9", user: "U1", text: "", files: [{ name: "p.png", mimetype: "image/png", url_private_download: "https://s/p.png" }] }, self);
  assert.equal(img.msg.text, "[图片]");
  assert.deepEqual(img.imageUrls, [{ url: "https://s/p.png", name: "p.png" }]);
});

test("parseMattermostPost: ignores self/system posts, surfaces file_ids", () => {
  const self = "ubot";
  assert.equal(parseMattermostPost({ channel_id: "c", user_id: "ubot", message: "hi" }, self), null); // self
  assert.equal(parseMattermostPost({ channel_id: "c", user_id: "u1", type: "system_join_channel", message: "x" }, self), null);
  const t = parseMattermostPost({ channel_id: "c1", user_id: "u1", message: "yo" }, self);
  assert.deepEqual(t.msg, { chatId: "c1", userId: "u1", userName: "u1", text: "yo" });
  const f = parseMattermostPost({ channel_id: "c1", user_id: "u1", message: "", file_ids: ["f1", "f2"] }, self);
  assert.equal(f.msg.text, "[图片]");
  assert.deepEqual(f.imageFileIds, ["f1", "f2"]);
});

test("parseMxc + parseMatrixEvent: text/image, self + non-message filtering", () => {
  assert.deepEqual(parseMxc("mxc://matrix.org/abc123"), { server: "matrix.org", mediaId: "abc123" });
  assert.equal(parseMxc("https://x/y"), null);
  const self = "@bot:s";
  assert.equal(parseMatrixEvent({ type: "m.room.encrypted", sender: "@u:s", __roomId: "!r" }, self), null);
  assert.equal(parseMatrixEvent({ type: "m.room.message", sender: "@bot:s", __roomId: "!r", content: { msgtype: "m.text", body: "hi" } }, self), null); // self
  const t = parseMatrixEvent({ type: "m.room.message", sender: "@u:s", __roomId: "!r1", content: { msgtype: "m.text", body: "yo" } }, self);
  assert.deepEqual(t.msg, { chatId: "!r1", userId: "@u:s", userName: "@u:s", text: "yo" });
  assert.equal(t.imageMxc, null);
  const img = parseMatrixEvent({ type: "m.room.message", sender: "@u:s", __roomId: "!r1", content: { msgtype: "m.image", body: "pic.png", url: "mxc://s/m1" } }, self);
  assert.equal(img.msg.text, "pic.png");
  assert.equal(img.imageMxc, "mxc://s/m1");
});

test("parseDingtalkMessage: text/picture/richText, captures sessionWebhook", () => {
  assert.equal(parseDingtalkMessage(null), null);
  assert.equal(parseDingtalkMessage({ msgtype: "audio", conversationId: "c" }), null); // unsupported → empty → null
  const t = parseDingtalkMessage({ msgtype: "text", conversationId: "cid", senderStaffId: "s1", senderNick: "Jeff", text: { content: "hi" }, sessionWebhook: "https://wh" });
  assert.deepEqual(t.msg, { chatId: "cid", userId: "s1", userName: "Jeff", text: "hi" });
  assert.equal(t.sessionWebhook, "https://wh");
  assert.equal(parseDingtalkMessage({ msgtype: "picture", conversationId: "cid", senderId: "s2" }).msg.text, "[图片]");
});

test("parseSignalMessage: skips sync/self, parses text/group/image", () => {
  const self = "+1555";
  assert.equal(parseSignalMessage({ envelope: { syncMessage: {} } }, self), null);
  assert.equal(parseSignalMessage({ envelope: { sourceNumber: "+1555", dataMessage: { message: "hi" } } }, self), null); // self
  const t = parseSignalMessage({ envelope: { sourceNumber: "+1666", sourceName: "Jeff", dataMessage: { message: "yo" } } }, self);
  assert.deepEqual(t.msg, { chatId: "+1666", userId: "+1666", userName: "Jeff", text: "yo" });
  const g = parseSignalMessage({ envelope: { sourceNumber: "+1666", dataMessage: { message: "hey", groupInfo: { groupId: "GRP" } } } }, self);
  assert.equal(g.msg.chatId, "group:GRP");
  const img = parseSignalMessage({ envelope: { sourceNumber: "+1666", dataMessage: { message: "", attachments: [{ id: "a1", contentType: "image/jpeg" }] } } }, self);
  assert.equal(img.msg.text, "[图片]");
  assert.equal(img.images.length, 1);
});

test("parseWecomMessage: needs body, skips self, parses text", () => {
  const self = "botX";
  assert.equal(parseWecomMessage({}, self), null);
  assert.equal(parseWecomMessage({ body: { from: { userid: "botX" }, msgtype: "text", text: { content: "hi" } } }, self), null); // self
  const t = parseWecomMessage({ body: { from: { userid: "u1", name: "Jeff" }, chatid: "c1", msgtype: "text", text: { content: "yo" } } }, self);
  assert.equal(t.msg.chatId, "c1");
  assert.equal(t.msg.userId, "u1");
  assert.equal(t.msg.text, "yo");
});

test("pickRoute: oldest live pane chosen (FIFO), dead pruned, chosen consumed", () => {
  const alive = (p) => p !== "dead";
  const r = pickRoute([{ pane: "a", ts: 3 }, { pane: "dead", ts: 1 }, { pane: "b", ts: 2 }], alive);
  assert.equal(r.chosen.pane, "b"); // oldest LIVE (dead ts:1 skipped, b ts:2 < a ts:3)
  assert.deepEqual(r.remaining.map((x) => x.pane), ["a"]); // b consumed, dead pruned, a kept
  assert.equal(pickRoute([], alive).chosen, null);
  const allDead = pickRoute([{ pane: "dead", ts: 1 }], alive);
  assert.equal(allDead.chosen, null);
  assert.deepEqual(allDead.remaining, []); // dead pruned even when nothing chosen
});

test("pickRoute: a persistent 'bind' route is chosen but NOT consumed", () => {
  const alive = () => true;
  const r = pickRoute([{ pane: "%1", ts: 1, mode: "bind" }, { pane: "%2", ts: 2, mode: "once" }], alive);
  assert.equal(r.chosen.pane, "%1"); // oldest
  assert.deepEqual(r.remaining.map((x) => x.pane).sort(), ["%1", "%2"]); // bind kept (not consumed)
  const r2 = pickRoute([{ pane: "%2", ts: 2, mode: "once" }], alive);
  assert.equal(r2.chosen.pane, "%2");
  assert.deepEqual(r2.remaining, []); // once consumed
});

test("outputDelta: append/unchanged/scroll-anchor/tail", () => {
  assert.equal(outputDelta("abc", "abc"), ""); // unchanged
  assert.equal(outputDelta("abc", "abcdef"), "def"); // pure append
  assert.equal(outputDelta("", "hello"), "hello"); // no baseline → all
  assert.equal(outputDelta("old\nlast", "scrolled\nlast\nnew"), "\nnew"); // re-anchor on last line
  const big = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n");
  assert.equal(outputDelta("gone\nvanished", big).split("\n").length, 20); // can't anchor → last 20 lines
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
