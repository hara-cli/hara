// Process/runtime state for long-lived chat gateways.
//
// Two invariants live here:
// 1. One Hara process owns a platform connection at a time. Multiple Feishu WebSockets for the same app
//    receive the same event and produce duplicate replies, so startup fails before opening a second socket.
// 2. Message ids, bounded retry budgets, and immutable no-tool flow decisions survive a restart. Every file
//    is credential-scoped private state; raw credentials are never written here.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, bindHaraPrivateStateWritePath, FileChangedError } from "../fs-write.js";
import {
  ensurePrivateStateSubdirectory,
  readPrivateStateFileSnapshot,
  type PrivateStateFileSnapshot,
} from "../security/private-state.js";
import { sleepSync } from "../sync-sleep.js";
import { compareProcessIdentity, defaultProcessIdentity } from "../process-identity.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { sameOpenedFileIdentity } from "../fs-identity.js";

const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LOCK_BYTES = 4 * 1024;
const LOCK_WAIT_MS = 5_000;
const STORE_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 60 * 60_000;
const DEFAULT_CAPACITY = 2_048;
const DEFAULT_STARTUP_GRACE_MS = 30_000;
const MAX_INBOUND_ATTEMPTS = 3;
const EVENT_SPOOL_BYTES = 2 * 1024 * 1024;
const EVENT_SPOOL_ITEM_BYTES = 128 * 1024;
const EVENT_SPOOL_CAPACITY = 128;
const EVENT_SPOOL_MAX_ATTEMPTS = 5;
const FLOW_RUN_FILE_BYTES = 128 * 1024;
const FLOW_RUN_OUTPUT_BYTES = 64 * 1024;
const FLOW_RUN_TTL_MS = 24 * 60 * 60_000;
const FLOW_RUN_CAPACITY = 512;
const FLOW_RUN_MAX_ATTEMPTS = 3;
const FLOW_RUN_FILE = /^[a-f0-9]{64}\.json$/;
const RUN_OUTCOME_FILE_BYTES = 32 * 1024 * 1024;
const RUN_OUTCOME_MAX_REPLY_BYTES = 64 * 1024;
const RUN_OUTCOME_MAX_FILE_BYTES = 20 * 1024 * 1024;
const RUN_OUTCOME_MAX_FILES = 4;
const RUN_OUTCOME_TTL_MS = 24 * 60 * 60_000;
const RUN_OUTCOME_CAPACITY = 32;
const RUN_OUTCOME_TOMBSTONE_CAPACITY = 2_048;
const RUN_OUTCOME_FILE = /^[a-f0-9]{64}\.json$/;

interface LeaseRecord {
  pid: number;
  token: string;
  startedAt: number;
  platform: string;
  /** OS process birth identity, so a recycled PID cannot keep or lose another process' lease. */
  birthIdentity?: string;
}

interface LeaseSnapshot {
  record: LeaseRecord;
  dev: number;
  ino: number;
  /** A fully-written staging inode that was atomically linked into place but not yet unlinked. */
  stagingPath?: string;
}

interface ProcessedMessage {
  id: string;
  seenAt: number;
  /** Present only while a poison event remains retryable. Completion omits it. */
  failedAttempts?: number;
}

interface ProcessedStore {
  version: 1;
  messages: ProcessedMessage[];
}

interface EventSpoolRecord {
  id: string;
  receivedAt: number;
  attempts: number;
  availableAt: number;
  payload: unknown;
}

interface EventSpoolStore {
  version: 1;
  items: EventSpoolRecord[];
}

interface StoredFlowRun {
  version: 1;
  /** Opaque hash of the credential-scoped platform event. Used only for post-ACK cleanup. */
  source: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: "running" | "ready" | "failed" | "complete" | "exhausted";
  alarmed: boolean;
  /** Immutable, bounded no-tool model result. It is private state and never contains credentials. */
  output?: string;
}

interface StoredRunOutcome {
  version: 1;
  status: "running" | "complete" | "terminal" | "acknowledged";
  createdAt: number;
  reply: string;
  files: { safeName: string; bytes: string }[];
  /** Synthesized default voice reply. Kept separate so a failed voice upload can retry without rerunning TTS. */
  voice?: { safeName: string; bytes: string };
}

interface InFlightMessage {
  outcome: Promise<boolean>;
  resolve(completed: boolean): void;
}

interface FailedMessage {
  attempts: number;
  lastAt: number;
  alarmed: boolean;
}

type ClaimAttempt =
  | { kind: "claim"; claim: GatewayMessageClaim }
  | { kind: "wait"; outcome: Promise<boolean> }
  | { kind: "duplicate" };

export interface GatewayRuntimeOptions {
  home?: string;
  /** Human-readable canonical platform used only in operator errors; state keys remain credential-scoped. */
  displayPlatform?: string;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
  ttlMs?: number;
  capacity?: number;
  startupGraceMs?: number;
}

export interface GatewayMessageClaimOptions {
  /** The event is backed by durable local state and must survive the fresh-process stale-event filter. */
  durable?: boolean;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function checkedPlatform(value: string): string {
  const platform = value.trim().toLowerCase();
  if (!PLATFORM.test(platform)) throw new Error(`invalid gateway platform '${value}'`);
  return platform;
}

/** Private stable namespace: same bot credential collides, different bots do not, raw identity never hits disk/logs. */
export function gatewayRuntimeScope(platformValue: string, connectionIdentity?: string): string {
  const platform = checkedPlatform(platformValue);
  if (!connectionIdentity) return platform;
  const digest = createHash("sha256").update(connectionIdentity).digest("hex").slice(0, 16);
  return checkedPlatform(`${platform}-${digest}`);
}

function stateDirectory(home: string): string {
  return ensurePrivateStateSubdirectory(home, [".hara", "gateway"]).path;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function leaseOwnerAlive(
  record: LeaseRecord,
  pidAlive: (pid: number) => boolean,
  processIdentity: (pid: number) => string | null,
): boolean {
  if (!pidAlive(record.pid)) return false;
  // Old locks and temporarily unavailable OS probes are treated as live. This may require manual recovery,
  // but can never steal a live process' lease. New locks carry an identity and safely detect PID reuse.
  if (!record.birthIdentity) return true;
  const current = processIdentity(record.pid);
  return compareProcessIdentity(record.birthIdentity, current) !== "different";
}

function validLease(value: unknown, platform: string): LeaseRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<LeaseRecord>;
  return Number.isSafeInteger(record.pid)
    && (record.pid as number) > 0
    && typeof record.token === "string"
    && /^[a-f0-9]{32}$/.test(record.token)
    && Number.isFinite(record.startedAt)
    && (record.startedAt as number) > 0
    && record.platform === platform
    && (
      record.birthIdentity === undefined
      || (typeof record.birthIdentity === "string" && /^[\x20-\x7e]{1,256}$/.test(record.birthIdentity))
    )
    ? record as LeaseRecord
    : null;
}

function leaseStagingPath(path: string, record: LeaseRecord): string {
  return `${path}.${record.pid}.${record.token}.pending`;
}

function readLease(path: string, platform: string): LeaseSnapshot | null {
  let fd: number;
  try {
    // O_NONBLOCK is inert for regular files and prevents a hostile FIFO/device at the lock path from hanging
    // gateway startup before fstat can reject it.
    fd = openSync(
      path,
      constants.O_RDONLY | optionalPosixOpenFlag("O_NOFOLLOW") | optionalPosixOpenFlag("O_NONBLOCK"),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink < 1 || info.nlink > 2 || info.size <= 0 || info.size > LOCK_BYTES) {
      throw new Error(`refusing malformed gateway instance lock: ${path}`);
    }
    const readBounded = (): Buffer => {
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) break;
        offset += count;
      }
      if (offset !== bytes.length) throw new Error(`refusing concurrently changed gateway instance lock: ${path}`);
      return bytes;
    };
    let parsed: unknown;
    try {
      const first = readBounded();
      const second = readBounded();
      const after = fstatSync(fd);
      if (
        !first.equals(second)
        || !after.isFile()
        || after.dev !== info.dev
        || after.ino !== info.ino
        || after.mode !== info.mode
        || after.nlink !== info.nlink
        || after.size !== info.size
        || after.mtimeMs !== info.mtimeMs
        || after.ctimeMs !== info.ctimeMs
      ) throw new Error("changed while reading");
      parsed = JSON.parse(first.toString("utf8"));
    } catch {
      throw new Error(`refusing malformed gateway instance lock: ${path}`);
    }
    const record = validLease(parsed, platform);
    if (!record) throw new Error(`refusing malformed gateway instance lock: ${path}`);
    if (info.nlink === 1) return { record, dev: info.dev, ino: info.ino };

