// The tick runner for `hara cron`: find due jobs and run each as a fresh `hara` session (the fired
// session IS the agent — same model as openclaw/hermes). Meant to be invoked every minute by the OS
// scheduler (see install.ts). A lock file prevents overlapping ticks from double-firing a slow job.
import { spawn } from "node:child_process";
import { deliverResult } from "./deliver.js";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { join } from "node:path";
import { loadJobs, recordRun, recordAlert, findJob, cronDir, logPath, type CronJob } from "./store.js";
import { isDue } from "./schedule.js";
import { shellCommand } from "../sandbox.js";
import { sensitiveShellCommandReason } from "../security/sensitive-files.js";
import { createToolOutputLineRedactor, redactToolSubprocessOutput, terminateSubprocessTree, toolSubprocessEnv } from "../security/subprocess-env.js";

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
const takeoverPath = (): string => join(cronDir(), ".tick.lock.takeover");
// Generous: a live-PID owner is respected this long (so a genuinely long job isn't double-fired); past it
// we assume PID reuse and take over. A *dead* owner is taken over within one tick regardless (see below).
const LOCK_STALE_MS = 6 * 60 * 60_000;
// A takeover/release guard protects only synchronous filesystem operations and should live for milliseconds.
// Five minutes tolerates long host pauses while still recovering a guard left by a crash or PID reuse.
const TAKEOVER_GUARD_STALE_MS = 5 * 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RUN_LOG_BYTES = 1_000_000;
const TERMINATE_GRACE_MS = 2_000;

interface TickLockFileSnapshot {
  /** null means a stable but oversized record; it remains malformed without being materialized. */
  raw: string | null;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface TickLockSnapshot extends TickLockFileSnapshot {
  raw: string;
  pid: number;
}

const MAX_LOCK_RECORD_BYTES = 512;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but is not signalable. Only ESRCH proves that an owner is gone.
    return error?.code !== "ESRCH";
  }
}

function readTickLockFileSnapshot(path: string): TickLockFileSnapshot | null {
  try {
    const before = lstatSync(path);
    if (!before.isFile()) return null;
    const raw = before.size <= MAX_LOCK_RECORD_BYTES ? readFileSync(path, "utf8").trim() : null;
    const after = lstatSync(path);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) return null;
    return { raw, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } catch {
    return null;
  }
}

function parseTickLockSnapshot(file: TickLockFileSnapshot | null): TickLockSnapshot | null {
  if (!file?.raw) return null;
  const match = /^(\d+):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(file.raw);
  const pid = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { ...file, raw: file.raw, pid };
}

function readTickLockSnapshot(path: string): TickLockSnapshot | null {
  return parseTickLockSnapshot(readTickLockFileSnapshot(path));
}

