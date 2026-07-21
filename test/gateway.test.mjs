import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseTelegramUpdate, chunkText, photoFileId, telegramAdapter } from "../dist/gateway/telegram.js";
import { parseDiscordMessage } from "../dist/gateway/discord.js";
import { dispatchFeishuInbound, FeishuWsHealthMonitor, feishuAdapter, parseFeishuContent, flattenPost, feishuTimestampMs } from "../dist/gateway/feishu.js";
import { parseSlackEvent } from "../dist/gateway/slack.js";
import { parseMattermostPost } from "../dist/gateway/mattermost.js";
import { matrixChatType, matrixDirectRoomsFromSync, parseMatrixEvent, parseMxc } from "../dist/gateway/matrix.js";
import { parseDingtalkMessage } from "../dist/gateway/dingtalk.js";
import { parseSignalMessage, signalAdapter } from "../dist/gateway/signal.js";
import { parseWecomMessage } from "../dist/gateway/wecom.js";
import { pickRoute, outputDelta } from "../dist/gateway/tmux-routes.js";
import { GatewayQueueClosedError, GatewayQueueFullError, KeyedSerialQueue, canonicalGatewayPlatform, gatewayAdmissionKey, gatewayStatus, parseCommand, isAllowed, resolveAllowlist, cleanReply, shouldDownloadInboundMedia } from "../dist/gateway/serve.js";
import { chatContext, chatCd, newChatSession, ownsChatSession, resolveOwnedSessionId, setChatSession, setChatAgent, cwdTag, toggleVoice } from "../dist/gateway/sessions.js";
import { randomWechatUin, envelope, buildSendBody, extractText, guessChatType, parseWeixinMessage, isSessionExpired, apiAesKey, audioFileItem, imageInlineItem, parseAesKey, inboundMediaRefs } from "../dist/gateway/weixin.js";
import { synthesize, ttsConfigFromEnv, ttsCleanText, ttsTimeoutMs } from "../dist/gateway/tts.js";
import { deliverResult } from "../dist/cron/deliver.js";

test("parseTelegramUpdate: text message → InboundMsg; non-text → null", () => {
  const m = parseTelegramUpdate({ update_id: 5, message: { text: "hi", chat: { id: 42 }, from: { id: 7, username: "jeff" } } });
  assert.deepEqual(m, { chatId: 42, userId: 7, userName: "jeff", text: "hi", messageId: "5" });
  assert.equal(parseTelegramUpdate({ update_id: 6, message: { photo: [], chat: { id: 1 } } }), null); // empty photo array
  assert.equal(parseTelegramUpdate({}), null);
  assert.equal(parseTelegramUpdate({ message: { text: "dm", chat: { id: 1, type: "private" }, from: { id: 1 } } }).chatType, "p2p");
  assert.equal(parseTelegramUpdate({ message: { text: "group", chat: { id: -1, type: "supergroup" }, from: { id: 2 } } }).chatType, "group");
});

test("gatewayStatus exposes only redacted configuration and actionable stopped state", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gateway-status-"));
  const saved = {
    HOME: process.env.HOME,
    appId: process.env.HARA_FEISHU_APP_ID,
    secret: process.env.HARA_FEISHU_APP_SECRET,
  };
  try {
    process.env.HOME = home;
    process.env.HARA_FEISHU_APP_ID = "cli_test_public_identity";
    process.env.HARA_FEISHU_APP_SECRET = "secret-must-never-leak";
    const status = await gatewayStatus("lark");
    assert.equal(status.platform, "feishu");
    assert.equal(status.configuration, "ready");
    assert.equal(status.configured, true);
    assert.equal(status.running, false);
    assert.equal(status.runtimeState, "unknown");
    assert.match(status.recommendation, /hara gateway --platform feishu/);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("cli_test_public_identity"), false);
    assert.equal(serialized.includes("secret-must-never-leak"), false);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.appId === undefined) delete process.env.HARA_FEISHU_APP_ID;
    else process.env.HARA_FEISHU_APP_ID = saved.appId;
    if (saved.secret === undefined) delete process.env.HARA_FEISHU_APP_SECRET;
    else process.env.HARA_FEISHU_APP_SECRET = saved.secret;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gatewayStatus distinguishes readable, missing, and malformed WeChat login state", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-weixin-status-"));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.equal((await gatewayStatus("weixin")).configuration, "missing");
    const state = join(home, ".hara", "weixin");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    writeFileSync(join(state, "creds.json"), "not-json", { mode: 0o600 });
    assert.equal((await gatewayStatus("weixin")).configuration, "unreadable");
    writeFileSync(join(state, "creds.json"), JSON.stringify({
      account_id: "account",
      token: "private-token",
      base_url: "https://example.invalid",
      user_id: "owner",
    }), { mode: 0o600 });
    const ready = await gatewayStatus("weixin");
    assert.equal(ready.configuration, "ready");
    assert.equal(JSON.stringify(ready).includes("private-token"), false);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("telegram media preflight still dispatches metadata but never fetches rejected bytes", async () => {
  const savedFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls = [];
  let received;
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (!String(url).includes("getUpdates")) throw new Error("media fetch must not run");
      return new Response(JSON.stringify({
        result: [{
          update_id: 1,
          message: {
            photo: [{ file_id: "small" }, { file_id: "large" }],
            chat: { id: 7, type: "private" },
            from: { id: 99, username: "blocked" },
          },
        }],
      }), { headers: { "content-type": "application/json" } });
    };
    await telegramAdapter("test-token").start(async (message) => {
      received = message;
      controller.abort();
    }, controller.signal, () => false);
  } finally {
    globalThis.fetch = savedFetch;
  }
  assert.equal(received.text, "[图片]");
  assert.equal(received.images, undefined);
  assert.equal(received.transientFiles, undefined);
  assert.equal(calls.length, 1);
});

