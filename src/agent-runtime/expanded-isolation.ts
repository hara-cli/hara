import { isExpandedRuntime, type ExpandedRuntimeId } from "./expanded-models.js";

/** Jeff option A, 2026-11-03: preserve host login and let these native CLIs load personal
 * plugins/hooks/MCP themselves. Hara never reads, copies or rewrites the user's home configuration.
 * This is an observed execution mode, not an assertion that extensions are isolated. */
export const expandedExtensionsIsolation = (runtimeId: unknown): "inherited" | undefined =>
  isExpandedRuntime(runtimeId) ? "inherited" : undefined;

/** Compatibility entry point: the former extension-isolation hard refusal is removed.
 * Only the runtime ID is validated. Seatbelt, permit admission and native tool refusals remain. */
export function assertExpandedRuntimeIsolation(runtimeId: ExpandedRuntimeId): void {
  if (!isExpandedRuntime(runtimeId)) throw new Error("runtime_permission_denied");
}
/** Legacy admission query: true permits inherited extensions; it does not claim isolation. */
export function expandedRuntimeIsolationReady(runtimeId: ExpandedRuntimeId): boolean { return isExpandedRuntime(runtimeId); }
