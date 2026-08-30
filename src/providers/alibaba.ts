const TOKEN_PLAN_OPENAI_HOST = "token-plan.cn-beijing.maas.aliyuncs.com";
const TOKEN_PLAN_OPENAI_PATH = "/compatible-mode/v1";

/** Alibaba Cloud Model Studio Token Plan is currently Beijing-only. This is the OpenAI-compatible
 * endpoint used by both personal and team subscription keys; the key's live `/models` result remains
 * authoritative for actual entitlement. */
export const TOKEN_PLAN_OPENAI_BASE_URL =
  `https://${TOKEN_PLAN_OPENAI_HOST}${TOKEN_PLAN_OPENAI_PATH}`;

/** Current interactive text/reasoning catalog documented for Token Plan. Desktop may use this list to
 * make setup selectable before a key has been verified, but must label it as unverified and replace it
 * with the key-scoped live `/models` result after connection. Media models intentionally live outside
 * this list because they use separate image/audio/video capability surfaces. */
export const TOKEN_PLAN_KNOWN_INTERACTIVE_AGENT_MODELS = Object.freeze([
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.6-flash",
  "deepseek-v4-pro-0813",
  "deepseek-v4-pro",
  "deepseek-v4-flash-0731",
  "glm-5.2",
]);

const TOKEN_PLAN_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "glm-5": "glm-5.2",
  "deepseek-v4-flash": "deepseek-v4-flash-0731",
});

const bareModel = (model: string): string => model.split("/").at(-1) ?? model;

/** Token Plan credentials are isolated from Coding Plan and pay-as-you-go credentials. Keep endpoint
 * detection exact so a similarly named proxy never inherits Alibaba-specific transport behavior. */
export function isOfficialTokenPlanOpenAIEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const path = url.pathname.replace(/\/+$/, "");
    return url.protocol === "https:"
      && host === TOKEN_PLAN_OPENAI_HOST
      && path === TOKEN_PLAN_OPENAI_PATH;
  } catch {
    return false;
  }
}

/** The shared Token Plan host serves both Responses and Chat-only models. These are the Qwen text
 * families Alibaba currently documents for Responses/Codex, including dated aliases and the preview/
 * production qwen3.8-max transition observed in the key-scoped live catalog. */
export function isTokenPlanQwenResponsesModel(model: string): boolean {
  return /^qwen3\.(?:8-(?:max(?:-preview)?|flash)|7-(?:max|plus)|6-(?:plus|flash))(?:-|$)/i.test(bareModel(model));
}

/** Models in the current Token Plan interactive catalog that Alibaba documents on its OpenAI-compatible
 * Responses API. Keep this separate from the Qwen family check: the same subscription endpoint also serves
 * DeepSeek and GLM, and those models should not silently fall back to Chat with no thinking control. Unknown
 * future ids continue to fail closed to Chat until their Responses behavior is documented or observed live. */
export function isTokenPlanResponsesModel(model: string): boolean {
  const id = bareModel(model);
  return isTokenPlanQwenResponsesModel(id)
    || /^deepseek-v4-(?:pro(?:-0813)?|flash(?:-0731)?)(?:-|$)/i.test(id)
    || /^glm-5\.2(?:-|$)/i.test(id);
}

/** Entries the live catalog still returns but nobody should newly choose: a retired alias that the server
 * silently reroutes, or a model another catalog entry beats on every axis. Hiding them keeps the picker a
 * list of real decisions instead of a changelog. This never restricts what a key may call — an explicit
 * `/model <id>` or `hara config set model` still accepts any entitled id, and the model already configured
 * is always kept in the list so nobody is stranded on one of these. */
export function isTokenPlanSupersededModel(model: string): boolean {
  const id = bareModel(model).toLowerCase();
  // Alibaba retired the preview and reroutes it to qwen3.8-max, billing and reporting it as qwen3.8-max.
  if (/^qwen3\.8-max-preview(?:-|$)/.test(id)) return true;
  // qwen3.6-flash loses to qwen3.8-flash on every axis: dearer per token (1.2/7.2 vs 0.8/2.7), tiered above
  // 256K (4.8/28.8) where qwen3.8-flash stays flat to 1M, and an older generation with the same vision.
  if (/^qwen3\.6-flash(?:-|$)/.test(id)) return true;
  return false;
}

/** One line of buying advice per catalog entry: what this model is FOR, and the one fact that decides it
 * (price shape, a standing discount, or a missing capability). Undefined for anything not in the curated
 * table, so an unknown future id shows up unannotated rather than mislabelled. */
export function tokenPlanModelHint(model: string): string | undefined {
  const id = bareModel(model).toLowerCase();
  if (/^qwen3\.8-flash(?:-|$)/.test(id)) return "daily driver · cheapest · flat rate to 1M · images";
  if (/^qwen3\.8-max(?:-|$)/.test(id)) return "heavy work · half price 22:00–08:00 · images";
  if (/^qwen3\.7-plus(?:-|$)/.test(id)) return "writing and tone · images";
  if (/^qwen3\.7-max(?:-|$)/.test(id)) return "text only · qwen3.8-max is the current generation";
  if (/^deepseek-v4-pro-0813(?:-|$)/.test(id)) return "text only · deep reasoning · half price 22:00–08:00";
  if (/^deepseek-v4-pro(?:-|$)/.test(id)) return "text only · deep reasoning · flat rate";
  if (/^deepseek-v4-flash(?:-0731)?(?:-|$)/.test(id)) return "text only · light work · peak/off-peak pricing";
  if (/^glm-5\.2(?:-|$)/.test(id)) return "text only · flat rate";
  return undefined;
}

/** `/models` is entitlement-authoritative but also lists media generators that require separate APIs or
 * Skills. Keep those out of Hara's interactive Agent model picker without guessing an allow-list for
 * future text models. */
export function isTokenPlanInteractiveAgentModel(model: string): boolean {
  const id = bareModel(model).toLowerCase();
  return !(
    /^qwen-(?:audio|image)(?:-|$)/.test(id)
    || /^wan[\d.]*-(?:image|video)(?:-|$)/.test(id)
    || /^happyhorse-/.test(id)
    || /-(?:tts|asr|i2v|t2v|r2v)(?:-|$)/.test(id)
  );
}

/** Suggest a known safe replacement only when the current key's authoritative live catalog contains the
 * target. This never turns the static catalog into an authorization claim. */
export function tokenPlanModelReplacement(
  current: string,
  availableModels: readonly string[],
): string | undefined {
  if (availableModels.includes(current)) return undefined;
  const replacement = TOKEN_PLAN_MODEL_REPLACEMENTS[bareModel(current).toLowerCase()];
  return replacement && availableModels.includes(replacement) ? replacement : undefined;
}