    // `writeLease` publishes with link(2): readers may observe two names for the same inode between the
    // atomic no-replace link and staging cleanup. Accept only that exact private, token-bound sibling.
    const stagingPath = leaseStagingPath(path, record);
    let staging;
    try {
      staging = lstatSync(stagingPath);
    } catch {
      const refreshed = fstatSync(fd);
      if (
        refreshed.isFile()
        && refreshed.nlink === 1
        && refreshed.dev === info.dev
        && refreshed.ino === info.ino
      ) return { record, dev: info.dev, ino: info.ino };
      throw new Error(`refusing malformed gateway instance lock: ${path}`);
    }
    if (
      !staging.isFile()
      || staging.isSymbolicLink()
      || staging.nlink !== 2
      || !sameOpenedFileIdentity(staging, info)
    ) throw new Error(`refusing malformed gateway instance lock: ${path}`);
    return { record, dev: info.dev, ino: info.ino, stagingPath };
  } finally {
    closeSync(fd);
  }
}

function sameLease(left: LeaseSnapshot | null, right: LeaseSnapshot | null): boolean {
  return Boolean(
    left
    && right
    && sameOpenedFileIdentity(left, right)
    && left.record.pid === right.record.pid
    && left.record.token === right.record.token,
  );
}

function unlinkLease(path: string, expected: LeaseSnapshot): void {
  let current = lstatSync(path);
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink < 1
    || current.nlink > 2
    || !sameOpenedFileIdentity(current, expected)
  ) throw new Error(`gateway instance lock changed before removal: ${path}`);

  if (current.nlink === 2) {
    if (!expected.stagingPath) throw new Error(`gateway instance lock changed before removal: ${path}`);
    const staging = lstatSync(expected.stagingPath);
    if (
      !staging.isFile()
      || staging.isSymbolicLink()
      || staging.nlink !== 2
      || !sameOpenedFileIdentity(staging, expected)
    ) throw new Error(`gateway instance lock changed before removal: ${path}`);
    unlinkSync(expected.stagingPath);
    current = lstatSync(path);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || !sameOpenedFileIdentity(current, expected)
    ) throw new Error(`gateway instance lock changed before removal: ${path}`);
  }
  unlinkSync(path);
}

function writeLease(path: string, record: LeaseRecord): LeaseSnapshot {
  const stagingPath = leaseStagingPath(path, record);
  let fd: number | undefined;
  let published = false;
  try {
    // Never expose an empty/partial owner record at the canonical path. The private staging inode is fully
    // written + fsynced first; link(2) then publishes it atomically and refuses to replace an existing owner.
    fd = openSync(stagingPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(stagingPath, path);
    published = true;
    try {
      unlinkSync(stagingPath);
    } catch {
      // A crash or cleanup failure here is safe: readLease recognizes only this token-bound second name.
    }
    const owned = readLease(path, record.platform);
    if (!owned || owned.record.token !== record.token || owned.record.pid !== record.pid) {
      throw new Error(`gateway instance lock changed during acquisition: ${path}`);
    }
    return owned;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!published) {
      try {
        unlinkSync(stagingPath);
      } catch {
        // Preserve the acquisition error; an unlinked-to staging file cannot claim the platform.
      }
    }
  }
}

