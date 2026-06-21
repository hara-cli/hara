// The tick runner for `hara cron`: find due jobs and run each as a fresh `hara` session (the fired
// session IS the agent — same model as openclaw/hermes). Meant to be invoked every minute by the OS
// scheduler (see install.ts). A lock file prevents overlapping ticks from double-firing a slow job.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadJobs, recordRun, cronDir, logPath, type CronJob } from "./store.js";
import { isDue } from "./schedule.js";

/** Jobs that are enabled AND due at `nowMs` (pure — for the tick and for testing). */
export function dueJobs(jobs: CronJob[], nowMs: number): CronJob[] {
  return jobs.filter((j) => j.enabled && isDue(j, nowMs));
}

/** How to invoke hara again — handles both `node dist/index.js` (argv[1] is a script) and the compiled
 *  single-binary (argv[1] is a user arg, so re-invoke the binary directly). Used by the tick + by install. */
export function selfArgv(): string[] {
  const a1 = process.argv[1];
  return a1 && /\.[cm]?js$|\.ts$/.test(a1) ? [process.execPath, a1] : [process.execPath];
}

const lockPath = (): string => join(cronDir(), ".tick.lock");
const LOCK_STALE_MS = 30 * 60_000;

/** Run one job's task in a fresh hara process (full-auto, no prompts), appending output to its log.
 *  Exported so `hara cron run <id>` can fire a job on demand, ignoring its schedule. */
export function runJobOnce(job: CronJob): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    mkdirSync(join(cronDir(), "logs"), { recursive: true });
    const args = job.mode === "org" ? ["org", job.task] : ["-p", job.task, "--approval", "full-auto"];
    const log = logPath(job.id);
    try {
      appendFileSync(log, `\n===== ${new Date().toISOString()} · ${job.name} (${job.mode}) =====\n`);
    } catch {
      /* logging is best-effort */
    }
    const self = selfArgv();
    const child = spawn(self[0], [...self.slice(1), ...args], { cwd: job.cwd, env: process.env });
    const append = (d: Buffer): void => {
      try {
        appendFileSync(log, d);
      } catch {
        /* ignore */
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `exited ${code}` }));
  });
}

/** One scheduler tick: run every due job (sequentially), recording each outcome. Lock-guarded so an
 *  overlapping tick (launchd fires every 60s; a job may run longer) skips instead of double-firing.
 *  `run` is injectable for tests. Returns the job ids that ran. */
export async function runTick(nowMs: number, run: (job: CronJob) => Promise<{ ok: boolean; error?: string }> = runJobOnce): Promise<{ ran: string[]; skipped?: string }> {
  mkdirSync(cronDir(), { recursive: true });
  const lock = lockPath();
  if (existsSync(lock)) {
    try {
      if (nowMs - statSync(lock).mtimeMs < LOCK_STALE_MS) return { ran: [], skipped: "another tick is in progress" };
    } catch {
      /* stale/unreadable lock → proceed */
    }
  }
  writeFileSync(lock, String(process.pid));
  try {
    const due = dueJobs(loadJobs(), nowMs);
    const ran: string[] = [];
    for (const job of due) {
      const r = await run(job);
      recordRun(job.id, nowMs, r.ok ? "ok" : "error", r.error);
      ran.push(job.id);
    }
    return { ran };
  } finally {
    try {
      rmSync(lock);
    } catch {
      /* best-effort */
    }
  }
}
