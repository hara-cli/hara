// /model picker: model discovery (/models) + the pure ↑↓ / ←→ navigation. The reasoning STYLE (from the
// registry, endpoint-based) decides which thinking levels ←→ offers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { levelsFor, levelLabel, movePicker, normalizeEffort } from "../dist/tui/model-picker.js";
import {
  CODING_PLAN_FALLBACK_MODELS,
  DEEPSEEK_FALLBACK_MODELS,
  codingPlanFallbackModels,
  deepSeekFallbackModels,
  listModels,
  miniMaxFallbackModels,
} from "../dist/providers/models.js";
import {
  TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS,
  TOKEN_PLAN_OPENAI_BASE_URL,
  tokenPlanModelReplacement,
} from "../dist/providers/alibaba.js";
import { MINIMAX_TOKEN_PLAN_MODELS } from "../dist/providers/minimax.js";

test("levelsFor: binary thinking styles → off/on; graded → full dial; DeepSeek uses off plus native low/high/max; none → nothing", () => {
  assert.deepEqual(levelsFor("enable_thinking"), ["off", "high"]);
  assert.deepEqual(levelsFor("ollama_think"), ["off", "high"]);
  assert.deepEqual(levelsFor("minimax_responses", "MiniMax-M3"), ["off", "high"]);
  assert.deepEqual(levelsFor("reasoning_effort"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levelsFor("thinking_budget"), ["off", "low", "medium", "high"]);
  assert.deepEqual(levelsFor("deepseek"), ["off", "low", "high", "max"]);
  assert.deepEqual(levelsFor("deepseek_responses"), ["off", "low", "high", "max"]);
  assert.deepEqual(levelsFor("qwen_responses", "qwen3.8-max"), ["low", "medium", "max"]);
  assert.deepEqual(levelsFor("qwen_responses", "qwen3.7-max"), ["off", "low", "medium", "high", "max"]);
  assert.deepEqual(levelsFor("qwen_responses", "deepseek-v4-pro"), []);
  assert.deepEqual(levelsFor("none"), []);
  assert.deepEqual(levelsFor("enable_thinking", "qwen3-coder-next"), [], "model-level capability overrides the shared endpoint");
  assert.deepEqual(levelsFor("enable_thinking", "qwen3-coder-plus"), []);
});

test("levelLabel: binary reads as on/off, graded as the level name", () => {
  assert.equal(levelLabel("enable_thinking", "high"), "on");
  assert.equal(levelLabel("enable_thinking", "off"), "off");
  assert.equal(levelLabel("minimax_responses", "high", "MiniMax-M3"), "on");
  assert.equal(levelLabel("reasoning_effort", "medium"), "medium");
  assert.equal(levelLabel("qwen_responses", "max", "qwen3.8-max"), "xhigh");
});

test("normalizeEffort maps stale cross-provider values onto qwen3.8-max's real dial", () => {
  assert.equal(normalizeEffort("qwen_responses", "qwen3.8-max", "off"), "low");
  assert.equal(normalizeEffort("qwen_responses", "qwen3.8-max", "high"), "max");
  assert.equal(normalizeEffort("qwen_responses", "qwen3.8-max", "medium"), "medium");
  assert.equal(normalizeEffort("qwen_responses", "deepseek-v4-pro", "high"), undefined);
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
  assert.equal(movePicker({ modelIdx: 0, effort: "off" }, "right", 3, "qwen_responses", "qwen3.8-max").effort, "medium");
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

test("Token Plan discovery follows the key-scoped live catalog but hides models that need separate media APIs", async () => {
  const tokenPlan = TOKEN_PLAN_OPENAI_BASE_URL;
  const live = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: "qwen3.8-max" },
        { id: "glm-5.2" },
        { id: "deepseek-v4-pro" },
        { id: "wan2.7-image" },
        { id: "wan2.7-image-pro" },
        { id: "qwen-audio-3.0-tts-plus" },
        { id: "qwen-audio-3.0-realtime-plus" },
        { id: "happyhorse-1.1-t2v" },
      ],
    }),
  });
  assert.deepEqual(
    await listModels(tokenPlan, "k", live),
    ["deepseek-v4-pro", "glm-5.2", "qwen3.8-max"],
  );
  assert.deepEqual(
    await listModels("https://another.example/v1", "k", live),
    [
      "deepseek-v4-pro",
      "glm-5.2",
      "happyhorse-1.1-t2v",
      "qwen-audio-3.0-realtime-plus",
      "qwen-audio-3.0-tts-plus",
      "qwen3.8-max",
      "wan2.7-image",
      "wan2.7-image-pro",
    ],
    "media filtering is scoped to the exact Token Plan endpoint",
  );
  const unavailable = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(
    await listModels(tokenPlan, "k", unavailable),
    [],
    "when entitlement discovery is unavailable Hara must not guess a personal/team catalog",
  );
});