function sameTickLockFile(left: TickLockFileSnapshot, right: TickLockFileSnapshot | null): boolean {
  return !!right
    && left.raw === right.raw
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameTickLock(left: TickLockSnapshot, right: TickLockSnapshot | null): boolean {
  return sameTickLockFile(left, right) && left.pid === right?.pid;
}

function staleTickLock(snapshot: TickLockSnapshot, nowMs: number): boolean {
  return nowMs - snapshot.mtimeMs >= LOCK_STALE_MS || !processIsAlive(snapshot.pid);
}

type TakeoverGuardState = "clear" | "active" | "recovered";

/** Recover only a complete, stable guard whose owner is proven dead or whose tiny synchronous lease is
 * far past its lifetime. Recovery deliberately ends this tick: a later invocation acquires a fresh guard,
 * keeping stale-guard deletion and new-guard creation out of the same contender's race window. */
function prepareTakeoverGuard(path: string, nowMs: number): TakeoverGuardState {
  if (!existsSync(path)) return "clear";
  const observedFile = readTickLockFileSnapshot(path);
  if (!observedFile) return "active"; // unreadable/non-regular/unstable is not evidence that deletion is safe
  const observed = parseTickLockSnapshot(observedFile);
  const staleRecord = (snapshot: TickLockSnapshot): boolean =>
    nowMs - snapshot.mtimeMs >= TAKEOVER_GUARD_STALE_MS || !processIsAlive(snapshot.pid);
  const staleMalformed = (snapshot: TickLockFileSnapshot): boolean =>
    nowMs - snapshot.mtimeMs >= TAKEOVER_GUARD_STALE_MS;
  if (observed ? !staleRecord(observed) : !staleMalformed(observedFile)) return "active";

  const currentFile = readTickLockFileSnapshot(path);
  if (!sameTickLockFile(observedFile, currentFile) || !currentFile) return "active";
  const current = parseTickLockSnapshot(currentFile);
  if (observed) {
    if (!sameTickLock(observed, current) || !current || !staleRecord(current)) return "active";
  } else if (current || !staleMalformed(currentFile)) {
    return "active";
  }
  try {
    rmSync(path);
    return "recovered";
  } catch {
    return "active";
  }
}

function writeExclusive(path: string, token: string): boolean {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(fd, token, { encoding: "utf8" });
    fsyncSync(fd);
    return true;
  } catch (error: any) {
    if (!created && error?.code === "EEXIST") return false;
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original write error */ }
      fd = undefined;
    }
    if (created) try { rmSync(path); } catch { /* the incomplete record will fail closed */ }
    throw error;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function removeOwnedLock(path: string, token: string): void {
  try { if (readTickLockSnapshot(path)?.raw === token) rmSync(path); } catch { /* best effort */ }
}

/** Release the primary lock under the same guard used for stale takeover. Without this, a >6h owner could
 * read its token, get descheduled while a reaper installs a successor, then unlink that successor by name. */
function releasePrimaryTickLock(lock: string, takeover: string, token: string): void {
  const releaseToken = `${process.pid}:${randomUUID()}`;
  if (!writeExclusive(takeover, releaseToken)) return; // an active reaper owns the transition
  try {
    const current = readTickLockSnapshot(lock);
    if (current?.raw === token) rmSync(lock);
  } catch {
    /* best effort; leaving an uncertain lock is safer than deleting it */
  } finally {
    removeOwnedLock(takeover, releaseToken);
  }
}

