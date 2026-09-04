// Shared provider construction for the interactive CLI, Desktop serve, gateway approval/judge calls, and
// connection tests. Every path must interpret auth:none/OAuth/wire-protocol targets identically.
import { providerIsLocal, type HaraConfig } from "../config.js";
import { createModelFetch, userModelFetch } from "../network/model-fetch.js";
import { getValidQwenAuth } from "./qwen-oauth.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createResponsesProvider } from "./responses.js";
import { deepSeekResponsesSupportsImages } from "./deepseek.js";
import { isOfficialTokenPlanOpenAIEndpoint } from "./alibaba.js";
import { resolvePlatform } from "./registry.js";
import {
  isOfficialVolcengineAgentPlanEndpoint,
  isVolcengineAgentPlanUnsupportedModelError,
  VOLCENGINE_AGENT_PLAN_AUTO_FALLBACK_MODEL,
} from "./volcengine.js";
import type { Provider, TurnResult } from "./types.js";
import type { ProviderTarget } from "./target.js";

function emptyFailedTurn(result: TurnResult): boolean {
  return result.stop === "error"
    && result.text === ""
    && result.toolUses.length === 0
    && (result.usage?.output ?? 0) === 0;
}

/** Keep Ark's documented `auto` router as the visible model while tolerating the subset of Agent Plan
 * keys that currently accept only the stable Codex alias. The retry is intentionally narrow: it can run
 * only before any streamed output/tool call, and only for Ark's exact unsupported-model response. */
export function withVolcengineAgentPlanAutoFallback(primary: Provider, fallback: Provider): Provider {
  return {
    ...primary,
    async turn(args) {
      let emittedText = false;
      const result = await primary.turn({
        ...args,
        onText(delta) {
          if (delta) emittedText = true;
          args.onText(delta);
        },
      });
      if (
        args.signal?.aborted
        || emittedText
        || !emptyFailedTurn(result)
        || !isVolcengineAgentPlanUnsupportedModelError(result.errorMsg)
      ) {
        return result;
      }
      const recovered = await fallback.turn(args);
      if (!emptyFailedTurn(recovered) || !isVolcengineAgentPlanUnsupportedModelError(recovered.errorMsg)) {
        return recovered;
      }
      return {
        ...recovered,
        errorMsg: `${recovered.errorMsg ?? "Agent Plan rejected the compatibility model."} Verify that this is an Agent Plan dedicated API key, then choose a model enabled for the subscribed plan.`,
      };
    },
  };
}

export async function createProviderForTarget(
  target: ProviderTarget,
  reasoningEffort?: HaraConfig["reasoningEffort"],
  /** True when the engine picked `reasoningEffort` itself rather than a user or rule choosing it. Such a
   * value is advisory: an endpoint that rejects the field may be retried without it instead of failing the
   * whole call. An explicit selection is a latency/cost contract and always fails visibly. */
  options: { reasoningAdvisory?: boolean } = {},
): Promise<Provider | null> {
  const { provider, apiKey, model, baseURL, proxy } = target;
  const fetch = proxy === undefined ? userModelFetch : createModelFetch(proxy);
  if (provider === "qwen-oauth") {
    const auth = await getValidQwenAuth();
    if (!auth) return null;
    return createOpenAIProvider({
      apiKey: auth.accessToken,
      baseURL: auth.baseURL,
      model,
      label: provider,
      reasoningEffort,
      fetch,
    });
  }

  // The OpenAI SDK requires a non-empty constructor value even when a compatible local endpoint has no
  // authentication. This sentinel never leaves the process for cloud targets and local targets have already
  // discarded all user credentials at target resolution.
  const transportKey = apiKey ?? (providerIsLocal(provider) ? "hara-local-no-secret" : undefined);
  if (!transportKey) return null;
  const caps = resolvePlatform(provider, baseURL, undefined, model);
  const wire = caps.wireApi;
  if (wire === "anthropic") {
    return createAnthropicProvider({ apiKey: transportKey, model, baseURL, reasoningEffort, fetch });
  }
  if (wire === "responses") {
    const alibabaTokenPlan = isOfficialTokenPlanOpenAIEndpoint(baseURL);
    const volcengineAgentPlan = isOfficialVolcengineAgentPlanEndpoint(baseURL);
    const responseOptions = {
      apiKey: transportKey,
      model,
      baseURL,
      label: provider,
      reasoningEffort,
      reasoningStyle: caps.reasoning,
      supportsImages: !/^deepseek-/i.test(model) || deepSeekResponsesSupportsImages(model),
      ...(options.reasoningAdvisory ? { reasoningAdvisory: true } : {}),
      ...(alibabaTokenPlan ? { store: false, dashscopeSessionCache: true } : {}),
      ...(volcengineAgentPlan ? { store: false } : {}),
      omitAuthorization: providerIsLocal(provider),
      fetch,
    };
    const primary = createResponsesProvider(responseOptions);
    if (volcengineAgentPlan && model.toLowerCase() === "auto") {
      const fallback = createResponsesProvider({
        ...responseOptions,
        model: VOLCENGINE_AGENT_PLAN_AUTO_FALLBACK_MODEL,
      });
      return withVolcengineAgentPlanAutoFallback(primary, fallback);
    }
    return primary;
  }
  return createOpenAIProvider({
    apiKey: transportKey,
    model,
    baseURL,
    label: provider,
    ...(options.reasoningAdvisory ? { reasoningAdvisory: true } : {}),
    reasoningEffort,
    omitAuthorization: providerIsLocal(provider),
    fetch,
  });
}
