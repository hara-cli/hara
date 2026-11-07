import type { ScopedConnection, ScopedRunConnection } from "./scoped-connections.js";
import { connectionModelEfforts } from "./connection-models.js";
import { resolveReasoningEffort } from "./default-effort.js";

/** Host-owned per-attempt provider choice. Keep the original connection provenance and configuration
 * unchanged. The resolved level is passed through the existing provider/Pi reasoning adapter. */
export function connectionForObjective(connection: ScopedConnection, binding: ScopedRunConnection, objective: string): Readonly<ScopedRunConnection> {
  return Object.freeze({ ...binding,
    reasoning: resolveReasoningEffort(binding.reasoning, connectionModelEfforts(connection, binding.model), objective) });
}