test("telegramAdapter surfaces send failures instead of reporting false success", async () => {
  const savedFetch = globalThis.fetch;
  try {
    const adapter = telegramAdapter("test-token");
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(adapter.send("same-chat", "hello"), /chat not found/);

    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await telegramAdapter("test-token").send("same-chat", "hello"); // cross-instance failure cannot poison the lane
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("telegramAdapter keeps every chunk of one chat message in a FIFO outbound lane", async () => {
  const savedFetch = globalThis.fetch;
  const sent = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body.text);
      await new Promise((resolve) => setImmediate(resolve));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = telegramAdapter("test-token");
    const first = "A".repeat(12_000);
    const second = "B".repeat(12_000);
    await Promise.all([adapter.send("same-chat", first), adapter.send("same-chat", second)]);
    const labels = sent.map((part) => part[0]);
    const firstCount = labels.filter((label) => label === "A").length;
    const secondCount = labels.filter((label) => label === "B").length;
    assert.ok(firstCount > 1 && secondCount > 1, "fixture produces multi-part messages");
    assert.deepEqual(labels, [...Array(firstCount).fill("A"), ...Array(secondCount).fill("B")]);
    assert.equal(sent.filter((part) => part.includes("A")).join(""), first);
    assert.equal(sent.filter((part) => part.includes("B")).join(""), second);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("credential-scoped outbound lanes quarantine a timed-out transport and recover without late interleaving", async () => {
  const savedFetch = globalThis.fetch;
  const savedTimeout = process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS;
  const sent = [];
  try {
    process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS = "50";
    let wedgeFirst = true;
    let releaseWedged;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body.text);
      if (wedgeFirst) {
        wedgeFirst = false;
        return new Promise((resolve) => { releaseWedged = resolve; }); // deliberately ignores AbortSignal
      }
      await new Promise((resolve) => setImmediate(resolve));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const first = telegramAdapter("shared-token");
    const second = telegramAdapter("shared-token");
    await assert.rejects(first.send("same-chat", "wedged"), /timed out after 50ms/);
    await assert.rejects(second.send("same-chat", "must-not-overtake"), /timed out after 50ms/);
    assert.deepEqual(sent, ["wedged"], "a queued request never starts while the ambiguous first request is alive");

    // The 50ms budget above is deliberately tiny so the quarantine path is exercised quickly. Recovery is
    // a different assertion: give its multi-chunk FIFO work a realistic bounded budget so a contended CI
    // event loop cannot turn scheduler latency into a false transport timeout.
    process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS = "1000";
    releaseWedged(new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const a = "A".repeat(12_000);
    const b = "B".repeat(12_000);
    await Promise.all([first.send("same-chat", a), second.send("same-chat", b)]);
    const labels = sent.slice(1).map((part) => part[0]);
    const aCount = labels.filter((label) => label === "A").length;
    const bCount = labels.filter((label) => label === "B").length;
    assert.deepEqual(labels, [...Array(aCount).fill("A"), ...Array(bCount).fill("B")]);
    assert.equal(sent.slice(1).filter((part) => part.startsWith("A")).join(""), a);
    assert.equal(sent.slice(1).filter((part) => part.startsWith("B")).join(""), b);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedTimeout === undefined) delete process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS;
    else process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS = savedTimeout;
  }
});

test("deliverResult is cancelled promptly even when a transport ignores AbortSignal", async () => {
  const savedFetch = globalThis.fetch;
  const controller = new AbortController();
  try {
    let transportSignal;
    globalThis.fetch = async (_url, init) => {
      transportSignal = init?.signal;
      return new Promise(() => {});
    };
    const pending = deliverResult("webhook:https://example.invalid/hook", "hello", controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    assert.match(result, /delivery failed: Gateway delivery cancelled/);
    assert.equal(transportSignal?.aborted, true, "caller cancellation reaches the active transport");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("deliverResult never reflects credential-bearing target URLs in failures and forwards webhook idempotency", async () => {
  const savedFetch = globalThis.fetch;
  const secretUrl = "https://hooks.example.invalid/run?token=super-secret-query";
  try {
    globalThis.fetch = async () => {
      throw new Error(`request to ${secretUrl} failed with Authorization=secret`);
    };
    const failed = await deliverResult(`webhook:${secretUrl}`, "hello");
    assert.equal(failed, "delivery failed: transport request failed");
    assert.doesNotMatch(failed, /super-secret|hooks\.example|Authorization/);

    let headers;
    globalThis.fetch = async (_url, init) => {
      headers = init?.headers;
      return new Response("", { status: 200 });
    };
    assert.equal(await deliverResult(`webhook:${secretUrl}`, "hello", undefined, "opaque-effect-key"), null);
    assert.equal(headers["Idempotency-Key"], "opaque-effect-key");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("Feishu outbound send and upload propagate cancellation through native fetch and retain a hard deadline", async () => {
  const savedFetch = globalThis.fetch;
  const savedTimeout = process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS;
  try {
    process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS = "50";
    const controller = new AbortController();
    let activeSignal;
    let authCalls = 0;
    let releaseSend;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("tenant_access_token")) {
        authCalls++;
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "short-lived-test-token", expire: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      }
      activeSignal = init?.signal;
      if (String(url).includes("/messages?")) {
        return new Promise((resolve) => { releaseSend = resolve; }); // deliberately ignores AbortSignal
      }
      return new Promise(() => {}); // upload deliberately ignores AbortSignal; the hard race must still settle
    };
    const adapter = feishuAdapter("app-id", "app-secret");
    const sending = adapter.send("chat", "hello", controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(sending, /Feishu send cancelled/);
    assert.equal(activeSignal?.aborted, true);

    releaseSend(new Response(JSON.stringify({ code: 0, data: { message_id: "late" } }), {
      headers: { "content-type": "application/json" },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    activeSignal = undefined;
    await assert.rejects(
      adapter.sendFile("chat", { safeName: "note.txt", bytes: Buffer.from("hello"), snapshotPath: "/unused" }),
      /Feishu upload timed out after 50ms/,
    );
    assert.equal(activeSignal?.aborted, true);
    assert.equal(authCalls, 1, "a valid tenant token is reused without persisting it");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedTimeout === undefined) delete process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS;
    else process.env.HARA_GATEWAY_OUTBOUND_TIMEOUT_MS = savedTimeout;
  }
});

test("Feishu message create hashes a stable flow effect key into a repeatable idempotency UUID", async () => {
  const savedFetch = globalThis.fetch;
  const payloads = [];
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "test-token", expire: 3600 }), {
          headers: { "content-type": "application/json" },
        });
      }
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ code: 0, data: { message_id: `m-${payloads.length}` } }), {
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = feishuAdapter("idempotent-app", "secret");
    await adapter.send("chat", "same effect", undefined, "opaque-flow-effect-key");
    await adapter.send("chat", "same effect", undefined, "opaque-flow-effect-key");
    assert.equal(payloads.length, 2);
    assert.match(payloads[0].uuid, /^[a-f0-9]{32}$/);
    assert.equal(payloads[1].uuid, payloads[0].uuid);
    assert.doesNotMatch(payloads[0].uuid, /opaque|flow|effect/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("telegramAdapter retries a failed update before advancing its polling offset", async () => {
  const savedFetch = globalThis.fetch;
  const savedSetTimeout = globalThis.setTimeout;
  const savedError = console.error;
  const controller = new AbortController();
  const offsets = [];
  const handled = [];
  const acknowledged = [];
  let poll = 0;
  try {
    // Make the adapter's retry backoff immediate without changing production timing.
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 2_000) {
        queueMicrotask(() => callback(...args));
        return 0;
      }
      return savedSetTimeout(callback, ms, ...args);
    };
    console.error = () => {};
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      offsets.push(parsed.searchParams.get("offset"));
      poll++;
      const updateId = poll < 3 ? 10 : 11;
      const text = updateId === 10 ? "retry" : "next";
      return new Response(JSON.stringify({
        result: [{ update_id: updateId, message: { text, chat: { id: 1, type: "private" }, from: { id: 1 } } }],
      }), { headers: { "content-type": "application/json" } });
    };
    let failedOnce = false;
    await telegramAdapter("test-token").start(async (message) => {
      handled.push(message.text);
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("transient handler failure");
      }
      if (message.text === "next") controller.abort();
      return async () => { acknowledged.push(message.text); };
    }, controller.signal);
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.setTimeout = savedSetTimeout;
    console.error = savedError;
  }
  assert.deepEqual(handled, ["retry", "retry", "next"]);
  assert.deepEqual(offsets, ["0", "0", "11"], "failure is re-polled; success advances to update_id + 1");
  assert.deepEqual(acknowledged, ["retry"], "cleanup waits for a later offset-bearing poll; unacked final work is retained");
});

test("telegramAdapter bounds a half-open polling body and does not leak credential URLs from transport errors", async () => {
  const savedFetch = globalThis.fetch;
  const savedSetTimeout = globalThis.setTimeout;
  const savedError = console.error;
  const errors = [];
  try {
    console.error = (...args) => errors.push(args.map(String).join(" "));

    const bodyController = new AbortController();
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 40_000) return savedSetTimeout(callback, 5, ...args);
      if (ms === 2_000) {
        bodyController.abort();
        queueMicrotask(() => callback(...args));
        return 0;
      }
      return savedSetTimeout(callback, ms, ...args);
    };
    globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "application/json" },
    });
    await telegramAdapter("body-timeout-token").start(async () => {}, bodyController.signal);
    assert.ok(errors.some((line) => line.includes("Telegram poll timed out")), "body consumption shares the poll deadline");

    errors.length = 0;
    const transportController = new AbortController();
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms === 2_000) {
        transportController.abort();
        queueMicrotask(() => callback(...args));
        return 0;
      }
      return savedSetTimeout(callback, ms, ...args);
    };
    globalThis.fetch = async () => {
      throw new Error("request failed https://api.telegram.org/botcredential-must-not-leak/getUpdates");
    };
    await telegramAdapter("credential-must-not-leak").start(async () => {}, transportController.signal);
    assert.ok(errors.some((line) => line.includes("Telegram getUpdates transport failed")));
    assert.ok(errors.every((line) => !line.includes("credential-must-not-leak")));
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.setTimeout = savedSetTimeout;
    console.error = savedError;
  }
});

