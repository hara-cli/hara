// Vision sidecar — "the eyes" for a text-only main model. When `visionModel` is configured, pasted
// images are sent to that model (e.g. qwen-vl on the same Alibaba plan) and turned into text the main
// model can act on. Provider-agnostic: it takes a pre-built Provider, so it reuses the normal image
// encoding path (base64 blocks for Anthropic, image_url data-URLs for OpenAI-compatible endpoints).
import type { ImageAttachment, Provider } from "./providers/types.js";
import { boundedProviderTurn } from "./providers/bounded-turn.js";

export type VisionCap = "vision" | "text" | "unknown";
export type ImageInputMode = "native" | "vision-sidecar" | "unsupported" | "unknown";
/** Keeps base64-encoded provider payloads below the common 5 MB request-item boundary. */
export const MAX_NATIVE_IMAGE_BYTES = 3_600_000;

export interface EffectiveAttachmentCapabilities {
  image: {
    mode: ImageInputMode;
    /** Maximum bytes accepted by Hara before any model or vision sidecar is called. */
    maxBytes: number;
    /** Present only when a configured vision sidecar will translate images for the main model. */
    viaModel?: string;
  };
  /** Text/code attachments are expanded locally before the provider request. */
  textFile: "inline-text";
  /** Directories contribute a bounded inventory; the agent reads individual files with local tools. */
  directory: "bounded-inventory-and-tools";
  /** Binary documents need a document/artifact tool rather than pretending the model received bytes. */
  binaryFile: "agent-tool";
}

/** A configured sidecar can use the current credential only when that credential is unconstrained (BYOK)
 * or its server-authoritative catalog contains the exact model. Passing [] means capability is unknown and
 * therefore unavailable — persistent UIs must not advertise a route they cannot prove. */
export function visionSidecarAuthorized(
  visionModel?: string,
  authorizedModels?: readonly string[],
): boolean {
  return Boolean(visionModel) && (
    authorizedModels === undefined
    || authorizedModels.includes(visionModel!)
  );
}

