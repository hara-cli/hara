// Observational success history only. These records neither register a binary nor grant execution.
// Trusted Host code calls recordSuccessfulUse only after the matching runtime really succeeds.
import type { OptionalRuntimeId } from "./runtime-install.js";
import { OPTIONAL_RUNTIMES } from "./runtime-catalog.js";
import { canonical, exact, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";

export interface RuntimeVersionSuccess {
  runtimeId: OptionalRuntimeId;
  version: string | null;
  fingerprint: string;
}
export interface RuntimeVersionCurrent {
  version: string | null;
  fingerprint: string | null;
  registered: boolean;
  requiresRetrust: boolean;
}
export interface RuntimeVersionStatus {
  schemaVersion: 1;
  lastSuccessfulVersion: string | null;
  currentVersion: string | null;
  change: "no_history" | "same" | "upgraded" | "downgraded" | "unknown";
  compatibility: "previously_succeeded" | "unverified" | "unknown";
  binaryChanged: boolean | null;
  requiresRetrust: boolean;
}
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const SUCCESS_FIELDS = ["runtimeId", "version", "fingerprint"] as const;
const CURRENT_FIELDS = ["version", "fingerprint", "registered", "requiresRetrust"] as const;
const optionalRuntime = (value: unknown): value is OptionalRuntimeId => typeof value === "string"
  && (OPTIONAL_RUNTIMES as readonly string[]).includes(value);
const knownVersion = (value: unknown): value is string => typeof value === "string" && value === value.trim() && VERSION.test(value);
const fingerprint = (value: unknown): value is string => typeof value === "string" && value.length === 64 && FINGERPRINT.test(value);
function invalid(): never { throw new Error("Invalid Runtime version history; private state was preserved"); }
function parseSuccess(value: unknown): RuntimeVersionSuccess {
  if (!plain(value) || !exact(value, SUCCESS_FIELDS) || !optionalRuntime(value.runtimeId)
    || !(value.version === null || knownVersion(value.version)) || !fingerprint(value.fingerprint)) return invalid();
  return { runtimeId: value.runtimeId, version: value.version, fingerprint: value.fingerprint };
}
function currentObservation(value: RuntimeVersionCurrent): RuntimeVersionCurrent {
  if (!plain(value) || !exact(value as unknown as Record<string, unknown>, CURRENT_FIELDS)
    || typeof value.registered !== "boolean" || typeof value.requiresRetrust !== "boolean") return invalid();
  // Banner text, paths and malformed fingerprints are never copied into a presentation DTO.
  return { version: knownVersion(value.version) ? value.version : null,
    fingerprint: fingerprint(value.fingerprint) ? value.fingerprint : null,
    registered: value.registered, requiresRetrust: value.requiresRetrust };
}
function compareVersions(current: string, last: string): number {
  const a = current.split(".").map(Number), b = last.split(".").map(Number);
  return (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!);
}
/** Content-free projection. A known version with no history is unverified; an unknown version
 * can never claim compatibility, even when the binary fingerprint happens to match. */
export function projectRuntimeVersionStatus(last: RuntimeVersionSuccess | null, input: RuntimeVersionCurrent): RuntimeVersionStatus {
  const current = currentObservation(input), success = last === null ? null : parseSuccess(last);
  const binaryChanged = success && current.fingerprint ? success.fingerprint !== current.fingerprint : null;
  let change: RuntimeVersionStatus["change"] = "unknown";
  if (current.version !== null) {
    if (!success) change = "no_history";
    else if (success.version !== null) {
      const comparison = compareVersions(current.version, success.version);
      change = comparison === 0 ? "same" : comparison > 0 ? "upgraded" : "downgraded";
    }
  }
  const compatibility = change === "unknown" ? "unknown"
    : change === "same" && binaryChanged === false && current.registered && !current.requiresRetrust
      ? "previously_succeeded" : "unverified";
  return { schemaVersion: 1, lastSuccessfulVersion: success?.version ?? null, currentVersion: current.version,
    change, compatibility, binaryChanged, requiresRetrust: current.requiresRetrust };
}
interface VersionDocument {
  schemaVersion: 1;
  revision: number;
  resourceBinding: WorkspaceResourceBinding;
  entries: RuntimeVersionSuccess[];
}
/** Explicit success writes, at most one entry per optional runtime in this exact Workspace generation.
 * No probing, raw CLI output, command/path, credential, login state or automatic trust change is stored. */
export class WorkspaceRuntimeVersionStore {
  private readonly state: WorkspaceJsonState<VersionDocument>;
  constructor(storage: WorkspaceResourceStorage) {
    this.state = new WorkspaceJsonState<VersionDocument>(storage, "runtime-successful-versions-v1.json", value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "revision", "resourceBinding", "entries"])
        || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.entries) || value.entries.length > OPTIONAL_RUNTIMES.length) return invalid();
      const entries = value.entries.map(parseSuccess);
      if (new Set(entries.map(row => row.runtimeId)).size !== entries.length) return invalid();
      return { schemaVersion: 1, revision: Number(value.revision), resourceBinding: structuredClone(value.resourceBinding) as WorkspaceResourceBinding, entries };
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), entries: [] }));
  }
  recordSuccessfulUse(runtimeId: OptionalRuntimeId, version: string | null, binaryFingerprint: string): void {
    if (!optionalRuntime(runtimeId) || !fingerprint(binaryFingerprint)) return invalid();
    const success: RuntimeVersionSuccess = { runtimeId, version: knownVersion(version) ? version : null, fingerprint: binaryFingerprint };
    const before = this.state.read(), previous = before.entries.find(row => row.runtimeId === runtimeId);
    if (previous && canonical(previous) === canonical(success)) return;
    this.state.update(before.revision, value => ({ ...value,
      entries: [...value.entries.filter(row => row.runtimeId !== runtimeId), success] }));
  }
  list(): RuntimeVersionSuccess[] { return this.state.read().entries; }
  status(runtimeId: OptionalRuntimeId, current: RuntimeVersionCurrent): RuntimeVersionStatus {
    if (!optionalRuntime(runtimeId)) return invalid();
    const last = this.state.read().entries.find(row => row.runtimeId === runtimeId) ?? null;
    return projectRuntimeVersionStatus(last, current);
  }
}
