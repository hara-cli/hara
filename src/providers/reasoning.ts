// Reasoning control — data-driven. Every platform in the provider registry declares a reasoning STYLE
// (how it wants the thinking dial expressed on the wire); this module owns the small set of styles and
// maps hara's dial (off/low/medium/high, or UNSET) onto the request params each style needs. Adding a
// platform that reuses a style is pure data in the registry — no new code here. New code only when a
// genuinely new style appears (a new provider param shape).

import { isTokenPlanQwenResponsesModel, isTokenPlanResponsesModel } from "./alibaba.js";

export type Effort = "off" | "low" | "medium" | "high" | "max" | undefined;

/** How a platform expresses the thinking dial on the wire:
 *  - `enable_thinking`  — DashScope chat (Qwen/GLM via Alibaba): a boolean that actually starts/stops the
 *                         thinking phase server-side (off → the big latency vanishes, measured 14s→1.6s).
 *  - `reasoning_effort` — OpenAI chat reasoning models (o-series / gpt-5): the `reasoning_effort` enum.
 *  - `reasoning_object` — OpenAI Responses API: `reasoning: { effort }` (for the responses transport).
 *  - `qwen_responses` — legacy/internal alias for Alibaba Qwen Responses reasoning.
 *  - `alibaba_responses` — Alibaba Model Studio Responses API: explicit off uses the provider extension
 *                         `enable_thinking:false`; enabled levels use `reasoning: { effort }`. The explicit
 *                         boolean is intentional: live Token Plan measurements found `effort:none` could
 *                         still emit reasoning tokens, while the boolean reliably disabled thinking.
 *  - `minimax_responses` — MiniMax M3 Responses API: `none` disables thinking; any enabled Hara level
 *                         maps to `high`, which MiniMax documents as Adaptive Thinking rather than depth.
 *  - `deepseek_responses` — DeepSeek V4 Responses API: `reasoning: { effort }`, with DeepSeek's
 *                         documented none|low|high|max values (`none` disables thinking).
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
export type ReasoningStyle = "enable_thinking" | "reasoning_effort" | "reasoning_object" | "qwen_responses" | "alibaba_responses" | "minimax_responses" | "deepseek_responses" | "deepseek" | "thinking_budget" | "ollama_think" | "none";

/** OpenAI reasoning families that accept `reasoning_effort` / `reasoning.effort`. Others reject it, so the
 *  `reasoning_effort` / `reasoning_object` styles no-op on non-reasoning models. */
export function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|gpt-5)/i.test(model);
}

const bareModel = (model: string): string => model.split("/").at(-1) ?? model;

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
      // OpenAI's ceiling is "high"; there's no "max" — clamp so the global `max` dial never 400s here.
      return { reasoning_effort: effort === "off" ? "minimal" : effort === "max" ? "high" : effort };
    case "reasoning_object":
      if (!isReasoningModel(model)) return {};
      return { reasoning: { effort: effort === "off" ? "minimal" : effort === "max" ? "high" : effort } };
    case "qwen_responses":
    case "alibaba_responses": {
      if (!supportsReasoningStyle(style, model)) return {};
      // Do not send `reasoning` together with the explicit off switch: Alibaba documents that the object
      // has priority. More importantly, current Token Plan behavior can keep thinking on for `none`, while
      // the top-level provider extension reliably returns zero reasoning tokens.
      if (effort === "off") return { enable_thinking: false };
      return { reasoning: { effort } };
    }
    case "minimax_responses":
      return { reasoning: { effort: effort === "off" ? "none" : "high" } };
    case "deepseek_responses":
      // DeepSeek Responses owns a provider-specific `none` value for disabling thinking. Keep the
      // transport stable instead of silently switching an `off` request to Chat Completions.
      return { reasoning: { effort: effort === "off" ? "none" : effort === "medium" ? "high" : effort } };
    case "deepseek":
      // off → turn thinking OFF via the object (reasoning_effort can't say "off"). Any level → thinking ON
      // + the effort enum. Normalize the cross-provider `medium` value to DeepSeek's documented `high`.
      if (effort === "off") return { thinking: { type: "disabled" } };
      return {
        thinking: { type: "enabled" },
        reasoning_effort: effort === "low" ? "low" : effort === "max" ? "max" : "high",
      };
    case "thinking_budget": // Anthropic — applied by anthropic.ts, not on a chat/responses merge body
    case "none":
    default:
      return {};
  }
}
