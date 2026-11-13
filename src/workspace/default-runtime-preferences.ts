import { isAgentRuntimeId, type AgentRuntimeId } from "../agent-runtime/bindings.js";
import { exact, plain } from "./local-state.js";
import { SettingsMigrationPendingError, VersionedSettings } from "./versioned-settings.js";
import { workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";

interface State { schemaVersion: 1; revision: number; defaultRuntimeId: AgentRuntimeId | null }
/** One Workspace's new-colleague preference. Saving never probes or activates an engine. */
export class WorkspaceDefaultRuntime {
  private readonly state: VersionedSettings<State>;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly legacyInitial: () => AgentRuntimeId | null) {
    this.state = new VersionedSettings(() => workspaceStateHome(), "workspace-default-runtime-v1.json", 1,
      () => ({ schemaVersion: 1, revision: 0, defaultRuntimeId: null }), raw => {
        if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "defaultRuntimeId"]) || raw.schemaVersion !== 1
          || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
          || raw.defaultRuntimeId !== null && !isAgentRuntimeId(raw.defaultRuntimeId)) throw new Error("Invalid Workspace default runtime preference");
        return { schemaVersion: 1, revision: Number(raw.revision), defaultRuntimeId: raw.defaultRuntimeId as AgentRuntimeId | null };
      }, {}, storage);
  }
  get(options: { readOnly?: boolean; assertWriteCurrent?: () => void } = {}) {
    const current = this.state.read();
    if (!options.readOnly && !current.readOnly && current.value.revision === 0) {
      try {
        this.state.update(0, old => {
          // The scoped CAS winner reads only the explicit old Host preference. Once this
          // record exists, even a saved null never reads or follows that legacy value again.
          let initial: AgentRuntimeId | null = null;
          try { initial = this.legacyInitial(); }
          catch (error) {
            if (error instanceof SettingsMigrationPendingError) throw error;
            // A safely read but invalid legacy value cannot become a valid engine choice.
          }
          return { ...old, defaultRuntimeId: initial };
        }, options.assertWriteCurrent);
      } catch (error) {
        const latest = this.state.read(); if (latest.readOnly || latest.value.revision === 0) throw error;
      }
    }
    const { value, readOnly, recovered } = this.state.read();
    return { ...value, workspaceId: this.storage.scope.workspaceId, readOnly: readOnly || !!options.readOnly, recovered };
  }
  set(defaultRuntimeId: unknown, expectedRevision: number, assertWriteCurrent?: () => void) {
    if (defaultRuntimeId !== null && !isAgentRuntimeId(defaultRuntimeId)) throw new Error("Invalid default Runtime preference");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Invalid default Runtime revision");
    this.state.update(expectedRevision, old => ({ ...old, defaultRuntimeId: defaultRuntimeId as AgentRuntimeId | null }), assertWriteCurrent);
    return this.get();
  }
}
