import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "./private-state.js";

const SUBDIRECTORIES = ["computer-control"];
const LEASE_FILE = "desktop.json";
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_WORKERS = 64;

export interface ComputerLeaseOptions {
  /** Engine-selected state home; omitted for the current OS user's physical desktop. */
  home?: string;
  runId: string;
  sessionId?: string;
}

export interface ComputerLease {
  /** Release only this token. Pending/live workers retain ownership until they are cancelled/untracked. */
  release(): void;
  /** Persist a spawn reservation before creating a worker; an orphaned reservation cannot be reclaimed. */
  prepareWorker(): void;
  /** Cancel a reservation only when spawning failed synchronously and no worker was created. */
  cancelPreparedWorker(): void;
  /** Register a newly spawned input worker before allowing it to send any input. */
  trackWorker(pid: number): void;
  /** Call after the worker exits. A pending release completes after the last live worker is gone. */
  untrackWorker(pid: number): void;
}

interface ComputerLeaseRecord {
  version: 1;
  token: string;
  pid: number;
  runId: string;
  sessionId?: string;
  createdAt: number;
  workerPids?: number[];
  pendingWorkers?: number;
}

interface ComputerLeaseRuntime {
  pid: number;
  isProcessAlive(pid: number): boolean;
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // Only ESRCH proves death. Permissions and unexpected host failures must not authorize recovery.
    return error?.code !== "ESRCH";
  }
}

function parseRecord(text: string): ComputerLeaseRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Computer control lease is invalid; ownership was not changed."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Computer control lease is invalid; ownership was not changed.");
  }
  const record = value as Partial<ComputerLeaseRecord>;
  if (
    record.version !== 1
    || typeof record.token !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(record.token)
    || !validPid(record.pid)
    || !validIdentity(record.runId)
    || (record.sessionId !== undefined && !validIdentity(record.sessionId))
    || !Number.isSafeInteger(record.createdAt)
    || Number(record.createdAt) <= 0
    || (record.pendingWorkers !== undefined && (
      !Number.isSafeInteger(record.pendingWorkers)
      || record.pendingWorkers < 0
      || record.pendingWorkers > MAX_WORKERS
    ))
    || (record.workerPids !== undefined && (
      !Array.isArray(record.workerPids)
      || record.workerPids.length > MAX_WORKERS
      || !record.workerPids.every(validPid)
      || new Set(record.workerPids).size !== record.workerPids.length
      || record.workerPids.includes(record.pid)
    ))
    || (record.workerPids?.length ?? 0) + (record.pendingWorkers ?? 0) > MAX_WORKERS
  ) throw new Error("Computer control lease is invalid; ownership was not changed.");
  return record as ComputerLeaseRecord;
}