// Built-in capability map for the major model families. First matching rule wins, so each family's
// vision pattern is listed BEFORE its text catch-all. Anything that matches nothing → "unknown"
// (we ask the user once and remember). Easy to extend — add a rule near the right family.
const MODEL_VISION_MAP: { rx: RegExp; cap: "vision" | "text" }[] = [
  // OpenAI
  { rx: /gpt-4o|gpt-4\.1|gpt-4-turbo|chatgpt-4o|gpt-5|(?:^|[-_/])o[134](?:[-_/]|$)/i, cap: "vision" },
  { rx: /gpt-4(\b|-0|-1)|gpt-3\.5|davinci|babbage|text-(?:embedding|davinci)/i, cap: "text" },
  // Qwen — Token Plan's qwen3.8-max and qwen3.6/3.7 plus/flash families accept images; 3.7-max and
  // coder models are text-only. Keep the specific vision families before the broad text catch-all.
  { rx: /qwen.*vl|qwen.*omni|qvq/i, cap: "vision" },
  { rx: /qwen3\.8-max(?:-preview)?|qwen3\.[567]-(?:plus|flash)/i, cap: "vision" },
  { rx: /qwen.*(?:coder|plus|max|turbo|long|math)|qwq|qwen[\d.]*-?\d+b\b|qwen-?\d/i, cap: "text" },
  // GLM / Zhipu — 4v/4.5v see images; glm-5, glm-4.7, glm-4-flash are text-only.
  { rx: /glm-?\d(?:\.\d+)?v|cogvlm|glm.*vision/i, cap: "vision" },
  { rx: /glm-?\d(?:\.\d+)?(?:-(?:air|flash|plus|long|x|0520))?\b|glm-z|chatglm/i, cap: "text" },
  // DeepSeek (the exact official V4 vision model and VL families first, then the text families)
  { rx: /^deepseek-v4-flash-vision-exp$/i, cap: "vision" },
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
  // Moonshot / Kimi — kimi-k2.5 sees images (Coding Plan); older Kimi text.
  { rx: /kimi-?k?2\.5|kimi.*vl|moonshot.*(?:vl|vision)/i, cap: "vision" },
  { rx: /kimi|moonshot/i, cap: "text" },
  // xAI Grok
  { rx: /grok.*vision|grok-[\d.]*v\b|grok-4/i, cap: "vision" },
  { rx: /grok/i, cap: "text" },
  // MiniMax — VL models see images; the M-series chat (e.g. MiniMax-M2.5) is text-only.
  { rx: /minimax.*(?:vl|vision)|abab.*vl/i, cap: "vision" },
  { rx: /minimax|abab/i, cap: "text" },
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

/**
 * Resolve the complete image-processing route exposed to persistent clients.
 * This is deliberately different from a model-only `vision` boolean: a text-only
 * main model can still accept an image when Hara has a configured vision sidecar.
 */
export function effectiveAttachmentCapabilities(
  provider: string,
  model: string,
  overrides: Record<string, "yes" | "no"> = {},
  visionModel?: string,
  authorizedModels?: readonly string[],
): EffectiveAttachmentCapabilities {
  const native = classifyVision(provider, model, overrides);
  // A gateway credential is scoped to its advertised model catalog. A global sidecar name must never
  // make a Desktop organization session claim image support unless that exact model is authorized by the
  // current connection. BYOK callers omit the catalog and retain their configured fallback behavior.
  const sidecarAuthorized = visionSidecarAuthorized(visionModel, authorizedModels);
  const image = native === "vision"
    ? { mode: "native" as const, maxBytes: MAX_NATIVE_IMAGE_BYTES }
    : sidecarAuthorized
      ? { mode: "vision-sidecar" as const, maxBytes: MAX_NATIVE_IMAGE_BYTES, viaModel: visionModel! }
      : native === "text"
        ? { mode: "unsupported" as const, maxBytes: MAX_NATIVE_IMAGE_BYTES }
        : { mode: "unknown" as const, maxBytes: MAX_NATIVE_IMAGE_BYTES };
  return {
    image,
    textFile: "inline-text",
    directory: "bounded-inventory-and-tools",
    binaryFile: "agent-tool",
  };
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

// Screenshot variant — tuned for driving the desktop (RPA) rather than transcription. A text-only main
// model can't see, so it needs *actionable* output: where things are, so it can issue clicks.
export const SCREENSHOT_SYSTEM = [
  "You are the eyes of an assistant operating this computer; it cannot see the screen and acts only on your",
  "words. Describe the screenshot so it can ACT. Prioritise, in order:",
  "1. INTERACTIVE elements — buttons, links, text fields, checkboxes, menus, tabs, icons — each with its",
  "   visible label and an approximate location: a region (e.g. top-right) AND a rough pixel x,y if you can.",
  "2. The currently focused/active element or selection, and any open dialog/modal/popup.",
  "3. Errors, warnings, and key visible text/headings — quote them exactly.",
  "4. One line on what app/screen this appears to be.",
  "Positions guide clicks, so always estimate them. Be concise and factual; never invent elements.",
].join("\n");

// Grounding — ask a vision model WHERE a UI element is (for accurate RPA clicking), as resolution-independent
// fractions so it works regardless of Retina/DPI scaling.
export const LOCATE_SYSTEM = [
  "You are given a screenshot. The user names ONE UI element (button, field, icon, menu item, link).",
  "Return ONLY its CENTER as JSON: {\"x\": <0-1000>, \"y\": <0-1000>}, where x is the position as per-mille of",
  "the image WIDTH (0=left, 1000=right) and y as per-mille of the HEIGHT (0=top, 1000=bottom).",
  "If the element is not visible, return {\"x\": -1, \"y\": -1}. Output ONLY the JSON, nothing else.",
].join("\n");

/** Parse a grounding reply → {x,y} as 0..1 fractions (accepts per-mille / percent / fraction), or null. */
export function parseLocate(text: string): { x: number; y: number } | null {
  const m = text.match(/"x"\s*:\s*(-?\d+(?:\.\d+)?)[\s,}]+.*?"y"\s*:\s*(-?\d+(?:\.\d+)?)/s) || text.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  let x = Number(m[1]);
  let y = Number(m[2]);
  if (x < 0 || y < 0 || Number.isNaN(x) || Number.isNaN(y)) return null; // not found / unparseable
  const norm = (v: number): number => (v > 100 ? v / 1000 : v > 1.5 ? v / 100 : v); // per-mille | percent | fraction → 0..1
  x = Math.min(1, Math.max(0, norm(x)));
  y = Math.min(1, Math.max(0, norm(y)));
  return { x, y };
}

/** Send a screenshot to a (grounding-capable) vision model and get the target's center as 0..1 fractions. */
export async function locateImage(
  provider: Provider,
  image: ImageAttachment,
  target: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ x: number; y: number } | null> {
  const r = await boundedProviderTurn(provider, {
    system: LOCATE_SYSTEM,
    history: [{ role: "user", content: `Locate this element: ${target}`, images: [image] }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: opts.timeoutMs ?? 30_000, signal: opts.signal, label: "image element location" });
  if (r.stop === "error") return null;
  return parseLocate(r.text);
}

const PROMPT = "Describe the attached image(s) per your instructions.";

/** Send images to the vision provider and return its textual description. Throws on a provider error.
 *  `system` overrides the default prompt (e.g. SCREENSHOT_SYSTEM); `hint` focuses it on a specific goal. */
export async function describeImages(
  provider: Provider,
  images: ImageAttachment[],
  opts: { signal?: AbortSignal; timeoutMs?: number; system?: string; hint?: string } = {},
): Promise<string> {
  const content = opts.hint ? `${PROMPT}\nFocus especially on: ${opts.hint}` : PROMPT;
  const r = await boundedProviderTurn(provider, {
    system: opts.system ?? DESCRIBE_SYSTEM,
    history: [{ role: "user", content, images }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: opts.timeoutMs ?? 90_000, signal: opts.signal, label: "image description" });
  if (r.stop === "error") throw new Error(r.errorMsg || "vision provider error");
  return r.text.trim();
}
