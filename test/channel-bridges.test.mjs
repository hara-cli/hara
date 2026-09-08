import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelBridgeNameForSource,
  channelBridgeWeixinTargets,
  createFeishuChannelBridge,
  handleChannelBridgeCommand,
  listChannelBridges,
  removeChannelBridge,
  resolveChannelBridgeTarget,
  subscribeWeixinChannelBridge,
  unsubscribeWeixinChannelBridge,
} from "../dist/gateway/channel-bridges.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "hara-channel-bridges-"));
}

test("channel bridges require an explicit Feishu source and per-WeChat subscription", () => {
  const home = temporaryHome();
  try {
    assert.deepEqual(listChannelBridges(home), []);
    assert.deepEqual(createFeishuChannelBridge("研发反馈", "oc_private_group", home, 1_000), {
      created: true,
      name: "研发反馈",
    });
    assert.equal(resolveChannelBridgeTarget("研发反馈", home), "feishu:oc_private_group");
    assert.deepEqual(channelBridgeWeixinTargets("feishu", "oc_private_group", home), []);

    assert.equal(subscribeWeixinChannelBridge("研发反馈", "wxid_alice", "Alice", home, 2_000), true);
    assert.equal(subscribeWeixinChannelBridge("研发反馈", "wxid_alice", "Alice", home, 2_001), false);
    assert.equal(subscribeWeixinChannelBridge("研发反馈", "wxid_bob", "Bob", home, 2_002), true);
    assert.deepEqual(channelBridgeWeixinTargets("feishu", "oc_private_group", home), [
      "weixin:wxid_alice",
      "weixin:wxid_bob",
    ]);
    assert.equal(channelBridgeNameForSource("feishu", "oc_private_group", home), "研发反馈");
    assert.deepEqual(listChannelBridges(home, "wxid_alice"), [{
      name: "研发反馈",
      sourcePlatform: "feishu",
      subscribers: 2,
      enabled: true,
      subscribed: true,
    }]);

    assert.equal(unsubscribeWeixinChannelBridge("研发反馈", "wxid_alice", home, 3_000), true);
    assert.equal(unsubscribeWeixinChannelBridge("研发反馈", "wxid_alice", home, 3_001), false);
    assert.deepEqual(channelBridgeWeixinTargets("feishu", "oc_private_group", home), ["weixin:wxid_bob"]);

    const registry = join(home, ".hara", "gateway", "channel-bridges.json");
    if (process.platform !== "win32") assert.equal(statSync(registry).mode & 0o777, 0o600);
    assert.match(readFileSync(registry, "utf8"), /wxid_bob/);
    assert.equal(removeChannelBridge("研发反馈", home), true);
    assert.equal(resolveChannelBridgeTarget("研发反馈", home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge commands are owner-gated, confirmed on removal, and never disclose platform ids", () => {
  const home = temporaryHome();
  const group = {
    platform: "feishu",
    chatType: "group",
    chatId: "oc_secret_group",
    userId: "ou_owner",
    userName: "Owner",
    isOwner: false,
    home,
  };
  try {
    assert.match(handleChannelBridgeCommand("on 公司通知", group), /只有.*所有者/);
    assert.equal(listChannelBridges(home).length, 0);

    const created = handleChannelBridgeCommand("on 公司通知", { ...group, isOwner: true });
    assert.match(created, /已将当前飞书群启用/);
    assert.equal(created.includes("oc_secret_group"), false);

    const weixin = {
      platform: "weixin",
      chatType: "p2p",
      chatId: "wxid_member",
      userId: "wxid_member",
      userName: "Member",
      isOwner: false,
      home,
    };
    assert.match(handleChannelBridgeCommand("join 公司通知 --as 王同事", weixin), /已订阅/);
    const listed = handleChannelBridgeCommand("list", weixin);
    assert.match(listed, /公司通知.*1 位微信订阅者.*已订阅/);
    assert.equal(listed.includes("wxid_member"), false);
    assert.equal(listed.includes("oc_secret_group"), false);
    assert.match(readFileSync(join(home, ".hara", "gateway", "channel-bridges.json"), "utf8"), /王同事/);

    assert.match(handleChannelBridgeCommand("remove 公司通知", { ...group, isOwner: true }), /请确认/);
    assert.equal(listChannelBridges(home).length, 1);
    assert.match(handleChannelBridgeCommand("remove 公司通知 confirm", { ...group, isOwner: true }), /已删除/);
    assert.equal(listChannelBridges(home).length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bridge names and peers reject ambiguous routing syntax", () => {
  const home = temporaryHome();
  try {
    assert.throws(() => createFeishuChannelBridge("bad:name", "oc_group", home), /不能包含/);
    assert.throws(() => createFeishuChannelBridge("ok", "bad\npeer", home), /invalid Feishu chat id/);
    createFeishuChannelBridge("one", "oc_one", home);
    assert.throws(() => createFeishuChannelBridge("one", "oc_two", home), /已被其他飞书群使用/);
    assert.throws(() => createFeishuChannelBridge("renamed", "oc_one", home), /已启用为/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
