import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WeChatGroupSceneController } from "../dist/wechat-group-scene.js";
import { BUNDLED_JEV_WECHAT_FILES } from "../dist/embedded/jev-wechat.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hara-wechat-group-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}

test("standalone builds embed the audited Jev bridge and migrate source-path settings", (t) => {
  assert.equal(
    BUNDLED_JEV_WECHAT_FILES["bridge.py"],
    readFileSync(new URL("../scripts/jev-wechat-bridge.py", import.meta.url), "utf8"),
  );
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsDir = join(home, ".hara", "wechat-group");
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    version: 1,
    helperRoot: "/obsolete/developer/path",
    agentRef: "global:fanli",
    trigger: "manual",
  }));
  chmodSync(settingsPath, 0o600);
  assert.deepEqual(new WeChatGroupSceneController({ home, platform: "darwin", bridge: async () => ({ ok: true }) }).settings(), {
    version: 4,
    agentRef: "global:fanli",
    trigger: "manual",
    mode: "assist",
    managedTrigger: "mention",
    managedMentionName: "",
  });
  writeFileSync(settingsPath, JSON.stringify({
    version: 3,
    agentRef: "global:hara",
    trigger: "manual",
    mode: "assist",
    managedTrigger: "mention",
  }));
  const migrated = new WeChatGroupSceneController({ home, platform: "darwin", bridge: async () => ({ ok: true }) });
  assert.equal(migrated.settings().agentRef, "main");
  assert.equal(migrated.save({ agentRef: "main" }).agentRef, "main");
  assert.equal(migrated.save({ agentRef: "main", managedMentionName: "＠ 小南" }).managedMentionName, "小南");
  assert.throws(
    () => migrated.save({ agentRef: "main", managedMentionName: "@only@inside" }),
    /valid group wake name/i,
  );
});

test("local WeChat group scene binds one visible conversation and fills only a remembered draft", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let title = "产品讨论群";
  let digest = "a".repeat(64);
  const calls = [];
  const controller = new WeChatGroupSceneController({
    home,
    platform: "darwin",
    now: (() => { let value = 1_000; return () => ++value; })(),
    bridge: async (request) => {
      calls.push(request);
      if (request.action === "status" || request.action === "request-permissions") {
        return { ok: true, screenCapture: "granted", accessibility: "granted", wechat: "running" };
      }
      if (request.action === "scan") {
        return {
          ok: true,
          title,
          digest,
          messages: [
            { side: "me", text: "上一个回复", confidence: 0.99 },
            { side: "them", sender: "小林", text: "今天能发版吗？", confidence: 0.98 },
          ],
        };
      }
      if (request.action === "fill") {
        return { ok: true, filled: true, reason: "已填入（未发送）" };
      }
      throw new Error("unexpected bridge action");
    },
  });

  controller.save({ agentRef: "global:fanli" });
  const status = await controller.status();
  assert.equal(status.helper, "ready");
  assert.equal(status.screenCapture, "granted");
  assert.equal(status.accessibility, "granted");
  assert.equal((await controller.requestPermissions()).screenCapture, "granted");
  assert.ok(calls.some((request) => request.action === "request-permissions"));

  await assert.rejects(() => controller.start("/work", false), /confirm/i);
  const started = await controller.start("/work", true);
  assert.equal(started.status.active, true);
  assert.equal(started.preview.conversation, "产品讨论群");
  assert.equal(started.preview.latestIncoming.sender, "小林");

  const context = controller.replyContext(started.preview.scanId);
  assert.equal(context.agentRef, "global:fanli");
  assert.equal(context.latestIncoming.text, "今天能发版吗？");
  assert.equal(context.managed, false);
  const draft = controller.rememberDraft(started.preview.scanId, "可以，完成验证后今天发版。");
  const filled = await controller.fill(draft.draftId);
  assert.deepEqual(filled, { filled: true, reviewRequired: false, reason: "已填入（未发送）" });
  const fillRequest = calls.find((request) => request.action === "fill");
  assert.equal(fillRequest.draft, "可以，完成验证后今天发版。");
  assert.equal(fillRequest.expectedTitle, "产品讨论群");
  assert.equal(fillRequest.expectedDigest, "a".repeat(64));
});

