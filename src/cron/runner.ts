// The tick runner for `hara cron`: find due jobs and run each as a fresh `hara` session (the fired
// session IS the agent — same model as openclaw/hermes). Meant to be invoked every minute by the OS
// scheduler (see install.ts). A lock file prevents overlapping ticks from double-firing a slow job.
import { spawn } from "node:child_process";
import { deliverResult } from "./deliver.js";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { join } from "node:path";
import {
  loadJobs,
  recordRun,
  recordRunStart,
  recoverInterruptedRuns,
  enqueueOutcomeNotifications,
  listPendingNotifications,
  acknowledgePendingNotification,
  deferPendingNotification,
  findJob,
  cronDir,
  logPath,
  type CronJob,
  type CronDeliveryOutcome,
} from "./store.js";
import { isDue } from "./schedule.js";
import { shellCommand } from "../sandbox.js";
import { sensitiveShellCommandReason } from "../security/sensitive-files.js";
import { createToolOutputLineRedactor, redactToolSubprocessOutput, terminateSubprocessTree, toolSubprocessEnv } from "../security/subprocess-env.js";
import { compareProcessIdentity, defaultProcessIdentity } from "../process-identity.js";

/** Jobs that are enabled AND due at `nowMs` (pure — for the tick and for testing). */
export function dueJobs(jobs: CronJob[], nowMs: number): CronJob[] {
  return jobs.filter((j) => j.enabled && isDue(j, nowMs));
}

/** How to invoke hara again. Under node, argv[1] is the entry to hand back to node — either `dist/index.js`
 *  OR the installed `hara` bin symlink (node runs both); as a compiled single-binary, execPath itself IS hara
 *  (argv[1] is a user arg), so re-invoke the binary directly. Used by the cron tick + the chat gateway.
 *  Node and ordinary Bun scripts retain argv[1] (the bin symlink need not end in `.js`); only Bun's
 *  `/$bunfs/…` compile-time virtual entry is omitted because execPath is already the standalone Hara. */
export function selfArgvFor(exec: string, entry: string | undefined, versions: NodeJS.ProcessVersions): string[] {
  const underNode = /(^|[\\/])node(\.exe)?$/i.test(exec);
  const bunScript = typeof versions.bun === "string" && !!entry && !entry.replace(/\\/g, "/").startsWith("/$bunfs/");
  return entry && (underNode || bunScript) ? [exec, entry] : [exec];
}

export function selfArgv(): string[] {
  return selfArgvFor(process.execPath, process.argv[1], process.versions);
}

export interface SelfInvocation {
  command: string;
  args: string[];
}

/** Add user-facing arguments to the runtime-aware self command. Exported separately so Node and compiled
 *  argv construction can be unit-tested without launching a second CLI. */
export function selfInvocation(args: readonly string[]): SelfInvocation {
  const [command, ...entryArgs] = selfArgv();
  return { command, args: [...entryArgs, ...args] };
}

/** Re-enter Hara as an attached foreground child without blocking this process's event loop. Inheriting all
 *  stdio keeps readline/Ink attached to the real terminal; this is required by `hara resume <id>`. */
export function runSelfAttached(args: readonly string[], cwd = process.cwd()): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const invocation = selfInvocation(args);
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolveRun({ code, signal });
    });
  });
}

const lockPath = (): string => join(cronDir(), ".tick.lock");
const takeoverPath = (): string => join(cronDir(), ".tick.lock.takeover");
// Malformed records have no process identity to verify. Keep a long poison window for the primary and a
// shorter one for the synchronous transition guard; valid live/legacy records are never reclaimed by age.
const MALFORMED_LOCK_POISON_MS = 6 * 60 * 60_000;
const MALFORMED_GUARD_POISON_MS = 5 * 60_000;
export const DEFAULT_CRON_JOB_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_CRON_TICK_TIMEOUT_MS = 60 * 60_000;
export const MAX_CRON_JOB_TIMEOUT_MS = 24 * 60 * 60_000;
// Keep normal scheduler ownership bounded even though a valid live owner is never reclaimed by wall-clock age.
export const MAX_CRON_TICK_TIMEOUT_MS = 5 * 60 * 60_000;
const DEFAULT_RUN_LOG_BYTES = 1_000_000;
const TERMINATE_GRACE_MS = 2_000;
const ABORT_SETTLE_MS = 750;
const FINAL_DELIVERY_TIMEOUT_MS = 5_000;

