import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, writePrivateStateFileSync } from "../security/private-state.js";
import { planLegacySchedules, type WorkspaceFeatures } from "./features.js";
import type { WorkspaceScheduler } from "./scheduler.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const markerName = "workspace-cutover-v1.json";
/** Old scheduler reads only this fixed, private gate. An invalid existing gate fails closed. */
export function legacySchedulerGate(home = homedir()): "enabled" | "disabled" | "invalid" {
  const path = join(home, ".hara/cron", markerName); if (!existsSync(path)) return "enabled";
  try {
    const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync.native(path) !== path
      || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) return "invalid";
    const snapshot = readPrivateStateFileSnapshotSync(path, 16384), raw = JSON.parse(snapshot!.text);
    if (raw.schemaVersion !== 1 || typeof raw.disabled !== "boolean" || typeof raw.personalWorkspaceId !== "string" || !/^[a-f0-9]{64}$/.test(raw.sourceHash)) return "invalid";
    return raw.disabled ? "disabled" : "enabled";
  } catch { return "invalid"; }
}
type Target = { features: WorkspaceFeatures; scheduler: WorkspaceScheduler };
/** Explicit host-owner operation, never called from startup, a model tool, or the migration banner.
 * Stage preserves enabled flags but migrated execution remains gated. Live cutover requires separate
 * approval and an independently stopped/quiescent old OS scheduler, not merely an empty queue. */
