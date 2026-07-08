// DashScope thinking toggle: reasoning "off" must actually disable the thinking phase (enable_thinking:
// false), the main DashScope latency — not just hide it (measured: qwen3.7-plus 14s → 1.6s). Detected by
// the DashScope ENDPOINT (baseURL / qwen provider), NOT the model name, so a custom qwen3.7-plus/glm-5
// profile is covered. UNSET leaves the request untouched (zero impact — the safe default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dashscopeThinking } from "../dist/providers/openai.js";

const DS = "https://coding.dashscope.aliyuncs.com/v1"; // the reporter's custom endpoint

test("dashscopeThinking: DashScope baseURL + reasoning off → disable thinking (false)", () => {
  assert.equal(dashscopeThinking("off", DS), false, "custom baseURL on dashscope (custom:qwen3.7-plus)");
  assert.equal(dashscopeThinking("off", undefined, "qwen"), false, "built-in qwen provider");
  assert.equal(dashscopeThinking("off", undefined, "qwen-oauth"), false, "qwen-oauth");
});

test("dashscopeThinking: DashScope + explicit low/medium/high → keep thinking on (true)", () => {
  assert.equal(dashscopeThinking("low", DS), true);
  assert.equal(dashscopeThinking("high", undefined, "qwen"), true);
});

test("dashscopeThinking: dial UNSET → undefined (leave untouched, model default, ZERO impact)", () => {
  assert.equal(dashscopeThinking(undefined, DS), undefined, "unset on dashscope → untouched");
  assert.equal(dashscopeThinking(undefined, undefined, "qwen"), undefined);
});

test("dashscopeThinking: non-DashScope endpoints are never touched", () => {
  assert.equal(dashscopeThinking("off", "https://api.openai.com/v1", "openai"), undefined);
  assert.equal(dashscopeThinking("off", "https://open.bigmodel.cn/api/paas/v4", "glm"), undefined, "GLM's own endpoint uses a different param");
  assert.equal(dashscopeThinking("off", "https://api.deepseek.com", "deepseek"), undefined);
  assert.equal(dashscopeThinking("off", undefined, "hara-gateway"), undefined);
});