function configuredTimeoutMs(
  explicit: number | undefined,
  envName: string,
  fallback: number,
  maximum: number,
): number {
  const envValue = process.env[envName]?.trim();
  const candidate = explicit ?? (envValue ? Number(envValue) : fallback);
  return Number.isFinite(candidate)
    ? Math.min(Math.max(100, Math.trunc(candidate)), maximum)
    : fallback;
}

/** Public for diagnostics/tests; scheduler deployments can override with HARA_CRON_JOB_TIMEOUT_MS. */
export function cronJobTimeoutMs(explicit?: number): number {
  return configuredTimeoutMs(explicit, "HARA_CRON_JOB_TIMEOUT_MS", DEFAULT_CRON_JOB_TIMEOUT_MS, MAX_CRON_JOB_TIMEOUT_MS);
}

/** Total scheduler-tick watchdog; configurable in milliseconds and hard-capped to bound normal ownership. */
export function cronTickTimeoutMs(explicit?: number): number {
  return configuredTimeoutMs(explicit, "HARA_CRON_TICK_TIMEOUT_MS", DEFAULT_CRON_TICK_TIMEOUT_MS, MAX_CRON_TICK_TIMEOUT_MS);
}

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
  token: string;
  /** OS process birth identity. Missing means a legacy/unknown owner and therefore fails closed while live. */
  birthIdentity?: string;
}

const MAX_LOCK_RECORD_BYTES = 512;
const TICK_LOCK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURRENT_PROCESS_BIRTH_IDENTITY = defaultProcessIdentity(process.pid);

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
  try {
    const parsed = JSON.parse(file.raw) as Record<string, unknown>;
    if (
      !parsed
      || typeof parsed !== "object"
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) <= 0
      || typeof parsed.token !== "string"
      || !TICK_LOCK_UUID.test(parsed.token)
      || (
        parsed.birthIdentity !== undefined
        && (typeof parsed.birthIdentity !== "string" || !/^[\x20-\x7e]{1,256}$/.test(parsed.birthIdentity))
      )
    ) return null;
    return {
      ...file,
      raw: file.raw,
      pid: parsed.pid as number,
      token: parsed.token,
      ...(typeof parsed.birthIdentity === "string" ? { birthIdentity: parsed.birthIdentity } : {}),
    };
  } catch {
    // Backward compatibility for the unpublished identity-less lock format. A live legacy PID is unknown,
    // never stale evidence; a proven-dead PID remains safe to reclaim.
    const match = /^(\d+):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(file.raw);
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid <= 0) return null;
    return { ...file, raw: file.raw, pid, token: match[2] };
  }
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

/** Only proof may retire a valid owner: dead PID, or same identity scheme with a different birth value.
 * A live same/unknown/legacy owner fails closed even after host sleep or event-loop suspension. */
function reclaimableTickLock(snapshot: TickLockSnapshot): boolean {
  if (!processIsAlive(snapshot.pid)) return true;
  if (!snapshot.birthIdentity) return false;
  const current = snapshot.pid === process.pid
    ? CURRENT_PROCESS_BIRTH_IDENTITY
    : defaultProcessIdentity(snapshot.pid);
  return compareProcessIdentity(snapshot.birthIdentity, current) === "different";
}

function newTickLockToken(): string {
  return JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
    ...(CURRENT_PROCESS_BIRTH_IDENTITY ? { birthIdentity: CURRENT_PROCESS_BIRTH_IDENTITY } : {}),
  });
}

type TakeoverGuardState = "clear" | "active" | "recovered";

/** Recover only a complete, stable guard whose owner is proven dead/reused. Age applies only to malformed
 * poison, never to a valid live/legacy record. Recovery deliberately ends this tick. */
