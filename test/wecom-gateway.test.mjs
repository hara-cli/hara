import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import {
  decryptWecomMedia,
  parseWecomMessage,
  wecomAdapter,
  wecomTimestampMs,
} from "../dist/gateway/wecom.js";
import { cleanupTransientMedia } from "../dist/gateway/media.js";

const ACK = (frame, extra = {}) => JSON.stringify({
  headers: { req_id: frame.headers.req_id },
  errcode: 0,
  errmsg: "ok",
  ...extra,
});

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fakeWecom(handler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set();
  const errors = [];
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch (error) {
        errors.push(error);
        return;
      }
      void Promise.resolve(handler(frame, socket, connections)).catch((error) => errors.push(error));
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    errors,
    connectionCount: () => connections,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function encryptWecomFixture(plain, key, paddingByte) {
  const pad = paddingByte ?? 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

test("WeCom parser exposes stable delivery metadata and classifies attachments", () => {
  const timestamp = 1_762_345_678;
  const video = parseWecomMessage({
    headers: { req_id: "callback-fallback" },
    body: {
      msgid: "message-1",
      create_time: timestamp,
      from: { userid: "u1" },
      chattype: "single",
      msgtype: "video",
      video: { url: "https://example.invalid/video", filename: "clip.mp4" },
    },
  }, "bot-1");
  assert.equal(video.msg.messageId, "message-1");
  assert.equal(video.msg.createdAtMs, timestamp * 1_000);
  assert.equal(video.msg.text, "[视频]");
  assert.equal(video.media[0].kind, "video");
  assert.equal(video.media[0].fileName, "clip.mp4");

  const mixed = parseWecomMessage({
    headers: { req_id: "callback-2" },
    body: {
      from: { userid: "u2" },
      chattype: "group",
      chatid: "room-1",
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "请看" } },
          { msgtype: "image", image: { url: "https://example.invalid/image" } },
        ],
      },
    },
  }, "bot-1");
  assert.equal(mixed.msg.messageId, "callback-2");
  assert.equal(mixed.msg.text, "请看");
  assert.equal(mixed.msg.chatType, "group");
  assert.equal(mixed.media[0].kind, "image");
  assert.equal(wecomTimestampMs("1762345678000"), 1_762_345_678_000);
  assert.equal(wecomTimestampMs("bad"), undefined);
});

test("WeCom media decryption rejects empty, malformed, and invalid-padded ciphertext", () => {
  const key = Buffer.alloc(32, 7);
  const encodedKey = key.toString("base64");
  const plain = Buffer.from("local WeCom fixture");
  assert.deepEqual(decryptWecomMedia(encryptWecomFixture(plain, key), encodedKey), plain);
  assert.throws(() => decryptWecomMedia(Buffer.alloc(0), encodedKey), /empty/);
  assert.throws(() => decryptWecomMedia(Buffer.alloc(15), encodedKey), /length/);

  const invalidPlain = Buffer.alloc(32, 1);
  invalidPlain[31] = 0;
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const invalidCiphertext = Buffer.concat([cipher.update(invalidPlain), cipher.final()]);
  assert.throws(() => decryptWecomMedia(invalidCiphertext, encodedKey), /padding/);
});