test("Feishu inbound callback errors are rethrown for platform redelivery", async () => {
  const savedError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await assert.rejects(
      dispatchFeishuInbound(async () => { throw new Error("handler failed"); }, {
        chatId: "chat",
        userId: "user",
        userName: "user",
        text: "hello",
      }),
      /handler failed/,
    );
  } finally {
    console.error = savedError;
  }
  assert.ok(errors.some((line) => line.includes("message handling failed")));
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

  const txt = parseDiscordMessage({ channel_id: "c1", author: { id: "5", username: "jeff" }, content: "yo" }, self, 1);
  assert.deepEqual(txt.msg, { chatId: "c1", userId: "5", userName: "jeff", text: "yo", chatType: "p2p" });
  assert.deepEqual(txt.imageUrls, []);
  assert.equal(parseDiscordMessage({ channel_id: "c2", guild_id: "g1", author: { id: "5" }, content: "guild" }, self, 1).msg.chatType, "group");
  assert.equal(parseDiscordMessage({ channel_id: "unknown", author: { id: "5" }, content: "unknown" }, self).msg.chatType, "group");
  assert.equal(parseDiscordMessage({ channel_id: "group-dm", author: { id: "5" }, content: "group" }, self, 3).msg.chatType, "group");

  const img = parseDiscordMessage(
    { channel_id: "c1", author: { id: "5", global_name: "Jeff" }, content: "", attachments: [{ url: "https://cdn/x.png", filename: "x.png", content_type: "image/png" }, { url: "https://cdn/d.pdf", filename: "d.pdf", content_type: "application/pdf" }] },
    self,
  );
  assert.equal(img.msg.text, "[图片]");
  assert.equal(img.msg.userName, "Jeff");
  assert.deepEqual(img.imageUrls, [{ url: "https://cdn/x.png", name: "x.png" }]); // pdf excluded
});

