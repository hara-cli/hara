const VOLCENGINE_AGENT_PLAN_HOST = "ark.cn-beijing.volces.com";
const VOLCENGINE_AGENT_PLAN_PATH = "/api/plan/v3";

/** Fixed Codex/Responses endpoint for Volcengine Ark Agent Plan (Beijing). Agent Plan keys are scoped to
 * this subscription route and must not be mixed with pay-as-you-go Ark API endpoints. */
export const VOLCENGINE_AGENT_PLAN_BASE_URL =
  `https://${VOLCENGINE_AGENT_PLAN_HOST}${VOLCENGINE_AGENT_PLAN_PATH}`;

/** Current Agent Plan text-model catalog documented by Volcengine (verified 2026-09-02). The stable
 * control-plane alias comes first and is the default. Live key-scoped discovery remains authoritative. */
export const VOLCENGINE_AGENT_PLAN_MODELS = Object.freeze([
  "ark-code-latest",
  "doubao-seed-2.0-mini",
  "doubao-seed-2.0-lite",
  "deepseek-v4-flash",
  "glm-5.3-flash",
  "doubao-seed-2.1-turbo",
  "doubao-seed-evolving",
  "minimax-m3",
  "glm-5.3",
  "glm-latest",
  "kimi-k2.7-code",
  "deepseek-v4-pro",
  "kimi-k3",
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
