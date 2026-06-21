// The tick runner for `hara cron`: find due jobs and run each as a fresh `hara` session (the fired
// session IS the agent — same model as openclaw/hermes). Meant to be invoked every minute by the OS
// scheduler (see install.ts). A lock file prevents overlapping ticks from double-firing a slow job.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, appendFileSync, readFileSync } from "node:fs";
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
// Generous: a live-PID owner is respected this long (so a genuinely long job isn't double-fired); past it
// we assume PID reuse and take over. A *dead* owner is taken over within one tick regardless (see below).
const LOCK_STALE_MS = 6 * 60 * 60_000;

/** Keep a per-job log from growing forever: once over ~1MB, retain only the last ~256KB. */
function capLog(log: string): void {
  try {
    if (existsSync(log) && statSync(log).size > 1_000_000) {
      writeFileSync(log, "…[older log truncated]\n" + readFileSync(log, "utf8").slice(-256_000));
    }
  } catch {
    /* best-effort */
  }
}

/** Run one job's task in a fresh hara process (full-auto, no prompts), appending output to its log.
 *  Exported so `hara cron run <id>` can fire a job on demand, ignoring its schedule. */
export function runJobOnce(job: CronJob): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    mkdirSync(join(cronDir(), "logs"), { recursive: true });
    const args = job.mode === "org" ? ["org", job.task] : ["-p", job.task, "--approval", "full-auto"];
    const log = logPath(job.id);
    capLog(log);
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
    let held = false;
    try {
      const fresh = nowMs - statSync(lock).mtimeMs < LOCK_STALE_MS;
      const pid = Number(readFileSync(lock, "utf8").trim());
      let alive = false;
      try {
        alive = pid > 0 && (process.kill(pid, 0), true); // signal 0 = liveness probe
      } catch {
        alive = false; // ESRCH → the tick that wrote this lock is gone
      }
      held = fresh && alive; // respect a lock only if it's recent AND owned by a live process (no crash-poison)
    } catch {
      held = false; // unreadable lock → proceed
    }
    if (held) return { ran: [], skipped: "another tick is in progress" };
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
