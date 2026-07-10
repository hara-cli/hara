// Reasoning control — data-driven. Every platform in the provider registry declares a reasoning STYLE
// (how it wants the thinking dial expressed on the wire); this module owns the small set of styles and
// maps hara's dial (off/low/medium/high, or UNSET) onto the request params each style needs. Adding a
// platform that reuses a style is pure data in the registry — no new code here. New code only when a
// genuinely new style appears (a new provider param shape).

export type Effort = "off" | "low" | "medium" | "high" | "max" | undefined;

/** How a platform expresses the thinking dial on the wire:
 *  - `enable_thinking`  — DashScope chat (Qwen/GLM via Alibaba): a boolean that actually starts/stops the
 *                         thinking phase server-side (off → the big latency vanishes, measured 14s→1.6s).
 *  - `reasoning_effort` — OpenAI chat reasoning models (o-series / gpt-5): the `reasoning_effort` enum.
 *  - `reasoning_object` — OpenAI Responses API: `reasoning: { effort }` (for the responses transport).
 *  - `deepseek`         — DeepSeek V4 OpenAI-compat chat: a `thinking: { type }` on/off object PLUS a
 *                         `reasoning_effort` enum whose NATIVE values are only `high`|`max` (the server
 *                         accepts low/medium but maps them → high, and xhigh → max). OFF must go through
 *                         `thinking: { type: "disabled" }` because `reasoning_effort` has no off/minimal —
 *                         those would be read as high. Unlike the OpenAI `reasoning_effort` style this is
 *                         NOT gated on isReasoningModel — DeepSeek's own thinking models own that switch.
 *  - `thinking_budget`  — Anthropic messages: `thinking: { type, budget_tokens }` (handled in anthropic.ts).
 *  - `ollama_think`     — Ollama's OpenAI-compat endpoint: a `think` boolean that stops a local reasoning
 *                         model's thinking phase (measured: deepseek-r1:14b 17s → 0.6s). Off models ignore it.
 *  - `none`             — the platform has no thinking control; leave the request untouched. */
export type ReasoningStyle = "enable_thinking" | "reasoning_effort" | "reasoning_object" | "deepseek" | "thinking_budget" | "ollama_think" | "none";

/** OpenAI reasoning families that accept `reasoning_effort` / `reasoning.effort`. Others reject it, so the
 *  `reasoning_effort` / `reasoning_object` styles no-op on non-reasoning models. */
export function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|gpt-5)/i.test(model);
}

/** Translate the dial into request params to MERGE into the wire body (chat/responses styles). Returns an
 *  empty object — leave the request untouched — when the dial is UNSET (keep the model's own default; zero
 *  impact, the safe default) or the style/model has nothing to add. Anthropic's `thinking_budget` is built
 *  in anthropic.ts (buildThinkingParam) and not covered here. Pure — exported for tests. */
export function reasoningParams(style: ReasoningStyle, effort: Effort, model = ""): Record<string, unknown> {
  if (effort === undefined) return {};
  switch (style) {
    case "enable_thinking":
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
    case "deepseek":
      // off → turn thinking OFF via the object (reasoning_effort can't say "off"). Any level → thinking ON
      // + the effort enum; DeepSeek natively honors high|max and maps low/medium→high server-side, so we
      // pass the dial through as-is (forward-compatible if DeepSeek later distinguishes low/medium).
      if (effort === "off") return { thinking: { type: "disabled" } };
      return { thinking: { type: "enabled" }, reasoning_effort: effort };
    case "thinking_budget": // Anthropic — applied by anthropic.ts, not on a chat/responses merge body
    case "none":
    default:
      return {};
  }
}