function prepareTakeoverGuard(path: string, nowMs: number): TakeoverGuardState {
  if (!existsSync(path)) return "clear";
  const observedFile = readTickLockFileSnapshot(path);
  if (!observedFile) return "active"; // unreadable/non-regular/unstable is not evidence that deletion is safe
  const observed = parseTickLockSnapshot(observedFile);
  const staleRecord = (snapshot: TickLockSnapshot): boolean => reclaimableTickLock(snapshot);
  const staleMalformed = (snapshot: TickLockFileSnapshot): boolean =>
    nowMs - snapshot.mtimeMs >= MALFORMED_GUARD_POISON_MS;
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

/** Release the primary lock under the same guard used for stale takeover. Without this, a paused owner could
 * read its token, get descheduled while a reaper installs a successor, then unlink that successor by name. */
function releasePrimaryTickLock(lock: string, takeover: string, token: string): void {
  const releaseToken = newTickLockToken();
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
  /** Parent interactive agent deadline/cancellation for manual `cronjob run`. Scheduler ticks omit it. */
  signal?: AbortSignal;
}

export interface CronRunResult {
  ok: boolean;
  error?: string;
  output?: string;
  /** A real job deadline or tick watchdog fired (not merely a non-zero exit). */
  timedOut?: boolean;
  /** The caller cancelled this run before its own timeout. */
  interrupted?: boolean;
}

export interface CronTickOptions {
  /** Per-job deadline; defaults to HARA_CRON_JOB_TIMEOUT_MS or 30 minutes. */
  jobTimeoutMs?: number;
  /** Total wall-clock deadline; defaults to HARA_CRON_TICK_TIMEOUT_MS or 60 minutes. */
  tickTimeoutMs?: number;
  /** Optional owner cancellation (primarily for embedding/tests). */
  signal?: AbortSignal;
  /** Injectable durable transport (tests/embedders); production uses deliverResult. */
  deliver?: CronDeliver;
}

export interface CronTickResult {
  ran: string[];
  skipped?: string;
  /** A tick that acquired the lock but stopped early due to its watchdog/caller. */
  stopped?: string;
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
export function runJobOnce(job: CronJob, options: CronRunOptions = {}): Promise<CronRunResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ ok: false, error: "interrupted before cron job start by agent run deadline or cancellation", output: "", interrupted: true });
  }
  return new Promise((resolve) => {
    const timeoutMs = cronJobTimeoutMs(options.timeoutMs);
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
    if (options.signal?.aborted) {
      resolve({ ok: false, error: "interrupted before cron job start by agent run deadline or cancellation", output: "", interrupted: true });
      return;
    }
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
    let aborted = false;
    let abortFallback: NodeJS.Timeout | undefined;
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
    const settle = (result: CronRunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      if (abortFallback) clearTimeout(abortFallback);
      options.signal?.removeEventListener("abort", abortRun);
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
    const abortRun = (): void => {
      if (done || timedOut || aborted) return;
      aborted = true;
      // A parent run deadline is already the hard boundary: kill immediately rather than adding the normal
      // cron timeout grace. The owned process group includes shell/node descendants.
      terminateSubprocessTree(child, { force: true, processGroup });
      abortFallback = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle({ ok: false, error: "interrupted by agent run deadline or cancellation", output: tail, interrupted: true });
      }, 750);
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
          if (closeBeforeForce) settle({ ok: false, error: `timed out after ${timeoutMs}ms`, output: tail, timedOut: true });
        },
        onFallback: () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({ ok: false, error: `timed out after ${timeoutMs}ms`, output: tail, timedOut: true });
        },
      });
    }, timeoutMs);
    options.signal?.addEventListener("abort", abortRun, { once: true });
    if (options.signal?.aborted) abortRun();
    child.stdout?.on("data", (d: Buffer) => { if (!done && !timedOut && !aborted) stdout.push(d.toString()); });
    child.stderr?.on("data", (d: Buffer) => { if (!done && !timedOut && !aborted) stderr.push(d.toString()); });
    child.on("error", (e) => {
      if (aborted) {
        settle({ ok: false, error: "interrupted by agent run deadline or cancellation", output: tail, interrupted: true });
        return;
      }
      if (timedOut && !forceIssued) {
        closeBeforeForce = true;
        return;
      }
      settle(timedOut
        ? { ok: false, error: `timed out after ${timeoutMs}ms`, output: tail, timedOut: true }
        : { ok: false, error: String(e?.message ?? e), output: tail });
    });
    child.on("close", (code) => {
      if (aborted) {
        settle({ ok: false, error: "interrupted by agent run deadline or cancellation", output: tail, interrupted: true });
        return;
      }
      if (timedOut && !forceIssued) {
        closeBeforeForce = true;
        return;
      }
      if (timedOut) settle({ ok: false, error: `timed out after ${timeoutMs}ms`, output: tail, timedOut: true });
      else settle(code === 0 ? { ok: true, output: tail } : { ok: false, error: `exited ${code}`, output: tail });
    });
  });
}

function terminalStatus(result: CronRunResult): "ok" | "error" | "timed_out" {
  return result.ok ? "ok" : result.timedOut ? "timed_out" : "error";
}

function safeRunFailure(error: unknown): CronRunResult {
  return {
    ok: false,
    error: redactToolSubprocessOutput(error instanceof Error ? error.message : String(error)),
    output: "",
  };
}

