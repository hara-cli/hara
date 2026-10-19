import { createHash, randomUUID } from "node:crypto";
import { isDue, nextRun, validTz } from "../cron/schedule.js";
import { WorkspaceJsonState, plain, text } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceFeatures, WorkspaceSchedule } from "./features.js";

interface ScheduleRun { id: string; scheduleId: string; definitionHash: string; requestId: string; occurredAt: number; runId: string | null;
  state: "running" | "completed" | "blocked" | "unknown"; reason: string | null }
interface State { revision: number; resourceBinding: WorkspaceResourceBinding; enabled: boolean; migratedEnabled: boolean; runs: ScheduleRun[] }
interface Executor { available(agentId: string): boolean; execute(agentId: string, task: string, requestId: string): Promise<{ runId: string; completed: boolean }>;
  executeLegacy?(row: WorkspaceSchedule, requestId: string): Promise<{ runId: string; completed: boolean; unknown?: boolean }> }
/** Durable claim precedes execution. Unknown/crashed claims never auto-replay; no global cron fallback. */
export class WorkspaceScheduler {
  private readonly state: WorkspaceJsonState<State>;
  private ticking = false;
  constructor(storage: WorkspaceResourceStorage, private readonly features: WorkspaceFeatures, private readonly executor: Executor) {
    this.state = new WorkspaceJsonState(storage, "workspace-scheduler-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding()) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || typeof raw.enabled !== "boolean" || typeof raw.migratedEnabled !== "boolean" || !Array.isArray(raw.runs) || raw.runs.length > 256) throw new Error("Invalid scheduler state; no work replayed");
      for (const run of raw.runs) if (!plain(run) || !text(run.id) || !text(run.scheduleId) || !text(run.requestId) || typeof run.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(run.definitionHash)
        || typeof run.occurredAt !== "number" || !Number.isFinite(run.occurredAt) || !["running", "completed", "blocked", "unknown"].includes(String(run.state))
        || !(run.runId === null || text(run.runId)) || !(run.reason === null || typeof run.reason === "string" && /^[a-z_]{1,80}$/.test(run.reason))) throw new Error("Invalid schedule receipt");
      return structuredClone(raw) as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), enabled: true, migratedEnabled: false, runs: [] }));
  }
  configure(enabled: boolean, migratedEnabled: boolean) {
    if (this.ticking || this.state.read().runs.some(row => row.state === "running")) throw new Error("Scheduler has active or outcome-unknown work; inspect before handoff");
    const value = this.state.read(); this.state.update(value.revision, current => ({ ...current, enabled, migratedEnabled }));
  }
  private timing(row: WorkspaceSchedule, runs = this.state.read().runs) {
    const hash = createHash("sha256").update(JSON.stringify([row.schedule, row.definition])).digest("hex");
    const latest = runs.filter(run => run.scheduleId === row.id && run.definitionHash === hash).sort((a, b) => b.occurredAt - a.occurredAt)[0];
    return { hash, job: { schedule: row.schedule, createdAt: typeof row.definition.createdAt === "number" ? row.definition.createdAt : 0,
      ...(typeof row.definition.tz === "string" && validTz(row.definition.tz) ? { tz: row.definition.tz } : {}),
      ...(latest ? { lastRunAt: latest.occurredAt } : typeof row.definition.lastRunAt === "number" ? { lastRunAt: row.definition.lastRunAt } : {}) } };
  }
  list(now = Date.now()) {
    const value = this.state.read(); return { ...value, schedules: this.features.schedules().map(row => ({ id: row.id,
      nextRunAt: row.enabled ? nextRun(this.timing(row, value.runs).job, now, { deadlineMs: Date.now() + 15 }) : null,
      awaitingHandoff: row.source !== "workspace" && !value.migratedEnabled,
      lastRun: value.runs.filter(run => run.scheduleId === row.id).at(-1) ?? null })) };
  }
  async tick(mainAgentId: string, now = Date.now(), manualId?: string): Promise<void> {
    if (this.ticking) return; this.ticking = true;
    try {
      const before = this.state.read(); if (!before.enabled) return;
      for (const row of this.features.schedules()) {
        const state = this.state.read(), timing = this.timing(row, state.runs);
        if (manualId ? row.id !== manualId : !row.enabled || !isDue(timing.job, now)) continue;
        if (row.source !== "workspace" && !state.migratedEnabled) continue;
        if (row.source !== "workspace" && !row.enabled) continue;
        if (state.runs.some(run => run.scheduleId === row.id && ["running", "unknown"].includes(run.state))) continue;
        if (state.runs.filter(run => ["running", "unknown"].includes(run.state)).length >= 128) return;
        // Legacy shell/org/external delivery has not been silently converted into Pi authority.
        const legacy = row.source !== "workspace", hasLegacyExecutor = legacy && Boolean(this.executor.executeLegacy);
        const unsupported = !hasLegacyExecutor && (row.definition.mode !== undefined && row.definition.mode !== "print" || Boolean(row.definition.deliver));
        const agentId = typeof row.definition.agentId === "string" ? row.definition.agentId : mainAgentId;
        if (!this.executor.available(agentId)) continue;
        const task = row.definition.task;
        const run: ScheduleRun = { id: randomUUID(), scheduleId: row.id, definitionHash: timing.hash, requestId: randomUUID(), occurredAt: now, runId: null,
          state: unsupported || !(hasLegacyExecutor ? typeof task === "string" && task.length > 0 && task.length <= 128000 : text(task, 8000)) ? "blocked" : "running",
          reason: unsupported ? "legacy_execution_review_required" : !task ? "missing_task" : null };
        this.state.update(state.revision, value => ({ ...value, runs: [...value.runs.filter(item => ["running", "unknown"].includes(item.state)),
          ...value.runs.filter(item => !["running", "unknown"].includes(item.state)).slice(-126), run] }));
        if (run.state !== "running") continue;
        try {
          const result = hasLegacyExecutor ? await this.executor.executeLegacy!(row, run.requestId) : await this.executor.execute(agentId, task as string, run.requestId);
          const unknown = "unknown" in result && result.unknown === true;
          this.finish(run.id, unknown ? "unknown" : result.completed ? "completed" : "blocked", result.runId, unknown ? "execution_outcome_unconfirmed" : result.completed ? null : "task_not_completed");
        } catch { this.finish(run.id, "unknown", null, "execution_outcome_unconfirmed"); }
      }
    } finally { this.ticking = false; }
  }
  private finish(id: string, state: ScheduleRun["state"], runId: string | null, reason: string | null) {
    const current = this.state.read(); this.state.update(current.revision, value => ({ ...value, runs: value.runs.map(row => row.id === id ? { ...row, state, runId, reason } : row) }));
  }
}
