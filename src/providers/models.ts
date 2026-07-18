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

// Model discovery — "what can this key run?" A coding-plan / OpenAI-compatible key usually exposes many
// models (Qwen, GLM, Kimi, …) via `GET {baseURL}/models`; the /model picker lists them so you switch by
// arrow keys, not by memorizing ids. Live results win. A bounded request falls back to Alibaba's documented
// exact Coding Plan ids only on the two official coding hosts; other endpoints keep the existing [] →
// type-an-id behavior. `fetchImpl` is injected so this stays pure/testable.
export async function listModels(baseURL: string | undefined, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!baseURL) return []; // SDK-default hosts (anthropic/openai) — no custom endpoint to enumerate
  const fallback = codingPlanFallbackModels(baseURL);
  try {
    const url = baseURL.replace(/\/+$/, "") + "/models";
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return fallback;
    const j = (await r.json()) as { data?: { id?: unknown }[] };
    const ids = (j?.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === "string" && x.length > 0);
    // Stable order + de-dup so the picker list doesn't jump around between opens.
    return ids.length ? [...new Set(ids)].sort((a, b) => a.localeCompare(b)) : fallback;
  } catch {
    return fallback;
  }
}
