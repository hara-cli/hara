// Shared provider construction for the interactive CLI, Desktop serve, gateway approval/judge calls, and
// connection tests. Every path must interpret auth:none/OAuth/wire-protocol targets identically.
import { providerIsLocal, type HaraConfig } from "../config.js";
import { getValidQwenAuth } from "./qwen-oauth.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { resolvePlatform } from "./registry.js";
import type { Provider } from "./types.js";
import type { ProviderTarget } from "./target.js";

export async function createProviderForTarget(
  target: ProviderTarget,
  reasoningEffort?: HaraConfig["reasoningEffort"],
): Promise<Provider | null> {
  const { provider, apiKey, model, baseURL } = target;
  if (provider === "qwen-oauth") {
    const auth = await getValidQwenAuth();
    if (!auth) return null;
    return createOpenAIProvider({
      apiKey: auth.accessToken,
      baseURL: auth.baseURL,
      model,
      label: provider,
      reasoningEffort,
    });
  }

  // The OpenAI SDK requires a non-empty constructor value even when a compatible local endpoint has no
  // authentication. This sentinel never leaves the process for cloud targets and local targets have already
  // discarded all user credentials at target resolution.
  const transportKey = apiKey ?? (providerIsLocal(provider) ? "hara-local-no-secret" : undefined);
  if (!transportKey) return null;
  const wire = resolvePlatform(provider, baseURL, undefined, model).wireApi;
  if (wire === "anthropic") {
    return createAnthropicProvider({ apiKey: transportKey, model, baseURL, reasoningEffort });
  }
  if (wire === "responses") {
    return {
      id: provider,
      model,
      async turn() {
        return {
          text: "",
          toolUses: [],
          stop: "error" as const,
          errorMsg:
            "This endpoint uses the OpenAI Responses API, which hara doesn't speak yet. Point hara at an OpenAI-compatible chat endpoint (…/compatible-mode/v1 or …/v1) or an Anthropic-compatible endpoint (…/apps/anthropic).",
        };
      },
    };
  }
  return createOpenAIProvider({
    apiKey: transportKey,
    model,
    baseURL,
    label: provider,
    reasoningEffort,
    omitAuthorization: providerIsLocal(provider),
  });
}