export interface CronRunOptions {
  timeoutMs?: number;
  maxLogBytes?: number;
}

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
export function runJobOnce(job: CronJob, options: CronRunOptions = {}): Promise<{ ok: boolean; error?: string; output?: string }> {
  return new Promise((resolve) => {
    const timeoutMs = Math.min(Math.max(100, options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS), 24 * 60 * 60_000);
    const maxLogBytes = Math.min(Math.max(4_096, options.maxLogBytes ?? DEFAULT_RUN_LOG_BYTES), 16 * 1024 * 1024);
    mkdirSync(join(cronDir(), "logs"), { recursive: true, mode: 0o700 });
    try { chmodSync(cronDir(), 0o700); chmodSync(join(cronDir(), "logs"), 0o700); } catch { /* best effort */ }
    const log = logPath(job.id);
    capLog(log);
    try {
      const safeName = redactToolSubprocessOutput(String(job.name).replace(/[\r\n\0]/g, " ").slice(0, 256));
      appendFileSync(log, `\n===== ${new Date().toISOString()} · ${safeName} (${job.mode}) =====\n`, { mode: 0o600 });
      chmodSync(log, 0o600);
    } catch {
      /* logging is best-effort */
    }
    // mode "command" = the deterministic lane (hermes-style): run the task as a plain shell command —
    // no agent, no tokens, exact. The other modes spawn a fresh hara session. Either way HARA_CRON=1
    // marks the child so cron-run sessions can't create more cron jobs (recursion guard).
    const self = selfArgv();
    if (job.mode === "command") {
      const denied = sensitiveShellCommandReason(job.task, job.cwd);
      if (denied) {
        const error = `blocked by protected secret boundary (${denied})`;
        try { appendFileSync(log, `[blocked] ${error}\n`); } catch { /* best effort */ }
        resolve({ ok: false, error, output: "" });
        return;
      }
    }
    let shell: ReturnType<typeof shellCommand> | null;
    try {
      shell = job.mode === "command" ? shellCommand(job.task, job.cwd, "off") : null;
    } catch (error) {
      const message = `failed security preflight: ${error instanceof Error ? error.message : String(error)}`;
      try { appendFileSync(log, `[blocked] ${message}\n`, { mode: 0o600 }); } catch { /* best effort */ }
      resolve({ ok: false, error: message, output: "" });
      return;
    }
    const [cmd, argv] = shell
      ? [shell.cmd, shell.args]
      : [self[0], [...self.slice(1), ...(job.mode === "org" ? ["org", job.task] : ["-p", job.task, "--approval", "full-auto"])]];
    // HARA_CRON_NAME rides along so the child session's meta gets a human title ("job name · time")
    // instead of the raw prompt (session store's automated-title strategy).
    const env = job.mode === "command"
      ? toolSubprocessEnv(process.env, { HARA_CRON: "1" })
      : { ...process.env, HARA_CRON: "1", HARA_CRON_NAME: job.name };
    const processGroup = platform() !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, argv as string[], { cwd: job.cwd, env, detached: processGroup });
    } catch (error) {
      resolve({ ok: false, error: `failed to start: ${error instanceof Error ? error.message : String(error)}`, output: "" });
      return;
    }
    let tail = ""; // last few KB, for chat delivery (the full stream goes to the log file)
    let logBytes = (() => { try { return statSync(log).size; } catch { return 0; } })();
    let logCapped = false;
    let done = false;
    let timedOut = false;
    let forceIssued = false;
    let closeBeforeForce = false;
    let cancelTermination: ((cancelForce?: boolean) => void) | undefined;
    const appendSafe = (safe: string): void => {
      tail = (tail + safe).slice(-4_000);
      if (logCapped) return;
      try {
        const bytes = Buffer.byteLength(safe);
        if (logBytes + bytes <= maxLogBytes) {
          appendFileSync(log, safe, { mode: 0o600 });
          logBytes += bytes;
        } else {
          const marker = `\n…[run log capped at ${maxLogBytes} bytes]…\n`;
          appendFileSync(log, marker, { mode: 0o600 });
          logBytes += Buffer.byteLength(marker);
          logCapped = true;
        }
      } catch {
        /* ignore */
      }
    };
    // stdout and stderr are separate byte streams; sharing a line buffer can splice unrelated chunks and
    // either corrupt output or create an unsafe synthetic token. Keep an independent redactor per stream.
    const stdout = createToolOutputLineRedactor(appendSafe);
    const stderr = createToolOutputLineRedactor(appendSafe);
    const flush = (): void => { stdout.flush(); stderr.flush(); };
    const settle = (result: { ok: boolean; error?: string; output?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      // Keep a timeout-triggered group KILL scheduled even if the direct child closed on TERM. The default
      // cancellation removes only the hard-settle fallback; it deliberately does not cancel escalation.
      cancelTermination?.();
      flush();
      capLog(log);
      resolve({
        ...result,
        error: result.error ? redactToolSubprocessOutput(result.error) : undefined,
        output: tail,
      });
    };
    const timeoutTimer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      cancelTermination = terminateSubprocessTree(child, {
        processGroup,
        graceMs: TERMINATE_GRACE_MS,
        fallbackMs: 3_000,
        onForce: () => {
          forceIssued = true;
          if (closeBeforeForce) settle({ ok: false, error: `timed out after ${timeoutMs}ms`, output: tail });
        },
        onFallback: () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({ ok: false, error: `timed out after ${timeoutMs}ms`, output: tail });
        },
      });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { if (!done && !timedOut) stdout.push(d.toString()); });
    child.stderr?.on("data", (d: Buffer) => { if (!done && !timedOut) stderr.push(d.toString()); });
    child.on("error", (e) => {
      if (timedOut && !forceIssued) {
        closeBeforeForce = true;
        return;
      }
      settle(timedOut
        ? { ok: false, error: `timed out after ${timeoutMs}ms`, output: tail }
        : { ok: false, error: String(e?.message ?? e), output: tail });
    });
    child.on("close", (code) => {
      if (timedOut && !forceIssued) {
        closeBeforeForce = true;
        return;
      }
      if (timedOut) settle({ ok: false, error: `timed out after ${timeoutMs}ms`, output: tail });
      else settle(code === 0 ? { ok: true, output: tail } : { ok: false, error: `exited ${code}`, output: tail });
    });
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
  mkdirSync(cronDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(cronDir(), 0o700); } catch { /* best effort */ }
  const lock = lockPath();
  const token = `${process.pid}:${randomUUID()}`;
  const takeover = takeoverPath();
  let acquired = false;

  const guardState = prepareTakeoverGuard(takeover, nowMs);
  if (guardState === "recovered") return { ran: [], skipped: "cleared a stale tick takeover guard; retry on the next tick" };
  if (guardState === "active") return { ran: [], skipped: "another tick is taking over a stale lock" };

  // Every ordinary contender checks the takeover guard both before and after O_EXCL creation. The second
  // check covers a contender that was descheduled between its first check and open(2).
  if (!existsSync(takeover) && writeExclusive(lock, token)) {
    if (!existsSync(takeover)) acquired = true;
    else removeOwnedLock(lock, token);
  } else if (!existsSync(lock)) {
    // A lock owner may have released between our failed preflight and O_EXCL attempt. Missing a single
    // minute is safer than guessing through an active takeover; the next scheduler tick retries.
    return { ran: [], skipped: "another tick is acquiring the lock" };
  } else {
    const observedFile = readTickLockFileSnapshot(lock);
    if (!observedFile) return { ran: [], skipped: "another tick is in progress" };
    const observed = parseTickLockSnapshot(observedFile);
    const malformedStale = (snapshot: TickLockFileSnapshot): boolean => nowMs - snapshot.mtimeMs >= LOCK_STALE_MS;
    if (observed ? !staleTickLock(observed, nowMs) : !malformedStale(observedFile)) {
      return { ran: [], skipped: "another tick is in progress" };
    }

    const takeoverToken = `${process.pid}:${randomUUID()}`;
    if (!writeExclusive(takeover, takeoverToken)) return { ran: [], skipped: "another tick is taking over a stale lock" };
    try {
      // Re-read under the exclusive guard and require the exact content/inode/size/mtime/ctime diagnosed.
      // A fresh malformed record stays fail-closed; only an unchanged record past the 6h poison window is
      // removable. Never unlink a successor merely because it occupies the same pathname.
      const currentFile = readTickLockFileSnapshot(lock);
      if (currentFile) {
        if (!sameTickLockFile(observedFile, currentFile)) {
          return { ran: [], skipped: "the tick lock changed during stale takeover" };
        }
        const current = parseTickLockSnapshot(currentFile);
        if (observed) {
          if (!sameTickLock(observed, current) || !current || !staleTickLock(current, nowMs)) {
            return { ran: [], skipped: "the tick lock changed during stale takeover" };
          }
        } else if (current || !malformedStale(currentFile)) {
          return { ran: [], skipped: "the tick lock changed during stale takeover" };
        }
        rmSync(lock);
      }
      acquired = writeExclusive(lock, token);
    } finally {
      removeOwnedLock(takeover, takeoverToken);
    }
  }
  if (!acquired) return { ran: [], skipped: "another tick is acquiring the lock" };
  try { chmodSync(lock, 0o600); } catch { /* best effort */ }
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
    // Remove only the lock instance we created; never unlink a successor after a stale-lock takeover.
    releasePrimaryTickLock(lock, takeover, token);
  }
}
