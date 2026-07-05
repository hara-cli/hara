// Persistent job store for `hara cron` — atomic JSON at ~/.hara/cron/jobs.json (temp + rename, like
// openclaw/hermes). Each job runs a fresh `hara` session when due; per-job run logs live alongside.
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import type { Schedule } from "./schedule.js";

export interface CronJob {
  id: string;
  name: string;
  schedule: Schedule;
  task: string; // the prompt / task / shell command to run (per `mode`)
  /** `print` = `hara -p <task>` · `org` = `hara org <task>` · `command` = run <task> as a SHELL
   *  COMMAND, deterministically — no agent, no tokens (hermes-style script lane). */
  mode: "print" | "org" | "command";
  cwd: string; // working directory the job runs in
  /** IANA timezone for cron-expr matching (e.g. "Asia/Shanghai"). Absent = local time. */
  tz?: string;
  /** Push each run's outcome to a channel: telegram:<chatId> | feishu:<chatId> | webhook:<url>. */
  deliver?: string;
  /** Consecutive failures before a 🚨 alert fires on the deliver channel (default 3). */
  alertAfter?: number;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  /** Consecutive error count (reset on success) — drives the failure alert. */
  consecutiveErrors?: number;
  /** Last 🚨 alert timestamp — cooldown gate so a flapping job doesn't spam. */
  lastAlertAt?: number;
}

export function cronDir(): string {
  return join(homedir(), ".hara", "cron");
}
export function jobsPath(): string {
  return join(cronDir(), "jobs.json");
}
export function logPath(id: string): string {
  return join(cronDir(), "logs", `${id}.log`);
}

export function loadJobs(): CronJob[] {
  const p = jobsPath();
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j) ? (j as CronJob[]) : [];
  } catch {
    return [];
  }
}

/** Persist the job list with an atomic temp-write + rename (never leaves a half-written jobs.json). */
export function saveJobs(jobs: CronJob[]): void {
  mkdirSync(cronDir(), { recursive: true });
  const p = jobsPath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(jobs, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

export function addJob(j: Omit<CronJob, "id" | "createdAt" | "enabled"> & { enabled?: boolean; createdAt: number }): CronJob {
  const jobs = loadJobs();
  const job: CronJob = { id: randomUUID().slice(0, 8), enabled: j.enabled ?? true, ...j };
  jobs.push(job);
  saveJobs(jobs);
  return job;
}

/** Resolve an id or unique id-prefix to a single job. Exact id wins; otherwise the prefix must match
 *  EXACTLY one job — an ambiguous prefix returns "ambiguous" (never silently picks one, since callers
 *  delete/toggle). `undefined` = no match. */
export function resolveJob(idOrPrefix: string): CronJob | "ambiguous" | undefined {
  const jobs = loadJobs();
  const exact = jobs.find((x) => x.id === idOrPrefix);
  if (exact) return exact;
  const pre = jobs.filter((x) => x.id.startsWith(idOrPrefix));
  return pre.length === 1 ? pre[0] : pre.length > 1 ? "ambiguous" : undefined;
}

/** Find a job by id/unique-prefix (back-compat; ambiguous → undefined). */
export function findJob(idOrPrefix: string): CronJob | undefined {
  const r = resolveJob(idOrPrefix);
  return r === "ambiguous" ? undefined : r;
}

/** Delete a job by EXACT id (callers resolve the prefix first via resolveJob). */
export function removeJob(id: string): boolean {
  const jobs = loadJobs();
  if (!jobs.some((x) => x.id === id)) return false;
  saveJobs(jobs.filter((x) => x.id !== id));
  return true;
}

/** Enable/disable a job by EXACT id. */
export function setEnabled(id: string, on: boolean): boolean {
  const jobs = loadJobs();
  const job = jobs.find((x) => x.id === id);
  if (!job) return false;
  job.enabled = on;
  saveJobs(jobs);
  return true;
}

/** Record a run's outcome (and stamp lastRunAt) for the given job. */
export function recordRun(id: string, at: number, status: "ok" | "error", error?: string): void {
  const jobs = loadJobs();
  const job = jobs.find((x) => x.id === id);
  if (!job) return;
  job.lastRunAt = at;
  job.lastStatus = status;
  job.lastError = error;
  job.consecutiveErrors = status === "error" ? (job.consecutiveErrors ?? 0) + 1 : 0;
  saveJobs(jobs);
}

/** Stamp the failure-alert time (cooldown gate). */
export function recordAlert(id: string, at: number): void {
  const jobs = loadJobs();
  const job = jobs.find((x) => x.id === id);
  if (!job) return;
  job.lastAlertAt = at;
  saveJobs(jobs);
}