test("Feishu WS health tracks reconnect duration and raises a bounded frequency alert", () => {
  let now = 0;
  const health = new FeishuWsHealthMonitor(() => now);
  health.ready();
  let last;
  for (let i = 0; i < 5; i++) {
    now += 1_000;
    last = health.disconnect();
    assert.equal(last.total, i + 1);
    assert.equal(last.hourCount, i + 1);
    assert.equal(last.alert, i === 4, "only the threshold crossing alerts");
    now += 500;
    assert.equal(health.reconnected(), 500);
  }
  assert.equal(last.dayCount, 5);
  assert.equal(last.connectedForMs, 1_000);

  now += 60 * 60_000 + 1;
  const later = health.disconnect();
  assert.equal(later.hourCount, 1, "the one-hour window expires old disconnects");
  assert.equal(later.dayCount, 6);
  assert.equal(later.alert, false);
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

test("feishuTimestampMs: accepts millisecond and second transport timestamps", () => {
  assert.equal(feishuTimestampMs("1800000000123"), 1_800_000_000_123);
  assert.equal(feishuTimestampMs("1800000000"), 1_800_000_000_000);
  assert.equal(feishuTimestampMs("bad"), undefined);
});

test("parseSlackEvent: filters non-messages/bots/subtypes, parses text + image file_share", () => {
  const self = "UBOT";
  assert.equal(parseSlackEvent({ type: "reaction_added" }, self), null);
  assert.equal(parseSlackEvent({ type: "message", bot_id: "B1", channel: "C", user: "U1", text: "hi" }, self), null);
  assert.equal(parseSlackEvent({ type: "message", user: "UBOT", channel: "C", text: "hi" }, self), null); // self
  assert.equal(parseSlackEvent({ type: "message", subtype: "message_changed", channel: "C", user: "U1", text: "x" }, self), null);
  const t = parseSlackEvent({ type: "message", channel: "C9", user: "U1", text: "yo" }, self);
  assert.deepEqual(t.msg, { chatId: "C9", userId: "U1", userName: "U1", text: "yo", chatType: "group" });
  assert.equal(parseSlackEvent({ type: "message", channel: "D9", channel_type: "channel", user: "U1", text: "dm" }, self).msg.chatType, "p2p", "D ids prove a DM even if the field disagrees");
  assert.equal(parseSlackEvent({ type: "message", channel: "legacy", channel_type: "im", user: "U1", text: "dm" }, self).msg.chatType, "p2p");
  assert.equal(parseSlackEvent({ type: "message", channel: "G9", channel_type: "mpim", user: "U1", text: "group dm" }, self).msg.chatType, "group");
  const img = parseSlackEvent({ type: "message", subtype: "file_share", channel: "C9", user: "U1", text: "", files: [{ name: "p.png", mimetype: "image/png", url_private_download: "https://s/p.png" }] }, self);
  assert.equal(img.msg.text, "[图片]");
  assert.deepEqual(img.imageUrls, [{ url: "https://s/p.png", name: "p.png" }]);
});

test("parseMattermostPost: ignores self/system posts, surfaces file_ids", () => {
  const self = "ubot";
  assert.equal(parseMattermostPost({ channel_id: "c", user_id: "ubot", message: "hi" }, self), null); // self
  assert.equal(parseMattermostPost({ channel_id: "c", user_id: "u1", type: "system_join_channel", message: "x" }, self), null);
  const t = parseMattermostPost({ channel_id: "c1", user_id: "u1", message: "yo" }, self);
  assert.deepEqual(t.msg, { chatId: "c1", userId: "u1", userName: "u1", text: "yo", chatType: "group" });
  assert.equal(parseMattermostPost({ channel_id: "dm", user_id: "u1", message: "yo" }, self, "D").msg.chatType, "p2p");
  assert.equal(parseMattermostPost({ channel_id: "g", user_id: "u1", message: "yo" }, self, "G").msg.chatType, "group");
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
  assert.deepEqual(t.msg, { chatId: "!r1", userId: "@u:s", userName: "@u:s", text: "yo", chatType: "group" });
  assert.equal(t.imageMxc, null);
  const img = parseMatrixEvent({ type: "m.room.message", sender: "@u:s", __roomId: "!r1", content: { msgtype: "m.image", body: "pic.png", url: "mxc://s/m1" } }, self);
  assert.equal(img.msg.text, "pic.png");
  assert.equal(img.imageMxc, "mxc://s/m1");

  const direct = matrixDirectRoomsFromSync({ account_data: { events: [{ type: "m.direct", content: { "@u:s": ["!r1", "not-a-room"] } }] } });
  assert.deepEqual([...direct], ["!r1"]);
  assert.equal(matrixDirectRoomsFromSync({ account_data: { events: [] } }), null, "no account-data update preserves the prior mapping");
  assert.equal(matrixChatType("!r1", self, "@u:s", direct, { [self]: {}, "@u:s": {} }), "p2p");
  assert.equal(matrixChatType("!r1", self, "@u:s", direct, { [self]: {}, "@u:s": {}, "@third:s": {} }), "group", "stale m.direct cannot turn a shared room into a DM");
  assert.equal(matrixChatType("!other", self, "@u:s", direct, { [self]: {}, "@u:s": {} }), "group");
});

test("parseDingtalkMessage: text/picture/richText, captures sessionWebhook", () => {
  assert.equal(parseDingtalkMessage(null), null);
  assert.equal(parseDingtalkMessage({ msgtype: "audio", conversationId: "c" }), null); // unsupported → empty → null
  const t = parseDingtalkMessage({ msgtype: "text", conversationType: 1, conversationId: "cid", senderStaffId: "s1", senderNick: "Jeff", text: { content: "hi" }, sessionWebhook: "https://wh" });
  assert.deepEqual(t.msg, { chatId: "cid", userId: "s1", userName: "Jeff", text: "hi", chatType: "p2p" });
  assert.equal(t.sessionWebhook, "https://wh");
  assert.equal(parseDingtalkMessage({ msgtype: "picture", conversationType: 2, conversationId: "cid", senderId: "s2" }).msg.chatType, "group");
  assert.equal(parseDingtalkMessage({ msgtype: "picture", conversationId: "cid", senderId: "s2" }).msg.chatType, "group", "unknown conversation type fails closed");
});

test("parseSignalMessage: skips sync/self, parses text/group/image", () => {
  const self = "+1555";
  assert.equal(parseSignalMessage({ envelope: { syncMessage: {} } }, self), null);
  assert.equal(parseSignalMessage({ envelope: { sourceNumber: "+1555", dataMessage: { message: "hi" } } }, self), null); // self
  const t = parseSignalMessage({ envelope: { sourceNumber: "+1666", sourceName: "Jeff", dataMessage: { message: "yo" } } }, self);
  assert.deepEqual(t.msg, { chatId: "+1666", userId: "+1666", userName: "Jeff", text: "yo", chatType: "p2p" });
  const g = parseSignalMessage({ envelope: { sourceNumber: "+1666", dataMessage: { message: "hey", groupInfo: { groupId: "GRP" } } } }, self);
  assert.equal(g.msg.chatId, "group:GRP");
  assert.equal(g.msg.chatType, "group");
  assert.equal(parseSignalMessage({ envelope: { sourceNumber: "+1666", dataMessage: { message: "malformed group", groupInfo: {} } } }, self).msg.chatType, "group");
  const img = parseSignalMessage({ envelope: { sourceNumber: "+1666", dataMessage: { message: "", attachments: [{ id: "a1", contentType: "image/jpeg" }] } } }, self);
  assert.equal(img.msg.text, "[图片]");
  assert.equal(img.images.length, 1);
});

test("signal adapter does not advertise unsafe path-only outbound files", () => {
  assert.equal(signalAdapter("http://127.0.0.1:8080", "+15550000000").sendFile, undefined);
});

test("parseWecomMessage: needs body, skips self, parses text", () => {
  const self = "botX";
  assert.equal(parseWecomMessage({}, self), null);
  assert.equal(parseWecomMessage({ body: { from: { userid: "botX" }, msgtype: "text", text: { content: "hi" } } }, self), null); // self
  const t = parseWecomMessage({ body: { from: { userid: "u1", name: "Jeff" }, chattype: "single", msgtype: "text", text: { content: "yo" } } }, self);
  assert.equal(t.msg.chatId, "u1");
  assert.equal(t.msg.userId, "u1");
  assert.equal(t.msg.text, "yo");
  assert.equal(t.msg.chatType, "p2p");
  assert.equal(parseWecomMessage({ body: { from: { userid: "u1" }, chattype: "group", chatid: "c1", msgtype: "text", text: { content: "group" } } }, self).msg.chatType, "group");
  assert.equal(parseWecomMessage({ body: { from: { userid: "u1" }, msgtype: "text", text: { content: "unknown" } } }, self).msg.chatType, "group");
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

test("chunkText: preserves content, prefers natural boundaries, and never tears Unicode", () => {
  assert.deepEqual(chunkText("short"), ["short"]);
  const big = "x".repeat(9000);
  const parts = chunkText(big, 4000);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), big);

  assert.deepEqual(chunkText("first line\nsecond line\nthird", 18), ["first line\n", "second line\nthird"]);
  const unicode = "中文🙂abc ".repeat(20);
  const unicodeParts = chunkText(unicode, 13);
  assert.equal(unicodeParts.join(""), unicode);
  assert.ok(unicodeParts.every((part) => part.length <= 13));
  assert.ok(unicodeParts.every((part) => !part.includes("�")));

  const clusters = ["👨‍👩‍👧‍👦", "e\u0301", "🇨🇳", "\r\n"];
  const delicate = `1234${clusters.join("ABCD")}tail`;
  const delicateParts = chunkText(delicate, 16);
  assert.equal(delicateParts.join(""), delicate);
  assert.ok(delicateParts.every((part) => part.length <= 16));
  for (const cluster of clusters) {
    assert.equal(delicateParts.filter((part) => part.includes(cluster)).length, 1, `${JSON.stringify(cluster)} stays intact`);
  }

  // Platform limits are measured like JavaScript String.length, not Unicode code points.
  const emojiParts = chunkText("🙂".repeat(8), 8);
  assert.equal(emojiParts.join(""), "🙂".repeat(8));
  assert.ok(emojiParts.every((part) => part.length <= 8));
  assert.deepEqual(emojiParts.map((part) => part.length), [8, 8]);

  // An individual grapheme may itself exceed the bound. Split it finitely, but preserve code points whenever
  // the configured limit can hold one (including ZWJ emoji and long combining-mark sequences).
  const oversized = `👨‍👩‍👧‍👦${"\u0301".repeat(20)}`;
  const oversizedParts = chunkText(oversized, 6);
  assert.equal(oversizedParts.join(""), oversized);
  assert.ok(oversizedParts.every((part) => part.length <= 6));
  assert.ok(oversizedParts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
  assert.ok(oversizedParts.every((part) => !/^[\uDC00-\uDFFF]/.test(part)));

  const crlfParts = chunkText("a\r\nb\r\nc\r\nd", 3);
  assert.equal(crlfParts.join(""), "a\r\nb\r\nc\r\nd");
  assert.ok(crlfParts.every((part) => part.length <= 3));
  assert.ok(crlfParts.every((part) => !part.endsWith("\r")));
  assert.ok(crlfParts.every((part) => !part.startsWith("\n")));
  assert.throws(() => chunkText("x", 0), /positive integer/);
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

test("media preflight requires both an allowed sender and an explicitly classified DM", () => {
  const allowlist = new Set(["owner"]);
  const base = { chatId: "chat", userId: "owner", userName: "owner", text: "[图片]" };
  assert.equal(shouldDownloadInboundMedia({ ...base, chatType: "p2p" }, allowlist), true);
  assert.equal(shouldDownloadInboundMedia({ ...base, chatType: "group" }, allowlist), false);
  assert.equal(shouldDownloadInboundMedia(base, allowlist), false, "legacy/unknown chat shapes fail closed for bytes");
  assert.equal(shouldDownloadInboundMedia({ ...base, userId: "stranger", chatType: "p2p" }, allowlist), false);
});

test("resolveAllowlist: env ids ∪ bot owner (weixin auto-allows the scanner)", () => {
  assert.deepEqual([...resolveAllowlist("a,b", "owner")].sort(), ["a", "b", "owner"]);
  assert.deepEqual([...resolveAllowlist("", "owner")], ["owner"]); // owner alone — no env needed
  assert.deepEqual([...resolveAllowlist("a, a ", undefined)], ["a"]); // trims + dedups, no owner
  assert.equal(resolveAllowlist("", undefined).size, 0); // telegram, no env = nobody
});

test("gateway aliases canonicalize before flow/session/approval identities are built", () => {
  assert.equal(canonicalGatewayPlatform("lark"), "feishu");
  assert.equal(canonicalGatewayPlatform("DING"), "dingtalk");
  assert.equal(canonicalGatewayPlatform(" wework "), "wecom");
  assert.equal(canonicalGatewayPlatform("slack"), "slack");
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

test("KeyedSerialQueue serializes one session, runs separate sessions concurrently, and cleans up", async () => {
  const queue = new KeyedSerialQueue(3);
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => (releaseFirst = resolve));

  const first = queue.run("session-a", async () => {
    events.push("a1:start");
    await firstGate;
    events.push("a1:end");
    return 1;
  });
  const second = queue.run("session-a", async () => {
    events.push("a2:start");
    return 2;
  });
  const other = queue.run("session-b", async () => {
    events.push("b:start");
    return 3;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["a1:start", "b:start"], "a second session starts without waiting for session-a");
  assert.equal(queue.pending("session-a"), 2);
  assert.equal(queue.size, 1, "the already-settled session-b key is cleaned eagerly");
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second, other]), [1, 2, 3]);
  assert.deepEqual(events, ["a1:start", "b:start", "a1:end", "a2:start"]);
  assert.equal(queue.pending("session-a"), 0);
  assert.equal(queue.size, 0, "settled session keys do not accumulate");
});

test("gateway admission keeps context mutation, commands, and coding in one same-chat FIFO", async () => {
  const queue = new KeyedSerialQueue(4);
  const firstMessage = { chatId: "chat-7", userId: "owner", chatType: "p2p" };
  const secondMessage = { chatId: "chat-7", userId: "owner", chatType: "p2p" };
  const key = gatewayAdmissionKey("credential-scope", firstMessage);
  assert.equal(key, gatewayAdmissionKey("credential-scope", secondMessage));
  assert.notEqual(
    gatewayAdmissionKey("credential-scope", { chatId: "room", userId: "alice", chatType: "group" }),
    gatewayAdmissionKey("credential-scope", { chatId: "room", userId: "bob", chatType: "group" }),
    "group actors keep independent context lanes",
  );

  let releaseFirst;
  const gate = new Promise((resolve) => (releaseFirst = resolve));
  const context = { session: "old", voice: false };
  const observed = [];
  const first = queue.run(key, async () => {
    observed.push(`first:${context.session}`);
    await gate;
    context.session = "new"; // models /new completing before the next message resolves chatContext
    context.voice = true;
  });
  const second = queue.run(gatewayAdmissionKey("credential-scope", secondMessage), async () => {
    observed.push(`second:${context.session}:${context.voice}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, ["first:old"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(observed, ["first:old", "second:new:true"]);
});

test("KeyedSerialQueue bounds backlog and a rejected task cannot poison its session", async () => {
  const queue = new KeyedSerialQueue(2);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const running = queue.run("busy", () => gate);
  const waiting = queue.run("busy", () => "next");
  await assert.rejects(
    queue.run("busy", () => "overflow"),
    (error) => error instanceof GatewayQueueFullError && error.limit === 2,
  );
  release();
  await running;
  assert.equal(await waiting, "next");

  await assert.rejects(queue.run("busy", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await queue.run("busy", () => "recovered"), "recovered");
  assert.equal(queue.size, 0);
});

test("KeyedSerialQueue enforces a global active-child semaphore while preserving cross-session progress", async () => {
  const queue = new KeyedSerialQueue(8, 2, 16, 16);
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const runs = Array.from({ length: 8 }, (_, index) => queue.run(`rotating-${index}`, async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.activeCount, 2);
  assert.equal(queue.queuedCount, 6);
  assert.equal(peak, 2, "rotating session ids cannot exceed the process-wide concurrency cap");
  release();
  assert.deepEqual(await Promise.all(runs), Array.from({ length: 8 }, (_, index) => index));
  assert.equal(peak, 2);
  assert.equal(queue.size, 0);
});

test("KeyedSerialQueue hard-caps rotating keys and the global waiting backlog", async () => {
  let releaseKeys;
  const keyGate = new Promise((resolve) => (releaseKeys = resolve));
  const keys = new KeyedSerialQueue(8, 1, 8, 3);
  const keyRuns = ["one", "two", "three"].map((key) => keys.run(key, () => keyGate));
  await assert.rejects(
    keys.run("four", () => undefined),
    (error) => error instanceof GatewayQueueFullError && error.scope === "keys" && error.limit === 3,
  );
  releaseKeys();
  await Promise.all(keyRuns);

  let releaseQueue;
  const queueGate = new Promise((resolve) => (releaseQueue = resolve));
  const backlog = new KeyedSerialQueue(8, 1, 2, 10);
  const backlogRuns = ["active", "waiting-a", "waiting-b"].map((key) => backlog.run(key, () => queueGate));
  assert.equal(backlog.activeCount, 1);
  assert.equal(backlog.queuedCount, 2);
  await assert.rejects(
    backlog.run("overflow", () => undefined),
    (error) => error instanceof GatewayQueueFullError && error.scope === "queued" && error.limit === 2,
  );
  assert.equal(backlog.size, 3, "a rejected rotating key is removed immediately");
  releaseQueue();
  await Promise.all(backlogRuns);
});

test("KeyedSerialQueue shutdown rejects queued/new work and drains the one in-flight task", async () => {
  const queue = new KeyedSerialQueue(8, 1, 8, 8);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const running = queue.run("one", () => gate);
  const waiting = queue.run("two", () => "never");
  const waitingRejected = assert.rejects(waiting, (error) => error instanceof GatewayQueueClosedError);
  queue.close();
  await waitingRejected;
  await assert.rejects(queue.run("three", () => undefined), (error) => error instanceof GatewayQueueClosedError);
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.queuedCount, 0);
  release();
  await running;
  await queue.waitForIdle();
  assert.equal(queue.size, 0);
});

test("chat ctx: /cd round trips restore each cwd thread and mutations preserve chat preferences", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gw-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const def = "/work/default";
    const a = chatContext("telegram", 42, def);
    assert.equal(a.cwd, def);
    assert.equal(a.sessionId, `telegram-42-${cwdTag(def)}`);
    assert.deepEqual(chatContext("telegram", 42, def), a); // stable

    assert.equal(toggleVoice("telegram", 42), true);
    assert.equal(setChatAgent("telegram", 42, "reviewer"), "reviewer");
    const beforeSwitch = JSON.parse(readFileSync(join(home, ".hara", "gateway", "chats.json"), "utf8"))["telegram:42"].lastUsed;

    const projSid = chatCd("telegram", 42, "/work/projB"); // /cd → that project's own thread
    const afterSwitch = JSON.parse(readFileSync(join(home, ".hara", "gateway", "chats.json"), "utf8"))["telegram:42"];
    assert.equal(afterSwitch.lastUsed, beforeSwitch, "/cd preserves lastUsed instead of replacing the entry");
    assert.equal(projSid, `telegram-42-${cwdTag("/work/projB")}`);
    assert.notEqual(cwdTag("/work/projB"), cwdTag(def)); // different dirs → different threads
    const b = chatContext("telegram", 42, def);
    assert.equal(b.cwd, "/work/projB");
    assert.equal(b.sessionId, projSid);
    assert.equal(b.voice, true, "/cd preserves voice");
    assert.equal(b.agent, "reviewer", "/cd preserves agent selection");

    const forked = newChatSession("telegram", 42, def); // /new forks the CURRENT dir's thread
    assert.equal(forked, `telegram-42-${cwdTag("/work/projB")}-1`);
    assert.equal(chatContext("telegram", 42, def).sessionId, forked);

    assert.equal(chatCd("telegram", 42, def), a.sessionId, "returning to a cwd restores its original thread");
    assert.equal(chatCd("telegram", 42, "/work/projB"), forked, "returning again restores its forked thread");

    setChatSession("telegram", 42, "explicit-session", "/work/other"); // /resume sets id + follows its cwd
    const c = chatContext("telegram", 42, def);
    assert.equal(c.sessionId, "explicit-session");
    assert.equal(c.cwd, "/work/other");
    assert.equal(chatCd("telegram", 42, "/work/projB"), forked, "/resume does not discard another cwd's thread");
    assert.equal(chatCd("telegram", 42, "/work/other"), "explicit-session", "/resume selection survives cwd round trips");

    assert.equal(chatContext("telegram", 42, def).voice, true);
    assert.equal(toggleVoice("telegram", 42), false); // and back off without replacing the entry
    assert.equal(chatContext("telegram", 42, def).agent, "reviewer");

    const stored = JSON.parse(readFileSync(join(home, ".hara", "gateway", "chats.json"), "utf8"))["telegram:42"];
    assert.ok(stored.lastUsed >= beforeSwitch, "lastUsed survives entry mutations");
    assert.equal(statSync(join(home, ".hara", "gateway")).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, ".hara", "gateway", "chats.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(home, ".hara", "gateway")), ["chats.json"], "atomic writes leave no lock/temp files");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("chat agent homes preserve their own threads and /agent main restores the prior cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gw-agent-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const main = chatContext("feishu", "dm-1", "/work/main");
    assert.equal(toggleVoice("feishu", "dm-1"), true);

    assert.equal(setChatAgent("feishu", "dm-1", "coder", undefined, "/agents/coder"), "coder");
    const coder = chatContext("feishu", "dm-1", "/ignored");
    assert.equal(coder.cwd, "/agents/coder");
    assert.equal(coder.agent, "coder");
    assert.equal(coder.voice, true);
    const coderFork = newChatSession("feishu", "dm-1", "/ignored");

    assert.equal(setChatAgent("feishu", "dm-1", "reviewer", undefined, "/agents/reviewer"), "reviewer");
    assert.equal(chatContext("feishu", "dm-1", "/ignored").cwd, "/agents/reviewer");

    assert.equal(setChatAgent("feishu", "dm-1", undefined), undefined);
    const restored = chatContext("feishu", "dm-1", "/ignored");
    assert.equal(restored.cwd, "/work/main");
    assert.equal(restored.sessionId, main.sessionId);
    assert.equal(restored.agent, undefined);
    assert.equal(restored.voice, true);

    setChatAgent("feishu", "dm-1", "coder", undefined, "/agents/coder");
    assert.equal(chatContext("feishu", "dm-1", "/ignored").sessionId, coderFork, "role home restores its prior fork");
    setChatAgent("feishu", "dm-1", undefined);
    assert.equal(chatContext("feishu", "dm-1", "/ignored").sessionId, main.sessionId);

    setChatAgent("feishu", "dm-1", "project:coder", undefined, "/agents/coder");
    setChatAgent("feishu", "dm-1", "global:reviewer");
    assert.equal(chatContext("feishu", "dm-1", "/ignored").cwd, "/agents/coder", "a portable global role keeps the current project");
    const portableThread = chatCd("feishu", "dm-1", "/work/portable");
    setChatAgent("feishu", "dm-1", undefined);
    const afterGlobal = chatContext("feishu", "dm-1", "/ignored");
    assert.equal(afterGlobal.cwd, "/work/portable", "clearing a global role does not resurrect a stale project-role return cwd");
    assert.equal(afterGlobal.sessionId, portableThread);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("group chat APIs isolate every member across cwd, session, voice, and agent state", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gw-group-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const alice = { chatType: "group", userId: "alice" };
  const bob = { chatType: "group", userId: "bob" };
  try {
    const a0 = chatContext("telegram", "room-1", "/work/shared", alice);
    const b0 = chatContext("telegram", "room-1", "/work/shared", bob);
    assert.notEqual(a0.sessionId, b0.sessionId);

    assert.equal(toggleVoice("telegram", "room-1", alice), true);
    assert.equal(setChatAgent("telegram", "room-1", "coder", alice, "/agents/alice"), "coder");
    const aExplicit = "alice-explicit";
    setChatSession("telegram", "room-1", aExplicit, "/agents/alice", alice);

    const bobProject = chatCd("telegram", "room-1", "/work/bob", bob);
    const bobFork = newChatSession("telegram", "room-1", "/work/shared", bob);
    assert.notEqual(bobProject, bobFork);

    const a = chatContext("telegram", "room-1", "/ignored", alice);
    const b = chatContext("telegram", "room-1", "/ignored", bob);
    assert.deepEqual({ cwd: a.cwd, sessionId: a.sessionId, voice: a.voice, agent: a.agent }, {
      cwd: "/agents/alice", sessionId: aExplicit, voice: true, agent: "coder",
    });
    assert.deepEqual({ cwd: b.cwd, sessionId: b.sessionId, voice: b.voice, agent: b.agent }, {
      cwd: "/work/bob", sessionId: bobFork, voice: false, agent: undefined,
    });

    assert.throws(() => chatContext("telegram", "room-1", "/work/shared", { chatType: "group" }), /requires a userId/);
    assert.throws(() => toggleVoice("telegram", "room-1", { chatType: "group" }), /requires a userId/);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("gateway compact session ids resolve only within one chat identity and only when unique", () => {
  const alice = { chatType: "group", userId: "alice" };
  const bob = { chatType: "group", userId: "bob" };
  const userTag = (id) => createHash("sha256").update(id).digest("hex").slice(0, 24);
  const aPrefix = `telegram-room-1-u${userTag("alice")}-`;
  const bPrefix = `telegram-room-1-u${userTag("bob")}-`;
  const ids = [`${aPrefix}abcdef-1`, `${aPrefix}abcdef-2`, `${bPrefix}fedcba-9`, "telegram-other-abcdef-1"];
  assert.equal(ownsChatSession("telegram", "room-1", ids[0], alice), true);
  assert.equal(ownsChatSession("telegram", "room-1", ids[2], alice), false);
  assert.deepEqual(resolveOwnedSessionId("telegram", "room-1", ids[0], ids, alice), { id: ids[0] });
  assert.deepEqual(resolveOwnedSessionId("telegram", "room-1", "abcdef-2", ids, alice), { id: ids[1] }, "displayed suffix resumes");
  assert.deepEqual(resolveOwnedSessionId("telegram", "room-1", `${aPrefix}abcdef`, ids, alice), { ambiguous: [ids[0], ids[1]] });
  assert.equal(resolveOwnedSessionId("telegram", "room-1", "fedcba-9", ids, alice), null, "another user's matching suffix stays invisible");
  assert.deepEqual(resolveOwnedSessionId("telegram", "room-1", "fedcba-9", ids, bob), { id: ids[2] });
  assert.equal(ownsChatSession("telegram", "room", "telegram-room-extra-abcdef-1"), false, "chat-id prefixes cannot cross ownership boundaries");
});

test("gateway chat persistence keeps concurrent cross-process mutations", async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-gw-race-"));
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "gateway", "sessions.js")).href;
  const run = (index) => new Promise((resolve, reject) => {
    const source = `import { chatContext } from ${JSON.stringify(moduleUrl)}; chatContext("telegram", ${JSON.stringify(`parallel-${index}`)}, ${JSON.stringify(`/work/${index}`)});`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, HOME: home, HARA_GATEWAY_IDLE_HOURS: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`child ${index} exited ${code}: ${stderr}`)));
  });
  try {
    await Promise.all(Array.from({ length: 16 }, (_, index) => run(index)));
    const gatewayDir = join(home, ".hara", "gateway");
    const stored = JSON.parse(readFileSync(join(gatewayDir, "chats.json"), "utf8"));
    assert.equal(Object.keys(stored).length, 16);
    for (let index = 0; index < 16; index += 1) {
      assert.equal(stored[`telegram:parallel-${index}`].cwd, `/work/${index}`);
    }
    assert.deepEqual(readdirSync(gatewayDir), ["chats.json"]);
    assert.equal(statSync(gatewayDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(gatewayDir, "chats.json")).mode & 0o777, 0o600);
  } finally {
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
  const withoutMetadata = parseWeixinMessage(
    { from_user_id: "u1", item_list: [{ type: 1, text_item: { text: "yo" } }], context_token: "t1" },
    "bot",
  );
  assert.deepEqual(withoutMetadata, {
    inbound: { chatId: "u1", userId: "u1", userName: "u1", text: "yo" },
    contextToken: "t1",
  });
  assert.equal(Object.hasOwn(withoutMetadata.inbound, "messageId"), false);
  assert.equal(Object.hasOwn(withoutMetadata.inbound, "createdAtMs"), false);

  assert.deepEqual(
    parseWeixinMessage({
      from_user_id: "u1",
      message_id: 42,
      create_time_ms: 1_762_345_678_901,
      item_list: [{ type: 1, text_item: { text: "metadata" } }],
    }, "bot"),
    {
      inbound: {
        chatId: "u1",
        userId: "u1",
        userName: "u1",
        text: "metadata",
        messageId: "42",
        createdAtMs: 1_762_345_678_901,
      },
      contextToken: "",
    },
  );

  const invalidMetadata = parseWeixinMessage({
    from_user_id: "u1",
    message_id: Number.MAX_SAFE_INTEGER + 1,
    create_time_ms: 0,
    item_list: [{ type: 1, text_item: { text: "invalid metadata" } }],
  }, "bot");
  assert.equal(Object.hasOwn(invalidMetadata.inbound, "messageId"), false);
  assert.equal(Object.hasOwn(invalidMetadata.inbound, "createdAtMs"), false);
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
  assert.equal(ttsTimeoutMs("0"), 60_000, "deadlines cannot be disabled");
  assert.equal(ttsTimeoutMs("999999"), 120_000, "deadlines have a hard upper bound");
  assert.equal(ttsCleanText("  hello\n\nworld  "), "hello world");
  assert.match(ttsCleanText("a ```code\nblock``` b"), /code omitted/);
  assert.ok(ttsCleanText("x".repeat(5000)).length <= 1200);
});

test("TTS hard timeout settles a wedged custom provider", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX custom-command fixture");
  const startedAt = Date.now();
  const output = await Promise.race([
    synthesize("timeout fixture", {
      provider: "cmd",
      voice: "",
      model: "",
      baseURL: "",
      apiKey: "",
      cmd: "trap '' TERM; sleep 30",
      timeoutMs: 60,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TTS timeout did not settle")), 2_000)),
  ]);
  assert.equal(output, null);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("TTS custom provider keeps the legacy config argument and returns only a private non-empty file", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX custom-command fixture");
  const output = await synthesize("private speech", {
    provider: "cmd",
    voice: "",
    model: "",
    baseURL: "",
    apiKey: "",
    cmd: "cat > {out}",
    timeoutMs: 2_000,
  });
  assert.ok(output);
  try {
    assert.equal(readFileSync(output, "utf8"), "private speech");
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(output, { force: true });
  }
});

test("gateway shutdown aborts TTS and kills its custom-command descendant tree", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process-group assertion");
  const dir = mkdtempSync(join(tmpdir(), "hara-tts-abort-"));
  const pidFile = join(dir, "descendant.pid");
  const controller = new AbortController();
  let descendantPid;
  try {
    const pending = synthesize("shutdown fixture", controller.signal, {
      provider: "cmd",
      voice: "",
      model: "",
      baseURL: "",
      apiKey: "",
      cmd: `trap '' TERM; sleep 30 & echo $! > '${pidFile}'; wait`,
      timeoutMs: 30_000,
    });
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(pidFile), true, "custom provider started its descendant");
    descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
    controller.abort(new Error("gateway shutdown"));
    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not cancel TTS")), 2_000)),
      ]),
      /gateway shutdown/,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === "ESRCH");
  } finally {
    controller.abort(new Error("test cleanup"));
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
