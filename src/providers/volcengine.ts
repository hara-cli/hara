const VOLCENGINE_AGENT_PLAN_HOST = "ark.cn-beijing.volces.com";
const VOLCENGINE_AGENT_PLAN_PATH = "/api/plan/v3";

/** Fixed Codex/Responses endpoint for Volcengine Ark Agent Plan (Beijing). Agent Plan keys are scoped to
 * this subscription route and must not be mixed with pay-as-you-go Ark API endpoints. */
export const VOLCENGINE_AGENT_PLAN_BASE_URL =
  `https://${VOLCENGINE_AGENT_PLAN_HOST}${VOLCENGINE_AGENT_PLAN_PATH}`;

/** Ark documents `ark-code-latest` as the stable Codex-compatible alias. Some otherwise valid Agent Plan
 * keys currently reject the newer `auto` router id with a model-capability 404, so Hara may use this alias
 * for one bounded compatibility retry after the request has failed before producing any output. */
export const VOLCENGINE_AGENT_PLAN_AUTO_FALLBACK_MODEL = "ark-code-latest";

/** Current Agent Plan conversation-model catalog documented by Volcengine (verified 2026-09-03).
 * `auto` is the product's first/default choice; compatibility aliases remain at the end so existing
 * configurations stay editable. Live key-scoped discovery remains authoritative. */
export const VOLCENGINE_AGENT_PLAN_MODELS = Object.freeze([
  "auto",
  "doubao-seed-evolving",
  "doubao-seed-2.1-turbo",
  "doubao-seed-2.0-lite",
  "doubao-seed-2.0-mini",
  "glm-5.3-flash",
  "glm-5.3",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "minimax-m3",
  "kimi-k2.7-code",
  "kimi-k3",
  "ark-code-latest",
  "glm-latest",
]);

export function isOfficialVolcengineAgentPlanEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return url.protocol === "https:"
      && url.hostname.toLowerCase().replace(/\.$/, "") === VOLCENGINE_AGENT_PLAN_HOST
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname.replace(/\/+$/, "") === VOLCENGINE_AGENT_PLAN_PATH;
  } catch {
    return false;
  }
}

/** `/models` may also enumerate embedding, image, video, and speech models. Those belong to separate
 * capability surfaces, not Hara's conversation model picker. Unknown future text models remain visible. */
export function isVolcengineAgentPlanInteractiveModel(model: string): boolean {
  const id = model.toLowerCase();
  return !(
    /(?:^|-)embedding(?:-|$)/.test(id)
    || /(?:seedream|seedance)/.test(id)
    || /-(?:tts|asr)(?:-|$)/.test(id)
  );
}

/** glm-5.3 is explicitly always-thinking on Agent Plan. Other current text models use Ark's documented
 * thinking disable switch plus the Codex low/medium/high reasoning dial. */
export function volcengineAgentPlanCanDisableThinking(model: string): boolean {
  const id = model.split("/").at(-1)?.toLowerCase() ?? model.toLowerCase();
  return !/^(?:glm-5\.3|glm-latest)$/.test(id);
}

/** Match only Ark's model-capability response. A generic 404 can mean a wrong endpoint, proxy, or account
 * route and must remain visible instead of silently trying a second billable request. */
export function isVolcengineAgentPlanUnsupportedModelError(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase().replace(/[_-]+/g, " ");
  return normalized.includes("requested model does not support the agent plan feature")
    || normalized.includes("model does not support agent plan")
    || /(?:请求|指定).{0,12}模型.{0,20}不支持.{0,12}agent plan/iu.test(message);
}
