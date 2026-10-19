import { createHash } from "node:crypto";
import { WorkspaceJsonState, canonical, exact, plain, text } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { isConnectionId } from "./scoped-connections.js";
import { redactSensitiveText } from "../security/secrets.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";

export interface InheritedConnectionLink { legacyId: string; purpose: "chat" | "decision"; connectionId: string; credentialGeneration: string; keyRequired: boolean }
export interface InheritedWorkspaceSettings {
  fallbackModel: string | null; fallbackConnectionIds: string[]; unresolvedConnectionIds: string[];
  decision: { connectionId: string | null; engine: string | null; mode: string | null; model: string | null };
  computerUse: string | null; computerApps: string | null; pluginsEnabled: string[]; pluginStates: Record<string, boolean>; locale: "zh" | "en" | null;
}
interface State { revision: number; schemaVersion: 1; resourceBinding: WorkspaceResourceBinding; sourceFingerprint: string | null; settings: InheritedWorkspaceSettings }
function optional(value: unknown, max = 256): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!text(value, max) || redactSensitiveText(value).redactions.length) throw new Error("Legacy setting requires review; credential values were not copied");
  return value;
}
function pluginStates(raw: unknown): Record<string, boolean> {
  const value = raw ?? {}, entries = Array.isArray(value) ? value.map(id => [id, true] as const) : plain(value) ? Object.entries(value) : null;
  // Match the existing plugin manifest identity grammar. Legacy config stores a boolean map; some
  // earlier import fixtures used an array. Preserve false explicitly, never reactivate by omission.
  if (!entries || entries.length > 128 || entries.some(([id, enabled]) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || typeof enabled !== "boolean")) throw new Error("Invalid legacy plugin list");
  return Object.fromEntries(entries.sort(([a], [b]) => String(a).localeCompare(String(b))));
}
export function planLegacyWorkspaceSettings(raw: unknown, links: readonly InheritedConnectionLink[], locale?: unknown): InheritedWorkspaceSettings {
  if (!plain(raw) || links.some(row => !isConnectionId(row.connectionId))) throw new Error("Invalid legacy settings/connection mapping");
  const ids = raw.fallbackConnectionIds ?? []; if (!Array.isArray(ids) || ids.length > 128) throw new Error("Invalid legacy fallback references");
  const fallbackConnectionIds: string[] = [], unresolvedConnectionIds: string[] = [];
  for (const value of ids) { const id = optional(value); if (!id) throw new Error("Invalid legacy fallback identity");
    const found = links.filter(row => row.legacyId === id && row.purpose === "chat");
    if (found.length > 1) throw new Error("Ambiguous legacy fallback connection; none guessed");
    if (found[0]) fallbackConnectionIds.push(found[0].connectionId); else unresolvedConnectionIds.push(id);
  }
  if (raw.plugins !== undefined && !plain(raw.plugins)) throw new Error("Invalid legacy plugin settings");
  const plugins = pluginStates(plain(raw.plugins) ? raw.plugins.enabled : undefined);
  const decision = links.filter(row => row.purpose === "decision"); if (decision.length > 1) throw new Error("Ambiguous legacy decision connection");
  if (locale !== undefined && locale !== null && !["zh", "en"].includes(String(locale))) throw new Error("Unsupported inherited UI language");
  const result: InheritedWorkspaceSettings = { fallbackModel: optional(raw.fallbackModel), fallbackConnectionIds: [...new Set(fallbackConnectionIds)], unresolvedConnectionIds: [...new Set(unresolvedConnectionIds)],
    decision: { connectionId: decision[0]?.connectionId ?? null, engine: optional(raw.decisionEngine, 80), mode: optional(raw.decisionMode, 80), model: optional(raw.decisionModel) },
    computerUse: optional(raw.computerUse, 4096), computerApps: optional(raw.computerApps, 4096), pluginsEnabled: Object.keys(plugins).filter(id => plugins[id]), pluginStates: plugins, locale: locale === undefined || locale === null ? null : locale as "zh" | "en" };
  const output = JSON.stringify(result);
  for (const [name, value] of Object.entries(raw)) if (/api.?key|secret|password|token/i.test(name) && typeof value === "string" && value.length >= 4 && output.includes(value)) throw new Error("Credential value was used as a setting; requires secure recovery");
  return result;
}
const empty = (): InheritedWorkspaceSettings => ({ fallbackModel: null, fallbackConnectionIds: [], unresolvedConnectionIds: [], decision: { connectionId: null, engine: null, mode: null, model: null }, computerUse: null, computerApps: null, pluginsEnabled: [], pluginStates: {}, locale: null });
function parseSettings(raw: unknown): InheritedWorkspaceSettings {
  if (!plain(raw) || !exact(raw, ["fallbackModel", "fallbackConnectionIds", "unresolvedConnectionIds", "decision", "computerUse", "computerApps", "pluginsEnabled", "pluginStates", "locale"])
    || !Array.isArray(raw.fallbackConnectionIds) || raw.fallbackConnectionIds.length > 128 || !Array.isArray(raw.unresolvedConnectionIds) || raw.unresolvedConnectionIds.length > 128
    || !plain(raw.decision) || !exact(raw.decision, ["connectionId", "engine", "mode", "model"])
    || raw.fallbackConnectionIds.some(id => !isConnectionId(id)) || raw.unresolvedConnectionIds.some(id => !text(id))
    || !(raw.decision.connectionId === null || isConnectionId(raw.decision.connectionId))
    || !Array.isArray(raw.pluginsEnabled) || raw.pluginsEnabled.length > 128 || !plain(raw.pluginStates)
    || ![null, "zh", "en"].includes(raw.locale as any) || redactSensitiveText(JSON.stringify(raw)).redactions.length) throw new Error("Invalid inherited workspace settings");
  const plugins = pluginStates(raw.pluginStates);
  if (canonical(raw.pluginsEnabled) !== canonical(Object.keys(plugins).filter(id => plugins[id]))) throw new Error("Inherited plugin states disagree; no activation guessed");
  return { fallbackModel: optional(raw.fallbackModel), fallbackConnectionIds: raw.fallbackConnectionIds as string[], unresolvedConnectionIds: raw.unresolvedConnectionIds as string[],
    decision: { connectionId: raw.decision.connectionId as string | null, engine: optional(raw.decision.engine, 80), mode: optional(raw.decision.mode, 80), model: optional(raw.decision.model) },
    computerUse: optional(raw.computerUse, 4096), computerApps: optional(raw.computerApps, 4096), pluginsEnabled: raw.pluginsEnabled as string[], pluginStates: plugins, locale: raw.locale as "zh" | "en" | null };
}
/** Workspace-local preferences are not permissions. In particular plugins/computerUse/decision do
 * not activate IO or create a second planner. Invocation still needs its normal owner/runtime gate. */
