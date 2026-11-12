import { withWorkspaceSessionAdmission } from "./session-lease.js";
// A protected scope never falls back to a legacy runtime when C3 bootstrap is disabled.
import { AgentBoundaryContractError } from "./agent-boundaries-contract.js";
import { isWorkspaceResourceBinding, sameWorkspaceResourceBinding, currentWorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { plain } from "./local-state.js";
export function workspaceAgentCommandProtected(storage: WorkspaceResourceStorage): boolean {
  return storage.readJson("workspace-agent-authority-v1.json", snapshot => {
    if (!snapshot) return false;
    let raw: unknown;
    try { raw = JSON.parse(snapshot.text); } catch { throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.protection"); }
    if (!plain(raw) || raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3 && raw.schemaVersion !== 4 || !isWorkspaceResourceBinding(raw.resourceBinding)
      || !sameWorkspaceResourceBinding(raw.resourceBinding, currentWorkspaceResourceBinding()!)) throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.protection");
    if (raw.schemaVersion === 1 && (Object.hasOwn(raw, "control") || Object.hasOwn(raw, "lifecycle") || Object.hasOwn(raw, "routing")) || raw.schemaVersion !== 1 && (!plain(raw.control) || (raw.schemaVersion === 3 || raw.schemaVersion === 4) && !plain(raw.lifecycle) || raw.schemaVersion === 4 && !plain(raw.routing) || raw.schemaVersion !== 4 && Object.hasOwn(raw, "routing"))) throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.protection");
    return raw.schemaVersion !== 1;
  });
}

/** Legacy claims and first migration serialize before any physical callback. */
export function withUnprotectedWorkspaceAdmission<T>(storage: WorkspaceResourceStorage, operation: () => T): T {
  return withWorkspaceSessionAdmission(storage, () => {
    if (workspaceAgentCommandProtected(storage)) throw new AgentBoundaryContractError("RUNTIME_UNSUPPORTED", "control.legacyEntry");
    return operation();
  });
}
/** Called inside shared admission lock. Ambiguous legacy effects require separate recovery. */
export function assertNoWorkspaceLegacyEffects(storage: WorkspaceResourceStorage): void {
  for (const [filename, key, terminal] of [
    ["workspace-legacy-command-runs-v1.json", "runs", ["completed", "failed", "blocked", "timed_out", "cancelled"]],
    ["workspace-legacy-outcomes-v1.json", "effects", ["sent", "blocked"]],
  ] as const) storage.readJson(filename, snapshot => {
    if (!snapshot) return;
    let raw: unknown; try { raw = JSON.parse(snapshot.text); } catch { throw new AgentBoundaryContractError("CONTROL_HELD", "control.legacyDrain"); }
    if (!plain(raw) || !isWorkspaceResourceBinding(raw.resourceBinding) || !sameWorkspaceResourceBinding(raw.resourceBinding, currentWorkspaceResourceBinding()!)
      || !Array.isArray(raw[key]) || (raw[key] as unknown[]).some(item => !plain(item) || !(terminal as readonly unknown[]).includes(item.state))) {
      throw new AgentBoundaryContractError("CONTROL_HELD", "control.legacyDrain");
    }
  });
}
