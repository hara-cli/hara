// Reasoning control — data-driven. Every platform in the provider registry declares a reasoning STYLE
// (how it wants the thinking dial expressed on the wire); this module owns the small set of styles and
// maps hara's dial (off/low/medium/high, or UNSET) onto the request params each style needs. Adding a
// platform that reuses a style is pure data in the registry — no new code here. New code only when a
// genuinely new style appears (a new provider param shape).

import { isTokenPlanQwenResponsesModel, isTokenPlanResponsesModel } from "./alibaba.js";
import { volcengineAgentPlanCanDisableThinking } from "./volcengine.js";

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;

/** How a platform expresses the thinking dial on the wire:
 *  - `enable_thinking`  — DashScope chat (Qwen/GLM via Alibaba): a boolean that actually starts/stops the
 *                         thinking phase server-side (off → the big latency vanishes, measured 14s→1.6s).
 *  - `reasoning_effort` — OpenAI chat reasoning models (o-series / gpt-5): the `reasoning_effort` enum.
 *  - `reasoning_object` — OpenAI Responses API: `reasoning: { effort }` (for the responses transport).
 *  - `qwen_responses` — legacy/internal alias for Alibaba Qwen Responses reasoning.
 *  - `alibaba_responses` — Alibaba Model Studio Responses API: `reasoning: { effort }`. Beijing Token
 *                         Plan documents the complete none|minimal|low|medium|high|xhigh|max vocabulary;
 *                         Hara calls the provider-native `none` value `off`.
 *  - `minimax_responses` — MiniMax M3 Responses API: `none` disables thinking; any enabled Hara level
 *                         maps to `high`, which MiniMax documents as Adaptive Thinking rather than depth.
 *  - `deepseek_responses` — DeepSeek V4 Responses API: `reasoning: { effort }`, with DeepSeek's
 *                         documented none|low|high|max values (`none` disables thinking).
 *  - `volcengine_responses` — Volcengine Ark Agent Plan Responses: Codex low|medium|high reasoning,
 *                         plus Ark's native `thinking:{type:"disabled"}` switch where the model permits it.
 *  - `deepseek`         — DeepSeek V4 OpenAI-compat chat: a `thinking: { type }` on/off object PLUS a
 *                         `reasoning_effort` enum whose native values are `low`|`high`|`max` (the server
 *                         maps medium/xhigh → high). OFF must go through
 *                         `thinking: { type: "disabled" }` because `reasoning_effort` has no off/minimal —
 *                         those would be read as high. Unlike the OpenAI `reasoning_effort` style this is
 *                         NOT gated on isReasoningModel — DeepSeek's own thinking models own that switch.
 *  - `thinking_budget`  — Anthropic messages: `thinking: { type, budget_tokens }` (handled in anthropic.ts).
 *  - `ollama_think`     — Ollama's OpenAI-compat endpoint: a `think` boolean that stops a local reasoning
 *                         model's thinking phase (measured: deepseek-r1:14b 17s → 0.6s). Off models ignore it.
 *  - `none`             — the platform has no thinking control; leave the request untouched. */
export type ReasoningStyle = "enable_thinking" | "reasoning_effort" | "reasoning_object" | "qwen_responses" | "alibaba_responses" | "minimax_responses" | "deepseek_responses" | "volcengine_responses" | "deepseek" | "thinking_budget" | "ollama_think" | "none";

/** OpenAI reasoning families that accept `reasoning_effort` / `reasoning.effort`. Others reject it, so the
 *  `reasoning_effort` / `reasoning_object` styles no-op on non-reasoning models. */
export function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|gpt-5)/i.test(model);
}

/** OpenAI's effort enum is model-specific. This returns only values that the selected model is documented
 * to accept; a persisted value from another model is still normalized defensively by `reasoningParams`.
 * Hara calls the provider-native `none` value `off` so all providers share one honest UI label. */
export function openAIReasoningEffortLevels(model: string): Exclude<Effort, undefined>[] {
  const id = bareModel(model).toLowerCase();
  if (/^gpt-5\.6(?:-|$)/.test(id)) return ["off", "low", "medium", "high", "xhigh", "max"];
  if (/^gpt-5\.(?:2|4|5)(?:-|$)/.test(id)) return ["off", "low", "medium", "high", "xhigh"];
  if (/^gpt-5(?:\.1)?(?:-|$)/.test(id)) return ["minimal", "low", "medium", "high"];
  if (/^(?:o1|o3|o4)(?:-|$)/.test(id)) return ["low", "medium", "high"];
  return [];
}

function openAIReasoningEffort(model: string, effort: Exclude<Effort, undefined>): string {
  const levels = openAIReasoningEffortLevels(model);
  if (levels.includes(effort)) return effort === "off" ? "none" : effort;
  if (effort === "off" || effort === "minimal") {
    if (levels.includes("off")) return "none";
    if (levels.includes("minimal")) return "minimal";
    return levels[0] ?? "minimal";
  }
  if (effort === "max") return levels.includes("max") ? "max" : levels.includes("xhigh") ? "xhigh" : "high";
  if (effort === "xhigh") return levels.includes("xhigh") ? "xhigh" : "high";
  return effort;
}

const bareModel = (model: string): string => model.split("/").at(-1) ?? model;

/** Effective Alibaba Responses levels for the selected model. Token Plan Personal is Beijing-only, where
 * the current Responses contract documents all seven levels for Qwen3.8. Third-party families keep their
 * provider-native narrower contracts even though they share Alibaba's transport. */