/** Claim the one supported gateway process for a platform. Stale owners are reclaimed only after PID proof. */
export function acquireGatewayInstance(platformValue: string, options: GatewayRuntimeOptions = {}): () => void {
  const platform = checkedPlatform(platformValue);
  const displayPlatform = checkedPlatform(options.displayPlatform ?? platform);
  const dir = stateDirectory(options.home ?? homedir());
  const lock = join(dir, `instance-${platform}.lock`);
  const reclaim = `${lock}.reclaim`;
  const now = options.now ?? Date.now;
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const processIdentity = options.processIdentity ?? defaultProcessIdentity;
  const birthIdentity = processIdentity(process.pid);
  const claim: LeaseRecord = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    startedAt: now(),
    platform,
    ...(birthIdentity ? { birthIdentity } : {}),
  };
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    const existingGuard = readLease(reclaim, platform);
    if (existingGuard) {
      if (!leaseOwnerAlive(existingGuard.record, pidAlive, processIdentity)) {
        const current = readLease(reclaim, platform);
        if (sameLease(existingGuard, current) && current && !leaseOwnerAlive(current.record, pidAlive, processIdentity)) {
          unlinkLease(reclaim, current);
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error(`gateway '${displayPlatform}' instance recovery is busy; retry shortly`);
      sleepSync(10);
      continue;
    }

    try {
      const owned = writeLease(lock, claim);
      let released = false;
      return () => {
        if (released) return;
        const current = readLease(lock, platform);
        if (sameLease(owned, current) && current) unlinkLease(lock, current);
        released = true;
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const held = readLease(lock, platform);
    if (!held) continue;
    if (leaseOwnerAlive(held.record, pidAlive, processIdentity)) {
      throw new Error(
        `gateway '${displayPlatform}' is already running (pid ${held.record.pid}); stop that process before starting another`,
      );
    }

    const guardRecord: LeaseRecord = {
      pid: process.pid,
      token: randomBytes(16).toString("hex"),
      startedAt: now(),
      platform,
      ...(birthIdentity ? { birthIdentity } : {}),
    };
    let guard: LeaseSnapshot | undefined;
    try {
      guard = writeLease(reclaim, guardRecord);
      const current = readLease(lock, platform);
      if (sameLease(held, current) && current && !leaseOwnerAlive(current.record, pidAlive, processIdentity)) unlinkLease(lock, current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      if (guard) {
        const currentGuard = readLease(reclaim, platform);
        if (sameLease(guard, currentGuard) && currentGuard) unlinkLease(reclaim, currentGuard);
      }
    }
    if (Date.now() >= deadline) throw new Error(`gateway '${displayPlatform}' stale instance could not be reclaimed`);
  }
}

function parseProcessedStore(snapshot: PrivateStateFileSnapshot | null, path: string): ProcessedMessage[] {
  if (!snapshot) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text);
  } catch {
    throw new Error(`invalid gateway message dedupe store: ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid gateway message dedupe store: ${path}`);
  }
  const store = parsed as Partial<ProcessedStore>;
  if (store.version !== 1 || !Array.isArray(store.messages) || store.messages.length > DEFAULT_CAPACITY * 4) {
    throw new Error(`invalid gateway message dedupe store: ${path}`);
  }
  const messages: ProcessedMessage[] = [];
  for (const entry of store.messages) {
    if (
      typeof entry !== "object"
      || entry === null
      || typeof (entry as ProcessedMessage).id !== "string"
      || !(entry as ProcessedMessage).id
      || (entry as ProcessedMessage).id.length > 512
      || !Number.isFinite((entry as ProcessedMessage).seenAt)
      || (entry as ProcessedMessage).seenAt <= 0
    ) throw new Error(`invalid gateway message dedupe store: ${path}`);
    const failedAttempts = (entry as ProcessedMessage).failedAttempts;
    if (
      failedAttempts !== undefined
      && (!Number.isInteger(failedAttempts) || failedAttempts < 1 || failedAttempts >= MAX_INBOUND_ATTEMPTS)
    ) throw new Error(`invalid gateway message dedupe store: ${path}`);
    messages.push({
      id: (entry as ProcessedMessage).id,
      seenAt: (entry as ProcessedMessage).seenAt,
      ...(failedAttempts !== undefined ? { failedAttempts } : {}),
    });
  }
  return messages;
}

/** A serialized, crash-safe, bounded id cache. Completions and real-failure budgets survive restarts. */
export class GatewayMessageDeduper {
  private readonly path: string;
  private readonly dir: string;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly startupGraceMs: number;
  private readonly inFlight = new Map<string, InFlightMessage>();
  private readonly failures = new Map<string, FailedMessage>();
  private queue: Promise<void> = Promise.resolve();

  private constructor(platform: string, options: GatewayRuntimeOptions) {
    this.dir = stateDirectory(options.home ?? homedir());
    this.path = join(this.dir, `processed-${platform}.json`);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.ttlMs = Math.max(1_000, Math.min(options.ttlMs ?? DEFAULT_TTL_MS, 24 * 60 * 60_000));
    this.capacity = Math.max(1, Math.min(options.capacity ?? DEFAULT_CAPACITY, DEFAULT_CAPACITY));
    this.startupGraceMs = Math.max(0, Math.min(options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS, 5 * 60_000));
  }

  static async open(platformValue: string, options: GatewayRuntimeOptions = {}): Promise<GatewayMessageDeduper> {
    const instance = new GatewayMessageDeduper(checkedPlatform(platformValue), options);
    const snapshot = await readPrivateStateFileSnapshot(instance.path, STORE_BYTES);
    parseProcessedStore(snapshot, instance.path); // fail closed before opening the platform socket
    return instance;
  }

  async claim(
    messageId: string | undefined,
    createdAtMs?: number,
    options: GatewayMessageClaimOptions = {},
  ): Promise<GatewayMessageClaim | null> {
    // A platform may redeliver while the first callback is still running. Wait for that exact claim to settle:
    // success means duplicate, failure means one waiter takes over. Never await while holding `queue`, because
    // the owner's complete/release operation must use the same serializer.
    for (;;) {
      const attempt = await this.serialize(() => this.tryClaimOne(messageId, createdAtMs, options.durable === true));
      if (attempt.kind === "claim") return attempt.claim;
      if (attempt.kind === "duplicate") return null;
      if (await attempt.outcome) return null;
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async tryClaimOne(messageId: string | undefined, createdAtMs?: number, durable = false): Promise<ClaimAttempt> {
    if (messageId === undefined) return { kind: "claim", claim: noOpMessageClaim() }; // adapters without stable ids keep their existing behavior
    const id = messageId.trim();
    if (!id || id.length > 512 || id.includes("\0")) return { kind: "duplicate" };
    if (!durable && Number.isFinite(createdAtMs) && (createdAtMs as number) < this.startedAt - this.startupGraceMs) {
      return { kind: "duplicate" };
    }
    const active = this.inFlight.get(id);
    if (active) return { kind: "wait", outcome: active.outcome };

    const now = this.now();
    const snapshot = await readPrivateStateFileSnapshot(this.path, STORE_BYTES);
    const cutoff = now - this.ttlMs;
    const recent = parseProcessedStore(snapshot, this.path).filter((entry) => entry.seenAt >= cutoff);
    const persisted = recent.find((entry) => entry.id === id);
    if (persisted && persisted.failedAttempts === undefined) return { kind: "duplicate" };
    const memoryFailure = this.failures.get(id);
    if (memoryFailure && now - memoryFailure.lastAt >= this.ttlMs) this.failures.delete(id);
    if (persisted?.failedAttempts !== undefined) {
      const current = this.failures.get(id);
      if (!current || current.attempts < persisted.failedAttempts) {
        this.failures.set(id, { attempts: persisted.failedAttempts, lastAt: persisted.seenAt, alarmed: false });
      }
    }
    const failed = this.failures.get(id);
    if (failed && failed.attempts >= MAX_INBOUND_ATTEMPTS) {
      await this.deadLetter(id, failed);
      return { kind: "duplicate" };
    }
    let resolveOutcome!: (completed: boolean) => void;
    const activeClaim: InFlightMessage = {
      outcome: new Promise<boolean>((resolve) => { resolveOutcome = resolve; }),
      resolve: (completed) => resolveOutcome(completed),
    };
    this.inFlight.set(id, activeClaim);

    let settlement: Promise<{ exhausted: boolean }> | undefined;
    const settle = (mode: "complete" | "release" | "fail"): Promise<{ exhausted: boolean }> => {
      if (settlement) return settlement;
      settlement = this.serialize(async () => {
        try {
          let completed = false;
          let exhausted = false;
          if (mode === "complete") {
            try {
              await this.persistCompleted(id);
              this.failures.delete(id);
              completed = true;
            } catch (error) {
              const failure = this.recordFailure(id);
              if (failure.attempts < MAX_INBOUND_ATTEMPTS) throw error;
              await this.deadLetter(id, failure);
              completed = true; // process-local exhaustion still breaks a loop when the state file is broken
              exhausted = true;
            }
          } else if (mode === "fail") {
            const failure = this.recordFailure(id);
            if (failure.attempts >= MAX_INBOUND_ATTEMPTS) {
              await this.deadLetter(id, failure);
              completed = true;
              exhausted = true;
            } else {
              await this.persistFailure(id, failure);
            }
          }
          if (this.inFlight.get(id) === activeClaim) this.inFlight.delete(id);
          activeClaim.resolve(completed);
          return { exhausted };
        } catch (error) {
          if (this.inFlight.get(id) === activeClaim) this.inFlight.delete(id);
          activeClaim.resolve(false);
          throw error;
        }
      });
      return settlement;
    };
    return {
      kind: "claim",
      claim: {
        complete: async () => { await settle("complete"); },
        release: async () => { await settle("release"); },
        fail: async () => (await settle("fail")).exhausted,
      },
    };
  }

  private recordFailure(id: string): FailedMessage {
    const now = this.now();
    const current = this.failures.get(id);
    this.failures.delete(id);
    const next = { attempts: (current?.attempts ?? 0) + 1, lastAt: now, alarmed: current?.alarmed ?? false };
    this.failures.set(id, next);
    // The same bounded capacity as the persistent store prevents rotating failed ids from growing memory.
    while (this.failures.size > this.capacity) {
      const oldest = this.failures.keys().next().value as string | undefined;
      if (!oldest) break;
      this.failures.delete(oldest);
    }
    return next;
  }

  private async deadLetter(id: string, failure: FailedMessage): Promise<void> {
    let persisted = false;
    try {
      await this.persistCompleted(id);
      persisted = true;
    } catch {
      // Continue with the process-local exhausted state. A broken disk must not turn a full-auto coding event
      // back into an infinite execution loop; the explicit alarm below makes durability loss observable.
    }
    if (!failure.alarmed) {
      failure.alarmed = true;
      const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
      console.error(
        `hara gateway: ALERT inbound event ${digest} stopped after ${MAX_INBOUND_ATTEMPTS} failed attempts — acknowledged to break the execution loop${persisted ? "" : " (dedupe persistence unavailable)"}`,
      );
    }
    if (persisted) this.failures.delete(id);
  }

  private async persistCompleted(id: string): Promise<void> {
    const now = this.now();
    const snapshot = await readPrivateStateFileSnapshot(this.path, STORE_BYTES);
    const cutoff = now - this.ttlMs;
    const recent = parseProcessedStore(snapshot, this.path).filter((entry) => entry.seenAt >= cutoff && entry.id !== id);

    recent.push({ id, seenAt: now });
    recent.sort((left, right) => left.seenAt - right.seenAt || left.id.localeCompare(right.id));
    let messages = recent.slice(-this.capacity);
    let payload = JSON.stringify({ version: 1, messages } satisfies ProcessedStore, null, 2) + "\n";
    while (Buffer.byteLength(payload, "utf8") > STORE_BYTES && messages.length > 1) {
      const averageBytes = Math.max(1, Math.ceil(Buffer.byteLength(payload, "utf8") / messages.length));
      const excess = Buffer.byteLength(payload, "utf8") - STORE_BYTES;
      messages = messages.slice(Math.max(1, Math.ceil(excess / averageBytes)));
      payload = JSON.stringify({ version: 1, messages } satisfies ProcessedStore, null, 2) + "\n";
    }
    if (Buffer.byteLength(payload, "utf8") > STORE_BYTES) {
      throw new Error(`gateway message id is too large for the bounded dedupe store: ${this.path}`);
    }
    const boundary = bindHaraPrivateStateWritePath(this.path, this.dir, "write gateway message dedupe state");
    await atomicWriteText(this.path, payload, {
      expected: snapshot?.text ?? null,
      expectedIdentity: snapshot
        ? { dev: snapshot.dev, ino: snapshot.ino, mode: snapshot.mode, nlink: snapshot.nlink }
        : undefined,
      mode: 0o600,
      boundary,
    });
  }

  private async persistFailure(id: string, failure: FailedMessage): Promise<void> {
    const snapshot = await readPrivateStateFileSnapshot(this.path, STORE_BYTES);
    const cutoff = failure.lastAt - this.ttlMs;
    const recent = parseProcessedStore(snapshot, this.path).filter((entry) => entry.seenAt >= cutoff && entry.id !== id);
    recent.push({ id, seenAt: failure.lastAt, failedAttempts: failure.attempts });
    recent.sort((left, right) => left.seenAt - right.seenAt || left.id.localeCompare(right.id));
    let messages = recent.slice(-this.capacity);
    let payload = JSON.stringify({ version: 1, messages } satisfies ProcessedStore, null, 2) + "\n";
    while (Buffer.byteLength(payload, "utf8") > STORE_BYTES && messages.length > 1) {
      const averageBytes = Math.max(1, Math.ceil(Buffer.byteLength(payload, "utf8") / messages.length));
      const excess = Buffer.byteLength(payload, "utf8") - STORE_BYTES;
      messages = messages.slice(Math.max(1, Math.ceil(excess / averageBytes)));
      payload = JSON.stringify({ version: 1, messages } satisfies ProcessedStore, null, 2) + "\n";
    }
    if (Buffer.byteLength(payload, "utf8") > STORE_BYTES) {
      throw new Error(`gateway failure id is too large for the bounded dedupe store: ${this.path}`);
    }
    const boundary = bindHaraPrivateStateWritePath(this.path, this.dir, "write gateway message failure state");
    await atomicWriteText(this.path, payload, {
      expected: snapshot?.text ?? null,
      expectedIdentity: snapshot
        ? { dev: snapshot.dev, ino: snapshot.ino, mode: snapshot.mode, nlink: snapshot.nlink }
        : undefined,
      mode: 0o600,
      boundary,
    });
  }
}

export interface GatewayMessageClaim {
  /** Persist this id only after the whole inbound handler finishes successfully. */
  complete(): Promise<void>;
  /** Release for shutdown/administrative cancellation without consuming a failure attempt. */
  release(): Promise<void>;
  /** Count a real handling failure. Returns true when the bounded attempts are exhausted and must be ACKed. */
  fail(): Promise<boolean>;
}

function noOpMessageClaim(): GatewayMessageClaim {
  return { complete: async () => {}, release: async () => {}, fail: async () => false };
}

function parseEventSpool(snapshot: PrivateStateFileSnapshot | null, path: string): EventSpoolRecord[] {
  if (!snapshot) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.text);
  } catch {
    throw new Error(`invalid gateway event spool: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid gateway event spool: ${path}`);
  }
  const store = parsed as Partial<EventSpoolStore>;
  if (store.version !== 1 || !Array.isArray(store.items) || store.items.length > EVENT_SPOOL_CAPACITY) {
    throw new Error(`invalid gateway event spool: ${path}`);
  }
  const seen = new Set<string>();
  return store.items.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid gateway event spool: ${path}`);
    const item = value as Partial<EventSpoolRecord>;
    if (
      typeof item.id !== "string"
      || !item.id
      || item.id.length > 512
      || item.id.includes("\0")
      || seen.has(item.id)
      || !Number.isFinite(item.receivedAt)
      || (item.receivedAt as number) <= 0
      || !Number.isSafeInteger(item.attempts)
      || (item.attempts as number) < 0
      || (item.attempts as number) >= EVENT_SPOOL_MAX_ATTEMPTS
      || !Number.isFinite(item.availableAt)
      || (item.availableAt as number) <= 0
      || !item.payload
      || typeof item.payload !== "object"
      || Array.isArray(item.payload)
    ) throw new Error(`invalid gateway event spool: ${path}`);
    const payloadText = JSON.stringify(item.payload);
    if (Buffer.byteLength(payloadText, "utf8") > EVENT_SPOOL_ITEM_BYTES) {
      throw new Error(`invalid gateway event spool: ${path}`);
    }
    seen.add(item.id);
    return item as EventSpoolRecord;
  });
}

export interface GatewaySpoolItem {
  readonly id: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export interface GatewaySpoolRetry {
  exhausted: boolean;
  attempts: number;
  retryAfterMs: number;
}

/** Private crash-safe queue used when a platform protocol requires an ACK before agent work can finish.
 * Payloads are bounded and owner-only; ids are credential-scoped by the caller's spool namespace. */
export class GatewayEventSpool {
  private readonly path: string;
  private readonly dir: string;
  private readonly now: () => number;
  private items: EventSpoolRecord[];
  private expectedText: string | null;
  private expectedIdentity: { dev: number; ino: number; mode: number; nlink: number } | undefined;
  private readonly leased = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  private constructor(scope: string, options: GatewayRuntimeOptions, snapshot: PrivateStateFileSnapshot | null) {
    this.dir = stateDirectory(options.home ?? homedir());
    this.path = join(this.dir, `inbound-${scope}.json`);
    this.now = options.now ?? Date.now;
    this.items = parseEventSpool(snapshot, this.path);
    this.expectedText = snapshot?.text ?? null;
    this.expectedIdentity = snapshot
      ? { dev: snapshot.dev, ino: snapshot.ino, mode: snapshot.mode, nlink: snapshot.nlink }
      : undefined;
  }

  static async open(scopeValue: string, options: GatewayRuntimeOptions = {}): Promise<GatewayEventSpool> {
    const scope = checkedPlatform(scopeValue);
    const dir = stateDirectory(options.home ?? homedir());
    const path = join(dir, `inbound-${scope}.json`);
    const snapshot = await readPrivateStateFileSnapshot(path, EVENT_SPOOL_BYTES);
    return new GatewayEventSpool(scope, options, snapshot);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async commit(items: EventSpoolRecord[]): Promise<void> {
    const text = JSON.stringify({ version: 1, items } satisfies EventSpoolStore, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > EVENT_SPOOL_BYTES) throw new Error("gateway event spool is full");
    const boundary = bindHaraPrivateStateWritePath(this.path, this.dir, "write gateway event spool");
    const written = await atomicWriteText(this.path, text, {
      expected: this.expectedText,
      expectedIdentity: this.expectedIdentity,
      mode: 0o600,
      boundary,
    });
    this.items = items;
    this.expectedText = text;
    this.expectedIdentity = { dev: written.dev, ino: written.ino, mode: written.mode, nlink: written.nlink };
  }

  /** Persist before ACK. false means the same platform event is already queued/in progress. */
  enqueue(idValue: string, payload: unknown): Promise<boolean> {
    return this.serialize(async () => {
      const id = idValue.trim();
      if (!id || id.length > 512 || id.includes("\0")) throw new Error("invalid gateway event id");
      if (this.items.some((item) => item.id === id)) return false;
      if (this.items.length >= EVENT_SPOOL_CAPACITY) throw new Error("gateway event spool is full");
      let payloadText: string;
      try {
        payloadText = JSON.stringify(payload);
      } catch {
        throw new Error("gateway event payload is not serializable");
      }
      if (!payloadText || Buffer.byteLength(payloadText, "utf8") > EVENT_SPOOL_ITEM_BYTES) {
        throw new Error("gateway event payload exceeds the spool limit");
      }
      const safePayload = JSON.parse(payloadText) as unknown;
      if (!safePayload || typeof safePayload !== "object" || Array.isArray(safePayload)) {
        throw new Error("gateway event payload must be an object");
      }
      const now = this.now();
      await this.commit([...this.items, { id, payload: safePayload, receivedAt: now, attempts: 0, availableAt: now }]);
      return true;
    });
  }

  nextReady(): Promise<GatewaySpoolItem | null> {
    return this.serialize(async () => {
      const now = this.now();
      const item = this.items.find((candidate) => candidate.availableAt <= now && !this.leased.has(candidate.id));
      if (item) this.leased.add(item.id);
      return item ? { id: item.id, payload: item.payload, attempts: item.attempts } : null;
    });
  }

  complete(id: string): Promise<void> {
    return this.serialize(async () => {
      this.leased.delete(id);
      const items = this.items.filter((item) => item.id !== id);
      if (items.length !== this.items.length) await this.commit(items);
    });
  }

  retry(id: string): Promise<GatewaySpoolRetry> {
    return this.serialize(async () => {
      this.leased.delete(id);
      const index = this.items.findIndex((item) => item.id === id);
      if (index < 0) return { exhausted: false, attempts: 0, retryAfterMs: 0 };
      const attempts = this.items[index].attempts + 1;
      if (attempts >= EVENT_SPOOL_MAX_ATTEMPTS) {
        await this.commit(this.items.filter((item) => item.id !== id));
        return { exhausted: true, attempts, retryAfterMs: 0 };
      }
      const retryAfterMs = Math.min(30_000, 2_000 * (2 ** Math.max(0, attempts - 1)));
      const next = this.items.slice();
      next[index] = { ...next[index], attempts, availableAt: this.now() + retryAfterMs };
      await this.commit(next);
      return { exhausted: false, attempts, retryAfterMs };
    });
  }

  /** Keep the durable item but relinquish this process-local worker lease (used only during shutdown). */
  release(id: string): Promise<void> {
    return this.serialize(async () => { this.leased.delete(id); });
  }
}

export interface GatewayFlowRunClaim {
  readonly retry: boolean;
  readonly output: string | undefined;
  saveOutput(output: string): Promise<void>;
  complete(): Promise<void>;
  fail(): Promise<{ exhausted: boolean; alarm: boolean }>;
  /** Gateway shutdown is not a failed attempt. Preserve a generated decision but restore the prior budget. */
  release(): Promise<void>;
  markAlarmed(): Promise<void>;
}

export type GatewayFlowRunAdmission =
  | { kind: "claim"; claim: GatewayFlowRunClaim }
  | { kind: "backoff"; retryAfterMs: number }
  | { kind: "complete" }
  | { kind: "exhausted"; alarm: boolean };

function checkedFlowDigest(value: string, label: string): string {
  const digest = value.trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid gateway flow ${label}`);
  return digest;
}

