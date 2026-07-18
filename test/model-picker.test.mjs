// /model picker: model discovery (/models) + the pure ↑↓ / ←→ navigation. The reasoning STYLE (from the
// registry, endpoint-based) decides which thinking levels ←→ offers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { levelsFor, levelLabel, movePicker } from "../dist/tui/model-picker.js";
import { CODING_PLAN_FALLBACK_MODELS, codingPlanFallbackModels, listModels } from "../dist/providers/models.js";

test("levelsFor: binary thinking styles → off/on; graded → full dial; deepseek adds max; none → nothing", () => {
  assert.deepEqual(levelsFor("enable_thinking"), ["off", "high"]);
  assert.deepEqual(levelsFor("ollama_think"), ["off", "high"]);
  assert.deepEqual(levelsFor("reasoning_effort"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levelsFor("thinking_budget"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levelsFor("deepseek"), ["off", "low", "medium", "high", "max"]);
  assert.deepEqual(levelsFor("none"), []);
  assert.deepEqual(levelsFor("enable_thinking", "qwen3-coder-next"), [], "model-level capability overrides the shared endpoint");
  assert.deepEqual(levelsFor("enable_thinking", "qwen3-coder-plus"), []);
});

test("levelLabel: binary reads as on/off, graded as the level name", () => {
  assert.equal(levelLabel("enable_thinking", "high"), "on");
  assert.equal(levelLabel("enable_thinking", "off"), "off");
  assert.equal(levelLabel("reasoning_effort", "medium"), "medium");
});

test("movePicker: ↑↓ wraps through models", () => {
  const s0 = { modelIdx: 0, effort: "off" };
  assert.equal(movePicker(s0, "down", 3, "none").modelIdx, 1);
  assert.equal(movePicker(s0, "up", 3, "none").modelIdx, 2, "up from 0 wraps to last");
  assert.equal(movePicker({ modelIdx: 2, effort: "off" }, "down", 3, "none").modelIdx, 0, "down from last wraps to 0");
  assert.equal(movePicker(s0, "down", 0, "none").modelIdx, 0, "no models → no move");
});

test("movePicker: ←→ cycles the thinking level for the endpoint's style", () => {
  // binary (enable_thinking): off ⇄ on(high)
  assert.equal(movePicker({ modelIdx: 0, effort: "off" }, "right", 3, "enable_thinking").effort, "high");
  assert.equal(movePicker({ modelIdx: 0, effort: "high" }, "right", 3, "enable_thinking").effort, "off", "wraps");
  // graded (reasoning_effort): off → low → medium → high → off
  assert.equal(movePicker({ modelIdx: 0, effort: "low" }, "right", 3, "reasoning_effort").effort, "medium");
  assert.equal(movePicker({ modelIdx: 0, effort: "off" }, "left", 3, "reasoning_effort").effort, "high", "left from off wraps to high");
  // deepseek: high → max → (wrap) off; left from off wraps to max
  assert.equal(movePicker({ modelIdx: 0, effort: "high" }, "right", 3, "deepseek").effort, "max");
  assert.equal(movePicker({ modelIdx: 0, effort: "max" }, "right", 3, "deepseek").effort, "off", "max wraps to off");
  assert.equal(movePicker({ modelIdx: 0, effort: "off" }, "left", 3, "deepseek").effort, "max", "left from off wraps to max");
  // none: ←→ is a no-op
  assert.equal(movePicker({ modelIdx: 0, effort: "off" }, "right", 3, "none").effort, "off");
});

test("listModels: parses /models, de-dups + sorts; [] on non-ok / no baseURL / throw", async () => {
  const ok = async () => ({ ok: true, json: async () => ({ data: [{ id: "qwen3.7-plus" }, { id: "glm-5" }, { id: "glm-5" }, { id: 7 }] }) });
  assert.deepEqual(await listModels("https://x/v1", "k", ok), ["glm-5", "qwen3.7-plus"], "sorted + de-duped, non-string dropped");
  assert.deepEqual(await listModels(undefined, "k", ok), [], "no baseURL (SDK-default host) → []");
  const notOk = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(await listModels("https://x/v1", "k", notOk), [], "non-ok → []");
  const boom = async () => { throw new Error("network"); };
  assert.deepEqual(await listModels("https://x/v1", "k", boom), [], "throw → [] (best-effort)");
});

test("Coding Plan model discovery uses live ids first and the documented exact list only as a host-scoped fallback", async () => {
  assert.deepEqual(codingPlanFallbackModels("https://coding.dashscope.aliyuncs.com/v1"), [...CODING_PLAN_FALLBACK_MODELS]);
  assert.deepEqual(codingPlanFallbackModels("https://coding-intl.dashscope.aliyuncs.com/v1"), [...CODING_PLAN_FALLBACK_MODELS]);
  assert.deepEqual(codingPlanFallbackModels("https://evil-coding.dashscope.aliyuncs.com/v1"), [], "hostname matching is exact");
  assert.ok(CODING_PLAN_FALLBACK_MODELS.includes("qwen3.5-plus"), "current Qwen list includes qwen3.5-plus");
  assert.ok(CODING_PLAN_FALLBACK_MODELS.includes("qwen3.7-plus"));

  const unavailable = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(
    await listModels("https://coding.dashscope.aliyuncs.com/v1", "k", unavailable),
    [...CODING_PLAN_FALLBACK_MODELS],
    "a non-enumerating official coding endpoint still gives the picker its supported ids",
  );
  const live = async () => ({ ok: true, json: async () => ({ data: [{ id: "future-model" }] }) });
  assert.deepEqual(
    await listModels("https://coding.dashscope.aliyuncs.com/v1", "k", live),
    ["future-model"],
    "live discovery is authoritative and is never polluted by a stale fallback",
  );
});
