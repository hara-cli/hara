/** DeepSeek capabilities documented for the official API. Keep this table small and explicit: live model
 * discovery may expose more ids, but only vendor-documented models inherit Responses-specific behavior. */
export const DEEPSEEK_RESPONSES_MODELS = Object.freeze([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
] as const);

/** DeepSeek's exact official Responses model ids that accept input_image blocks. Keep this separate from
 * transport support: Flash and Pro use Responses too, but remain text-only. */
export const DEEPSEEK_RESPONSES_VISION_MODELS = Object.freeze([
  "deepseek-v4-flash-vision-exp",
] as const);

export function deepSeekResponsesSupportsImages(modelId?: string): boolean {
  const normalizedModel = modelId?.trim().toLowerCase();
  return DEEPSEEK_RESPONSES_VISION_MODELS.some((model) => model === normalizedModel);
}

function parsedDeepSeekEndpoint(baseURL: string | undefined): URL | undefined {
  if (!baseURL) return undefined;
  try {
    const endpoint = new URL(baseURL);
    const hostname = endpoint.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
      || hostname !== "api.deepseek.com"
    ) {
      return undefined;
    }
    return endpoint;
  } catch {
    return undefined;
  }
}

function normalizedEndpointPath(endpoint: URL): string {
  const path = endpoint.pathname.replace(/\/+$/u, "").toLowerCase();
  return path || "/";
}

export function isOfficialDeepSeekEndpoint(providerId?: string, baseURL?: string): boolean {
  return baseURL ? parsedDeepSeekEndpoint(baseURL) !== undefined : providerId === "deepseek";
}

export function isOfficialDeepSeekResponsesEndpoint(
  providerId?: string,
  baseURL?: string,
): boolean {
  if (!baseURL) return providerId === "deepseek";
  const endpoint = parsedDeepSeekEndpoint(baseURL);
  if (!endpoint) return false;
  return normalizedEndpointPath(endpoint) === "/" || normalizedEndpointPath(endpoint) === "/v1";
}

export function isDeepSeekResponsesModel(
  providerId?: string,
  baseURL?: string,
  modelId?: string,
): boolean {
  const normalizedModel = modelId?.trim().toLowerCase();
  return isOfficialDeepSeekResponsesEndpoint(providerId, baseURL)
    && DEEPSEEK_RESPONSES_MODELS.some((model) => model === normalizedModel);
}
