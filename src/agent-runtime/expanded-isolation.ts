import type { ExpandedRuntimeId } from "./expanded-models.js";

/** Release admission, not a user preference. No environment variable, model input or renderer
 * option can waive this requirement. A transport fixture is not a vendor isolation receipt.
 *
 * The documented Copilot config is additive; Cursor merges global/project MCP; Grok discovers
 * native and vendor-compatible plugins/hooks. None of these three installed binaries has been
 * verified here. Keep real session AND metadata subprocesses closed until the exact CLI has a
 * reviewed mechanism for Hara-only MCP, no inherited plugins/hooks, and no native scheduling.
 * Host login must remain in place: never achieve isolation by copying credentials or changing HOME.
 */
export function assertExpandedRuntimeIsolation(_runtimeId: ExpandedRuntimeId): void {
  throw new Error("runtime_permission_denied");
}
export function expandedRuntimeIsolationReady(_runtimeId: ExpandedRuntimeId): boolean { return false; }
