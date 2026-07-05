// The tick runner for `hara cron`: find due jobs and run each as a fresh `hara` session (the fired
// session IS the agent — same model as openclaw/hermes). Meant to be invoked every minute by the OS
// scheduler (see install.ts). A lock file prevents overlapping ticks from double-firing a slow job.
import { spawn } from "node:child_process";
import { deliverResult } from "./deliver.js";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadJobs, recordRun, recordAlert, findJob, cronDir, logPath, type CronJob } from "./store.js";
import { isDue } from "./schedule.js";

/** Jobs that are enabled AND due at `nowMs` (pure — for the tick and for testing). */
export function dueJobs(jobs: CronJob[], nowMs: number): CronJob[] {
  return jobs.filter((j) => j.enabled && isDue(j, nowMs));
}

/** How to invoke hara again. Under node, argv[1] is the entry to hand back to node — either `dist/index.js`
 *  OR the installed `hara` bin symlink (node runs both); as a compiled single-binary, execPath itself IS hara
 *  (argv[1] is a user arg), so re-invoke the binary directly. Used by the cron tick + the chat gateway.
 *  Discriminator is whether execPath is node — NOT argv[1]'s extension (the bin symlink has no `.js`). */
export function selfArgv(): string[] {
  const exec = process.execPath;
  const underNode = /(^|[\\/])node(\.exe)?$/i.test(exec);
  return underNode && process.argv[1] ? [exec, process.argv[1]] : [exec];
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
export function runJobOnce(job: CronJob): Promise<{ ok: boolean; error?: string; output?: string }> {
  return new Promise((resolve) => {
    mkdirSync(join(cronDir(), "logs"), { recursive: true });
    const log = logPath(job.id);
    capLog(log);
    try {
      appendFileSync(log, `\n===== ${new Date().toISOString()} · ${job.name} (${job.mode}) =====\n`);
    } catch {
      /* logging is best-effort */
    }
    // mode "command" = the deterministic lane (hermes-style): run the task as a plain shell command —
    // no agent, no tokens, exact. The other modes spawn a fresh hara session. Either way HARA_CRON=1
    // marks the child so cron-run sessions can't create more cron jobs (recursion guard).
    const self = selfArgv();
    const [cmd, argv] =
      job.mode === "command"
        ? ["bash", ["-lc", job.task]]
        : [self[0], [...self.slice(1), ...(job.mode === "org" ? ["org", job.task] : ["-p", job.task, "--approval", "full-auto"])]];
    const child = spawn(cmd, argv as string[], { cwd: job.cwd, env: { ...process.env, HARA_CRON: "1" } });
    let tail = ""; // last few KB, for chat delivery (the full stream goes to the log file)
    const append = (d: Buffer): void => {
      tail = (tail + d.toString()).slice(-4_000);
      try {
        appendFileSync(log, d);
      } catch {
        /* ignore */
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => resolve({ ok: false, error: String(e?.message ?? e), output: tail }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true, output: tail } : { ok: false, error: `exited ${code}`, output: tail }));
  });
}

/** After a run: push the outcome to the job's deliver channel, and — on repeated failures — a 🚨 alert
 *  (threshold `alertAfter` (default 3), 6h cooldown). Best-effort: a delivery error only hits the log.
 *  `deliver` + `nowMs` injectable for tests. */
export async function deliverOutcome(
  job: CronJob,
  r: { ok: boolean; error?: string; output?: string },
  deliver: (spec: string, text: string) => Promise<string | null> = deliverResult,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!job.deliver) return;
  const snippet = (r.output ?? "").trim().slice(-1_500);
  const head = r.ok ? `⏰ ${job.name} ✓` : `⏰ ${job.name} ✗ ${r.error ?? "failed"}`;
  const err = await deliver(job.deliver, snippet ? `${head}\n${snippet}` : head);
  if (err) {
    try {
      appendFileSync(logPath(job.id), `\n[deliver] ${err}\n`);
    } catch {
      /* best-effort */
    }
  }
  if (!r.ok) {
    const fresh = findJob(job.id); // recordRun already bumped consecutiveErrors
    const count = fresh?.consecutiveErrors ?? 0;
    const threshold = job.alertAfter ?? 3;
    const cooled = !fresh?.lastAlertAt || nowMs - fresh.lastAlertAt > 6 * 3_600_000;
    if (count >= threshold && cooled) {
      await deliver(job.deliver, `🚨 ${job.name} has failed ${count}× in a row — latest: ${r.error ?? "unknown"}. Log: ${logPath(job.id)}`);
      recordAlert(job.id, nowMs);
    }
  }
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
      await deliverOutcome(job, r);
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
