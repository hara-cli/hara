const TOKEN_PLAN_OPENAI_HOST = "token-plan.cn-beijing.maas.aliyuncs.com";
const TOKEN_PLAN_OPENAI_PATH = "/compatible-mode/v1";

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
  return /^qwen3\.(?:8-max(?:-preview)?|7-(?:max|plus)|6-(?:plus|flash))(?:-|$)/i.test(bareModel(model));
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