/** Manual-run lifecycle wrapper: persistence happens before the child starts and is always closed out. */
export async function runJobTracked(job: CronJob, options: CronRunOptions = {}): Promise<CronRunResult> {
  const startedAt = Date.now();
  let runningToken: string | null;
  try {
    runningToken = recordRunStart(job.id, startedAt);
  } catch (error) {
    return { ok: false, error: `failed to persist cron running state: ${safeRunFailure(error).error}` };
  }
  if (!runningToken) {
    let current: CronJob | undefined;
    try {
      current = findJob(job.id);
      if (current?.lastStatus === "running") {
        // A dead parent may still have a detached child. Persist the same fail-closed recovery used by ticks,
        // but do not continue into a new run: the operator must inspect and retry explicitly.
        const recovered = recoverInterruptedRuns(startedAt, job.id).find((entry) => entry.job.id === job.id);
        if (recovered) {
          return {
            ok: false,
            error: `previous cron attempt was interrupted and the job was disabled; Hara refused to overlap a possible orphaned child. Inspect the process/workspace, then run \`hara cron run ${job.id}\` again explicitly`,
            output: "",
          };
        }
        current = findJob(job.id);
        if (current?.lastStatus === "running") {
          const pid = current.runningPid ? ` (owner pid ${current.runningPid})` : "";
          return {
            ok: false,
            error: `cron job already has an unresolved running attempt${pid}; Hara refused to overlap it. Wait for it to finish or stop/recover that owner before retrying`,
            output: "",
          };
        }
      }
    } catch (error) {
      return { ok: false, error: `failed to inspect/recover cron running state: ${safeRunFailure(error).error}`, output: "" };
    }
    return {
      ok: false,
      error: current?.lastError
        ? `cron job could not start: ${current.lastError}`
        : "cron job could not start because it no longer exists or its state changed concurrently",
      output: "",
    };
  }
  let result: CronRunResult;
  try {
    result = await runJobOnce(job, options);
  } catch (error) {
    result = safeRunFailure(error);
  }
  const finishedAt = Date.now();
  recordRun(job.id, finishedAt, terminalStatus(result), result.error, finishedAt - startedAt, runningToken);
  return result;
}

type CronDeliver = (
  spec: string,
  text: string,
  signal?: AbortSignal,
  idempotencyKey?: string,
) => Promise<string | null>;

interface PendingDeliveryOptions {
  limit?: number;
  jobId?: string;
  ids?: ReadonlySet<string>;
}

/** Attempt a bounded slice of the durable queue. Transport failure updates backoff but never removes the
 * effect; confirmed success atomically acknowledges it (and starts alert cooldown). */
export async function deliverPendingNotifications(
  deliver: CronDeliver = deliverResult,
  nowMs = Date.now(),
  signal?: AbortSignal,
  options: PendingDeliveryOptions = {},
): Promise<number> {
  const pending = listPendingNotifications(nowMs, options.limit ?? 8, options.jobId)
    .filter((notification) => !options.ids || options.ids.has(notification.id));
  let acknowledged = 0;
  for (const notification of pending) {
    if (signal?.aborted) break;
    let error: string | null;
    try {
      error = await deliver(notification.target, notification.text, signal, notification.id);
    } catch (cause) {
      error = `delivery failed: ${safeRunFailure(cause).error ?? "transport request failed"}`;
    }
    if (!error) {
      acknowledgePendingNotification(notification.jobId, notification.id, Date.now());
      acknowledged++;
      continue;
    }
    deferPendingNotification(notification.jobId, notification.id, error, Date.now());
    try {
      appendFileSync(logPath(notification.jobId), `\n[${notification.kind === "alert" ? "alert" : "deliver"}] ${error}\n`);
    } catch {
      /* the durable queue is authoritative; the human-readable log is best effort */
    }
  }
  return acknowledged;
}

/** Public one-off wrapper retained for embedders/tests. Unlike the old best-effort implementation, intent is
 * persisted before transport and keeps the same idempotency key until confirmed. Production ticks enqueue
 * atomically inside recordRun and call `deliverPendingNotifications` directly. */
export async function deliverOutcome(
  job: CronJob,
  r: CronDeliveryOutcome,
  deliver: CronDeliver = deliverResult,
  nowMs: number = Date.now(),
  signal?: AbortSignal,
): Promise<void> {
  const ids = enqueueOutcomeNotifications(job.id, r, nowMs);
  if (!ids.length) return;
  await deliverPendingNotifications(deliver, nowMs, signal, {
    limit: Math.min(64, ids.length),
    jobId: job.id,
    ids: new Set(ids),
  });
}