test("WeCom local WebSocket round-trip authenticates before send and uploads verified chunks", async () => {
  const authFrames = [];
  const outboundFrames = [];
  const uploadInit = [];
  const uploadChunks = [];
  let resolveInbound;
  const inbound = new Promise((resolve) => { resolveInbound = resolve; });
  const fake = await fakeWecom((frame, socket) => {
    if (frame.cmd === "aibot_subscribe") {
      authFrames.push(frame);
      socket.send(ACK(frame));
      socket.send(JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: { req_id: "callback-1" },
        body: {
          msgid: "message-1",
          create_time: 1_762_345_678,
          from: { userid: "user-1" },
          chattype: "single",
          msgtype: "text",
          text: { content: "本地测试" },
        },
      }));
      return;
    }
    if (frame.cmd === "aibot_send_msg") {
      outboundFrames.push(frame);
      socket.send(ACK(frame));
      return;
    }
    if (frame.cmd === "aibot_upload_media_init") {
      uploadInit.push(frame);
      socket.send(ACK(frame, { body: { upload_id: "upload-local-1" } }));
      return;
    }
    if (frame.cmd === "aibot_upload_media_chunk") {
      uploadChunks.push(frame);
      socket.send(ACK(frame));
      return;
    }
    if (frame.cmd === "aibot_upload_media_finish") {
      socket.send(ACK(frame, { body: { media_id: "media-local-1" } }));
      return;
    }
    if (frame.cmd === "ping") socket.send(ACK(frame));
  });

  const controller = new AbortController();
  const adapter = wecomAdapter("bot-local", "secret-local", fake.url, {
    requestTimeoutMs: 500,
    heartbeatMs: 200,
    reconnectBaseMs: 10,
    maxAuthFailures: 1,
  });
  const running = adapter.start(async (message) => resolveInbound(message), controller.signal);
  try {
    const received = await Promise.race([
      inbound,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for inbound callback")), 2_000)),
    ]);
    assert.deepEqual(received, {
      chatId: "user-1",
      userId: "user-1",
      userName: "user-1",
      text: "本地测试",
      messageId: "message-1",
      createdAtMs: 1_762_345_678_000,
      chatType: "p2p",
      images: undefined,
      transientFiles: undefined,
    });

    await adapter.send("user-1", "本地回复");
    const bytes = Buffer.alloc(600 * 1024, 0x5a);
    await adapter.sendFile("user-1", {
      safeName: "fixture.bin",
      bytes,
      snapshotPath: "",
    });

    assert.equal(authFrames.length, 1);
    assert.deepEqual(authFrames[0].body, { bot_id: "bot-local", secret: "secret-local" });
    assert.equal(outboundFrames[0].body.markdown.content, "本地回复");
    assert.equal(outboundFrames[0].body.chatid, "user-1");
    assert.equal(uploadInit[0].body.total_chunks, 2);
    assert.equal(uploadInit[0].body.total_size, bytes.length);
    assert.equal(uploadInit[0].body.md5, createHash("md5").update(bytes).digest("hex"));
    assert.deepEqual(uploadChunks.map((frame) => frame.body.chunk_index), [0, 1]);
    assert.deepEqual(
      Buffer.concat(uploadChunks.map((frame) => Buffer.from(frame.body.base64_data, "base64"))),
      bytes,
    );
    assert.equal(outboundFrames[1].body.file.media_id, "media-local-1");
    assert.deepEqual(fake.errors, []);
  } finally {
    controller.abort();
    await running;
    await fake.close();
  }
});