test("initial group attachment retries one transient frame without an incoming bubble", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let scans = 0;
  const controller = new WeChatGroupSceneController({
    home,
    platform: "darwin",
    bridge: async (request) => {
      if (request.action === "status") {
        return { ok: true, screenCapture: "granted", accessibility: "granted", wechat: "running" };
      }
      if (request.action === "scan") {
        scans += 1;
        return {
          ok: true,
          title: "产品讨论群",
          digest: String(scans).repeat(64),
          messages: scans === 1
            ? [{ side: "me", text: "刚发送的消息", confidence: 0.99 }]
            : [{ side: "them", sender: "小林", text: "这条现在可见", confidence: 0.99 }],
        };
      }
      throw new Error(`unexpected bridge action ${request.action}`);
    },
  });

  controller.save({ agentRef: "global:hara" });
  const started = await controller.start("/work", true);
  assert.equal(scans, 2);
  assert.equal(started.status.active, true);
  assert.equal(started.preview.latestIncoming.text, "这条现在可见");
});

test("managed mode requires a fresh confirmation and uses the configured group wake name", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let digest = "1".repeat(64);
  let incoming = "刚才的旧消息";
  let outgoing = "";
  const calls = [];
  let now = 10_000;
  const controller = new WeChatGroupSceneController({
    home,
    platform: "darwin",
    now: () => now,
    bridge: async (request) => {
      calls.push(request);
      if (request.action === "status") {
        return { ok: true, screenCapture: "granted", accessibility: "granted", wechat: "running" };
      }
      if (request.action === "scan") {
        return {
          ok: true,
          title: "产品讨论群",
          digest,
          messages: [
            { side: "them", sender: "小林", text: incoming, confidence: 0.99 },
            ...(outgoing ? [{ side: "me", text: outgoing, confidence: 0.99 }] : []),
          ],
        };
      }
      if (request.action === "send-preflight") {
        return { ok: true, ready: true, inputMode: "visual" };
      }
      if (request.action === "send") {
        return { ok: true, sent: true, inputMode: "visual", reason: "verified" };
      }
      throw new Error(`unexpected bridge action ${request.action}`);
    },
  });

  controller.save({
    agentRef: "global:fanli",
    mode: "managed",
    managedTrigger: "mention",
    managedMentionName: "小南",
  });
  await assert.rejects(() => controller.start("/work", true, false), /confirmManaged/);
  const started = await controller.start("/work", true, true);
  assert.equal(started.status.managedArmed, true);
  assert.equal(started.status.lastManagedEvent, "armed");
  assert.equal(started.status.lastManagedDetail, "delivery_visual");
  assert.deepEqual(controller.managedClaim(started.preview.scanId, ["Fanli"]), {
    action: "idle",
    reason: "this observation was already handled",
  });

  digest = "2".repeat(64);
  incoming = "今天能发版吗？";
  const unmentioned = await controller.scan("/work");
  assert.equal(controller.managedClaim(unmentioned.scanId, ["Fanli"]).action, "ignore");
  assert.equal((await controller.status()).lastManagedDetail, "mention_required");

  digest = "3".repeat(64);
  incoming = "@Fanli 今天能发版吗？";
  const oldAlias = await controller.scan("/work");
  assert.equal(controller.managedClaim(oldAlias.scanId, ["Fanli"]).action, "ignore");

  digest = "4".repeat(64);
  incoming = "@小南助手 今天能发版吗？";
  const longerName = await controller.scan("/work");
  assert.equal(controller.managedClaim(longerName.scanId, ["Fanli"]).action, "ignore");

  digest = "5".repeat(64);
  incoming = "请 @小南，今天能发版吗？";
  const mentioned = await controller.scan("/work");
  assert.equal(controller.managedClaim(mentioned.scanId, ["Fanli"]).action, "reply");
  assert.equal(controller.replyContext(mentioned.scanId).managed, true);
  const draft = controller.rememberDraft(mentioned.scanId, "可以，完成验证后今天发版。");
  now += 20_000;
  assert.deepEqual(await controller.sendManaged(draft.draftId), { sent: true, reason: "verified" });
  assert.equal((await controller.status()).lastManagedEvent, "sent");
  assert.equal((await controller.status()).lastManagedDetail, "delivery_visual");
  const send = calls.find((request) => request.action === "send");
  assert.equal(send.managed, true);
  assert.equal(send.expectedTitle, "产品讨论群");
  assert.equal(send.expectedDigest, "5".repeat(64));

  digest = "6".repeat(64);
  outgoing = "可以，完成验证后今天发版。";
  const afterOwnSend = await controller.scan("/work");
  assert.equal(controller.managedClaim(afterOwnSend.scanId, ["Fanli"]).action, "idle");

  const audit = readFileSync(join(home, ".hara", "wechat-group", "managed-audit.json"), "utf8");
  assert.doesNotMatch(audit, /产品讨论群|今天能发版/);
  assert.match(audit, /"event": "sent"/);
});

