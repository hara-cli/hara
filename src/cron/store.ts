// Persistent job store for `hara cron` — atomic JSON at ~/.hara/cron/jobs.json (temp + rename, like
// openclaw/hermes). Each job runs a fresh `hara` session when due; per-job run logs live alongside.
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { cronMatches, parseCron, validTz, type Schedule } from "./schedule.js";
import { compareProcessIdentity, defaultProcessIdentity } from "../process-identity.js";
import { sleepSync } from "../sync-sleep.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";

export type CronNotificationKind = "outcome" | "alert";

/** A delivery effect is durable before transport. Its id is reused across retries so transports with
 * idempotency support cannot duplicate a message after an ambiguous response/process crash. */
export interface CronPendingNotification {
  id: string;
  kind: CronNotificationKind;
  target: string;
  text: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface CronDeliveryOutcome {
  ok: boolean;
  error?: string;
  /** Redacted stdout only. `output` may also contain stderr for diagnostics. */
  stdout?: string;
  output?: string;
}

export type CronDeliverMode = "always" | "on-output" | "on-error";

/** Hard persistence bounds: outages must apply backpressure instead of growing jobs.json forever. */
export const MAX_CRON_PENDING_NOTIFICATIONS = 64;
const CRON_RUN_NOTIFICATION_RESERVE = 2;
const MAX_CRON_JOBS = 4_096;
export const MAX_CRON_STORE_BYTES = 32 * 1024 * 1024;

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
  /** Outcome noise policy. Alerts remain independent and are still sent at alertAfter. */
  deliverMode?: CronDeliverMode;
  /** Consecutive failures before a 🚨 alert fires on the deliver channel (default 3). */
  alertAfter?: number;
  enabled: boolean;
  createdAt: number;
  /** One explicit creation-minute occurrence waiting for the next OS tick. Disable/start clears it. */
  pendingDueAt?: number;
  lastRunAt?: number;
  /** Persisted lifecycle state. `running` survives a scheduler crash so `cron list` never lies by omission. */
  lastStatus?: "ok" | "error" | "running" | "timed_out";
  /** Wall-clock start of the active run; cleared on every terminal outcome. */
  runningSince?: number;
  /** Parent Hara process and per-attempt token. They let a later tick distinguish a live manual run from
   * an orphan left by a crashed scheduler, and prevent an older completion overwriting a newer attempt. */
  runningPid?: number;
  runningToken?: string;
  /** Duration of the latest terminal run. */
  lastDurationMs?: number;
  lastError?: string;
  /** Consecutive error count (reset on success) — drives the failure alert. */
  consecutiveErrors?: number;
  /** Last 🚨 alert timestamp — cooldown gate so a flapping job doesn't spam. */
  lastAlertAt?: number;
  /** Durable result/alarm effects awaiting confirmed transport acknowledgement. */
  pendingNotifications?: CronPendingNotification[];
}

