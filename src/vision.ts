// Vision sidecar — "the eyes" for a text-only main model. When `visionModel` is configured, pasted
// images are sent to that model (e.g. qwen-vl on the same Alibaba plan) and turned into text the main
// model can act on. Provider-agnostic: it takes a pre-built Provider, so it reuses the normal image
// encoding path (base64 blocks for Anthropic, image_url data-URLs for OpenAI-compatible endpoints).
import type { ImageAttachment, Provider } from "./providers/types.js";

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
