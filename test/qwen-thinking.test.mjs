// Reasoning is now data-driven: the registry maps a platform → a reasoning STYLE, and the applier maps
// the dial → wire params. Pins the DashScope speedup path (enable_thinking) end to end, plus the other
// styles and the resolver that makes a custom DashScope profile Just Work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reasoningParams, supportsReasoningStyle } from "../dist/providers/reasoning.js";
import { resolvePlatform } from "../dist/providers/registry.js";

const DS = "https://coding.dashscope.aliyuncs.com/v1"; // the reporter's custom endpoint

test("reasoningParams enable_thinking: off → stop thinking (fast), levels → on, UNSET → untouched", () => {
  assert.deepEqual(reasoningParams("enable_thinking", "off"), { enable_thinking: false });
  assert.deepEqual(reasoningParams("enable_thinking", "low"), { enable_thinking: true });
  assert.deepEqual(reasoningParams("enable_thinking", "high"), { enable_thinking: true });
  assert.deepEqual(reasoningParams("enable_thinking", undefined), {}, "UNSET → {} (model default, zero impact)");
});

test("Coding Plan coder models suppress the unsupported thinking parameter", () => {
  for (const model of ["qwen3-coder-next", "qwen3-coder-plus", "qwen/qwen3-coder-plus"]) {
    assert.equal(supportsReasoningStyle("enable_thinking", model), false, model);
    assert.deepEqual(reasoningParams("enable_thinking", "high", model), {}, model);
    assert.deepEqual(reasoningParams("enable_thinking", "off", model), {}, `${model} also rejects enable_thinking:false`);
  }
  assert.equal(supportsReasoningStyle("enable_thinking", "qwen3.7-plus"), true);
});

test("reasoningParams reasoning_effort: only OpenAI reasoning models; off → minimal", () => {
  assert.deepEqual(reasoningParams("reasoning_effort", "high", "gpt-5"), { reasoning_effort: "high" });
  assert.deepEqual(reasoningParams("reasoning_effort", "off", "o3"), { reasoning_effort: "minimal" });
  assert.deepEqual(reasoningParams("reasoning_effort", "high", "qwen3.7-plus"), {}, "non-reasoning model → untouched");
});

test("reasoningParams reasoning_object (Responses API): reasoning:{effort} on reasoning models", () => {
  assert.deepEqual(reasoningParams("reasoning_object", "medium", "gpt-5"), { reasoning: { effort: "medium" } });
  assert.deepEqual(reasoningParams("reasoning_object", "medium", "qwen3.7-plus"), {});
});

test("reasoningParams none / thinking_budget: nothing merged on the chat/responses body", () => {
  assert.deepEqual(reasoningParams("none", "off"), {});
  assert.deepEqual(reasoningParams("thinking_budget", "high"), {}, "Anthropic thinking is applied in anthropic.ts");
});

test("reasoningParams ollama_think: off → think:false (measured 17s→0.6s), levels → true, UNSET → {}", () => {
  assert.deepEqual(reasoningParams("ollama_think", "off"), { think: false });
  assert.deepEqual(reasoningParams("ollama_think", "medium"), { think: true });
  assert.deepEqual(reasoningParams("ollama_think", undefined), {});
});

test("resolvePlatform: local Ollama / LM Studio → chat + ollama_think, no cache", () => {
  for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://localhost:1234/v1"]) {
    const caps = resolvePlatform("ollama", url);
    assert.equal(caps.reasoning, "ollama_think", url);
    assert.equal(caps.cache, "none");
  }
});

test("resolvePlatform: ANY vendor's /anthropic endpoint → anthropic wire + thinking budget + cache_control", () => {
  for (const url of ["https://api.deepseek.com/anthropic", "https://api.moonshot.cn/anthropic", "https://open.bigmodel.cn/api/anthropic", "https://api.minimaxi.com/anthropic"]) {
    const caps = resolvePlatform("custom", url);
    assert.equal(caps.wireApi, "anthropic", url);
    assert.equal(caps.reasoning, "thinking_budget");
    assert.equal(caps.cache, "cache_control");
  }
});

test("resolvePlatform: DeepSeek OpenAI-compat (chat) → the deepseek style (thinking:{type} + reasoning_effort)", () => {
  // DeepSeek V4 (v4-pro/v4-flash) added a per-request thinking switch + reasoning_effort(high|max) on the
  // OpenAI-compat chat path — see the `deepseek` reasoning style in reasoning.ts.
  assert.equal(resolvePlatform("deepseek", "https://api.deepseek.com").reasoning, "deepseek");
  assert.equal(resolvePlatform("deepseek", "https://api.deepseek.com/v1").wireApi, "chat");
  // The vendor's /anthropic endpoint still wins (checked first) → anthropic wire, not the chat deepseek style.
  assert.equal(resolvePlatform("deepseek", "https://api.deepseek.com/anthropic").reasoning, "thinking_budget");
});

test("resolvePlatform: a custom DashScope baseURL → chat + enable_thinking (custom:qwen3.7-plus)", () => {
  const caps = resolvePlatform("custom", DS);
  assert.equal(caps.wireApi, "chat");
  assert.equal(caps.reasoning, "enable_thinking", "so reasoning off actually disables Qwen thinking");
  assert.equal(caps.cache, "auto");
});

test("resolvePlatform: DashScope endpoint variants + built-in providers", () => {
  assert.equal(resolvePlatform("qwen").reasoning, "enable_thinking", "built-in qwen provider");
  assert.equal(resolvePlatform(undefined, "https://coding.dashscope.aliyuncs.com/apps/anthropic").wireApi, "anthropic");
  assert.equal(resolvePlatform(undefined, "https://coding.dashscope.aliyuncs.com/apps/anthropic").cache, "cache_control");
  assert.equal(resolvePlatform(undefined, "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1").wireApi, "responses");
  assert.equal(resolvePlatform("anthropic").wireApi, "anthropic");
  assert.equal(resolvePlatform("openai").reasoning, "reasoning_effort");
});

test("resolvePlatform: explicit wireApi override wins the transport", () => {
  assert.equal(resolvePlatform("openai", undefined, "responses").wireApi, "responses");
});
