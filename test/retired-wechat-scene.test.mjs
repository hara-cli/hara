import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the shipped CLI does not instantiate or wire the retired group controller", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /WeChatGroupSceneController|wechatGroupScene\./);
  for (const hook of ["wechatGroupStatus", "startWechatGroupScene", "sendWechatGroupManagedDraft", "scanWechatGroupScene"]) {
    assert.doesNotMatch(source, new RegExp(hook + "\\s*:"));
  }
  assert.match(source, /gatewayStatuses: \(\) => gatewaySupervisor\.list\(\["weixin", "feishu"\]\)/);
  assert.match(source, /computerSettings: \(targetCwd\) => computerSettingsFor/);
  assert.match(source, /decisionSettings: \(targetCwd\) => decisionSettingsSnapshot/);
});

test("native release smoke rejects a resurrected scene while requiring independent retained capabilities", () => {
  const source = readFileSync(new URL("../scripts/standalone-serve-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /methods\]\.some\(method => method\.startsWith\("settings\.wechat-group\."\)\)/);
  assert.match(source, /retiredStart\.error\?\.code !== -32601/);
  for (const method of ["settings.computer.get", "settings.decision.get", "settings.gateways.list"]) assert.ok(source.includes(method));
});
