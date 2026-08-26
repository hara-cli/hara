// Reasoning is now data-driven: the registry maps a platform → a reasoning STYLE, and the applier maps
// the dial → wire params. Pins the DashScope speedup path (enable_thinking) end to end, plus the other
// styles and the resolver that makes a custom DashScope profile Just Work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isQwenResponsesReasoningModel, reasoningParams, supportsReasoningStyle } from "../dist/providers/reasoning.js";
import {
  DEEPSEEK_RESPONSES_MODELS,
  isDeepSeekResponsesModel,
  resolvePlatform,
} from "../dist/providers/registry.js";
import {
  isOfficialTokenPlanOpenAIEndpoint,
  isTokenPlanQwenResponsesModel,
} from "../dist/providers/alibaba.js";
import { isOfficialMiniMaxEndpoint } from "../dist/providers/minimax.js";

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

test("Token Plan Qwen Responses uses documented model-specific reasoning levels", () => {
  assert.equal(isQwenResponsesReasoningModel("qwen3.8-max"), true);
  assert.equal(isQwenResponsesReasoningModel("qwen/qwen3.7-max"), true);
  assert.equal(isQwenResponsesReasoningModel("qwen3.6-plus"), true);
  assert.equal(isQwenResponsesReasoningModel("qwen3.6-flash"), true);
  assert.equal(isQwenResponsesReasoningModel("deepseek-v4-pro"), false, "shared Token Plan host is not a Qwen capability");
  assert.deepEqual(reasoningParams("qwen_responses", "low", "qwen3.8-max"), { reasoning: { effort: "low" } });
  assert.deepEqual(reasoningParams("qwen_responses", "medium", "qwen3.8-max"), { reasoning: { effort: "medium" } });
  assert.deepEqual(reasoningParams("qwen_responses", "high", "qwen3.8-max"), { reasoning: { effort: "xhigh" } });
  assert.deepEqual(reasoningParams("qwen_responses", "max", "qwen3.8-max"), { reasoning: { effort: "xhigh" } });
  assert.deepEqual(reasoningParams("qwen_responses", "off", "qwen3.8-max"), { reasoning: { effort: "low" } });
  assert.deepEqual(reasoningParams("qwen_responses", "off", "qwen3.7-max"), { reasoning: { effort: "none" } });
  assert.deepEqual(reasoningParams("qwen_responses", "max", "qwen3.6-flash"), { reasoning: { effort: "max" } });
  assert.deepEqual(reasoningParams("qwen_responses", "high", "deepseek-v4-pro"), {});
});

test("reasoningParams DeepSeek Responses uses only documented effort values", () => {
  assert.deepEqual(reasoningParams("deepseek_responses", "low", "deepseek-v4-flash"), { reasoning: { effort: "low" } });
  assert.deepEqual(reasoningParams("deepseek_responses", "medium", "deepseek-v4-flash"), { reasoning: { effort: "high" } });
  assert.deepEqual(reasoningParams("deepseek_responses", "max", "deepseek-v4-flash"), { reasoning: { effort: "max" } });
  assert.deepEqual(reasoningParams("deepseek_responses", "off", "deepseek-v4-flash"), { reasoning: { effort: "none" } });
});

test("reasoningParams MiniMax M3 exposes an adaptive thinking on/off switch", () => {
  assert.deepEqual(reasoningParams("minimax_responses", "off", "MiniMax-M3"), { reasoning: { effort: "none" } });
  for (const effort of ["low", "medium", "high", "max"]) {
    assert.deepEqual(
      reasoningParams("minimax_responses", effort, "MiniMax-M3"),
      { reasoning: { effort: "high" } },
      effort,
    );
  }
});