export function alibabaReasoningEffortLevels(model: string): Exclude<Effort, undefined>[] {
  const id = bareModel(model).toLowerCase();
  if (/^qwen3\.8-(?:max(?:-preview)?|flash)(?:-|$)/.test(id)) {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  if (/^deepseek-v4-(?:pro-0813|flash-0731)(?:-|$)/.test(id)) {
    return ["off", "low", "high", "max"];
  }
  if (/^deepseek-v4-(?:pro|flash)(?:-|$)/.test(id)) {
    return ["off", "high", "max"];
  }
  if (/^glm-5\.2(?:-|$)/.test(id)) {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  if (isTokenPlanQwenResponsesModel(id)) {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }
  return [];
}

/** Normalize a cross-provider or older saved value to the selected Alibaba model's native/effective level.
 * This also defines migration behavior when a user changes model without first clearing the old default. */
export function normalizeAlibabaReasoningEffort(
  model: string,
  effort: Exclude<Effort, undefined>,
): Exclude<Effort, undefined> {
  const id = bareModel(model).toLowerCase();
  if (/^qwen3\.8-(?:max(?:-preview)?|flash)(?:-|$)/.test(id)) {
    return effort;
  }
  if (/^deepseek-v4-(?:pro-0813|flash-0731)(?:-|$)/.test(id)) {
    if (effort === "off" || effort === "low" || effort === "high" || effort === "max") return effort;
    return effort === "minimal" ? "low" : "high";
  }
  if (/^deepseek-v4-(?:pro|flash)(?:-|$)/.test(id)) {
    if (effort === "off" || effort === "high" || effort === "max") return effort;
    return effort === "xhigh" ? "max" : "high";
  }
  return effort;
}

/** Qwen models whose public Model Studio metadata documents Responses reasoning controls. Keep this
 * allow-list family-shaped: the Token Plan endpoint also serves GLM/DeepSeek models, which must not
 * receive Qwen-only values merely because they share a base URL. */
export function isQwenResponsesReasoningModel(model: string): boolean {
  return isTokenPlanQwenResponsesModel(model);
}

/** Endpoint capability is not enough: Alibaba's Coding Plan serves qwen3-coder-next/plus on the same
 * DashScope URL as thinking models, but documents both coder ids as not supporting thinking mode. */
export function supportsReasoningStyle(style: ReasoningStyle, model = ""): boolean {
  if (style === "none") return false;
  if (style === "enable_thinking" && /^qwen3-coder-(?:next|plus)(?:-|$)/i.test(bareModel(model))) {
    return false;
  }
  if (style === "qwen_responses") return isQwenResponsesReasoningModel(model);
  if (style === "alibaba_responses") return isTokenPlanResponsesModel(model);
  return true;
}

/** Translate the dial into request params to MERGE into the wire body (chat/responses styles). Returns an
 *  empty object — leave the request untouched — when the dial is UNSET (keep the model's own default; zero
 *  impact, the safe default) or the style/model has nothing to add. Anthropic's `thinking_budget` is built
 *  in anthropic.ts (buildThinkingParam) and not covered here. Pure — exported for tests. */
export function reasoningParams(style: ReasoningStyle, effort: Effort, model = ""): Record<string, unknown> {
  if (effort === undefined) return {};
  switch (style) {
    case "enable_thinking":
      if (!supportsReasoningStyle(style, model)) return {};
      // off → false (stop the thinking phase, fast); any explicit level → true (keep it on).
      return { enable_thinking: effort !== "off" };
    case "ollama_think":
      // Ollama's `think` boolean — off stops a local reasoning model's thinking (safe: non-thinking
      // models ignore it). Same shape as enable_thinking, different param name.
      return { think: effort !== "off" };
    case "reasoning_effort":
      if (!isReasoningModel(model)) return {};
      return { reasoning_effort: openAIReasoningEffort(model, effort) };
    case "reasoning_object":
      if (!isReasoningModel(model)) return {};
      return { reasoning: { effort: openAIReasoningEffort(model, effort) } };
    case "qwen_responses":
    case "alibaba_responses": {
      if (!supportsReasoningStyle(style, model)) return {};
      // Use the reasoning object because it has priority and `enable_thinking` is deprecated on Responses.
      // Normalize aliases first so the stored setting and the wire both describe a real model-native level.
      const normalized = normalizeAlibabaReasoningEffort(model, effort);
      return { reasoning: { effort: normalized === "off" ? "none" : normalized } };
    }
    case "minimax_responses":
      return { reasoning: { effort: effort === "off" ? "none" : "high" } };
    case "deepseek_responses":
      // DeepSeek Responses owns a provider-specific `none` value for disabling thinking. Keep the
      // transport stable instead of silently switching an `off` request to Chat Completions.
      return {
        reasoning: {
          effort: effort === "off"
            ? "none"
            : effort === "low" || effort === "max"
              ? effort
              : "high",
        },
      };
    case "volcengine_responses":
      if (effort === "off") {
        return volcengineAgentPlanCanDisableThinking(model)
          ? { thinking: { type: "disabled" } }
          : {};
      }
      return {
        reasoning: {
          effort: effort === "low" || effort === "high" ? effort : "medium",
        },
      };
    case "deepseek":
      // off → turn thinking OFF via the object (reasoning_effort can't say "off"). Any level → thinking ON
      // + the effort enum. Normalize the cross-provider `medium` value to DeepSeek's documented `high`.
      if (effort === "off") return { thinking: { type: "disabled" } };
      return {
        thinking: { type: "enabled" },
        reasoning_effort: effort === "low" || effort === "max" ? effort : "high",
      };
    case "thinking_budget": // Anthropic — applied by anthropic.ts, not on a chat/responses merge body
    case "none":
    default:
      return {};
  }
}