export class CronStoreCorruptError extends Error {
  readonly code = "HARA_CRON_STORE_CORRUPT";
  constructor(detail: string) {
    super(`cron job store is invalid (${detail}); refusing to overwrite it. Inspect ${jobsPath()} and ${join(cronDir(), "store-error.log")}`);
    this.name = "CronStoreCorruptError";
  }
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

interface StoreLockRecord {
  pid: number;
  token: string;
  /** Stable for one OS process lifetime, so a recycled live PID cannot preserve somebody else's guard. */
  birthIdentity?: string;
}

const STORE_LOCK_ATTEMPTS = 200;
const STORE_LOCK_WAIT_MS = 10;
const STORE_MALFORMED_POISON_MS = 500;
// Store mutations are synchronous and normally hold the lock for milliseconds. A generous 30-second lease
// recovers a crashed lock whose PID has since been reused; the old owner is fenced at the commit guard below.
const STORE_LOCK_LEASE_MS = 30_000;
const MAX_STORE_LOCK_BYTES = 512;

function storeLockPath(): string {
  return join(cronDir(), ".jobs.lock");
}

interface StoreLockSnapshot {
  raw: string | null;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function readStoreLockSnapshot(path: string): StoreLockSnapshot | null {
  try {
    const before = lstatSync(path);
    let raw: string | null = null;
    if (before.isFile() && before.size <= MAX_STORE_LOCK_BYTES) {
      const fd = openSync(
        path,
        constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"),
      );
      try {
        const opened = fstatSync(fd);
        if (opened.isFile() && sameOpenedFileIdentity(opened, before) && opened.size <= MAX_STORE_LOCK_BYTES) {
          const buffer = Buffer.alloc(opened.size);
          let offset = 0;
          while (offset < buffer.length) {
            const bytes = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (!bytes) break;
            offset += bytes;
          }
          raw = buffer.subarray(0, offset).toString("utf8");
        }
      } finally {
        closeSync(fd);
      }
    }
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

function parseStoreLock(snapshot: StoreLockSnapshot | null): StoreLockRecord | null {
  if (snapshot?.raw === null || snapshot?.raw === undefined) return null;
  try {
    const parsed = JSON.parse(snapshot.raw);
    return Number.isSafeInteger(parsed?.pid) && parsed.pid > 0
      && typeof parsed?.token === "string" && parsed.token.length > 0 && parsed.token.length <= 128
      && (
        parsed.birthIdentity === undefined
        || (typeof parsed.birthIdentity === "string" && /^[\x20-\x7e]{1,256}$/.test(parsed.birthIdentity))
      )
      ? {
          pid: parsed.pid,
          token: parsed.token,
          ...(parsed.birthIdentity ? { birthIdentity: parsed.birthIdentity } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function readStoreLock(path: string): StoreLockRecord | null {
  return parseStoreLock(readStoreLockSnapshot(path));
}

function sameStoreLock(left: StoreLockSnapshot, right: StoreLockSnapshot | null): boolean {
  return !!right
    && left.raw === right.raw
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function malformedStoreLockStale(snapshot: StoreLockSnapshot, now = Date.now()): boolean {
  return !parseStoreLock(snapshot) && now - snapshot.mtimeMs >= STORE_MALFORMED_POISON_MS;
}

function validStoreLockLeaseExpired(snapshot: StoreLockSnapshot, now = Date.now()): boolean {
  return !!parseStoreLock(snapshot) && now - snapshot.mtimeMs >= STORE_LOCK_LEASE_MS;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

const CURRENT_PROCESS_BIRTH_IDENTITY = defaultProcessIdentity(process.pid);

function newStoreLockRecord(): StoreLockRecord {
  const birthIdentity = CURRENT_PROCESS_BIRTH_IDENTITY;
  return {
    pid: process.pid,
    token: randomUUID(),
    ...(birthIdentity ? { birthIdentity } : {}),
  };
}

function storeLockOwnerAlive(record: StoreLockRecord): boolean {
  if (!processAlive(record.pid)) return false;
  if (!record.birthIdentity) return true;
  const current = record.pid === process.pid ? CURRENT_PROCESS_BIRTH_IDENTITY : defaultProcessIdentity(record.pid);
  return compareProcessIdentity(record.birthIdentity, current) !== "different";
}

function writeStoreLockExclusive(path: string, record: StoreLockRecord): void {
  // Never expose a partial lock record at the contested pathname. A process may be suspended indefinitely
  // between open and write; publish the fully written+fsynced inode with an atomic create-if-absent link.
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(staging, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(staging, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(staging); } catch { /* a crash may leave only an inert, uniquely named staging file */ }
  }
}

function removeOwnedStoreLock(path: string, owner: StoreLockRecord): void {
  const current = readStoreLock(path);
  if (current?.pid === owner.pid && current.token === owner.token) rmSync(path, { force: true });
}

/** A valid reclaim guard protects the tiny verify+commit critical section. New records use OS birth identity
 * to distinguish a live owner from PID reuse. A live legacy identity-less guard fails closed: age alone cannot
 * fence an owner suspended after its final token check but before rename, and this lock format was unpublished. */
function clearDeadOrPoisonedStoreGuard(path: string): boolean {
  const observed = readStoreLockSnapshot(path);
  if (!observed) return true;
  const record = parseStoreLock(observed);
  const reclaimable = record ? !storeLockOwnerAlive(record) : malformedStoreLockStale(observed);
  if (!reclaimable) return false;
  const current = readStoreLockSnapshot(path);
  const currentRecord = parseStoreLock(current);
  const stillReclaimable = record
    ? currentRecord?.pid === record.pid
      && currentRecord.token === record.token
      && !!current
      && !storeLockOwnerAlive(currentRecord)
    : !!current && malformedStoreLockStale(current);
  if (!sameStoreLock(observed, current) || !stillReclaimable) return false;
  rmSync(path, { force: true });
  return true;
}

interface StoreLease {
  /** Execute the final namespace commit only while the primary token is still current. */
  commit<T>(fn: () => T): T;
}

function withStoreCommitFence<T>(lock: string, reclaim: string, claim: StoreLockRecord, fn: () => T): T {
  let guard: StoreLockRecord | undefined;
  for (let attempt = 0; attempt < STORE_LOCK_ATTEMPTS; attempt++) {
    if (!clearDeadOrPoisonedStoreGuard(reclaim)) {
      sleepSync(STORE_LOCK_WAIT_MS);
      continue;
    }
    const candidate = newStoreLockRecord();
    try {
      writeStoreLockExclusive(reclaim, candidate);
      guard = candidate;
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
    sleepSync(STORE_LOCK_WAIT_MS);
  }
  if (!guard) throw new Error("cron job store commit fence is busy; retry the operation");
  try {
    const currentGuard = readStoreLock(reclaim);
    if (currentGuard?.pid !== guard.pid || currentGuard.token !== guard.token) {
      throw new Error("cron job store commit guard was replaced before commit; retry the operation");
    }
    const current = readStoreLock(lock);
    if (current?.pid !== claim.pid || current.token !== claim.token) {
      throw new Error("cron job store lease was replaced before commit; retry the operation");
    }
    // Renew both names immediately before the synchronous namespace commit. A stale-owner reaper that
    // observed either snapshot sees this renewal or loses its snapshot CAS; a resumed owner whose guard was
    // already replaced fails above before it can publish stale jobs.json contents.
    const now = new Date();
    utimesSync(reclaim, now, now);
    utimesSync(lock, now, now);
    return fn();
  } finally {
    removeOwnedStoreLock(reclaim, guard);
  }
}

/** All cron read-modify-write operations share this bounded O_EXCL mutex. Dead owners are reclaimed only
 * under a second exclusive guard and after token revalidation, so a reaper can never unlink a successor. */
function withStoreLock<T>(fn: (lease: StoreLease) => T): T {
  mkdirSync(cronDir(), { recursive: true, mode: 0o700 });
  const lock = storeLockPath();
  const reclaim = `${lock}.reclaim`;
  let claim: StoreLockRecord | undefined;

  for (let attempt = 0; attempt < STORE_LOCK_ATTEMPTS; attempt++) {
    const reclaimObserved = readStoreLockSnapshot(reclaim);
    if (reclaimObserved) {
      if (clearDeadOrPoisonedStoreGuard(reclaim)) continue;
      sleepSync(STORE_LOCK_WAIT_MS);
      continue;
    }

    const candidate = newStoreLockRecord();
    try {
      writeStoreLockExclusive(lock, candidate);
      // A reaper may have installed its guard after our preflight but before link(2). Never enter a
      // transaction under that guard: remove only our token and retry after the transition completes.
      if (existsSync(reclaim)) {
        removeOwnedStoreLock(lock, candidate);
      } else {
        claim = candidate;
        break;
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const observed = readStoreLockSnapshot(lock);
    const held = parseStoreLock(observed);
    if (observed && ((held && (!storeLockOwnerAlive(held) || validStoreLockLeaseExpired(observed))) || malformedStoreLockStale(observed))) {
      const guard = newStoreLockRecord();
      try {
        writeStoreLockExclusive(reclaim, guard);
        const current = readStoreLockSnapshot(lock);
        const currentRecord = parseStoreLock(current);
        const stillReclaimable = held
          ? currentRecord?.pid === held.pid
            && currentRecord.token === held.token
            && !!current
            && (!storeLockOwnerAlive(currentRecord) || validStoreLockLeaseExpired(current))
          : !!current && malformedStoreLockStale(current);
        if (sameStoreLock(observed, current) && stillReclaimable) rmSync(lock);
      } catch {
        // Another writer won reclamation, or the evidence is malformed. Never fail open.
      } finally {
        const currentGuard = readStoreLock(reclaim);
        if (currentGuard?.pid === process.pid && currentGuard.token === guard.token) rmSync(reclaim, { force: true });
      }
    }
    sleepSync(STORE_LOCK_WAIT_MS);
  }

  if (!claim) throw new Error("cron job store is busy; retry the operation");
  const lease: StoreLease = {
    commit: <T>(commit: () => T): T => withStoreCommitFence(lock, reclaim, claim!, commit),
  };
  try {
    return fn(lease);
  } finally {
    removeOwnedStoreLock(lock, claim);
  }
}

function validFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validSchedule(value: unknown): value is Schedule {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<Schedule> & Record<string, unknown>;
  if (schedule.kind === "cron") return typeof schedule.expr === "string" && !!parseCron(schedule.expr);
  if (schedule.kind === "every") return validFinite(schedule.everyMs) && schedule.everyMs > 0 && typeof schedule.display === "string";
  return schedule.kind === "once" && validFinite(schedule.runAt) && typeof schedule.display === "string";
}

function validPendingNotification(value: unknown): value is CronPendingNotification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notification = value as Partial<CronPendingNotification>;
  return typeof notification.id === "string" && notification.id.length > 0 && notification.id.length <= 256
    && (notification.kind === "outcome" || notification.kind === "alert")
    && typeof notification.target === "string" && notification.target.length > 0 && notification.target.length <= 4_096
    && typeof notification.text === "string" && notification.text.length <= 8_192
    && validFinite(notification.createdAt)
    && typeof notification.attempts === "number" && Number.isInteger(notification.attempts)
    && notification.attempts >= 0 && notification.attempts <= Number.MAX_SAFE_INTEGER
    && validFinite(notification.nextAttemptAt)
    && (notification.lastError === undefined || (typeof notification.lastError === "string" && notification.lastError.length <= 4_096));
}

function validPendingNotifications(value: unknown): value is CronPendingNotification[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_CRON_PENDING_NOTIFICATIONS) return false;
  const ids = new Set<string>();
  let alerts = 0;
  for (const notification of value) {
    if (!validPendingNotification(notification) || ids.has(notification.id)) return false;
    ids.add(notification.id);
    if (notification.kind === "alert" && ++alerts > 1) return false;
  }
  return true;
}

function validCronJob(value: unknown): value is CronJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Partial<CronJob>;
  return typeof job.id === "string" && !!job.id && job.id.length <= 128
    && typeof job.name === "string" && job.name.length <= 1_000
    && validSchedule(job.schedule)
    && typeof job.task === "string"
    && (job.mode === "print" || job.mode === "org" || job.mode === "command")
    && typeof job.cwd === "string" && !!job.cwd
    && typeof job.enabled === "boolean"
    && validFinite(job.createdAt)
    && (job.pendingDueAt === undefined || (job.schedule.kind === "cron" && validFinite(job.pendingDueAt)))
    && (job.tz === undefined || (typeof job.tz === "string" && validTz(job.tz)))
    && (job.deliver === undefined || (typeof job.deliver === "string" && job.deliver.length > 0 && job.deliver.length <= 4_096))
    && (
      job.deliverMode === undefined
      || (
        job.deliver !== undefined
        && (job.deliverMode === "always" || job.deliverMode === "on-output" || job.deliverMode === "on-error")
      )
    )
    && (job.alertAfter === undefined || (Number.isInteger(job.alertAfter) && job.alertAfter >= 1 && job.alertAfter <= 1_000))
    && (job.lastRunAt === undefined || validFinite(job.lastRunAt))
    && (job.runningSince === undefined || validFinite(job.runningSince))
    && (job.runningPid === undefined || (Number.isInteger(job.runningPid) && job.runningPid > 0))
    && (job.runningToken === undefined || (typeof job.runningToken === "string" && job.runningToken.length > 0 && job.runningToken.length <= 128))
    && (job.lastDurationMs === undefined || validFinite(job.lastDurationMs))
    && (job.lastError === undefined || typeof job.lastError === "string")
    && (job.consecutiveErrors === undefined || (Number.isInteger(job.consecutiveErrors) && job.consecutiveErrors >= 0))
    && (job.lastAlertAt === undefined || validFinite(job.lastAlertAt))
    && validPendingNotifications(job.pendingNotifications)
    && (job.lastStatus === undefined || ["ok", "error", "running", "timed_out"].includes(job.lastStatus));
}

function recordStoreError(detail: string): void {
  try {
    mkdirSync(cronDir(), { recursive: true, mode: 0o700 });
    const path = join(cronDir(), "store-error.log");
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${new Date().toISOString()} ${detail}\n`, { mode: 0o600 });
    renameSync(temp, path);
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  } catch {
    // Diagnostics must never turn a parse failure into destructive recovery.
  }
}

export function loadJobs(): CronJob[] {
  const p = jobsPath();
  if (!existsSync(p)) return [];
  const snapshot = lstatSync(p);
  if (!snapshot.isFile() || snapshot.size > MAX_CRON_STORE_BYTES) {
    const detail = !snapshot.isFile()
      ? "jobs.json is not a regular file"
      : `jobs.json exceeds the ${MAX_CRON_STORE_BYTES}-byte safety limit`;
    recordStoreError(detail);
    throw new CronStoreCorruptError(detail);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    const detail = "JSON could not be parsed";
    recordStoreError(detail);
    throw new CronStoreCorruptError(detail);
  }
  if (!Array.isArray(parsed)) {
    const detail = "top level is not an array";
    recordStoreError(detail);
    throw new CronStoreCorruptError(detail);
  }
  if (parsed.length > MAX_CRON_JOBS) {
    const detail = `top level exceeds the ${MAX_CRON_JOBS}-job safety limit`;
    recordStoreError(detail);
    throw new CronStoreCorruptError(detail);
  }
  const ids = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    const job = parsed[index];
    if (!validCronJob(job)) {
      const detail = `entry ${index + 1} has an invalid schema`;
      recordStoreError(detail);
      throw new CronStoreCorruptError(detail);
    }
    if (ids.has(job.id)) {
      const detail = `entry ${index + 1} duplicates job id ${job.id}`;
      recordStoreError(detail);
      throw new CronStoreCorruptError(detail);
    }
    ids.add(job.id);
  }
  return parsed;
}

/** Persist while the caller owns the store lock. The final rename is fenced against an expired owner that
 * resumes after another process reclaimed its primary lease. */
function saveJobsUnlocked(jobs: CronJob[], lease: StoreLease): void {
  mkdirSync(cronDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(cronDir(), 0o700); } catch { /* best effort */ }
  if (jobs.length > MAX_CRON_JOBS || jobs.some((job) => !validCronJob(job))) {
    throw new Error("refusing to persist cron jobs outside the bounded store schema");
  }
  const serialized = JSON.stringify(jobs, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_CRON_STORE_BYTES) {
    throw new Error(`refusing to persist cron jobs larger than ${MAX_CRON_STORE_BYTES} bytes`);
  }
  const p = jobsPath();
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    lease.commit(() => renameSync(tmp, p));
  } finally {
    rmSync(tmp, { force: true });
  }
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

/** Replace the complete list under the same mutex used by granular mutations. Prefer add/remove/set APIs
 * for concurrent callers; this is retained for migrations and explicit whole-store replacement. */
export function saveJobs(jobs: CronJob[]): void {
  withStoreLock((lease) => saveJobsUnlocked(jobs, lease));
}

function mutateJobs<T>(mutate: (jobs: CronJob[]) => T): T {
  return withStoreLock((lease) => {
    const jobs = loadJobs();
    const result = mutate(jobs);
    saveJobsUnlocked(jobs, lease);
    return result;
  });
}

export function addJob(j: Omit<CronJob, "id" | "createdAt" | "enabled"> & { enabled?: boolean; createdAt: number }): CronJob {
  return mutateJobs((jobs) => {
    const enabled = j.enabled ?? true;
    const job: CronJob = { ...j, id: randomUUID().slice(0, 8), enabled };
    delete job.pendingDueAt;
    delete job.pendingNotifications;
    if (enabled && job.schedule.kind === "cron" && cronMatches(job.schedule.expr, new Date(job.createdAt), job.tz)) {
      job.pendingDueAt = job.createdAt;
    }
    jobs.push(job);
    return job;
  });
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
  return mutateJobs((jobs) => {
    const index = jobs.findIndex((x) => x.id === id);
    if (index < 0) return false;
    jobs.splice(index, 1);
    return true;
  });
}

/** Enable/disable a job by EXACT id. */
export function setEnabled(id: string, on: boolean): boolean {
  return mutateJobs((jobs) => {
    const job = jobs.find((x) => x.id === id);
    if (!job) return false;
    job.enabled = on;
    // Disabling explicitly abandons an unconsumed creation-minute occurrence. Enabling later must resume
    // from the schedule at that time, never replay a stale trigger inferred from job creation.
    if (!on) delete job.pendingDueAt;
    return true;
  });
}

/** Persist a run before any child process/provider work starts. */
export function recordRunStart(id: string, at: number, requireEnabled = false): string | null {
  return mutateJobs((jobs) => {
    const job = jobs.find((x) => x.id === id);
    if (!job || (requireEnabled && !job.enabled)) return null;
    // Never overwrite an unresolved attempt merely because its recorded parent PID is gone. The parent may
    // have launched a detached child before crashing, so a second manual run could duplicate file/network
    // side effects. Scheduler ticks call `recoverInterruptedRuns` first; manual callers receive a focused
    // diagnostic and must explicitly retry only after that recovery has disabled the ambiguous attempt.
    if (job.lastStatus === "running") return null;
    const pendingCount = job.pendingNotifications?.length ?? 0;
    if (pendingCount > MAX_CRON_PENDING_NOTIFICATIONS - CRON_RUN_NOTIFICATION_RESERVE) {
      const error = `cron delivery backlog has ${pendingCount}/${MAX_CRON_PENDING_NOTIFICATIONS} pending notifications; job disabled before launch to keep jobs.json bounded — restore delivery, let the queue drain, then re-enable the job`;
      job.enabled = false;
      delete job.pendingDueAt;
      job.lastStatus = "error";
      delete job.lastDurationMs;
      job.lastError = error;
      const alertAlreadyPending = job.pendingNotifications?.some((notification) => notification.kind === "alert") ?? false;
      if (job.deliver && !alertAlreadyPending) {
        enqueueNotification(
          job,
          "alert",
          `🚨 ${job.name} was disabled before launch: ${error}`,
          at,
          `delivery-backlog-${Math.trunc(at)}`,
        );
      }
      return null;
    }
    const token = randomUUID();
    job.lastRunAt = at;
    delete job.pendingDueAt;
    job.lastStatus = "running";
    job.runningSince = at;
    job.runningPid = process.pid;
    job.runningToken = token;
    delete job.lastDurationMs;
    delete job.lastError;
    return token;
  });
}

const ALERT_COOLDOWN_MS = 6 * 3_600_000;
export const MAX_CRON_RUNNING_AGE_MS = 24 * 60 * 60_000 + 5 * 60_000;

function notificationText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\0/g, "").slice(0, max);
}

function enqueueNotification(
  job: CronJob,
  kind: CronNotificationKind,
  text: string,
  nowMs: number,
  attemptKey: string,
): string | null {
  const id = `cron:${job.id}:${attemptKey}:${kind}`;
  const pending = (job.pendingNotifications ??= []);
  if (pending.some((notification) => notification.id === id)) return id;

  let compacted = false;
  if (pending.length >= MAX_CRON_PENDING_NOTIFICATIONS) {
    // Alerts are never discarded. Under the validated schema there is at most one, so a full queue always
    // has an older outcome that can be represented by an explicit compaction marker on the new critical fact.
    const sameAttemptOutcome = kind === "alert" ? `cron:${job.id}:${attemptKey}:outcome` : undefined;
    let oldestOutcome = -1;
    for (let index = 0; index < pending.length; index++) {
      if (pending[index].kind !== "outcome" || pending[index].id === sameAttemptOutcome) continue;
      if (oldestOutcome < 0 || pending[index].createdAt < pending[oldestOutcome].createdAt) oldestOutcome = index;
    }
    if (oldestOutcome < 0) return null;
    pending.splice(oldestOutcome, 1);
    compacted = true;
  }
  const safeText = compacted
    ? `⚠️ Delivery backlog reached ${MAX_CRON_PENDING_NOTIFICATIONS}; one older outcome was compacted without delivery.\n${text}`
    : text;
  pending.push({
    id,
    kind,
    target: job.deliver!,
    text: notificationText(safeText, 8_192),
    createdAt: nowMs,
    attempts: 0,
    nextAttemptAt: nowMs,
  });
  return id;
}

/** Queue outcome + threshold alarm while already under the jobs transaction. `lastAlertAt` is deliberately
 * NOT changed here: cooldown begins only after the alert transport is confirmed and acknowledged. */
function enqueueOutcomeForJob(
  job: CronJob,
  result: CronDeliveryOutcome,
  nowMs: number,
  attemptKey: string,
): string[] {
  if (!job.deliver) return [];
  const queued: string[] = [];
  const snippet = notificationText(result.output, 1_500).trim();
  const stdout = notificationText(result.stdout, 1_500).trim();
  const safeError = notificationText(result.error || "failed", 1_000);
  const head = result.ok ? `⏰ ${job.name} ✓` : `⏰ ${job.name} ✗ ${safeError}`;
  const mode = job.deliverMode ?? "always";
  const shouldDeliverOutcome = mode === "always"
    || (mode === "on-output" && stdout.length > 0)
    || (mode === "on-error" && !result.ok);
  if (shouldDeliverOutcome) {
    const outcomeId = enqueueNotification(job, "outcome", snippet ? `${head}\n${snippet}` : head, nowMs, attemptKey);
    if (outcomeId) queued.push(outcomeId);
  }

  if (!result.ok) {
    const count = job.consecutiveErrors ?? 0;
    const threshold = job.alertAfter ?? 3;
    const cooled = !job.lastAlertAt || nowMs - job.lastAlertAt > ALERT_COOLDOWN_MS;
    const alertAlreadyPending = job.pendingNotifications?.some((notification) => notification.kind === "alert") ?? false;
    if (count >= threshold && cooled && !alertAlreadyPending) {
      const alertId = enqueueNotification(
        job,
        "alert",
        `🚨 ${job.name} has failed ${count}× in a row — latest: ${safeError}. Log: ${logPath(job.id)}`,
        nowMs,
        attemptKey,
      );
      if (alertId) queued.push(alertId);
    }
  }
  return queued;
}

/** Compatibility/public helper for callers that recorded state separately. Production tick code passes the
 * outcome to `recordRun`, making state + delivery intent one atomic jobs.json commit. */
export function enqueueOutcomeNotifications(
  id: string,
  result: CronDeliveryOutcome,
  nowMs = Date.now(),
  attemptKey = randomUUID(),
): string[] {
  return mutateJobs((jobs) => {
    const job = jobs.find((candidate) => candidate.id === id);
    return job ? enqueueOutcomeForJob(job, result, nowMs, attemptKey) : [];
  });
}

/** Record a run's terminal outcome. Timeouts are errors for streak/alert purposes but stay distinguishable
 * in persisted state and `cron list`. `at` is the finish time; lastRunAt remains the actual start. When
 * `delivery` is supplied, terminal state and its transport effects commit atomically. */
export function recordRun(
  id: string,
  at: number,
  status: "ok" | "error" | "timed_out",
  error?: string,
  durationMs?: number,
  runningToken?: string,
  delivery?: CronDeliveryOutcome,
): boolean {
  return mutateJobs((jobs) => {
    const job = jobs.find((x) => x.id === id);
    if (!job || (runningToken !== undefined && job.runningToken !== runningToken)) return false;
    const attemptKey = runningToken ?? job.runningToken ?? randomUUID();
    const startedAt = job.runningSince;
    job.lastRunAt = startedAt ?? at;
    job.lastStatus = status;
    delete job.runningSince;
    delete job.runningPid;
    delete job.runningToken;
    const measuredDuration = durationMs ?? (startedAt === undefined ? undefined : Math.max(0, at - startedAt));
    if (measuredDuration === undefined) delete job.lastDurationMs;
    else job.lastDurationMs = Math.max(0, Math.trunc(measuredDuration));
    if (status === "ok" || !error) delete job.lastError;
    else job.lastError = error;
    job.consecutiveErrors = status === "ok" ? 0 : (job.consecutiveErrors ?? 0) + 1;
    if (delivery) enqueueOutcomeForJob(job, delivery, at, attemptKey);
    return true;
  });
}

export interface PendingCronNotification extends CronPendingNotification {
  jobId: string;
}

/** Return due effects only, alert-first, with a hard item cap so a long outage cannot consume a whole tick. */
export function listPendingNotifications(nowMs = Date.now(), limit = 8, jobId?: string): PendingCronNotification[] {
  const bounded = Math.max(0, Math.min(64, Math.trunc(limit)));
  if (!bounded) return [];
  return loadJobs()
    .filter((job) => !jobId || job.id === jobId)
    .flatMap((job) => (job.pendingNotifications ?? []).map((notification) => ({ ...notification, jobId: job.id })))
    .filter((notification) => notification.nextAttemptAt <= nowMs)
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "alert" ? -1 : 1;
      return left.createdAt - right.createdAt;
    })
    .slice(0, bounded);
}

/** Confirm one transport effect. Alert cooldown is recorded in the same commit that removes its pending
 * record, so a crash cannot acknowledge delivery without also suppressing an immediate duplicate alert. */
export function acknowledgePendingNotification(jobId: string, notificationId: string, at = Date.now()): boolean {
  return mutateJobs((jobs) => {
    const job = jobs.find((candidate) => candidate.id === jobId);
    const pending = job?.pendingNotifications;
    const index = pending?.findIndex((notification) => notification.id === notificationId) ?? -1;
    if (!job || !pending || index < 0) return false;
    const [notification] = pending.splice(index, 1);
    if (notification.kind === "alert") job.lastAlertAt = at;
    if (!pending.length) delete job.pendingNotifications;
    return true;
  });
}

/** Persist an attempt failure and exponential backoff. The effect itself remains unchanged, including its
 * stable idempotency key, until a later tick receives a confirmed transport success. */
export function deferPendingNotification(
  jobId: string,
  notificationId: string,
  error: string,
  at = Date.now(),
): boolean {
  return mutateJobs((jobs) => {
    const notification = jobs
      .find((candidate) => candidate.id === jobId)
      ?.pendingNotifications?.find((candidate) => candidate.id === notificationId);
    if (!notification) return false;
    notification.attempts = Math.min(Number.MAX_SAFE_INTEGER, notification.attempts + 1);
    const exponent = Math.min(10, Math.max(0, notification.attempts - 1));
    const delay = Math.min(6 * 3_600_000, 30_000 * (2 ** exponent));
    notification.nextAttemptAt = at + delay;
    notification.lastError = notificationText(error || "transport request failed", 4_096);
    return true;
  });
}

export interface RecoveredCronRun {
  job: CronJob;
  error: string;
}

/** Close `running` records whose owner is gone OR whose age exceeds every supported job timeout plus grace.
 * The age fence handles PID reuse and a live-but-wedged legacy parent. The attempt remains consumed and the
 * job is disabled: a detached child may still exist, so recovery never kills or automatically replays it. */
export function recoverInterruptedRuns(at: number, jobId?: string): RecoveredCronRun[] {
  return mutateJobs((jobs) => {
    const recovered: RecoveredCronRun[] = [];
    for (const job of jobs) {
      if (jobId && job.id !== jobId) continue;
      if (job.lastStatus !== "running") continue;
      const startedAt = job.runningSince ?? job.lastRunAt ?? at;
      const tooOld = at - startedAt >= MAX_CRON_RUNNING_AGE_MS;
      if (job.runningPid && processAlive(job.runningPid) && !tooOld) continue;
      const attemptKey = job.runningToken ?? randomUUID();
      const error = tooOld
        ? "cron running state exceeded the 24h maximum job lifetime plus cleanup grace; job disabled because the recorded PID may be reused or its child may still be running — verify, then re-enable or run it manually"
        : "previous Hara process exited before recording a terminal cron result; job disabled because an orphaned child may still be running — verify, then re-enable or run it manually";
      job.lastRunAt = startedAt;
      job.lastStatus = "error";
      job.enabled = false;
      delete job.pendingDueAt;
      delete job.runningSince;
      delete job.runningPid;
      delete job.runningToken;
      job.lastDurationMs = Math.max(0, Math.trunc(at - startedAt));
      job.lastError = error;
      job.consecutiveErrors = (job.consecutiveErrors ?? 0) + 1;
      enqueueOutcomeForJob(job, { ok: false, error, output: "" }, at, attemptKey);
      recovered.push({ job: { ...job }, error });
    }
    return recovered;
  });
}

/** Stamp the failure-alert time (cooldown gate). */
export function recordAlert(id: string, at: number): void {
  mutateJobs((jobs) => {
    const job = jobs.find((x) => x.id === id);
    if (job) job.lastAlertAt = at;
  });
}
