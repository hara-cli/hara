// Optional safety net for the thinking dial on UNKNOWN endpoints.
//
// Most
// OpenAI-compatible servers ignore a field they do not implement, but a strict one answers HTTP 400
// "unknown parameter". Removing an explicitly selected thinking level can materially change latency and
// cost, so production callers fail visibly by default. A caller may opt into best-effort removal only when
// the field is genuinely advisory and changing it cannot violate a user or automation contract.
//
// Deliberately narrow: an error we cannot positively attribute to our own parameters is rethrown
// untouched. A real 400 (bad model id, oversized input, missing credential) must still surface as
// itself, and a rejection must never be laundered into a different error message.
import type { ReasoningStyle } from "./reasoning.js";

/** Every top-level key any reasoning style can contribute. Used to recognize an endpoint that names the
 *  offending field, and to strip precisely our own additions on the retry. */
const REASONING_PARAM_KEYS = ["reasoning", "reasoning_effort", "enable_thinking", "think", "thinking"] as const;

/** Routes known to reject the dial, for this process only. Deliberately in-memory: it is a transport
 *  observation, not user state, and must not become a file that outlives a server-side fix. */
const unsupportedRoutes = new Set<string>();

/** Identity of one (endpoint, model, style) combination. The API key is never part of it. */
export function reasoningRouteKey(
  label: string | undefined,
  baseURL: string | undefined,
  model: string,
  style: ReasoningStyle,
): string {
  return `${label ?? ""}|${baseURL ?? ""}|${model}|${style}`;
}

export function reasoningUnsupported(route: string): boolean {
  return unsupportedRoutes.has(route);
}

export function markReasoningUnsupported(route: string): void {
  unsupportedRoutes.add(route);
}

/** Test seam. Production code never needs to forget a route mid-process. */
export function resetReasoningSupport(): void {
  unsupportedRoutes.clear();
}

function errorStatus(error: any): number | undefined {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return typeof status === "number" ? status : undefined;
}

function errorText(error: any): string {
  const parts = [error?.message, error?.error?.message, error?.error?.param, error?.param, error?.code, error?.error?.code];
  return parts.filter((part) => typeof part === "string").join(" ").toLowerCase();
}

const REJECTS_UNKNOWN_FIELD =
  /(unknown|unsupported|unrecognized|invalid|unexpected|not supported)[^.]{0,40}(parameter|field|argument|property|key)|extra fields|additional(?:properties| properties)|不支持[^。]{0,20}(参数|字段)/;

/** Did this failure come from the reasoning parameters WE added?
 *  - "named"   → the endpoint named one of our keys. Attributable, so the route is remembered.
 *  - "generic" → an unknown-parameter rejection that names nothing. Worth one retry, but not worth
 *                poisoning the memory: the offending field may have been someone else's.
 *  - null      → unrelated; the caller must rethrow. */
export function classifyReasoningRejection(
  error: unknown,
  sentKeys: readonly string[],
): "named" | "generic" | null {
  if (!sentKeys.length) return null;
  const status = errorStatus(error);
  if (status !== 400 && status !== 422) return null;
  const text = errorText(error);
  if (!text) return null;
  if (sentKeys.some((key) => text.includes(key))) return "named";
  return REJECTS_UNKNOWN_FIELD.test(text) ? "generic" : null;
}

/** Merge the style's parameters into the request body, unless this route already rejected them.
 *  Returns the keys actually applied — the exact set the fallback is allowed to strip. */
export function applyReasoningParams(
  params: Record<string, unknown>,
  applied: Record<string, unknown>,
  route: string,
): string[] {
  const keys = Object.keys(applied);
  if (!keys.length || reasoningUnsupported(route)) return [];
  Object.assign(params, applied);
  return keys;
}

/** Send the request; on a rejection attributable to the reasoning parameters, strip them and send once
 *  more, but only when the caller explicitly permits that semantic/cost change. */
export async function sendWithReasoningFallback<T>(
  route: string,
  params: Record<string, unknown>,
  sentKeys: readonly string[],
  send: (body: Record<string, unknown>) => Promise<T>,
  options: { allowRemoval?: boolean } = {},
): Promise<T> {
  try {
    return await send(params);
  } catch (error) {
    const rejection = classifyReasoningRejection(error, sentKeys);
    if (!rejection) throw error;
    if (options.allowRemoval !== true) throw error;
    if (rejection === "named") markReasoningUnsupported(route);
    const retry: Record<string, unknown> = { ...params };
    for (const key of REASONING_PARAM_KEYS) delete retry[key];
    return await send(retry);
  }
}
