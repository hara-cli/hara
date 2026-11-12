import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync } from "../security/private-state.js";
import { SettingsMigrationPendingError, VersionedSettings } from "./versioned-settings.js";
import { plain } from "./local-state.js";
import { isAgentRuntimeId, type AgentRuntimeId } from "../agent-runtime/bindings.js";

export type ThemePreference = "system" | "light" | "dark";
const theme = (value: unknown): value is ThemePreference => value === "system" || value === "light" || value === "dark";
export const LEGACY_BUNDLE_IDS = ["com.nanhara.hara", "com.nanhara.hara.dev", "com.nanhara.hara.workspace-candidate", "com.nanhara.hara.workspace-lab"];
/** Read exactly the public appearance preference, never enumerate other localStorage values. */
export function readLegacyTheme(home: string): ThemePreference {
  let seen = 0; const deadline = Date.now() + 2500;
  for (const id of LEGACY_BUNDLE_IDS) for (const base of [join(home, "Library/WebKit", id), join(home, "Library/Application Support", id)]) {
    const walk = (dir: string, depth: number): ThemePreference | undefined => {
      if (depth > 8 || seen > 300 || Date.now() >= deadline) return;
      let entries; try { if (lstatSync(dir).isSymbolicLink()) return; entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (Date.now() >= deadline) return;
        if (entry.isSymbolicLink()) continue; const path = join(dir, entry.name);
        if (entry.isDirectory()) { const value = walk(path, depth + 1); if (value) return value; }
        else if (entry.name.endsWith(".localstorage") || entry.name === "localstorage.sqlite3") {
          if (++seen > 300) return;
          const result = spawnSync("/usr/bin/sqlite3", ["-readonly", path, "SELECT hex(value) FROM ItemTable WHERE key='hara.theme' LIMIT 1;"], { encoding: "utf8", timeout: Math.max(1, Math.min(500, deadline - Date.now())), maxBuffer: 1024, env: { PATH: "/usr/bin:/bin" } });
          if (result.status === 0 && /^[a-f0-9]+\s*$/i.test(result.stdout)) { const bytes = Buffer.from(result.stdout.trim(), "hex");
            for (const value of [bytes.toString("utf8"), bytes.toString("utf16le")]) if (theme(value)) return value; }
        }
      }
    };
    const found = walk(base, 0); if (found) return found;
  }
  return "system";
}
export interface UpdatePreferences { autoCheck: boolean; lastChecked: number | null; skippedVersion: string | null; snooze: { version: string; until: number } | null }
const updateDefaults = (): UpdatePreferences => ({ autoCheck: true, lastChecked: null, skippedVersion: null, snooze: null });
function updates(raw: unknown): UpdatePreferences {
  if (raw === undefined) return updateDefaults();
  if (!plain(raw) || typeof raw.autoCheck !== "boolean" || !(raw.lastChecked === null || typeof raw.lastChecked === "number" && Number.isFinite(raw.lastChecked))
    || !(raw.skippedVersion === null || typeof raw.skippedVersion === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.skippedVersion))
    || !(raw.snooze === null || plain(raw.snooze) && typeof raw.snooze.version === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.snooze.version) && typeof raw.snooze.until === "number" && Number.isFinite(raw.snooze.until))) throw new Error("Invalid update preferences");
  return structuredClone(raw) as unknown as UpdatePreferences;
}
interface Preferences { defaultRuntimeId: AgentRuntimeId | null; schemaVersion: 2; revision: number; theme: ThemePreference; migratedFrom: string; executionDetails: "brief" | "detailed"; collapseDetails: boolean; alwaysShowTimingDiagnostics: boolean; updates: UpdatePreferences }
export class WorkspacePreferences {
  private readonly state: VersionedSettings<Preferences>;
  constructor(private readonly home: string, legacyHome?: string, legacyTheme: () => ThemePreference = () => legacyHome ? readLegacyTheme(legacyHome) : "system") {
    let cachedTheme: ThemePreference | undefined;
    this.state = new VersionedSettings<Preferences>(() => home, "ui-preferences-v1.json", 2,
      () => ({ schemaVersion: 2, revision: 0, defaultRuntimeId: null, theme: cachedTheme ??= legacyTheme(), migratedFrom: legacyHome ? "legacy-preference-or-system" : "system", executionDetails: "brief", collapseDetails: true, alwaysShowTimingDiagnostics: false, updates: updateDefaults() }),
      raw => {
        if (!plain(raw) || raw.schemaVersion !== 2 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !theme(raw.theme)) throw new Error("Invalid appearance settings");
        if (raw.executionDetails !== undefined && !["brief", "detailed"].includes(String(raw.executionDetails)) || raw.collapseDetails !== undefined && typeof raw.collapseDetails !== "boolean"
          || raw.alwaysShowTimingDiagnostics !== undefined && typeof raw.alwaysShowTimingDiagnostics !== "boolean") throw new Error("Invalid execution display preference");
        if (raw.defaultRuntimeId !== undefined && raw.defaultRuntimeId !== null && !isAgentRuntimeId(raw.defaultRuntimeId)) throw new Error("Invalid default Runtime preference");
        // Optional additions to v2 are backwards compatible; no side-effecting schema migration.
        return { schemaVersion: 2, revision: Number(raw.revision), defaultRuntimeId: raw.defaultRuntimeId as AgentRuntimeId | null ?? null, theme: raw.theme, migratedFrom: typeof raw.migratedFrom === "string" ? raw.migratedFrom : "v1",
          executionDetails: raw.executionDetails === "detailed" ? "detailed" : "brief", collapseDetails: raw.collapseDetails !== false, alwaysShowTimingDiagnostics: raw.alwaysShowTimingDiagnostics === true, updates: updates(raw.updates) };
      }, { 1: raw => ({ ...raw, schemaVersion: 2, migratedFrom: "v1" }) });
  }
  /** Pure, bounded migration input; never runs appearance migration or overwrites the source. */
  legacyDefaultRuntimeId(): AgentRuntimeId | null {
    const read = (name = "ui-preferences-v1.json") => {
      try {
        const file = bindPrivateHaraStateFile(this.home, [], name);
        return readPrivateStateFileSnapshotSync(file.path, 4 * 1024 * 1024);
      } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw new SettingsMigrationPendingError();
      }
    };
    let snapshot = read();
    if (!snapshot) {
      // Publication can briefly claim both names. A missing snapshot is not an empty
      // preference until the existing Host writer has released its lock.
      try {
        snapshot = withPrivateStateLockSync(this.home, [], "ui-preferences-v1", () => read() ?? read("ui-preferences-v1-backup.json"));
      } catch { throw new SettingsMigrationPendingError(); }
    }
    if (!snapshot) return null;
    const raw: unknown = JSON.parse(snapshot.text);
    if (!plain(raw) || raw.schemaVersion !== 1 && raw.schemaVersion !== 2 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
      || raw.defaultRuntimeId !== undefined && raw.defaultRuntimeId !== null && !isAgentRuntimeId(raw.defaultRuntimeId)) throw new Error("Invalid legacy Runtime preference");
    return isAgentRuntimeId(raw.defaultRuntimeId) ? raw.defaultRuntimeId : null;
  }
  read() { const { value, readOnly, recovered } = this.state.read(); return { ...value, readOnly, recovered }; }
  save(value: unknown, expected: number, extra: { defaultRuntimeId?: unknown; executionDetails?: unknown; collapseDetails?: unknown; alwaysShowTimingDiagnostics?: unknown; updates?: unknown } = {}) {
    if (Object.hasOwn(extra, "defaultRuntimeId")) throw new Error("Default runtime requires an explicit Workspace preference");
    if (!theme(value)) throw new Error("Invalid appearance choice");
    return this.state.update(expected, old => ({ ...old, theme: value === undefined ? old.theme : value as ThemePreference,
      ...(extra.executionDetails !== undefined ? { executionDetails: extra.executionDetails as Preferences["executionDetails"] } : {}),
      ...(extra.alwaysShowTimingDiagnostics !== undefined ? { alwaysShowTimingDiagnostics: extra.alwaysShowTimingDiagnostics as boolean } : {}),
      ...(extra.collapseDetails !== undefined ? { collapseDetails: extra.collapseDetails as boolean } : {}), ...(extra.updates !== undefined ? { updates: updates(extra.updates) } : {}) }));
  }
}
