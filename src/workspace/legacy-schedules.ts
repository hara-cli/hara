import { createHash } from "node:crypto";
import { isWorkspaceId } from "./registry.js";
import { isWorkspaceAgentId } from "./agent-binding.js";
import { validWorkspaceSchedule, type WorkspaceFeatures, type WorkspaceSchedule } from "./features.js";
import { canonical, plain } from "./local-state.js";
import type { LegacyTaskPlan } from "./legacy-plan.js";
import type { WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceLegacyResources } from "./legacy-resources.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";
import { redactSensitiveText } from "../security/secrets.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Stage the reviewed mixed-mode source into the EXISTING feature/scheduler store. Source hashes,
 * clocks and enabled flags are retained; one unsafe row is metadata-only/quarantined, not discarded.
 * Nothing here enables migrated execution or calls a shell, Provider or delivery transport. */
export function legacyScheduleRows(input: { jobs: unknown; plan: readonly LegacyTaskPlan[]; sourceFingerprint: string; workspaceId: string;
  mainAgentId: string; resources: WorkspaceLegacyResources; knownCredentials?: readonly string[] }): WorkspaceSchedule[] {
  const rows = Array.isArray(input.jobs) ? input.jobs : plain(input.jobs) ? input.jobs.jobs : null;
  if (!Array.isArray(rows) || rows.length !== input.plan.length || rows.length > 4096 || !isWorkspaceId(input.workspaceId) || !isWorkspaceAgentId(input.mainAgentId)
    || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint) || new Set(input.plan.map(row => row.id)).size !== rows.length) throw new Error("Invalid reviewed legacy schedule source");
  return rows.map(row => {
    if (!plain(row) || typeof row.id !== "string") throw new Error("Invalid legacy task identity");
    const review = input.plan.find(item => item.id === row.id);
    if (!review || hash(canonical(row)) !== review.definitionHash || !validWorkspaceSchedule(row.schedule) || typeof row.cwd !== "string"
      || !Number.isFinite(row.createdAt) || typeof row.task !== "string" || !["print", "command", "org"].includes(String(row.mode))
      || typeof row.enabled !== "boolean" || review.originalEnabled !== row.enabled || review.importEnabled !== (row.enabled && !review.expiredOnce)
      || review.timezone !== (row.tz === undefined || row.tz === "" ? "Asia/Shanghai" : row.tz)
      || review.expiredOnce && row.schedule.kind !== "once") throw new Error("Legacy task source changed since dry-run");
    const resourceId = "lr_" + hash(row.cwd), resource = input.resources.sourceForHost(resourceId);
    if (!resource.purposes.includes("schedule-cwd") || resource.originalPath !== row.cwd) throw new Error("Legacy task cwd mapping changed");
    let quarantined = review.definitionValidation !== "pass";
    if (row.deliver !== undefined && (typeof row.deliver !== "string" || row.deliver.length > 4096 || redactSensitiveText(row.deliver).redactions.length
      || input.knownCredentials?.some(value => value.length >= 4 && String(row.deliver).includes(value)))) quarantined = true;
    if (row.deliverMode !== undefined && !["always", "on-output", "on-error"].includes(String(row.deliverMode))) quarantined = true;
    if (!quarantined && (redactSensitiveText(row.task).redactions.length || input.knownCredentials?.some(value => value.length >= 4 && row.task!.toString().includes(value)))) throw new Error("Task credential guard disagrees with dry-run; source preserved");
    const definition: Record<string, unknown> = { mode: row.mode, task: quarantined ? "" : row.task, cwd: row.cwd, tz: review.timezone,
      agentId: input.mainAgentId, createdAt: row.createdAt, legacy: { sourceHash: review.definitionHash, resourceId, originalEnabled: review.originalEnabled,
        quarantined, reason: quarantined ? "source_review_required" : "execution_adapter_and_handoff_pending", oldStatus: ["ok", "error", "running"].includes(String(row.lastStatus)) ? row.lastStatus : null } };
    // Keep the scheduler's original occurrence/error generations, not arbitrary old stderr/body fields.
    for (const key of ["lastRunAt", "scheduleRevision", "lastRunScheduleRevision", "scheduleUpdatedAt", "definitionRevision", "alertAfter", "consecutiveErrors", "lastAlertAt"]) {
      if (row[key] === undefined) continue;
      if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw new Error("Legacy schedule counters require review");
      definition[key] = row[key];
    }
    if (!quarantined && typeof row.deliver === "string") definition.deliver = row.deliver;
    if (!quarantined && row.deliverMode !== undefined) definition.deliverMode = row.deliverMode;
    return { id: row.id, name: review.name, schedule: structuredClone(row.schedule), enabled: review.importEnabled && !quarantined, workspaceId: input.workspaceId,
      migrationId: hash("hara-legacy-schedule-v1\0" + input.sourceFingerprint + "\0" + row.id), source: "legacy-v1", definition };
  });
}
export function legacySchedulesDomain(storage: WorkspaceResourceStorage, features: WorkspaceFeatures, sourceFingerprint: string, rows: readonly WorkspaceSchedule[]) {
  return new LegacyOwnerFileDomain(storage, "schedules", sourceFingerprint, [".hara/workspace-features-v1.json"], rows.length, () => {
    features.importLegacy([...rows]);
  });
}