test("WeCom auth failures stop after a bound and outbound calls report the disconnected state", async () => {
  const secret = "must-not-appear-in-errors";
  const fake = await fakeWecom((frame, socket) => {
    if (frame.cmd === "aibot_subscribe") {
      socket.send(JSON.stringify({
        headers: { req_id: frame.headers.req_id },
        errcode: 40001,
        errmsg: `invalid credential ${secret}`,
      }));
    }
  });
  const adapter = wecomAdapter("bot-bad", secret, fake.url, {
    requestTimeoutMs: 200,
    reconnectBaseMs: 10,
    maxAuthFailures: 1,
  });
  const controller = new AbortController();
  try {
    const running = adapter.start(async () => undefined, controller.signal);
    await assert.rejects(adapter.send("user-1", "never sent"), /not authenticated/);
    await assert.rejects(running, (error) => {
      assert.match(error.message, /authentication failed 1 time/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.deepEqual(fake.errors, []);
  } finally {
    controller.abort();
    await fake.close();
  }
});

test("WeCom nonzero send acknowledgements are failures and never expose the configured secret", async () => {
  const secret = "send-secret-must-be-redacted";
  let resolveInbound;
  const inbound = new Promise((resolve) => { resolveInbound = resolve; });
  const fake = await fakeWecom((frame, socket) => {
    if (frame.cmd === "aibot_subscribe") {
      socket.send(ACK(frame));
      socket.send(JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: { req_id: "send-error-callback" },
        body: {
          msgid: "send-error-message",
          create_time: Math.floor(Date.now() / 1_000),
          from: { userid: "user-1" },
          chattype: "single",
          msgtype: "text",
          text: { content: "ready" },
        },
      }));
      return;
    }
    if (frame.cmd === "aibot_send_msg") {
      socket.send(JSON.stringify({
        headers: { req_id: frame.headers.req_id },
        errcode: 45009,
        errmsg: `rate limited ${secret}`,
      }));
    }
  });
  const adapter = wecomAdapter("bot-send-error", secret, fake.url, {
    requestTimeoutMs: 200,
    maxAuthFailures: 1,
  });
  const controller = new AbortController();
  const running = adapter.start(async (message) => resolveInbound(message), controller.signal);
  try {
    await inbound;
    await assert.rejects(adapter.send("user-1", "must fail"), (error) => {
      assert.match(error.message, /45009/);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.deepEqual(fake.errors, []);
  } finally {
    controller.abort();
    await running;
    await fake.close();
  }
});

test("WeCom local media preflight keeps files out of the vision image list", async () => {
  const priorHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "hara-wecom-media-home-"));
  process.env.HOME = home;
  const received = [];
  let resolveMessages;
  const messages = new Promise((resolve) => { resolveMessages = resolve; });
  const fake = await fakeWecom((frame, socket) => {
    if (frame.cmd !== "aibot_subscribe") return;
    socket.send(ACK(frame));
    for (const body of [
      {
        msgid: "media-image",
        create_time: Math.floor(Date.now() / 1_000),
        from: { userid: "allowed-user" },
        chattype: "single",
        msgtype: "image",
        image: {
          base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64"),
        },
      },
      {
        msgid: "media-file",
        create_time: Math.floor(Date.now() / 1_000),
        from: { userid: "allowed-user" },
        chattype: "single",
        msgtype: "file",
        file: {
          filename: "report.pdf",
          base64: Buffer.from("%PDF-local-fixture").toString("base64"),
        },
      },
    ]) {
      socket.send(JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: { req_id: `callback-${body.msgid}` },
        body,
      }));
    }
  });
  const adapter = wecomAdapter("bot-media", "secret-media", fake.url, {
    requestTimeoutMs: 500,
    maxAuthFailures: 1,
  });
  const controller = new AbortController();
  const running = adapter.start(async (message) => {
    received.push(message);
    if (received.length === 2) resolveMessages();
  }, controller.signal, () => true);
  const transient = [];
  try {
    await Promise.race([
      messages,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for local media")), 2_000)),
    ]);
    const image = received.find((message) => message.messageId === "media-image");
    const file = received.find((message) => message.messageId === "media-file");
    assert.equal(image.images.length, 1);
    assert.equal(image.transientFiles.length, 1);
    assert.equal(image.images[0], image.transientFiles[0]);
    assert.ok(existsSync(image.images[0]));
    assert.equal(file.images, undefined);
    assert.equal(file.transientFiles.length, 1);
    assert.match(file.text, /^\[文件 report\.pdf: .+\.pdf\]$/);
    assert.ok(existsSync(file.transientFiles[0]));
    transient.push(...image.transientFiles, ...file.transientFiles);
    assert.deepEqual(fake.errors, []);
  } finally {
    controller.abort();
    await running;
    await fake.close();
    await cleanupTransientMedia("wecom", transient, join(home, ".hara"));
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("WeCom reconnects when two heartbeat ACKs are missed", async () => {
  const fake = await fakeWecom((frame, socket) => {
    if (frame.cmd === "aibot_subscribe") socket.send(ACK(frame));
    // Deliberately ignore ping frames to emulate a half-open connection.
  });
  const adapter = wecomAdapter("bot-heartbeat", "secret-heartbeat", fake.url, {
    heartbeatMs: 50,
    requestTimeoutMs: 200,
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
    maxAuthFailures: 1,
  });
  const controller = new AbortController();
  const running = adapter.start(async () => undefined, controller.signal);
  try {
    await waitFor(() => fake.connectionCount() >= 2, "heartbeat reconnect", 2_000);
    assert.deepEqual(fake.errors, []);
  } finally {
    controller.abort();
    await running;
    await fake.close();
  }
});

test("spawned hara gateway uses the local WeCom transport and rejects a blocked sender", async () => {
  let resolveReply;
  const reply = new Promise((resolve) => { resolveReply = resolve; });
  const fake = await fakeWecom((frame, socket) => {
    if (frame.cmd === "aibot_subscribe") {
      socket.send(ACK(frame));
      socket.send(JSON.stringify({
        cmd: "aibot_msg_callback",
        headers: { req_id: "process-callback-1" },
        body: {
          msgid: "process-message-1",
          create_time: Math.floor(Date.now() / 1_000),
          from: { userid: "blocked-user" },
          chattype: "single",
          msgtype: "text",
          text: { content: "should not execute" },
        },
      }));
      return;
    }
    if (frame.cmd === "aibot_send_msg") {
      resolveReply(frame);
      socket.send(ACK(frame));
      return;
    }
    if (frame.cmd === "ping") socket.send(ACK(frame));
  });

  const home = mkdtempSync(join(tmpdir(), "hara-wecom-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "hara-wecom-work-"));
  const localSecret = "process-local-secret";
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "cli.js"), "gateway", "--platform", "wecom", "--cwd", cwd], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HARA_WECOM_BOT_ID: "process-local-bot",
      HARA_WECOM_SECRET: localSecret,
      HARA_WECOM_WS_URL: fake.url,
      HARA_GATEWAY_ALLOWED: "allowed-user",
      HARA_GATEWAY_OWNER: "",
      HARA_GATEWAY_OUTBOUND_TIMEOUT_MS: "2000",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-64 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-64 * 1024); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const sent = await Promise.race([
      reply,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`gateway reply timeout\n${stderr}`)), 5_000)),
    ]);
    assert.equal(sent.body.chatid, "blocked-user");
    assert.equal(sent.body.markdown.content, "⛔ not authorized.");
    assert.match(stderr, /hara gateway: wecom up/);
    assert.match(stderr, /hara wecom: authenticated/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(localSecret));

    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("spawned gateway did not stop")), 3_000)),
    ]);
    assert.equal(result.code, 0, `gateway exited via ${result.signal}\n${stderr}`);
    assert.deepEqual(fake.errors, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await fake.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
