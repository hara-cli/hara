// Vision sidecar — "the eyes" for a text-only main model. When `visionModel` is configured, pasted
// images are sent to that model (e.g. qwen-vl on the same Alibaba plan) and turned into text the main
// model can act on. Provider-agnostic: it takes a pre-built Provider, so it reuses the normal image
// encoding path (base64 blocks for Anthropic, image_url data-URLs for OpenAI-compatible endpoints).
import type { ImageAttachment, Provider } from "./providers/types.js";

export type VisionCap = "vision" | "text" | "unknown";

// Built-in capability map for the major model families. First matching rule wins, so each family's
// vision pattern is listed BEFORE its text catch-all. Anything that matches nothing → "unknown"
// (we ask the user once and remember). Easy to extend — add a rule near the right family.
const MODEL_VISION_MAP: { rx: RegExp; cap: "vision" | "text" }[] = [
  // OpenAI
  { rx: /gpt-4o|gpt-4\.1|gpt-4-turbo|chatgpt-4o|gpt-5|(?:^|[-_/])o[134](?:[-_/]|$)/i, cap: "vision" },
  { rx: /gpt-4(\b|-0|-1)|gpt-3\.5|davinci|babbage|text-(?:embedding|davinci)/i, cap: "text" },
  // Qwen
  { rx: /qwen.*vl|qwen.*omni|qvq/i, cap: "vision" },
  { rx: /qwen-?3[.\d]*-(?:plus|max)/i, cap: "vision" }, // Qwen3 flagships (Alibaba coding plan) accept images — verified qwen3.7-plus
  { rx: /qwen.*(?:coder|plus|max|turbo|long|math)|qwq|qwen[\d.]*-?\d+b\b|qwen-?\d/i, cap: "text" },
  // GLM / Zhipu
  { rx: /glm-?4(?:\.\d+)?v|cogvlm|glm.*-v\b/i, cap: "vision" },
  { rx: /glm-4(?:\.\d+)?(?:-(?:air|flash|plus|long|x|0520))?\b|glm-z|chatglm/i, cap: "text" },
  // DeepSeek (VL first, then the text families)
  { rx: /deepseek.*vl/i, cap: "vision" },
  { rx: /deepseek/i, cap: "text" },
  // Google
  { rx: /gemini|gemma-3/i, cap: "vision" },
  { rx: /gemma/i, cap: "text" },
  // Mistral (Pixtral/small-3 see; the rest text)
  { rx: /pixtral|mistral-small-3|mistral.*vision/i, cap: "vision" },
  { rx: /mistral|mixtral|codestral|ministral/i, cap: "text" },
  // Meta Llama (3.2-11B/90B + 4 see; the rest text)
  { rx: /llama-?3\.2-(?:11|90)b|llama.*vision|llama-?4/i, cap: "vision" },
  { rx: /llama|codellama/i, cap: "text" },
  // Moonshot / Kimi
  { rx: /kimi.*vl|moonshot.*(?:vl|vision)/i, cap: "vision" },
  { rx: /kimi|moonshot/i, cap: "text" },
  // xAI Grok
  { rx: /grok.*vision|grok-[\d.]*v\b|grok-4/i, cap: "vision" },
  { rx: /grok/i, cap: "text" },
  // Other well-known vision families
  { rx: /(?:^|[-_/])vl(?:[-_/]|$)|internvl|llava|minicpm-?v|yi-vl|step-1[vo]|doubao.*(?:vl|vision)|ernie.*vl/i, cap: "vision" },
];

/**
 * Resolve a model's vision capability: explicit per-model override → Anthropic (all modern Claude see
 * images) → built-in family map → "unknown" (caller asks the user). Pure + table-driven so it's testable.
 */
export function classifyVision(provider: string, model: string, overrides: Record<string, "yes" | "no"> = {}): VisionCap {
  const o = overrides[model];
  if (o === "yes") return "vision";
  if (o === "no") return "text";
  if (provider === "anthropic") return "vision";
  const m = model || "";
  for (const r of MODEL_VISION_MAP) if (r.rx.test(m)) return r.cap;
  return "unknown";
}

export const DESCRIBE_SYSTEM = [
  "You are the eyes of a coding assistant that cannot see images. Transcribe and describe the attached",
  "image(s) completely and precisely so the assistant can act on them without seeing them.",
  "Rules:",
  "1. Transcribe ALL visible text and code VERBATIM, preserving line breaks and indentation — put code,",
  "   terminal output, and logs in fenced code blocks.",
  "2. For UI / screenshots: describe the layout, components, labels, states, and notable colors.",
  "3. For diagrams / charts: describe the structure — nodes, edges, axes, and data.",
  "4. Quote any error or warning messages exactly.",
  "5. Be thorough and factual; do not speculate beyond what is visible.",
].join("\n");

const PROMPT = "Describe the attached image(s) per your instructions.";

/** Send images to the vision provider and return its textual description. Throws on a provider error. */
export async function describeImages(
  provider: Provider,
  images: ImageAttachment[],
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const r = await provider.turn({
    system: DESCRIBE_SYSTEM,
    history: [{ role: "user", content: PROMPT, images }],
    tools: [],
    onText: () => {},
    signal: opts.signal,
  });
  if (r.stop === "error") throw new Error(r.errorMsg || "vision provider error");
  return r.text.trim();
}