export class WorkspaceInheritedSettings {
  private readonly state: WorkspaceJsonState<State>;
  constructor(storage: WorkspaceResourceStorage) {
    this.state = new WorkspaceJsonState(storage, "workspace-inherited-settings-v1.json", raw => {
      if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "sourceFingerprint", "settings"]) || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !(raw.sourceFingerprint === null || typeof raw.sourceFingerprint === "string" && /^[a-f0-9]{64}$/.test(raw.sourceFingerprint))) throw new Error("Invalid inherited settings scope");
      return { ...raw, settings: parseSettings(raw.settings) } as unknown as State;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), sourceFingerprint: null, settings: empty() }));
  }
  read() { return this.state.read(); }
  import(sourceFingerprint: string, settings: InheritedWorkspaceSettings) {
    if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) throw new Error("Invalid legacy settings source fingerprint");
    const before = this.read();
    if (before.sourceFingerprint) { if (before.sourceFingerprint !== sourceFingerprint) throw new Error("Legacy settings source changed; current settings preserved"); return { imported: false, value: before }; }
    if (before.revision) return { imported: false, preservedUserSettings: true, value: before };
    return { imported: true, value: this.state.update(before.revision, old => ({ ...old, sourceFingerprint, settings: parseSettings(settings) })) };
  }
  save(settings: InheritedWorkspaceSettings, expected: number) { return this.state.update(expected, old => ({ ...old, settings: parseSettings(settings) })); }
  receiptHash() { const value = this.read(); return createHash("sha256").update(canonical(value)).digest("hex"); }
}

/** Explicit source projection after the connection domain has produced its same-space ID mapping. */
export function legacySettingsDomain(storage: WorkspaceResourceStorage, sourceFingerprint: string,
  settings: () => InheritedWorkspaceSettings): LegacyOwnerFileDomain {
  return new LegacyOwnerFileDomain(storage, "settings", sourceFingerprint, [".hara/workspace-inherited-settings-v1.json"], 1,
    () => { new WorkspaceInheritedSettings(storage).import(sourceFingerprint, settings()); });
}
