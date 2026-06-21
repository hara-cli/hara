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
  task: string; // the prompt / task to run
  mode: "print" | "org"; // `hara -p <task>` vs `hara org <task>`
  cwd: string; // working directory the job runs in
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
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

/** Find a job by id or unique id-prefix (so users can type the short form). */
export function findJob(idOrPrefix: string): CronJob | undefined {
  const jobs = loadJobs();
  return jobs.find((x) => x.id === idOrPrefix) ?? jobs.filter((x) => x.id.startsWith(idOrPrefix)).at(0);
}

export function removeJob(idOrPrefix: string): boolean {
  const jobs = loadJobs();
  const job = jobs.find((x) => x.id === idOrPrefix) ?? jobs.find((x) => x.id.startsWith(idOrPrefix));
  if (!job) return false;
  saveJobs(jobs.filter((x) => x.id !== job.id));
  return true;
}

export function setEnabled(idOrPrefix: string, on: boolean): boolean {
  const jobs = loadJobs();
  const job = jobs.find((x) => x.id === idOrPrefix) ?? jobs.find((x) => x.id.startsWith(idOrPrefix));
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
  saveJobs(jobs);
}
