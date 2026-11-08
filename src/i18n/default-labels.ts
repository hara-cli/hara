import { createHash } from "node:crypto";
import { readPrivateStateFileSnapshotSync, writePrivateStateFileSync, type PrivateStateFileBinding } from "../security/private-state.js";
export const DEFAULT_WORKSPACE_LABELS = Object.freeze(["我的空間", "我的空间", "个人空间", "個人空間", "我的工作空间", "我的工作空間", "My workspace"]);
export const DEFAULT_ORCHESTRATOR_TITLES = Object.freeze(["Root Orchestrator", "Root orchestrator", "总调度", "總調度"]);
export interface DefaultLabel { labelSource?: "default"; labelKey?: "core.name.workspace" }
export function validDefaultLabel(row: Record<string, unknown>): boolean {
  return row.labelSource === undefined && row.labelKey === undefined
    || row.labelSource === "default" && row.labelKey === "core.name.workspace" && typeof row.label === "string" && DEFAULT_WORKSPACE_LABELS.includes(row.label);
}
export function markDefaultWorkspaces<T extends { label: string }>(rows: T[]): number {
  let changed = 0;
  for (const row of rows as (T & DefaultLabel)[]) if (row.labelSource === undefined && DEFAULT_WORKSPACE_LABELS.includes(row.label)) {
    row.labelSource = "default"; row.labelKey = "core.name.workspace"; changed++;
  }
  return changed;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function decode(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("invalid or unsupported default-label migration state; refusing replacement"); }
}
interface Backup { schemaVersion: 1; beforeText: string; beforeSha256: string; afterSha256: string; rollbackRequested: boolean }
/** Caller holds the SAME resource lock used by ordinary writes. Never accepts a renderer path.
 * The private backup precedes publication; rollback is CAS-only and records intent before restoring. */
export function migrateDefaultLabels<T>(input: { file: PrivateStateFileBinding; backup: PrivateStateFileBinding;
  parse(value: unknown): T; mark(value: T): boolean; assertCurrent?: () => void; rollback?: boolean; maxBytes?: number }): boolean {
  const cap = input.maxBytes ?? 1024 * 1024;
  const current = readPrivateStateFileSnapshotSync(input.file.path, cap);
  if (!current) return false;
  const value = input.parse(decode(current.text));
  const saved = readPrivateStateFileSnapshotSync(input.backup.path, cap * 3);
  let backup: Backup | undefined;
  if (saved) {
    const raw = decode(saved.text) as Record<string, unknown>;
    if (!raw || raw.schemaVersion !== 1 || Object.keys(raw).sort().join() !== "afterSha256,beforeSha256,beforeText,rollbackRequested,schemaVersion"
      || typeof raw.beforeText !== "string" || hash(raw.beforeText) !== raw.beforeSha256
      || typeof raw.afterSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.afterSha256) || typeof raw.rollbackRequested !== "boolean") throw new Error("invalid default-label migration backup; state preserved");
    input.parse(decode(raw.beforeText as string)); backup = raw as unknown as Backup;
  }
  if (input.rollback || backup?.rollbackRequested) {
    if (!backup) return false;
    if (hash(current.text) !== backup.afterSha256 && hash(current.text) !== backup.beforeSha256) throw new Error("default labels changed since migration; rollback refused");
    if (!backup.rollbackRequested) {
      backup.rollbackRequested = true;
      writePrivateStateFileSync(input.backup, JSON.stringify(backup) + "\n", { expectedText: saved!.text, assertCurrent: input.assertCurrent });
    }
    if (hash(current.text) === backup.beforeSha256) return false;
    writePrivateStateFileSync(input.file, backup.beforeText, { expectedText: current.text, assertCurrent: input.assertCurrent });
    return true;
  }
  if (backup && hash(current.text) !== backup.beforeSha256) return false;
  if (!input.mark(value)) return false;
  const afterText = JSON.stringify(value) + "\n";
  input.parse(JSON.parse(afterText));
  const next: Backup = { schemaVersion: 1, beforeText: current.text, beforeSha256: hash(current.text), afterSha256: hash(afterText), rollbackRequested: false };
  if (backup && backup.afterSha256 !== next.afterSha256) throw new Error("default-label migration differs from its backup; state preserved");
  if (!backup) writePrivateStateFileSync(input.backup, JSON.stringify(next) + "\n", { expectedMissing: true, assertCurrent: input.assertCurrent });
  writePrivateStateFileSync(input.file, afterText, { expectedText: current.text, assertCurrent: input.assertCurrent });
  return true;
}