test("Token Plan setup suggestions stay separate from live entitlement and stale ids migrate only to authorized targets", () => {
  assert.ok(TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS.includes("qwen3.8-max"));
  assert.ok(TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS.includes("glm-5.2"));
  assert.equal(TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS.some((id) => /audio|image|happyhorse|wan/i.test(id)), false);
  assert.equal(tokenPlanModelReplacement("glm-5", ["glm-5.2", "qwen3.8-max"]), "glm-5.2");
  assert.equal(tokenPlanModelReplacement("glm-5", ["qwen3.8-max"]), undefined, "never recommends an unauthorized static target");
  assert.equal(tokenPlanModelReplacement("glm-5.2", ["glm-5.2"]), undefined, "available current model needs no migration");
  assert.equal(tokenPlanModelReplacement("deepseek-v4-flash", ["deepseek-v4-flash-0731"]), "deepseek-v4-flash-0731");
});

test("DeepSeek model discovery falls back to the official V4 Responses catalog on the exact host", async () => {
  assert.deepEqual([...DEEPSEEK_FALLBACK_MODELS], [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
  ]);
  assert.deepEqual(deepSeekFallbackModels("https://api.deepseek.com/v1"), [...DEEPSEEK_FALLBACK_MODELS]);
  assert.deepEqual(deepSeekFallbackModels("https://api.deepseek.com./v1"), [...DEEPSEEK_FALLBACK_MODELS]);
  assert.deepEqual(deepSeekFallbackModels("https://api.deepseek.com.example/v1"), []);
  assert.deepEqual(deepSeekFallbackModels("https://api.deepseek.com/anthropic"), []);
  assert.deepEqual(deepSeekFallbackModels("https://api.deepseek.com/proxy/v1"), []);

  const unavailable = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(
    await listModels("https://api.deepseek.com", "k", unavailable),
    [...DEEPSEEK_FALLBACK_MODELS],
    "the picker remains usable when the official model-list endpoint is unavailable",
  );
  const live = async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-v5" }] }) });
  assert.deepEqual(
    await listModels("https://api.deepseek.com", "k", live),
    ["deepseek-v5"],
    "live discovery remains authoritative over the dated fallback",
  );
});

test("MiniMax Token Plan discovery falls back to M3 only on the exact official endpoint", async () => {
  assert.deepEqual([...MINIMAX_TOKEN_PLAN_MODELS], ["MiniMax-M3"]);
  assert.deepEqual(miniMaxFallbackModels("https://api.minimaxi.com/v1"), ["MiniMax-M3"]);
  assert.deepEqual(miniMaxFallbackModels("https://api.minimaxi.com/v1/"), ["MiniMax-M3"]);
  assert.deepEqual(miniMaxFallbackModels("http://api.minimaxi.com/v1"), []);
  assert.deepEqual(miniMaxFallbackModels("https://api.minimaxi.com.example/v1"), []);
  assert.deepEqual(miniMaxFallbackModels("https://api.minimaxi.com/anthropic"), []);

  const unavailable = async () => ({ ok: false, json: async () => ({}) });
  assert.deepEqual(
    await listModels("https://api.minimaxi.com/v1", "k", unavailable),
    ["MiniMax-M3"],
  );
  const live = async () => ({ ok: true, json: async () => ({ data: [{ id: "MiniMax-M3.1" }] }) });
  assert.deepEqual(
    await listModels("https://api.minimaxi.com/v1", "k", live),
    ["MiniMax-M3.1"],
    "live key-scoped discovery remains authoritative",
  );
});