test("reasoningParams DeepSeek Chat preserves its native low/high/max levels", () => {
  assert.deepEqual(reasoningParams("deepseek", "off", "deepseek-v4-pro"), { thinking: { type: "disabled" } });
  assert.deepEqual(reasoningParams("deepseek", "low", "deepseek-v4-pro"), {
    thinking: { type: "enabled" },
    reasoning_effort: "low",
  });
  assert.deepEqual(reasoningParams("deepseek", "medium", "deepseek-v4-pro"), {
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  assert.deepEqual(reasoningParams("deepseek", "max", "deepseek-v4-pro"), {
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
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

test("resolvePlatform: MiniMax Token Plan and an older generic profile use the official Responses route", () => {
  const baseURL = "https://api.minimaxi.com/v1";
  assert.equal(isOfficialMiniMaxEndpoint(baseURL), true);
  assert.equal(isOfficialMiniMaxEndpoint(`${baseURL}/`), true);
  assert.equal(isOfficialMiniMaxEndpoint("http://api.minimaxi.com/v1"), false);
  assert.equal(isOfficialMiniMaxEndpoint("https://api.minimaxi.com.example/v1"), false);
  assert.equal(isOfficialMiniMaxEndpoint("https://api.minimaxi.com/anthropic"), false);
  for (const provider of ["minimax-token-plan", "openai", "custom"]) {
    const caps = resolvePlatform(provider, baseURL, undefined, "MiniMax-M3");
    assert.equal(caps.wireApi, "responses", provider);
    assert.equal(caps.reasoning, "minimax_responses", provider);
  }
  const anthropic = resolvePlatform("minimax-token-plan", "https://api.minimaxi.com/anthropic", undefined, "MiniMax-M3");
  assert.equal(anthropic.wireApi, "anthropic");
  assert.equal(anthropic.reasoning, "thinking_budget");
});

test("resolvePlatform: official DeepSeek V4 models use Responses; legacy ids keep Chat", () => {
  assert.deepEqual([...DEEPSEEK_RESPONSES_MODELS], [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
  ]);
  for (const model of DEEPSEEK_RESPONSES_MODELS) {
    const caps = resolvePlatform("deepseek", "https://api.deepseek.com/v1", undefined, model);
    assert.equal(caps.wireApi, "responses", model);
    assert.equal(caps.reasoning, "deepseek_responses", model);
    assert.equal(isDeepSeekResponsesModel("deepseek", undefined, model), true, `${model} uses the built-in endpoint`);
  }
  assert.equal(resolvePlatform("deepseek", "https://api.deepseek.com", undefined, "deepseek-chat").reasoning, "deepseek");
  // The vendor's /anthropic endpoint still wins (checked first) → anthropic wire, not the chat deepseek style.
  assert.equal(resolvePlatform("deepseek", "https://api.deepseek.com/anthropic", undefined, "deepseek-v4-flash").reasoning, "thinking_budget");
  assert.equal(
    resolvePlatform("hara-gateway", "https://gw.nanhara.tech/v1", undefined, "deepseek-v4-pro").reasoning,
    "deepseek",
    "a canonical managed model keeps DeepSeek thinking controls through Hara Control",
  );
  assert.equal(
    resolvePlatform("hara-gateway", "https://gw.nanhara.tech/v1", undefined, "deepseek-v4-flash-vision-exp").reasoning,
    "deepseek",
    "the managed vision model keeps DeepSeek thinking controls through Hara Control",
  );
  assert.equal(
    resolvePlatform("hara-gateway", "https://gw.nanhara.tech/v1", undefined, "glm-5").reasoning,
    "none",
    "unrelated gateway models never inherit DeepSeek-only request fields",
  );
});

test("resolvePlatform: DeepSeek Responses routing requires the exact official host", () => {
  for (const baseURL of [
    "https://api.deepseek.com.example/v1",
    "https://evil.test/api.deepseek.com/v1",
    "not a URL containing api.deepseek.com",
  ]) {
    assert.equal(isDeepSeekResponsesModel("deepseek", baseURL, "deepseek-v4-pro"), false, baseURL);
    assert.equal(resolvePlatform("deepseek", baseURL, undefined, "deepseek-v4-pro").wireApi, "chat", baseURL);
  }
  assert.equal(isDeepSeekResponsesModel("custom", "https://api.deepseek.com./v1", "DEEPSEEK-V4-PRO"), true);
  assert.equal(isDeepSeekResponsesModel("deepseek", "https://api.deepseek.com/anthropic", "deepseek-v4-pro"), false);
  assert.equal(isDeepSeekResponsesModel("deepseek", "https://api.deepseek.com/proxy/v1", "deepseek-v4-pro"), false);
});

test("resolvePlatform: a custom DashScope baseURL → chat + enable_thinking (custom:qwen3.7-plus)", () => {
  const caps = resolvePlatform("custom", DS);
  assert.equal(caps.wireApi, "chat");
  assert.equal(caps.reasoning, "enable_thinking", "so reasoning off actually disables Qwen thinking");
  assert.equal(caps.cache, "auto");
});

test("resolvePlatform: Token Plan selects Responses per model and keeps other catalog models on Chat", () => {
  const tokenPlan = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
  assert.equal(isOfficialTokenPlanOpenAIEndpoint(tokenPlan), true);
  assert.equal(isOfficialTokenPlanOpenAIEndpoint(`${tokenPlan}/`), true);
  assert.equal(isOfficialTokenPlanOpenAIEndpoint("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic"), false);
  assert.equal(isOfficialTokenPlanOpenAIEndpoint("https://token-plan.cn-beijing.maas.aliyuncs.com.example/compatible-mode/v1"), false);
  for (const model of ["qwen3.8-max", "qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"]) {
    assert.equal(isTokenPlanQwenResponsesModel(model), true, model);
    assert.equal(resolvePlatform("qwen", tokenPlan, undefined, model).wireApi, "responses", model);
    assert.equal(resolvePlatform("qwen", tokenPlan, undefined, model).reasoning, "qwen_responses", model);
  }
  for (const model of ["glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash-0731", "kimi-k2.7-code", "MiniMax-M2.5"]) {
    assert.equal(isTokenPlanQwenResponsesModel(model), false, model);
    assert.equal(resolvePlatform("qwen", tokenPlan, undefined, model).wireApi, "chat", model);
    assert.equal(resolvePlatform("qwen", tokenPlan, undefined, model).reasoning, "none", model);
  }
  assert.equal(resolvePlatform("qwen", tokenPlan).wireApi, "chat", "missing model fails closed to Chat");
});

test("resolvePlatform: DashScope endpoint variants + built-in providers", () => {
  assert.equal(resolvePlatform("qwen").reasoning, "enable_thinking", "built-in qwen provider");
  assert.equal(resolvePlatform(undefined, "https://coding.dashscope.aliyuncs.com/apps/anthropic").wireApi, "anthropic");
  assert.equal(resolvePlatform(undefined, "https://coding.dashscope.aliyuncs.com/apps/anthropic").cache, "cache_control");
  assert.equal(resolvePlatform("anthropic").wireApi, "anthropic");
  assert.equal(resolvePlatform("openai").reasoning, "reasoning_effort");
});

test("resolvePlatform: explicit wireApi override wins the transport", () => {
  assert.equal(resolvePlatform("openai", undefined, "responses").wireApi, "responses");
});