function parseStoredFlowRun(snapshot: PrivateStateFileSnapshot, path: string): StoredFlowRun {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.text);
  } catch {
    throw new Error(`invalid gateway flow run: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid gateway flow run: ${path}`);
  const stored = value as Partial<StoredFlowRun>;
  if (
    stored.version !== 1
    || typeof stored.source !== "string"
    || !/^[a-f0-9]{64}$/.test(stored.source)
    || !Number.isFinite(stored.createdAt)
    || (stored.createdAt as number) <= 0
    || !Number.isFinite(stored.updatedAt)
    || (stored.updatedAt as number) < (stored.createdAt as number)
    || !Number.isInteger(stored.attempts)
    || (stored.attempts as number) < 0
    || (stored.attempts as number) > FLOW_RUN_MAX_ATTEMPTS
    || !Number.isFinite(stored.nextAttemptAt)
    || (stored.nextAttemptAt as number) < 0
    || !["running", "ready", "failed", "complete", "exhausted"].includes(String(stored.status))
    || typeof stored.alarmed !== "boolean"
    || (stored.output !== undefined && (
      typeof stored.output !== "string"
      || Buffer.byteLength(stored.output, "utf8") > FLOW_RUN_OUTPUT_BYTES
    ))
    || ((stored.status === "ready" || stored.status === "complete") && stored.output === undefined)
    || (stored.status === "exhausted" && (stored.attempts as number) < FLOW_RUN_MAX_ATTEMPTS)
  ) throw new Error(`invalid gateway flow run: ${path}`);
  return stored as StoredFlowRun;
}

