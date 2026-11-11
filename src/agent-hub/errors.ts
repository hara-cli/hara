/** Public ingress failures use fixed classifications, never filesystem/provider exception text. */
export type AgentHubErrorCode = "invalid_request" | "unauthorized" | "conflict" | "quota_exceeded"
  | "unsupported_attachment" | "registry_unavailable" | "store_unavailable";
export class AgentHubError extends Error {
  constructor(readonly code: AgentHubErrorCode) { super(`Agent Hub: ${code}`); this.name = "AgentHubError"; }
}
export function hubAssert(value: unknown, code: AgentHubErrorCode = "invalid_request"): asserts value {
  if (!value) throw new AgentHubError(code);
}
export function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