export class LegacyScheduleMigration {
  constructor(private readonly home: string, private readonly personalWorkspaceId: string, private readonly targets: Map<string, Target>) {}
  private file(name: string) { return bindPrivateHaraStateFile(this.home, ["cron"], name); }
  private read(name: string) { return readPrivateStateFileSnapshotSync(this.file(name).path, 4 * 1024 * 1024); }
  private write(name: string, value: unknown) {
    const file = this.file(name), current = this.read(name); writePrivateStateFileSync(file, JSON.stringify(value) + "\n", current ? { expectedText: current.text } : { expectedMissing: true });
  }
  preview() {
    const source = this.read("jobs.json"); if (!source) throw new Error("Legacy schedule source unavailable; nothing migrated");
    const plan = planLegacySchedules(JSON.parse(source.text), this.personalWorkspaceId, this.file("jobs.json").path);
    if (plan.state !== "planned" || plan.jobs.some(row => !this.targets.has(row.workspaceId))) throw new Error("Legacy schedule mapping requires review");
    return { sourceHash: digest(source.text), plan, count: plan.jobs.length, enabled: plan.jobs.filter(row => row.enabled).length,
      backup: this.file("workspace-migration-source-v1.json").path, personalWorkspaceId: this.personalWorkspaceId };
  }
  stage(approved: boolean, expectedSourceHash: string) {
    if (!approved) throw new Error("Explicit migration approval required");
    const preview = this.preview(); if (preview.sourceHash !== expectedSourceHash) throw new Error("Legacy schedules changed; re-review required");
    const source = this.read("jobs.json")!, previous = this.read("workspace-migration-receipt-v1.json"), backup = this.read("workspace-migration-source-v1.json");
    if (backup && digest(backup.text) !== preview.sourceHash) throw new Error("Prior migration backup belongs to another source; preserved");
    if (!backup) writePrivateStateFileSync(this.file("workspace-migration-source-v1.json"), source.text, { expectedMissing: true });
    const oldReceipt = previous ? JSON.parse(previous.text) : null;
    if (oldReceipt && (oldReceipt.sourceHash !== preview.sourceHash || oldReceipt.personalWorkspaceId !== this.personalWorkspaceId || oldReceipt.state === "rolled_back")) throw new Error("Prior migration receipt requires review; preserved");
    // Persist intent before any scoped import. A partial failure is explicitly re-runnable.
    const receipt = { schemaVersion: 1, state: "staged", sourceHash: preview.sourceHash, personalWorkspaceId: this.personalWorkspaceId,
      originalSchedulers: [...this.targets].map(([workspaceId, target]) => { const state = target.scheduler.list(); return { workspaceId, enabled: state.enabled, migratedEnabled: state.migratedEnabled }; }),
      jobs: preview.plan.jobs.map(row => ({ workspaceId: row.workspaceId, migrationId: row.migrationId, definitionHash: digest(JSON.stringify(row.definition)) })) };
    if (!oldReceipt) this.write("workspace-migration-receipt-v1.json", receipt);
    let imported = 0; for (const target of this.targets.values()) imported += target.features.importLegacy(preview.plan.jobs);
    return { ...preview, imported };
  }
  cutover(input: { approved: boolean; oldSchedulerStopped: boolean; expectedSourceHash: string }) {
    if (!input.approved || !input.oldSchedulerStopped) throw new Error("Separate old scheduler shutdown confirmation required");
    const preview = this.preview(); if (preview.sourceHash !== input.expectedSourceHash) throw new Error("Legacy source changed before cutover");
    if (preview.plan.jobs.some(row => row.definition.mode !== undefined && row.definition.mode !== "print" || Boolean(row.definition.deliver))) {
      throw new Error("Legacy execution/delivery adapters are not ready; cutover refused, old scheduler remains enabled");
    }
    const receipt = this.read("workspace-migration-receipt-v1.json"); if (!receipt || JSON.parse(receipt.text).sourceHash !== preview.sourceHash) throw new Error("Migration receipt missing");
    // Unknown tick ownership is not zero. Jeff must stop the old OS service before this boundary.
    if (["tick.lock", ".tick.lock", ".jobs.lock"].some(name => existsSync(join(this.home, ".hara/cron", name)))
      || preview.plan.jobs.some(row => row.definition.lastStatus === "running")) throw new Error("Old scheduler still active or ownership unknown");
    for (const row of preview.plan.jobs) if (!this.targets.get(row.workspaceId)!.features.schedules().some(item => item.migrationId === row.migrationId)) throw new Error("Migration incomplete");
    this.write(markerName, { schemaVersion: 1, disabled: true, personalWorkspaceId: this.personalWorkspaceId, sourceHash: preview.sourceHash });
    for (const target of this.targets.values()) target.scheduler.configure(true, true);
    this.write("workspace-migration-receipt-v1.json", { ...JSON.parse(receipt.text), state: "active" });
    return { state: "active", backup: preview.backup };
  }
  rollback(approved: boolean) {
    if (!approved) throw new Error("Explicit rollback approval required");
    const file = this.read("workspace-migration-receipt-v1.json"); if (!file) throw new Error("Migration receipt unavailable");
    const receipt = JSON.parse(file.text); if (receipt.personalWorkspaceId !== this.personalWorkspaceId) throw new Error("Migration target changed");
    for (const target of this.targets.values()) target.scheduler.configure(false, false);
    for (const job of receipt.jobs) {
      const current = this.targets.get(job.workspaceId)?.features.schedules().find(row => row.migrationId === job.migrationId);
      if (current && digest(JSON.stringify(current.definition)) !== job.definitionHash) throw new Error("Migrated task was edited; preserve it for manual reconciliation");
    }
    for (const target of this.targets.values()) target.features.removeMigration(receipt.jobs.map((job: any) => job.migrationId));
    for (const state of receipt.originalSchedulers ?? []) { const target = this.targets.get(state.workspaceId); if (!target) throw new Error("Original scheduler target unavailable"); target.scheduler.configure(state.enabled, state.migratedEnabled); }
    // The source was never rewritten: preserve newer old-run timestamps rather than restoring over it.
    this.write(markerName, { schemaVersion: 1, disabled: false, personalWorkspaceId: this.personalWorkspaceId, sourceHash: receipt.sourceHash });
    this.write("workspace-migration-receipt-v1.json", { ...receipt, state: "rolled_back" });
    return { state: "rolled_back", sourceUnchanged: true, backup: this.file("workspace-migration-source-v1.json").path };
  }
}
