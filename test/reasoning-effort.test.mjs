// Unit tests for the reasoningEffort dial (A.P0).
// Covers: Anthropic `thinking` param mapping + adaptive-only model guard, and OpenAI's
// reasoning-model detection (so `reasoning_effort` only attaches when it's accepted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingParam } from "../dist/providers/anthropic.js";
import { isReasoningModel } from "../dist/providers/openai.js";
import { reasoningParams } from "../dist/providers/reasoning.js";
import { resolvePlatform } from "../dist/providers/registry.js";

// ── anthropic.buildThinkingParam ──────────────────────────────────────────────

test("anthropic: unset effort → adaptive (preserves prior default)", () => {
  assert.deepEqual(buildThinkingParam("claude-sonnet-4-6", undefined), { type: "adaptive" });
});

test("anthropic: off → omit thinking (returns undefined)", () => {
  assert.equal(buildThinkingParam("claude-sonnet-4-6", "off"), undefined);
});

test("anthropic: low → enabled with small budget (4096)", () => {
  assert.deepEqual(buildThinkingParam("claude-sonnet-4-6", "low"), { type: "enabled", budget_tokens: 4096 });
});

test("anthropic: medium → adaptive (balanced default)", () => {
  assert.deepEqual(buildThinkingParam("claude-sonnet-4-6", "medium"), { type: "adaptive" });
});

test("anthropic: high → enabled with large budget (24000)", () => {
  assert.deepEqual(buildThinkingParam("claude-sonnet-4-6", "high"), { type: "enabled", budget_tokens: 24000 });
});

test("anthropic: max → enabled with the biggest budget (32000)", () => {
  assert.deepEqual(buildThinkingParam("claude-sonnet-4-6", "max"), { type: "enabled", budget_tokens: 32000 });
});

test("anthropic: adaptive-only models (opus-4-7/opus-4-8/fable) can't take budget — fall back to adaptive on low/high", () => {
  for (const m of ["claude-opus-4-7", "claude-opus-4-8", "claude-opus-4-7-20260101", "claude-fable-1", "opus-4-8"]) {
    assert.deepEqual(buildThinkingParam(m, "low"), { type: "adaptive" }, `${m} low → adaptive`);
    assert.deepEqual(buildThinkingParam(m, "high"), { type: "adaptive" }, `${m} high → adaptive`);
  }
});

test("anthropic: adaptive-only model with effort=off still omits thinking (off works on every model)", () => {
  assert.equal(buildThinkingParam("claude-opus-4-8", "off"), undefined);
});

// ── openai.isReasoningModel ───────────────────────────────────────────────────

test("openai: OpenAI reasoning-param families (o1/o3/o4/gpt-5) are detected", () => {
  for (const m of ["o1", "o1-preview", "o3-mini", "o4-mini", "gpt-5", "gpt-5-mini", "GPT-5-Turbo"]) {
    assert.equal(isReasoningModel(m), true, `${m} should accept reasoning_effort`);
  }
});

test("openai: models that don't accept the reasoning_effort param return false (gpt-4o / qwen / deepseek-r1 / glm)", () => {
  // DeepSeek-R1 / GLM-5 emit reasoning_content in the stream and can't be silenced via this param;
  // gpt-4o / qwen reject the field outright. Either way the provider must NOT attach it.
  for (const m of ["gpt-4o", "gpt-4o-mini", "qwen-plus", "qwen3-coder", "deepseek-chat", "deepseek-r1", "glm-4.5", "kimi-latest"]) {
    assert.equal(isReasoningModel(m), false, `${m} should NOT take reasoning_effort`);
  }
});

// ── reasoningParams: the OpenAI-compat merge body per style (incl. the new DeepSeek style + max clamp) ──

test("reasoning: unset dial → {} for every style (model default, zero impact)", () => {
  for (const style of ["reasoning_effort", "reasoning_object", "deepseek", "enable_thinking", "ollama_think", "none"]) {
    assert.deepEqual(reasoningParams(style, undefined, "deepseek-v4-pro"), {}, `${style} unset → {}`);
  }
});

test("deepseek style: off → thinking DISABLED (reasoning_effort can't express off)", () => {
  assert.deepEqual(reasoningParams("deepseek", "off", "deepseek-v4-pro"), { thinking: { type: "disabled" } });
});

test("deepseek style: high/max → thinking enabled + the effort enum passed through", () => {
  assert.deepEqual(reasoningParams("deepseek", "high", "deepseek-v4-pro"), { thinking: { type: "enabled" }, reasoning_effort: "high" });
  assert.deepEqual(reasoningParams("deepseek", "max", "deepseek-v4-pro"), { thinking: { type: "enabled" }, reasoning_effort: "max" });
});

test("deepseek style: low/medium pass through (DeepSeek maps them → high server-side)", () => {
  assert.deepEqual(reasoningParams("deepseek", "low", "deepseek-v4-pro"), { thinking: { type: "enabled" }, reasoning_effort: "low" });
  assert.deepEqual(reasoningParams("deepseek", "medium", "deepseek-v4-pro"), { thinking: { type: "enabled" }, reasoning_effort: "medium" });
});

test("deepseek style: NOT gated on isReasoningModel — applies even to a bare model id", () => {
  assert.deepEqual(reasoningParams("deepseek", "high", "deepseek-chat"), { thinking: { type: "enabled" }, reasoning_effort: "high" });
});

test("reasoning_effort style: max clamps to OpenAI's ceiling 'high' (OpenAI has no max)", () => {
  assert.deepEqual(reasoningParams("reasoning_effort", "max", "gpt-5"), { reasoning_effort: "high" });
  assert.deepEqual(reasoningParams("reasoning_effort", "off", "gpt-5"), { reasoning_effort: "minimal" });
  assert.deepEqual(reasoningParams("reasoning_effort", "high", "gpt-4o"), {}, "non-reasoning model → no field");
});

test("reasoning_object style: max clamps to 'high' too", () => {
  assert.deepEqual(reasoningParams("reasoning_object", "max", "gpt-5"), { reasoning: { effort: "high" } });
});

// ── resolvePlatform: DeepSeek (by provider id AND by baseURL) resolves to the deepseek style ──

test("registry: deepseek resolves to the 'deepseek' reasoning style (provider id + baseURL)", () => {
  assert.equal(resolvePlatform("deepseek").reasoning, "deepseek", "by provider id");
  assert.equal(resolvePlatform(undefined, "https://api.deepseek.com/v1").reasoning, "deepseek", "by baseURL");
  assert.equal(resolvePlatform(undefined, "https://api.deepseek.com/v1").wireApi, "chat");
});