export type CronJobRunner = (job: CronJob, options?: CronRunOptions) => Promise<CronRunResult>;

interface BoundedJobOutcome {
  result: CronRunResult;
  stopTick?: "watchdog" | "cancelled";
}

/** Hard-race a runner as well as passing it a signal. The race is intentional: a buggy/custom runner that
 * ignores AbortSignal must not retain the global tick lock forever. The production runner owns a detached
 * process group and force-kills it synchronously when this controller aborts. */
async function runOneWithinTick(
  job: CronJob,
  run: CronJobRunner,
  jobTimeoutMs: number,
  tickTimeoutMs: number,
  tickSignal: AbortSignal,
  tickWatchdogSignal: AbortSignal,
): Promise<BoundedJobOutcome> {
  const jobDeadline = new AbortController();
  const signal = AbortSignal.any([tickSignal, jobDeadline.signal]);
  let jobTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let onTickAbort: (() => void) | undefined;
  let jobTimedOut = false;
  const boundary = new Promise<BoundedJobOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: BoundedJobOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    jobTimer = setTimeout(() => {
      const error = `timed out after ${jobTimeoutMs}ms`;
      jobTimedOut = true;
      jobDeadline.abort(new Error(error));
      // Production runJobOnce force-kills its owned process group synchronously, then settles on close. Give
      // that cleanup a short bounded window before starting the next due job; a runner that ignores both the
      // signal and the hard race still cannot retain the tick forever.
      settleTimer = setTimeout(() => {
        finish({ result: { ok: false, error, output: "", timedOut: true } });
      }, ABORT_SETTLE_MS);
    }, jobTimeoutMs);
    onTickAbort = () => {
      const watchdog = tickWatchdogSignal.aborted;
      const error = watchdog ? `tick watchdog timed out after ${tickTimeoutMs}ms` : "tick cancelled by caller";
      finish({
        result: {
          ok: false,
          error,
          output: "",
          ...(watchdog ? { timedOut: true } : { interrupted: true }),
        },
        stopTick: watchdog ? "watchdog" : "cancelled",
      });
    };
    tickSignal.addEventListener("abort", onTickAbort, { once: true });
    if (tickSignal.aborted) onTickAbort();
  });
  const execution = Promise.resolve()
    .then(() => run(job, { timeoutMs: jobTimeoutMs, signal }))
    .then(
      (result): BoundedJobOutcome => jobTimedOut && !tickSignal.aborted
        ? { result: { ...result, ok: false, error: `timed out after ${jobTimeoutMs}ms`, timedOut: true, interrupted: undefined } }
        : { result },
      (error): BoundedJobOutcome => jobTimedOut && !tickSignal.aborted
        ? { result: { ok: false, error: `timed out after ${jobTimeoutMs}ms`, output: "", timedOut: true } }
        : { result: safeRunFailure(error) },
    );
  const outcome = await Promise.race([execution, boundary]);
  if (jobTimer) clearTimeout(jobTimer);
  if (settleTimer) clearTimeout(settleTimer);
  if (onTickAbort) tickSignal.removeEventListener("abort", onTickAbort);
  return outcome;
}

/** Await auxiliary work without allowing a non-cooperative delivery adapter to outlive the tick lock. */
async function completesBeforeTick(work: Promise<unknown>, tickSignal: AbortSignal): Promise<boolean> {
  const completed = Promise.resolve(work).then(() => true, () => true);
  if (tickSignal.aborted) {
    void completed;
    return false;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    tickSignal.addEventListener("abort", onAbort, { once: true });
    if (tickSignal.aborted) onAbort();
  });
  const result = await Promise.race([completed, aborted]);
  if (onAbort) tickSignal.removeEventListener("abort", onAbort);
  return result;
}

/** One scheduler tick: run every due job (sequentially), recording each outcome. Lock-guarded so an
 *  overlapping tick (launchd fires every 60s; a job may run longer) skips instead of double-firing.
 *  `run` is injectable for tests. Returns the job ids that ran. */