function serialize(record: ComputerLeaseRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function busy(record: ComputerLeaseRecord): Error {
  return new Error(
    `Computer control is busy: run '${record.runId}'${record.sessionId ? ` in session '${record.sessionId}'` : ""}`
    + ` owns the physical desktop (pid ${record.pid}). Wait for that action and its input workers to finish.`
    + ((record.pendingWorkers ?? 0) > 0 ? " An unresolved worker spawn retains ownership and requires diagnosis if its owner has died." : ""),
  );
}

function acquire(options: ComputerLeaseOptions, runtime: ComputerLeaseRuntime): ComputerLease {
  if (!validIdentity(options.runId) || (options.sessionId !== undefined && !validIdentity(options.sessionId))) {
    throw new TypeError("Computer control requires a valid engine-owned runId and optional sessionId.");
  }
  const home = options.home ?? homedir();
  const binding = bindPrivateHaraStateFile(home, SUBDIRECTORIES, LEASE_FILE);
  const withLock = <T>(fn: () => T): T => withPrivateStateLockSync(home, SUBDIRECTORIES, "desktop", fn, {
    attempts: 25,
    waitMs: 10,
    busyMessage: "Computer control lease is being updated by another process; retry the action.",
  });
  const claim: ComputerLeaseRecord = {
    version: 1,
    token: randomUUID(),
    pid: runtime.pid,
    runId: options.runId,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    createdAt: Date.now(),
    workerPids: [],
    pendingWorkers: 0,
  };

  withLock(() => {
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_RECORD_BYTES);
    if (snapshot) {
      const current = parseRecord(snapshot.text);
      // Never re-enter or refresh an existing run's ownership, even if its PID is no longer alive.
      // Timestamps are evidence only: a long-running owner/worker is never stolen through a TTL.
      if (
        current.runId === options.runId
        || (current.pendingWorkers ?? 0) > 0
        || runtime.isProcessAlive(current.pid)
        || current.workerPids?.some((pid) => runtime.isProcessAlive(pid))
      ) throw busy(current);
    }
    writePrivateStateFileSync(binding, serialize(claim), snapshot
      ? { expectedText: snapshot.text }
      : { expectedMissing: true });
  });

  let releaseRequested = false;
  let released = false;
  const currentClaim = () => {
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_RECORD_BYTES);
    const record = snapshot ? parseRecord(snapshot.text) : undefined;
    if (!snapshot || record?.token !== claim.token || record.pid !== claim.pid || record.runId !== claim.runId) {
      return undefined;
    }
    return { snapshot, record };
  };
  const finishRelease = (current: NonNullable<ReturnType<typeof currentClaim>>): boolean => {
    if ((current.record.pendingWorkers ?? 0) > 0) return false;
    if (current.record.workerPids?.some((pid) => runtime.isProcessAlive(pid))) return false;
    removePrivateStateFile(binding.path, current.snapshot, binding.directory);
    released = true;
    return true;
  };

  return {
    release() {
      if (released) return;
      releaseRequested = true;
      withLock(() => {
        const current = currentClaim();
        if (!current) { released = true; return; }
        finishRelease(current);
      });
    },
    prepareWorker() {
      if (releaseRequested || released) throw new Error("Computer control lease was released; no new input worker may be started.");
      withLock(() => {
        const current = currentClaim();
        if (!current) throw new Error("Computer control lease ownership changed; no new input worker may be started.");
        const pendingWorkers = current.record.pendingWorkers ?? 0;
        if ((current.record.workerPids?.length ?? 0) + pendingWorkers >= MAX_WORKERS) {
          throw new Error("Computer control lease has too many input workers.");
        }
        writePrivateStateFileSync(binding, serialize({ ...current.record, pendingWorkers: pendingWorkers + 1 }), {
          expectedText: current.snapshot.text,
        });
      });
    },
    cancelPreparedWorker() {
      if (released) return;
      withLock(() => {
        const current = currentClaim();
        if (!current) { released = true; return; }
        const pendingWorkers = current.record.pendingWorkers ?? 0;
        if (pendingWorkers === 0) throw new Error("Computer control lease has no pending input worker to cancel.");
        writePrivateStateFileSync(binding, serialize({ ...current.record, pendingWorkers: pendingWorkers - 1 }), {
          expectedText: current.snapshot.text,
        });
        if (releaseRequested) {
          const updated = currentClaim();
          if (updated) finishRelease(updated);
        }
      });
    },
    trackWorker(pid) {
      if (!validPid(pid) || pid === claim.pid) throw new TypeError("Computer input worker must have a distinct valid PID.");
      if (released) throw new Error("Computer control lease was released; no new input worker may be started.");
      withLock(() => {
        const current = currentClaim();
        if (!current) throw new Error("Computer control lease ownership changed; no new input worker may be started.");
        const workers = current.record.workerPids ?? [];
        if (workers.includes(pid)) return;
        const pendingWorkers = current.record.pendingWorkers ?? 0;
        if (releaseRequested && pendingWorkers === 0) {
          throw new Error("Computer control lease was released; no new input worker may be started.");
        }
        if (pendingWorkers === 0) throw new Error("Computer input worker was not prepared before spawning.");
        writePrivateStateFileSync(binding, serialize({
          ...current.record, workerPids: [...workers, pid], pendingWorkers: pendingWorkers - 1,
        }), {
          expectedText: current.snapshot.text,
        });
      });
    },
    untrackWorker(pid) {
      if (!validPid(pid)) throw new TypeError("Computer input worker must have a valid PID.");
      if (released) return;
      withLock(() => {
        const current = currentClaim();
        if (!current) { released = true; return; }
        const workers = current.record.workerPids ?? [];
        if (workers.includes(pid)) {
          if (runtime.isProcessAlive(pid)) throw new Error("Computer input worker is still alive; desktop ownership was retained.");
          writePrivateStateFileSync(binding, serialize({
            ...current.record, workerPids: workers.filter((worker) => worker !== pid),
          }), { expectedText: current.snapshot.text });
        }
        if (releaseRequested) {
          const updated = currentClaim();
          if (updated) finishRelease(updated);
        }
      });
    },
  };
}

/** Cross-process ownership of the current OS user's physical desktop. Never grant this from model input. */
export function acquireComputerLease(options: ComputerLeaseOptions): ComputerLease {
  return acquire(options, { pid: process.pid, isProcessAlive: processAlive });
}

/** Hermetic PID seam for tests only; production acquisition never reads overrides from environment/model data. */
export function createComputerLeaseAcquirerForTests(runtime: ComputerLeaseRuntime): (options: ComputerLeaseOptions) => ComputerLease {
  if (!validPid(runtime.pid) || typeof runtime.isProcessAlive !== "function") {
    throw new TypeError("invalid computer lease test runtime");
  }
  return (options) => acquire(options, runtime);
}
