import { userModelFetch } from "../network/model-fetch.js";
import {
  DEEPSEEK_RESPONSES_MODELS,
  isOfficialDeepSeekResponsesEndpoint,
} from "./deepseek.js";
import {
  isOfficialTokenPlanOpenAIEndpoint,
  isTokenPlanInteractiveAgentModel,
  isTokenPlanSupersededModel,
} from "./alibaba.js";
import {
  isOfficialMiniMaxEndpoint,
  MINIMAX_TOKEN_PLAN_MODELS,
} from "./minimax.js";
import {
  isOfficialVolcengineAgentPlanEndpoint,
  isVolcengineAgentPlanInteractiveModel,
  VOLCENGINE_AGENT_PLAN_MODELS,
} from "./volcengine.js";

// Alibaba Coding Plan's documented exact ids (verified 2026-07-18). Live `/models` remains authoritative;
// this list is only a usability fallback because the coding endpoint/key combinations do not all enumerate.
// Keep exact casing: Coding Plan explicitly forbids guessing compatible/version-like aliases.
export const CODING_PLAN_FALLBACK_MODELS = Object.freeze([
  "qwen3.7-plus",
  "qwen3.6-plus",
  "kimi-k2.5",
  "glm-5",
  "MiniMax-M2.5",
  "qwen3.5-plus",
  "qwen3-max-2026-01-23",
  "qwen3-coder-next",
  "qwen3-coder-plus",
  "glm-4.7",
]);

/** DeepSeek's official Responses catalog. Live `/models` still wins, but its availability should not be
 * required for the model picker to expose the three documented V4 choices. */
export const DEEPSEEK_FALLBACK_MODELS = DEEPSEEK_RESPONSES_MODELS;

export function codingPlanFallbackModels(baseURL: string | undefined): string[] {
  if (!baseURL) return [];
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "coding.dashscope.aliyuncs.com" || host === "coding-intl.dashscope.aliyuncs.com"
      ? [...CODING_PLAN_FALLBACK_MODELS]
      : [];
  } catch {
    return [];
  }
}

export function deepSeekFallbackModels(baseURL: string | undefined): string[] {
  return isOfficialDeepSeekResponsesEndpoint(undefined, baseURL)
    ? [...DEEPSEEK_FALLBACK_MODELS]
    : [];
}

export function miniMaxFallbackModels(baseURL: string | undefined): string[] {
  return isOfficialMiniMaxEndpoint(baseURL) ? [...MINIMAX_TOKEN_PLAN_MODELS] : [];
}

export function volcengineAgentPlanFallbackModels(baseURL: string | undefined): string[] {
  return isOfficialVolcengineAgentPlanEndpoint(baseURL)
    ? [...VOLCENGINE_AGENT_PLAN_MODELS]
    : [];
}

/** Hara's model picker is an Agent/conversation surface. Capability-specific endpoints such as
 * embeddings, rerankers, speech, image/video generation and realtime voice belong in their own tools,
 * while multimodal conversation models (VL/vision models) deliberately remain selectable. */
export function isInteractiveConversationModel(model: string): boolean {
  const id = model.toLowerCase();
  return !(
    /(?:^|[-_/])(?:embedding|rerank)(?:[-_/]|$)/.test(id)
    || /(?:^|[-_/])(?:tts|asr|stt|whisper|realtime|audio|speech)(?:[-_/]|$)/.test(id)
    || /(?:seedream|seedance|dall-e|gpt-image|image-generation|stable-diffusion)/.test(id)
    || /(?:^|[-_/])(?:image|t2i|i2i|sora|veo|t2v|i2v|v2v)(?:[-_/]|$)/.test(id)
    || /(?:^|[-_/])flux(?:[-_/]|$)/.test(id)
  );
}

// Model discovery — "what can this key run?" A plan / OpenAI-compatible key usually exposes many
// models (Qwen, GLM, Kimi, …) via `GET {baseURL}/models`; the /model picker lists them so you switch by
// arrow keys, not by memorizing ids. Live results win. A bounded request falls back to Alibaba's documented
// exact Coding Plan ids only on the two official coding hosts; other endpoints keep the existing [] →
// type-an-id behavior. `fetchImpl` is injected so this stays pure/testable.
export async function listModels(
  baseURL: string | undefined,
  apiKey: string,
  fetchImpl: typeof fetch = userModelFetch,
  /** The model already in use. It is never filtered out of the list, so a user sitting on a superseded
   * entry can still see and re-pick it instead of silently losing their current route. */
  keep?: string,
): Promise<string[]> {
  if (!baseURL) return []; // SDK-default hosts (anthropic/openai) — no custom endpoint to enumerate
  const fallback = [
    ...codingPlanFallbackModels(baseURL),
    ...deepSeekFallbackModels(baseURL),
    ...miniMaxFallbackModels(baseURL),
    ...volcengineAgentPlanFallbackModels(baseURL),
  ];
  try {
    const url = baseURL.replace(/\/+$/, "") + "/models";
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return fallback;
    const j = (await r.json()) as { data?: { id?: unknown }[] };
    const ids = (j?.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === "string" && x.length > 0);
    // Stable order + de-dup so the picker list doesn't jump around between opens.
    const discovered = [...new Set(ids)]
      .filter(isInteractiveConversationModel)
      .sort((a, b) => a.localeCompare(b));
    const selectable = isOfficialTokenPlanOpenAIEndpoint(baseURL)
      ? discovered.filter((id) =>
          isTokenPlanInteractiveAgentModel(id)
          && (!isTokenPlanSupersededModel(id) || id === keep))
      : isOfficialVolcengineAgentPlanEndpoint(baseURL)
        ? discovered.filter(isVolcengineAgentPlanInteractiveModel)
      : discovered;
    return selectable.length ? selectable : fallback;
  } catch {
    return fallback;
  }
}