export async function runTick(
  nowMs: number,
  run: CronJobRunner = runJobOnce,
  options: CronTickOptions = {},
): Promise<CronTickResult> {
  mkdirSync(cronDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(cronDir(), 0o700); } catch { /* best effort */ }
  const lock = lockPath();
  const token = newTickLockToken();
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
    const malformedStale = (snapshot: TickLockFileSnapshot): boolean => nowMs - snapshot.mtimeMs >= MALFORMED_LOCK_POISON_MS;
    if (observed ? !reclaimableTickLock(observed) : !malformedStale(observedFile)) {
      return { ran: [], skipped: "another tick is in progress" };
    }

    const takeoverToken = newTickLockToken();
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
          if (!sameTickLock(observed, current) || !current || !reclaimableTickLock(current)) {
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
  const tickTimeoutMs = cronTickTimeoutMs(options.tickTimeoutMs);
  const jobTimeoutMs = Math.min(cronJobTimeoutMs(options.jobTimeoutMs), tickTimeoutMs);
  const deliver = options.deliver ?? deliverResult;
  const tickDeadline = new AbortController();
  const tickTimer = setTimeout(() => {
    tickDeadline.abort(new Error(`tick watchdog timed out after ${tickTimeoutMs}ms`));
  }, tickTimeoutMs);
  const tickSignal = options.signal ? AbortSignal.any([options.signal, tickDeadline.signal]) : tickDeadline.signal;
  try {
    // A prior scheduler/manual process may have died after persisting `running`. Recovery atomically records
    // terminal state + durable notifications before selecting due work. Live, non-expired owners are preserved.
    let due: CronJob[];
    try {
      recoverInterruptedRuns(nowMs);
      due = dueJobs(loadJobs(), nowMs);
    } catch (error) {
      return { ran: [], stopped: `cron store unavailable: ${safeRunFailure(error).error}` };
    }
    // Every OS tick retries a bounded alert-first slice, including disabled/orphaned/one-shot jobs which may
    // never run again. A transport failure remains queued with backoff instead of disappearing into a log.
    const drained = await completesBeforeTick(
      deliverPendingNotifications(deliver, nowMs, tickSignal, { limit: 8 }),
      tickSignal,
    );
    if (!drained || tickSignal.aborted) {
      return {
        ran: [],
        stopped: tickDeadline.signal.aborted
          ? `tick watchdog timed out after ${tickTimeoutMs}ms`
          : "tick cancelled by caller",
      };
    }
    const ran: string[] = [];
    let stopped: string | undefined;
    for (const job of due) {
      if (tickSignal.aborted) {
        stopped = tickDeadline.signal.aborted
          ? `tick watchdog timed out after ${tickTimeoutMs}ms`
          : "tick cancelled by caller";
        break;
      }
      const startedAt = Date.now();
      let runningToken: string | null;
      try {
        // Re-check enabled/existence under the store mutex. A disable/remove racing the earlier due snapshot
        // wins cleanly and is never overwritten by this tick.
        runningToken = recordRunStart(job.id, startedAt, true);
      } catch (error) {
        stopped = `could not persist running state for ${job.id}: ${safeRunFailure(error).error}`;
        break; // fail closed: never launch a job whose running state was not durably recorded
      }
      if (!runningToken) continue;
      const bounded = await runOneWithinTick(job, run, jobTimeoutMs, tickTimeoutMs, tickSignal, tickDeadline.signal);
      const r = bounded.result;
      const finishedAt = Date.now();
      const recorded = recordRun(job.id, finishedAt, terminalStatus(r), r.error, finishedAt - startedAt, runningToken, r);
      ran.push(job.id);
      // Even the total watchdog/caller cancellation must produce the promised visible failure alert. Give
      // that final delivery its own small hard boundary instead of skipping it or extending the tick forever.
      const deliverySignal = tickSignal.aborted ? AbortSignal.timeout(FINAL_DELIVERY_TIMEOUT_MS) : tickSignal;
      const delivered = !recorded
        ? true // a newer attempt/removal owns state now; do not send this stale attempt's outcome
        : await completesBeforeTick(
            deliverPendingNotifications(deliver, finishedAt, deliverySignal, { limit: 8, jobId: job.id }),
            deliverySignal,
          );
      if (bounded.stopTick || !delivered || tickSignal.aborted) {
        stopped = tickDeadline.signal.aborted
          ? `tick watchdog timed out after ${tickTimeoutMs}ms`
          : "tick cancelled by caller";
        break;
      }
    }
    return { ran, ...(stopped ? { stopped } : {}) };
  } finally {
    clearTimeout(tickTimer);
    // Remove only the lock instance we created; never unlink a successor after a stale-lock takeover.
    releasePrimaryTickLock(lock, takeover, token);
  }
}
