// Unit tests for the reasoningEffort dial (A.P0).
// Covers: Anthropic `thinking` param mapping + adaptive-only model guard, and OpenAI's
// reasoning-model detection (so `reasoning_effort` only attaches when it's accepted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThinkingParam } from "../dist/providers/anthropic.js";
import { isReasoningModel } from "../dist/providers/openai.js";

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
