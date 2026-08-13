// Shared provider construction for the interactive CLI, Desktop serve, gateway approval/judge calls, and
// connection tests. Every path must interpret auth:none/OAuth/wire-protocol targets identically.
import { providerIsLocal, type HaraConfig } from "../config.js";
import { createModelFetch, userModelFetch } from "../network/model-fetch.js";
import { getValidQwenAuth } from "./qwen-oauth.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createResponsesProvider } from "./responses.js";
import { resolvePlatform } from "./registry.js";
import type { Provider } from "./types.js";
import type { ProviderTarget } from "./target.js";

export async function createProviderForTarget(
  target: ProviderTarget,
  reasoningEffort?: HaraConfig["reasoningEffort"],
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
    return createResponsesProvider({
      apiKey: transportKey,
      model,
      baseURL,
      label: provider,
      reasoningEffort,
      reasoningStyle: caps.reasoning,
      supportsImages: caps.reasoning !== "deepseek_responses",
      omitAuthorization: providerIsLocal(provider),
      fetch,
    });
  }
  return createOpenAIProvider({
    apiKey: transportKey,
    model,
    baseURL,
    label: provider,
    reasoningEffort,
    omitAuthorization: providerIsLocal(provider),
    fetch,
  });
}
