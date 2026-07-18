import {
  providerDefaultBaseURL,
  providerDefaultModel,
  providerEnvKey,
  isProviderId,
  providerIsLocal,
  type HaraConfig,
  type ProviderId,
} from "../config.js";
import {
  getProfile,
  PERSONAL_ID,
  resolveActive,
  type ActiveResolution,
  type Profile,
} from "../profile/profile.js";

export interface ProviderTarget {
  provider: ProviderId;
  apiKey?: string;
  baseURL?: string;
  model: string;
}

export interface ProviderTargetOverride {
  provider?: ProviderId;
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/** Resolve the identity profile for the same cwd used to load config. */
export function profileForConfig(cfg: HaraConfig): {
  profile: Profile;
  resolution: ActiveResolution;
} {
  const resolution = resolveActive(cfg.cwd);
  if (resolution.id !== PERSONAL_ID) {
    const profile = getProfile(resolution.id);
    if (profile) return { profile, resolution };
  }
  return {
    resolution: resolution.id === PERSONAL_ID
      ? resolution
      : { id: PERSONAL_ID, source: "fallback" },
    profile: {
      id: PERSONAL_ID,
      kind: "byok",
      label: "Personal",
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      defaultModel: cfg.model,
    },
  };
}

/**
 * Resolve one BYOK/local transport target.
 *
 * A named Profile is an identity boundary: its vendor, credential and endpoint must not be replaced by
 * the always-populated personal/global config. Explicit HARA_* values remain one-shot overrides. The
 * personal profile and explicit sidecars continue to use the merged config.
 */
export function resolveByokProviderTarget(
  cfg: HaraConfig,
  profile: Profile,
  sidecarOverride: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ProviderTarget {
  const personalOrOverride = profile.id === "personal" || sidecarOverride;
  const profileProvider: ProviderId =
    profile.provider && profile.provider !== "hara-gateway" ? profile.provider : "anthropic";
  const environmentProvider: ProviderId | undefined =
    isProviderId(env.HARA_PROVIDER) && env.HARA_PROVIDER !== "hara-gateway"
      ? env.HARA_PROVIDER
      : undefined;
  const provider: ProviderId =
    personalOrOverride
      ? (cfg.provider !== "hara-gateway" ? cfg.provider : profileProvider)
      : environmentProvider ?? profileProvider;
  const namedProviderChanged = !personalOrOverride && provider !== profileProvider;
  const envKey = providerEnvKey(provider);
  const providerEnvApiKey = envKey ? env[envKey] : undefined;
  const candidateApiKey = personalOrOverride
    ? cfg.apiKey ?? profile.apiKey
    : env.HARA_API_KEY ?? providerEnvApiKey ?? (namedProviderChanged ? undefined : profile.apiKey);
  // Ollama/LM Studio declare auth:none. Never forward a stale cloud key (including HARA_API_KEY) to a
  // loopback process that happens to occupy the configured port.
  const apiKey = providerIsLocal(provider) ? undefined : candidateApiKey;
  const baseURL = personalOrOverride
    ? cfg.baseURL ?? profile.baseURL ?? providerDefaultBaseURL(provider)
    : env.HARA_BASE_URL
      ?? (namedProviderChanged ? undefined : profile.baseURL)
      ?? providerDefaultBaseURL(provider);
  const profileModel = profile.model || profile.defaultModel || "";
  const model = personalOrOverride
    ? cfg.model || env.HARA_MODEL || profileModel
    : env.HARA_MODEL
      || (namedProviderChanged ? "" : profileModel)
      || providerDefaultModel(provider);
  return { provider, apiKey, baseURL, model };
}

/**
 * Apply an explicit runtime selection (session model, role model, vision/route sidecar, fallback).
 *
 * A provider switch starts a fresh credential/endpoint boundary; absent fields use that provider's public
 * defaults and never inherit the previous profile's key or host.
 */
export function overrideProviderTarget(
  base: ProviderTarget,
  override: ProviderTargetOverride | undefined,
): ProviderTarget {
  if (!override) return base;
  const owns = (key: keyof ProviderTargetOverride): boolean =>
    Object.prototype.hasOwnProperty.call(override, key);
  const provider = override.provider ?? base.provider;
  const providerChanged = provider !== base.provider;
  const apiKey = providerIsLocal(provider)
    ? undefined
    : owns("apiKey")
      ? override.apiKey
      : providerChanged
        ? undefined
        : base.apiKey;
  const baseURL = owns("baseURL")
    ? override.baseURL
    : providerChanged
      ? providerDefaultBaseURL(provider)
      : base.baseURL;
  const model = owns("model") && override.model
    ? override.model
    : providerChanged
      ? providerDefaultModel(provider)
      : base.model;
  return { provider, apiKey, baseURL, model };
}

/** Gateway profiles own their default, while an explicit session/role model remains selectable. */
export function resolveGatewayModel(
  cfg: HaraConfig,
  profile: Profile,
  env: NodeJS.ProcessEnv = process.env,
  requestedModel?: string,
): string {
  return env.HARA_MODEL || requestedModel || profile.model || profile.defaultModel || cfg.model;
}
