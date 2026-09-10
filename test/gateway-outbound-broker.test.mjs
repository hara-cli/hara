import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processGatewayOutboundOnce,
  sendThroughConnectedGateway,
  serveGatewayOutboundRequests,
  submitGatewayOutbound,
} from "../dist/gateway/outbound-broker.js";
import {
  acquireGatewayInstance,
  gatewayRuntimeScope,
  GatewayRuntimeReporter,
  liveGatewayRuntimeScopes,
} from "../dist/gateway/runtime-state.js";
import { createFeishuChannelBridge } from "../dist/gateway/channel-bridges.js";
import "../dist/tools/all.js";
import { getTool } from "../dist/tools/registry.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "hara-outbound-broker-"));
}

function fakeAdapter(sent, fail = false) {
  return {
    name: "feishu",
    async start() {},
    async send(chatId, text, _signal, idempotencyKey) {
      sent.push({ chatId, text, idempotencyKey });
      if (fail) throw new Error("secret-bearing transport failure");
    },
  };
}

test("credential-free outbound requests are delivered once by the target gateway", async () => {
  const home = temporaryHome();
  const scope = gatewayRuntimeScope("feishu", "app-id-that-must-not-be-persisted");
  const sent = [];
  try {
    const queued = await submitGatewayOutbound(
      scope,
      "feishu",
      "oc_group",
      "hello from WeChat",
      "stable-operation",
      undefined,
      { home, waitMs: 0 },
    );
    assert.equal(queued.status, "queued");
    assert.equal(await processGatewayOutboundOnce(fakeAdapter(sent), scope, new AbortController().signal, { home }), 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      chatId: "oc_group",
      text: "hello from WeChat",
      idempotencyKey: queued.requestId,
    });

    const repeated = await submitGatewayOutbound(
      scope,
      "feishu",
      "oc_group",
      "hello from WeChat",
      "stable-operation",
      undefined,
      { home, waitMs: 0 },
    );
    assert.equal(repeated.status, "sent");
    assert.equal(repeated.requestId, queued.requestId);
    assert.equal(await processGatewayOutboundOnce(fakeAdapter(sent), scope, new AbortController().signal, { home }), 0);
    assert.equal(sent.length, 1, "receipt prevents a repeated external send");

    const directory = join(home, ".hara", "gateway", `outbound-${scope}`);
    const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^result-[a-f0-9]{64}\.json$/);
    const receipt = readFileSync(join(directory, files[0]), "utf8");
    assert.equal(receipt.includes("app-id-that-must-not-be-persisted"), false);
    assert.equal(receipt.includes("hello from WeChat"), false);
    if (process.platform !== "win32") assert.equal(statSync(join(directory, files[0])).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("target transport failures return a bounded receipt without leaking adapter errors", async () => {
  const home = temporaryHome();
  const scope = gatewayRuntimeScope("feishu", "another-private-app");
  try {
    const queued = await submitGatewayOutbound(scope, "feishu", "oc_group", "message", "failing-op", undefined, {
      home,
      waitMs: 0,
    });
    assert.equal(queued.status, "queued");
    await processGatewayOutboundOnce(fakeAdapter([], true), scope, new AbortController().signal, { home });
    const result = await submitGatewayOutbound(scope, "feishu", "oc_group", "message", "failing-op", undefined, {
      home,
      waitMs: 0,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error, /could not deliver/);
    assert.equal(result.error.includes("secret-bearing"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("connected-gateway routing rejects offline and ambiguous accounts instead of guessing", async () => {
  const home = temporaryHome();
  const firstScope = gatewayRuntimeScope("feishu", "first-app");
  const secondScope = gatewayRuntimeScope("feishu", "second-app");
  let releaseFirst;
  let releaseSecond;
  let firstReporter;
  let secondReporter;
  try {
    const offline = await sendThroughConnectedGateway("feishu", "oc_group", "hello", "offline", undefined, {
      home,
      waitMs: 0,
    });
    assert.deepEqual(offline, { status: "failed", error: "feishu gateway is not running" });

    releaseFirst = acquireGatewayInstance(firstScope, { home, displayPlatform: "feishu" });
    firstReporter = await GatewayRuntimeReporter.open(firstScope, "feishu", { home });
    firstReporter.connected();
    await firstReporter.flush();
    assert.deepEqual(await liveGatewayRuntimeScopes("feishu", { home }), [firstScope]);

    releaseSecond = acquireGatewayInstance(secondScope, { home, displayPlatform: "feishu" });
    secondReporter = await GatewayRuntimeReporter.open(secondScope, "feishu", { home });
    secondReporter.connected();
    await secondReporter.flush();
    assert.equal((await liveGatewayRuntimeScopes("feishu", { home })).length, 2);
    const ambiguous = await sendThroughConnectedGateway("feishu", "oc_group", "hello", "ambiguous", undefined, {
      home,
      waitMs: 0,
    });
    assert.equal(ambiguous.status, "failed");
    assert.match(ambiguous.error, /more than one.*account/);
  } finally {
    releaseSecond?.();
    releaseFirst?.();
    secondReporter?.stopped();
    firstReporter?.stopped();
    await Promise.all([secondReporter?.flush(), firstReporter?.flush()]);
    rmSync(home, { recursive: true, force: true });
  }
});

test("the eager channel_message tool uses a connected Feishu gateway instead of looking for a vendor CLI", async () => {
  const home = temporaryHome();
  const scope = gatewayRuntimeScope("feishu", "tool-owned-app");
  const sent = [];
  const abort = new AbortController();
  let release;
  let reporter;
  let worker;
  const savedGateway = process.env.HARA_GATEWAY;
  const savedAppId = process.env.HARA_FEISHU_APP_ID;
  const savedSecret = process.env.HARA_FEISHU_APP_SECRET;
  try {
    process.env.HARA_GATEWAY = "weixin";
    delete process.env.HARA_FEISHU_APP_ID;
    delete process.env.HARA_FEISHU_APP_SECRET;
    createFeishuChannelBridge("公司反馈", "oc_company", home);
    release = acquireGatewayInstance(scope, { home, displayPlatform: "feishu" });
    reporter = await GatewayRuntimeReporter.open(scope, "feishu", { home });
    reporter.connected();
    await reporter.flush();
    worker = serveGatewayOutboundRequests(fakeAdapter(sent), scope, abort.signal, { home, pollMs: 10 });

    const tool = getTool("channel_message");
    assert.ok(tool);
    assert.equal(tool.visibility, "eager");
    assert.match(tool.description, /only when both the recipient and message body are known/);
    assert.match(tool.description, /direct question\(s\) for the missing value\(s\)/);
    assert.match(tool.description, /no preface, explanation, example, or promise to send/);
    assert.match(tool.description, /Who should I send it to\? What should I send\?/);
    assert.match(tool.description, /action=list only when the user asks which destinations are available/);
    assert.match(tool.description, /internal ids, and bridge mechanics out of ordinary user-facing clarifications/);
    assert.equal(tool.classify({ action: "list" }, { cwd: process.cwd() }).effect, "read");
    assert.equal(tool.classify({ action: "send" }, { cwd: process.cwd() }).effect, "exec");
    const listed = await tool.run({ action: "list" }, { cwd: process.cwd(), stateHome: home });
    assert.match(listed, /Feishu ready/);
    assert.match(listed, /bridge:公司反馈/);
    assert.equal(listed.includes("oc_company"), false);

    const result = await tool.run(
      { action: "send", target: "bridge:公司反馈", text: "请查看今天的反馈" },
      { cwd: process.cwd(), stateHome: home, taskId: "wechat-task", toolCallId: "call-one", signal: abort.signal },
    );
    assert.match(result, /Sent to bridge:公司反馈/);
    assert.equal(sent.length, 1);
    assert.deepEqual({ chatId: sent[0].chatId, text: sent[0].text }, {
      chatId: "oc_company",
      text: "[来自 Hara 微信]\n请查看今天的反馈",
    });

    const replayed = await tool.run(
      { action: "send", target: "bridge:公司反馈", text: "请查看今天的反馈" },
      { cwd: process.cwd(), stateHome: home, taskId: "wechat-task", toolCallId: "call-one", signal: abort.signal },
    );
    assert.match(replayed, /Sent to bridge:公司反馈/);
    assert.equal(sent.length, 1, "the same tool call is idempotent");

    const intentionalRepeat = await tool.run(
      { action: "send", target: "bridge:公司反馈", text: "请查看今天的反馈" },
      { cwd: process.cwd(), stateHome: home, taskId: "wechat-task", toolCallId: "call-two", signal: abort.signal },
    );
    assert.match(intentionalRepeat, /Sent to bridge:公司反馈/);
    assert.equal(sent.length, 2, "a later explicit call may intentionally send the same text again");
  } finally {
    abort.abort();
    await worker;
    release?.();
    reporter?.stopped();
    await reporter?.flush();
    if (savedGateway === undefined) delete process.env.HARA_GATEWAY;
    else process.env.HARA_GATEWAY = savedGateway;
    if (savedAppId === undefined) delete process.env.HARA_FEISHU_APP_ID;
    else process.env.HARA_FEISHU_APP_ID = savedAppId;
    if (savedSecret === undefined) delete process.env.HARA_FEISHU_APP_SECRET;
    else process.env.HARA_FEISHU_APP_SECRET = savedSecret;
    rmSync(home, { recursive: true, force: true });
  }
});