/**
 * Private per-rule flow decisions and attempt budgets. A model decision is committed before the first delivery,
 * then reused byte-for-byte by every retry. One file per source/rule avoids rewriting unrelated model output.
 */
export class GatewayFlowRunStore {
  private readonly dir: string;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();

  private constructor(scope: string, options: GatewayRuntimeOptions) {
    const home = options.home ?? homedir();
    this.dir = ensurePrivateStateSubdirectory(home, [".hara", "gateway", `flow-runs-${scope}`]).path;
    this.now = options.now ?? Date.now;
  }

  static async open(scopeValue: string, options: GatewayRuntimeOptions = {}): Promise<GatewayFlowRunStore> {
    const store = new GatewayFlowRunStore(checkedPlatform(scopeValue), options);
    await store.prune();
    return store;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private runPath(runKeyValue: string): string {
    return join(this.dir, `${checkedFlowDigest(runKeyValue, "run key")}.json`);
  }

  private removeSnapshot(path: string, snapshot: PrivateStateFileSnapshot): void {
    const current = lstatSync(path);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || !sameOpenedFileIdentity(current, snapshot)
    ) throw new Error(`gateway flow run changed before removal: ${path}`);
    unlinkSync(path);
  }

  private async writeRecord(
    path: string,
    snapshot: PrivateStateFileSnapshot | null,
    record: StoredFlowRun,
  ): Promise<void> {
    const text = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(text, "utf8") > FLOW_RUN_FILE_BYTES) throw new Error("gateway flow decision exceeds the private cache limit");
    const boundary = bindHaraPrivateStateWritePath(path, this.dir, "write gateway flow run");
    await atomicWriteText(path, text, {
      expected: snapshot?.text ?? null,
      expectedIdentity: snapshot
        ? { dev: snapshot.dev, ino: snapshot.ino, mode: snapshot.mode, nlink: snapshot.nlink }
        : undefined,
      mode: 0o600,
      boundary,
    });
  }

  private async prune(): Promise<void> {
    const cutoff = this.now() - FLOW_RUN_TTL_MS;
    for (const name of readdirSync(this.dir)) {
      if (!FLOW_RUN_FILE.test(name)) continue;
      const path = join(this.dir, name);
      try {
        const snapshot = await readPrivateStateFileSnapshot(path, FLOW_RUN_FILE_BYTES);
        if (!snapshot) continue;
        const record = parseStoredFlowRun(snapshot, path);
        // The absolute lifetime is deliberately not refreshed by retries. It matches the 24-hour effect-receipt
        // horizon and prevents a poison event from retaining model text forever.
        if (record.createdAt < cutoff) this.removeSnapshot(path, snapshot);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  async claim(runKeyValue: string, sourceValue: string): Promise<GatewayFlowRunAdmission> {
    const runKey = checkedFlowDigest(runKeyValue, "run key");
    const source = checkedFlowDigest(sourceValue, "source key");
    return this.serialize(async () => {
      const path = this.runPath(runKey);
      let snapshot = await readPrivateStateFileSnapshot(path, FLOW_RUN_FILE_BYTES);
      let existing = snapshot ? parseStoredFlowRun(snapshot, path) : undefined;
      const now = this.now();
      if (snapshot && existing && now - existing.createdAt >= FLOW_RUN_TTL_MS) {
        this.removeSnapshot(path, snapshot);
        snapshot = null;
        existing = undefined;
      }
      if (existing && existing.source !== source) throw new Error(`gateway flow source mismatch: ${path}`);
      if (existing?.status === "complete") return { kind: "complete" };
      if (existing?.status === "exhausted") return { kind: "exhausted", alarm: !existing.alarmed };
      if (existing?.status === "failed" && now < existing.nextAttemptAt) {
        return { kind: "backoff", retryAfterMs: existing.nextAttemptAt - now };
      }
      if (existing && existing.attempts >= FLOW_RUN_MAX_ATTEMPTS) {
        const exhausted: StoredFlowRun = { ...existing, status: "exhausted", nextAttemptAt: 0, updatedAt: now };
        await this.writeRecord(path, snapshot, exhausted);
        return { kind: "exhausted", alarm: !exhausted.alarmed };
      }
      if (!existing) {
        let names = readdirSync(this.dir).filter((name) => FLOW_RUN_FILE.test(name));
        if (names.length >= FLOW_RUN_CAPACITY) {
          await this.prune();
          names = readdirSync(this.dir).filter((name) => FLOW_RUN_FILE.test(name));
          if (names.length >= FLOW_RUN_CAPACITY) {
            throw new Error("gateway flow decision cache is full; acknowledged-event cleanup or operator recovery is required");
          }
        }
      }
      const original = existing ? { ...existing } : undefined;
      const running: StoredFlowRun = {
        version: 1,
        source,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        attempts: (existing?.attempts ?? 0) + 1,
        nextAttemptAt: 0,
        status: "running",
        alarmed: existing?.alarmed ?? false,
        ...(existing?.output !== undefined ? { output: existing.output } : {}),
      };
      await this.writeRecord(path, snapshot, running);

      let settled = false;
      let failedResult: { exhausted: boolean; alarm: boolean } | undefined;
      const mutateActive = async (mutate: (current: StoredFlowRun, currentSnapshot: PrivateStateFileSnapshot) => Promise<void>): Promise<void> => {
        await this.serialize(async () => {
          const currentSnapshot = await readPrivateStateFileSnapshot(path, FLOW_RUN_FILE_BYTES);
          if (!currentSnapshot) throw new Error("gateway flow run disappeared while active");
          const current = parseStoredFlowRun(currentSnapshot, path);
          if (current.status !== "running" || current.attempts !== running.attempts || current.source !== source) {
            throw new Error("gateway flow run changed while active");
          }
          await mutate(current, currentSnapshot);
        });
      };
      const claim: GatewayFlowRunClaim = {
        retry: existing !== undefined,
        output: existing?.output,
        saveOutput: async (output: string): Promise<void> => {
          if (settled) throw new Error("gateway flow run is already settled");
          if (Buffer.byteLength(output, "utf8") > FLOW_RUN_OUTPUT_BYTES) throw new Error("gateway flow decision exceeds the private cache limit");
          await mutateActive(async (current, currentSnapshot) => {
            if (current.output !== undefined && current.output !== output) throw new Error("gateway flow decision is immutable across retries");
            await this.writeRecord(path, currentSnapshot, { ...current, output, updatedAt: this.now() });
          });
        },
        complete: async (): Promise<void> => {
          if (settled) return;
          await mutateActive(async (current, currentSnapshot) => {
            if (current.output === undefined) throw new Error("gateway flow decision was not persisted before completion");
            await this.writeRecord(path, currentSnapshot, { ...current, status: "complete", nextAttemptAt: 0, updatedAt: this.now() });
          });
          settled = true;
        },
        fail: async (): Promise<{ exhausted: boolean; alarm: boolean }> => {
          if (failedResult) return failedResult;
          if (settled) return { exhausted: false, alarm: false };
          await mutateActive(async (current, currentSnapshot) => {
            const exhausted = current.attempts >= FLOW_RUN_MAX_ATTEMPTS;
            const retryAfterMs = Math.min(30_000, 2_000 * (2 ** Math.max(0, current.attempts - 1)));
            const next: StoredFlowRun = {
              ...current,
              status: exhausted ? "exhausted" : "failed",
              nextAttemptAt: exhausted ? 0 : this.now() + retryAfterMs,
              updatedAt: this.now(),
            };
            await this.writeRecord(path, currentSnapshot, next);
            failedResult = { exhausted, alarm: exhausted && !next.alarmed };
          });
          settled = true;
          return failedResult ?? { exhausted: false, alarm: false };
        },
        release: async (): Promise<void> => {
          if (settled) return;
          await mutateActive(async (current, currentSnapshot) => {
            const output = current.output ?? original?.output;
            if (!original && output === undefined) {
              this.removeSnapshot(path, currentSnapshot);
              return;
            }
            const restored: StoredFlowRun = original
              ? {
                  ...original,
                  updatedAt: this.now(),
                  ...(output !== undefined ? { output } : {}),
                  ...(output !== undefined && original.output === undefined ? { status: "ready", nextAttemptAt: 0 } : {}),
                }
              : {
                  version: 1,
                  source,
                  createdAt: running.createdAt,
                  updatedAt: this.now(),
                  attempts: 0,
                  nextAttemptAt: 0,
                  status: "ready",
                  alarmed: false,
                  output: output!,
                };
            await this.writeRecord(path, currentSnapshot, restored);
          });
          settled = true;
        },
        markAlarmed: async (): Promise<void> => {
          await this.markAlarmed(runKey);
        },
      };
      return { kind: "claim", claim };
    });
  }

  async markAlarmed(runKeyValue: string): Promise<void> {
    const path = this.runPath(runKeyValue);
    await this.serialize(async () => {
      const snapshot = await readPrivateStateFileSnapshot(path, FLOW_RUN_FILE_BYTES);
      if (!snapshot) return;
      const current = parseStoredFlowRun(snapshot, path);
      if (current.status !== "exhausted" || current.alarmed) return;
      await this.writeRecord(path, snapshot, { ...current, alarmed: true, updatedAt: this.now() });
    });
  }

  /** Platform ACK cleanup. Both arguments and filenames are opaque hashes, so private message ids never land here. */
  async removeSource(sourceValue: string | undefined): Promise<void> {
    if (!sourceValue) return;
    const source = checkedFlowDigest(sourceValue, "source key");
    await this.serialize(async () => {
      for (const name of readdirSync(this.dir)) {
        if (!FLOW_RUN_FILE.test(name)) continue;
        const path = join(this.dir, name);
        const snapshot = await readPrivateStateFileSnapshot(path, FLOW_RUN_FILE_BYTES);
        if (!snapshot) continue;
        const record = parseStoredFlowRun(snapshot, path);
        if (record.source === source) this.removeSnapshot(path, snapshot);
      }
    });
  }

  /** Focused diagnostics/tests; values are bounded private state and the key itself is already opaque. */
  async load(runKeyValue: string): Promise<Pick<StoredFlowRun, "status" | "attempts" | "output" | "alarmed"> | null> {
    const path = this.runPath(runKeyValue);
    const snapshot = await readPrivateStateFileSnapshot(path, FLOW_RUN_FILE_BYTES);
    if (!snapshot) return null;
    const record = parseStoredFlowRun(snapshot, path);
    return {
      status: record.status,
      attempts: record.attempts,
      ...(record.output !== undefined ? { output: record.output } : {}),
      alarmed: record.alarmed,
    };
  }
}

export interface GatewayRunOutcome {
  reply: string;
  files: { safeName: string; bytes: Buffer }[];
  voice?: { safeName: string; bytes: Buffer };
}

export type GatewayRunOutcomeState =
  | { status: "running" }
  | { status: "terminal" }
  | ({ status: "complete" } & GatewayRunOutcome);

export type GatewayRunOutcomeRecovery = "missing" | "terminalized" | "already-terminal" | "removed";

function parseRunOutcome(snapshot: PrivateStateFileSnapshot, path: string): GatewayRunOutcomeState {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.text);
  } catch {
    throw new Error(`invalid gateway run outcome: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid gateway run outcome: ${path}`);
  const stored = value as Partial<StoredRunOutcome>;
  if (
    stored.version !== 1
    || !["running", "complete", "terminal", "acknowledged"].includes(String(stored.status))
    || !Number.isFinite(stored.createdAt)
    || (stored.createdAt as number) <= 0
    || typeof stored.reply !== "string"
    || Buffer.byteLength(stored.reply, "utf8") > RUN_OUTCOME_MAX_REPLY_BYTES
    || !Array.isArray(stored.files)
    || stored.files.length > RUN_OUTCOME_MAX_FILES
  ) throw new Error(`invalid gateway run outcome: ${path}`);
  if (stored.status !== "complete") {
    if (stored.reply || stored.files.length || stored.voice !== undefined) throw new Error(`invalid gateway run outcome: ${path}`);
    return { status: stored.status === "running" ? "running" : "terminal" };
  }
  let total = 0;
  const decodePayload = (file: unknown): { safeName: string; bytes: Buffer } => {
    if (
      !file
      || typeof file !== "object"
      || typeof (file as { safeName?: unknown }).safeName !== "string"
      || !(file as { safeName: string }).safeName
      || (file as { safeName: string }).safeName.length > 128
      || /[\\/\0]/u.test((file as { safeName: string }).safeName)
      || typeof (file as { bytes?: unknown }).bytes !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test((file as { bytes: string }).bytes)
    ) throw new Error(`invalid gateway run outcome: ${path}`);
    const payload = file as { safeName: string; bytes: string };
    const bytes = Buffer.from(payload.bytes, "base64");
    total += bytes.length;
    if (bytes.length > RUN_OUTCOME_MAX_FILE_BYTES || total > RUN_OUTCOME_MAX_FILE_BYTES) {
      throw new Error(`invalid gateway run outcome: ${path}`);
    }
    return { safeName: payload.safeName, bytes };
  };
  const files = stored.files.map(decodePayload);
  const voice = stored.voice === undefined ? undefined : decodePayload(stored.voice);
  return { status: "complete", reply: stored.reply, files, ...(voice ? { voice } : {}) };
}

function runOutcomeStorageStatus(snapshot: PrivateStateFileSnapshot, path: string): StoredRunOutcome["status"] {
  parseRunOutcome(snapshot, path); // strict full-shape validation first
  return (JSON.parse(snapshot.text) as StoredRunOutcome).status;
}

/** Stores a started tombstone before a default coding run and its completed result before chat delivery.
 * A crash/restart therefore never guesses that coding is safe to repeat: an unfinished tombstone becomes an
 * explicit recovery notice, while a completed immutable result is only resent. Each message gets a separate
 * bounded private file so a large attachment never rewrites unrelated outcomes. */
export class GatewayRunOutcomeStore {
  private readonly dir: string;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();

  private constructor(scope: string, options: GatewayRuntimeOptions) {
    const home = options.home ?? homedir();
    this.dir = ensurePrivateStateSubdirectory(home, [".hara", "gateway", `run-outcomes-${scope}`]).path;
    this.now = options.now ?? Date.now;
  }

  static async open(scopeValue: string, options: GatewayRuntimeOptions = {}): Promise<GatewayRunOutcomeStore> {
    const store = new GatewayRunOutcomeStore(checkedPlatform(scopeValue), options);
    await store.prune();
    return store;
  }

  private outcomePath(messageIdValue: string): string {
    const messageId = messageIdValue.trim();
    if (!messageId || messageId.length > 512 || messageId.includes("\0")) throw new Error("invalid gateway outcome message id");
    return join(this.dir, `${createHash("sha256").update(messageId).digest("hex")}.json`);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private removeSnapshot(path: string, snapshot: PrivateStateFileSnapshot): void {
    const current = lstatSync(path);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || !sameOpenedFileIdentity(current, snapshot)
    ) throw new Error(`gateway run outcome changed before removal: ${path}`);
    unlinkSync(path);
  }

  private async replaceWithMarker(
    path: string,
    snapshot: PrivateStateFileSnapshot,
    status: "terminal" | "acknowledged",
  ): Promise<void> {
    const text = JSON.stringify({
      version: 1,
      status,
      createdAt: this.now(),
      reply: "",
      files: [],
    } satisfies StoredRunOutcome) + "\n";
    const boundary = bindHaraPrivateStateWritePath(path, this.dir, `${status} gateway run outcome`);
    await atomicWriteText(path, text, {
      expected: snapshot.text,
      expectedIdentity: {
        dev: snapshot.dev,
        ino: snapshot.ino,
        mode: snapshot.mode,
        nlink: snapshot.nlink,
      },
      mode: 0o600,
      boundary,
    });
  }

  private async prune(): Promise<void> {
    const now = this.now();
    for (const name of readdirSync(this.dir)) {
      if (!RUN_OUTCOME_FILE.test(name)) continue;
      const path = join(this.dir, name);
      try {
        const snapshot = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
        if (!snapshot) continue;
        const storageStatus = runOutcomeStorageStatus(snapshot, path);
        if (storageStatus === "acknowledged") {
          // The adapter invokes remove only after the platform ACK is durable. If unlink failed after that
          // acknowledgement marker was committed, startup can finish the deletion without guessing.
          this.removeSnapshot(path, snapshot);
        } else if (storageStatus === "complete" && now - snapshot.mtimeMs >= RUN_OUTCOME_TTL_MS) {
          // Completed output can contain up to 20 MiB of attachment bytes, so payload retention has a TTL.
          // Never delete the execution marker, though: an offline durable platform event could arrive later
          // and otherwise rerun full-auto coding. A distinct terminal status remains fail-closed on redelivery,
          // but no longer consumes one of the 32 payload/in-progress slots.
          await this.replaceWithMarker(path, snapshot, "terminal");
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  /** Make one active slot without ever deleting an ambiguous execution marker. Completed payloads can be
   * compacted to terminal tombstones; 32 genuinely running records require explicit operator recovery. */
  private async makeRoomForStart(): Promise<void> {
    const records: {
      path: string;
      snapshot: PrivateStateFileSnapshot;
      status: StoredRunOutcome["status"];
    }[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!RUN_OUTCOME_FILE.test(name)) continue;
      const path = join(this.dir, name);
      const snapshot = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (!snapshot) continue;
      const status = runOutcomeStorageStatus(snapshot, path);
      if (status === "acknowledged") {
        this.removeSnapshot(path, snapshot);
        continue;
      }
      records.push({ path, snapshot, status });
    }
    const active = records.filter((record) => record.status === "running" || record.status === "complete");
    if (records.length >= RUN_OUTCOME_CAPACITY + RUN_OUTCOME_TOMBSTONE_CAPACITY) {
      throw new Error(
        "gateway run outcome tombstone cache is full; inspect the workspace and platform history, then recover "
          + "one known original message id with `hara gateway --platform <name> --recover-outcome <id> "
          + "--confirm-recovery delete-terminal:<id>`; Hara will not bulk-delete markers",
      );
    }
    if (active.length < RUN_OUTCOME_CAPACITY) {
      return;
    }
    const slotsNeeded = active.length - RUN_OUTCOME_CAPACITY + 1;
    const compactable = active
      .filter((record) => record.status === "complete")
      .sort((left, right) => left.snapshot.mtimeMs - right.snapshot.mtimeMs);
    if (compactable.length < slotsNeeded) {
      const ambiguous = active.length - compactable.length;
      throw new Error(
        `gateway run outcome cache has ${ambiguous} ambiguous interrupted runs; Hara will not rerun or delete them automatically. `
          + "After reviewing one original message id, free an active slot with `hara gateway --platform <name> "
          + "--recover-outcome <id> --confirm-recovery terminalize:<id>`",
      );
    }
    for (const record of compactable.slice(0, slotsNeeded)) {
      await this.replaceWithMarker(record.path, record.snapshot, "terminal");
    }
  }

  async load(messageId: string | undefined): Promise<GatewayRunOutcomeState | null> {
    if (messageId === undefined) return null;
    const path = this.outcomePath(messageId);
    const snapshot = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
    return snapshot ? parseRunOutcome(snapshot, path) : null;
  }

  /** Atomically records that execution is about to begin. null means this caller owns the fresh tombstone. */
  async start(messageId: string | undefined): Promise<GatewayRunOutcomeState | null> {
    if (messageId === undefined) return null;
    return this.serialize(async () => {
      const path = this.outcomePath(messageId);
      const existing = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (existing) return parseRunOutcome(existing, path);
      // The common path has fewer than 32 files and must not decode unrelated cached attachments merely to
      // start a run. A full/terminal-heavy directory takes the slower validated compaction path.
      if (readdirSync(this.dir).filter((name) => RUN_OUTCOME_FILE.test(name)).length >= RUN_OUTCOME_CAPACITY) {
        await this.makeRoomForStart();
      }
      const text = JSON.stringify({
        version: 1,
        status: "running",
        createdAt: this.now(),
        reply: "",
        files: [],
      } satisfies StoredRunOutcome) + "\n";
      const boundary = bindHaraPrivateStateWritePath(path, this.dir, "start gateway run outcome");
      try {
        await atomicWriteText(path, text, { expected: null, mode: 0o600, boundary });
        return null;
      } catch (error) {
        // Another local callback/process can only win by creating the same credential/message tombstone. Load
        // that durable result instead of treating the race as permission to execute a second time.
        if (!(error instanceof FileChangedError)) throw error;
        const raced = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
        if (!raced) throw error;
        return parseRunOutcome(raced, path);
      }
    });
  }

  /** Replaces a started tombstone with immutable output. The first completed execution always wins. */
  async finish(messageId: string | undefined, outcome: GatewayRunOutcome): Promise<void> {
    if (messageId === undefined) return;
    await this.serialize(async () => {
      const path = this.outcomePath(messageId);
      if (Buffer.byteLength(outcome.reply, "utf8") > RUN_OUTCOME_MAX_REPLY_BYTES || outcome.files.length > RUN_OUTCOME_MAX_FILES) {
        throw new Error("gateway run outcome exceeds the private cache limit");
      }
      let total = 0;
      const files = outcome.files.map((file) => {
        if (!file.safeName || file.safeName.length > 128 || /[\\/\0]/u.test(file.safeName)) {
          throw new Error("gateway run outcome has an invalid attachment name");
        }
        total += file.bytes.length;
        if (file.bytes.length > RUN_OUTCOME_MAX_FILE_BYTES || total > RUN_OUTCOME_MAX_FILE_BYTES) {
          throw new Error("gateway run outcome exceeds the private cache limit");
        }
        return { safeName: file.safeName, bytes: file.bytes.toString("base64") };
      });
      let voice: StoredRunOutcome["voice"];
      if (outcome.voice) {
        if (!outcome.voice.safeName || outcome.voice.safeName.length > 128 || /[\\/\0]/u.test(outcome.voice.safeName)) {
          throw new Error("gateway run outcome has an invalid voice attachment name");
        }
        total += outcome.voice.bytes.length;
        if (outcome.voice.bytes.length > RUN_OUTCOME_MAX_FILE_BYTES || total > RUN_OUTCOME_MAX_FILE_BYTES) {
          throw new Error("gateway run outcome exceeds the private cache limit");
        }
        voice = { safeName: outcome.voice.safeName, bytes: outcome.voice.bytes.toString("base64") };
      }
      const text = JSON.stringify({
        version: 1,
        status: "complete",
        createdAt: this.now(),
        reply: outcome.reply,
        files,
        ...(voice ? { voice } : {}),
      } satisfies StoredRunOutcome) + "\n";
      if (Buffer.byteLength(text, "utf8") > RUN_OUTCOME_FILE_BYTES) throw new Error("gateway run outcome exceeds the private cache limit");
      const existing = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (!existing) throw new Error("gateway run outcome was not started; refusing an unguarded completion");
      if (parseRunOutcome(existing, path).status === "complete") return;
      const boundary = bindHaraPrivateStateWritePath(path, this.dir, "write gateway run outcome");
      try {
        await atomicWriteText(path, text, {
          expected: existing.text,
          expectedIdentity: {
            dev: existing.dev,
            ino: existing.ino,
            mode: existing.mode,
            nlink: existing.nlink,
          },
          mode: 0o600,
          boundary,
        });
      } catch (error) {
        if (!(error instanceof FileChangedError)) throw error;
        const raced = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
        if (raced && parseRunOutcome(raced, path).status === "complete") return;
        throw error;
      }
    });
  }

  async remove(messageId: string | undefined): Promise<void> {
    if (messageId === undefined) return;
    await this.serialize(async () => {
      const path = this.outcomePath(messageId);
      const snapshot = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (!snapshot) return;
      // Persist proof that the adapter already observed a durable platform ACK before attempting unlink. If
      // deletion itself fails or the process crashes, prune() can safely finish it on restart.
      if (runOutcomeStorageStatus(snapshot, path) !== "acknowledged") {
        await this.replaceWithMarker(path, snapshot, "acknowledged");
      }
      const acknowledged = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (acknowledged) this.removeSnapshot(path, acknowledged);
    });
  }

  /** Explicit, single-record operator recovery by the original platform message id.
   *
   * `terminalize:<id>` can only preserve a running marker as a compact terminal marker; it never deletes it.
   * `delete-terminal:<id>` can only delete a marker that is already terminal. Keeping these as distinct
   * confirmations makes repeating the first command harmless and prevents an accidental running deletion.
   */
  async recover(messageIdValue: string, confirmationValue: string): Promise<GatewayRunOutcomeRecovery> {
    const messageId = messageIdValue.trim();
    if (!messageId || messageId.length > 512 || messageId.includes("\0")) {
      throw new Error("invalid gateway outcome message id");
    }
    const terminalizeConfirmation = `terminalize:${messageId}`;
    const deleteConfirmation = `delete-terminal:${messageId}`;
    if (confirmationValue !== terminalizeConfirmation && confirmationValue !== deleteConfirmation) {
      throw new Error(
        "confirmation must exactly match terminalize:<message-id> or delete-terminal:<message-id>",
      );
    }
    return this.serialize(async () => {
      const path = this.outcomePath(messageId);
      const snapshot = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (!snapshot) return "missing";
      const status = runOutcomeStorageStatus(snapshot, path);
      if (status === "complete") {
        throw new Error("refusing to discard a completed gateway outcome before its platform acknowledgement");
      }
      if (confirmationValue === terminalizeConfirmation) {
        if (status === "terminal" || status === "acknowledged") return "already-terminal";
        await this.replaceWithMarker(path, snapshot, "terminal");
        return "terminalized";
      }
      if (status === "running") {
        throw new Error(
          "refusing to delete an ambiguous running outcome; confirm terminalize:<message-id> first",
        );
      }
      // An acknowledged marker already carries durable proof that normal post-ACK cleanup may delete it.
      // For terminal markers, this explicit message-id-bound confirmation is the operator's recovery proof.
      if (status !== "acknowledged") await this.replaceWithMarker(path, snapshot, "acknowledged");
      const acknowledged = await readPrivateStateFileSnapshot(path, RUN_OUTCOME_FILE_BYTES);
      if (acknowledged) this.removeSnapshot(path, acknowledged);
      return "removed";
    });
  }
}

/** Tracks adapter callbacks that may outlive socket shutdown, so an instance lease is never released early. */
export class GatewayInboundTracker {
  private readonly tasks = new Set<Promise<unknown>>();

  get size(): number {
    return this.tasks.size;
  }

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }

  async drain(timeoutMs = 15_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("timeout must be a non-negative integer");
    const deadline = Date.now() + timeoutMs;
    if (!this.tasks.size) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      this.waitForIdle().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return settled;
  }
}