test("managed mode refuses to arm when no verified delivery route is available", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new WeChatGroupSceneController({
    home,
    platform: "darwin",
    bridge: async (request) => {
      if (request.action === "status") {
        return { ok: true, screenCapture: "granted", accessibility: "granted", wechat: "running" };
      }
      if (request.action === "scan") {
        return {
          ok: true,
          title: "产品讨论群",
          digest: "d".repeat(64),
          messages: [{ side: "them", text: "请回复", confidence: 0.99 }],
        };
      }
      if (request.action === "send-preflight") {
        return { ok: false, ready: false, category: "send_control_unavailable", error: "send unavailable" };
      }
      throw new Error(`unexpected bridge action ${request.action}`);
    },
  });
  controller.save({ agentRef: "main", mode: "managed", managedTrigger: "all" });
  await assert.rejects(() => controller.start("/work", true, true), /send unavailable/);
  assert.equal((await controller.status()).active, false);
  assert.equal((await controller.status()).managedArmed, false);
});

test("an uncertain visual fill is consumed once and returned as a review state", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new WeChatGroupSceneController({
    home,
    platform: "darwin",
    bridge: async (request) => {
      if (request.action === "status") {
        return { ok: true, screenCapture: "granted", accessibility: "granted", wechat: "running" };
      }
      if (request.action === "scan") {
        return {
          ok: true,
          title: "产品讨论群",
          digest: "a".repeat(64),
          messages: [{ side: "them", text: "请回复", confidence: 0.99 }],
        };
      }
      if (request.action === "fill") {
        return {
          ok: true,
          filled: false,
          attempted: true,
          reviewRequired: true,
          reason: "已尝试输入，画面未能确认；请检查草稿，勿重复点击",
        };
      }
      throw new Error(`unexpected bridge action ${request.action}`);
    },
  });
  controller.save({ agentRef: "main" });
  const started = await controller.start("/work", true);
  const draft = controller.rememberDraft(started.preview.scanId, "收到");
  assert.deepEqual(await controller.fill(draft.draftId), {
    filled: false,
    reviewRequired: true,
    reason: "已尝试输入，画面未能确认；请检查草稿，勿重复点击",
  });
  await assert.rejects(() => controller.fill(draft.draftId), /expired/i);
});

test("switching away from the attached group invalidates further observations", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let title = "A 群";
  let digest = "b".repeat(64);
  const controller = new WeChatGroupSceneController({
    home,
    platform: "darwin",
    bridge: async (request) => request.action === "status"
      ? { ok: true, screenCapture: "granted", accessibility: "required", wechat: "running" }
      : {
          ok: true,
          title,
          digest,
          messages: [{ side: "them", text: "你好", confidence: 1 }],
        },
  });
  controller.save({ agentRef: "global:hara" });
  await controller.start("/work", true);
  title = "B 群";
  digest = "c".repeat(64);
  await assert.rejects(() => controller.scan("/work"), /visible WeChat conversation changed/i);
});

test("scene refuses unsupported platforms", async (t) => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new WeChatGroupSceneController({ home, platform: "linux" });
  assert.throws(
    () => controller.save({ agentRef: "global:hara" }),
    /requires macOS/i,
  );
  assert.equal((await controller.status()).helper, "unsupported");
});
