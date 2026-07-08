// Model discovery — "what can this key run?" A coding-plan / OpenAI-compatible key usually exposes many
// models (Qwen, GLM, Kimi, …) via `GET {baseURL}/models`; the /model picker lists them so you switch by
// arrow keys, not by memorizing ids. Best-effort: many endpoints don't implement it → [] and the picker
// falls back to typing an id. `fetchImpl` is injected so this stays pure/testable.
export async function listModels(baseURL: string | undefined, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!baseURL) return []; // SDK-default hosts (anthropic/openai) — no custom endpoint to enumerate
  try {
    const url = baseURL.replace(/\/+$/, "") + "/models";
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: { id?: unknown }[] };
    const ids = (j?.data ?? []).map((m) => m?.id).filter((x): x is string => typeof x === "string" && x.length > 0);
    // Stable order + de-dup so the picker list doesn't jump around between opens.
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
