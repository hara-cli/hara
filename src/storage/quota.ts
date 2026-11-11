import { lstatSync, readdirSync, realpathSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertPrivateStateDirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateDirectoryIdentity } from "../security/private-state.js";

export class StorageQuotaError extends Error {
  constructor(readonly code: "quota_exceeded" | "unavailable" | "configuration_conflict") {
    super(`Hara storage quota: ${code}`); this.name = "StorageQuotaError";
  }
}
const ACTIVE_TRANSACTIONS = new Set<string>();
const MAX_STATE = 64 * 1024, REFRESH_MS = 30_000, MAX_AGE_MS = 300_000;
type Root = PrivateStateDirectoryIdentity;
interface Reservation { id: string; bytes: number; pid: number; active: boolean }
interface State {
  schemaVersion: 2; revision: number; policyRevision: number; limitBytes: number; roots: Root[];
  usageBytes: number; sampledAt: number; reservations: Reservation[];
}
interface Transaction { id: string; delta: number; reserved: boolean; peak: number; uncertain: boolean }
export interface StorageQuotaPolicy { revision: number; limitBytes: number }
export interface StorageQuotaLimitChange { expectedRevision: number; expectedLimitBytes: number; limitBytes: number }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const unavailable = (): never => { throw new StorageQuotaError("unavailable"); };
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code !== "ESRCH"; } // Unknown is still active.
};
const active = (row: Reservation) => row.active && (row.pid === process.pid ? ACTIVE_TRANSACTIONS.has(row.id) : alive(row.pid));
/** Shared metadata cache plus crash-conservative reservations. The global lock only protects the
 * small accounting/policy record: census, payload IO and caller callbacks always run outside it.
 * Legacy writers must join this controller or request refreshUsage() after their mutations. */
export class HaraStorageQuota {
  readonly home: string;
  private readonly additionalRoots: Root[];
  private readonly initialLimit: number;
  private currentLimit: number;
  private bound = false;
  private context?: Transaction;
  private refreshing?: Promise<boolean>;
  private nextRefreshAt = 0;
  private policyBinding?: ReturnType<typeof bindPrivateHaraStateFile>;
  private rootSet?: Root[];
  private readonly now: () => number;
  constructor(options: { home: string; limitBytes: number; additionalRoots?: readonly Root[]; now?: () => number }) {
    if (!Number.isSafeInteger(options.limitBytes) || options.limitBytes < 4096) throw new StorageQuotaError("configuration_conflict");
    this.home = realpathSync.native(options.home); this.initialLimit = this.currentLimit = options.limitBytes;
    if ((options.additionalRoots?.length ?? 0) > 16) throw new StorageQuotaError("configuration_conflict");
    this.additionalRoots = (options.additionalRoots ?? []).map(root => ({ ...root })); this.now = options.now ?? Date.now;
  }
  get limitBytes(): number { return this.currentLimit; }
  assertHome(home: string): void {
    if (realpathSync.native(home) !== this.home) throw new StorageQuotaError("configuration_conflict");
  }
  private binding() {
    this.policyBinding ??= bindPrivateHaraStateFile(this.home, ["storage-quota"], "policy.json");
    assertPrivateStateDirectory(this.policyBinding.directory); return this.policyBinding;
  }
  private roots(): Root[] {
    if (this.rootSet) { for (const root of this.rootSet) assertPrivateStateDirectory(root); return this.rootSet; }
    const base = bindPrivateHaraStateFile(this.home, [], "quota-root-probe").directory;
    const roots = [base, ...this.additionalRoots].sort((a, b) => a.path.localeCompare(b.path));
    const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || !isAbsolute(rel) && rel.split(sep)[0] !== ".."; };
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]; assertPrivateStateDirectory(root);
      if (root.path === resolve(sep) || root.path.length > 4096) throw new StorageQuotaError("configuration_conflict");
      for (let j = 0; j < i; j++) if (inside(roots[j].path, root.path) || inside(root.path, roots[j].path)) throw new StorageQuotaError("configuration_conflict");
    }
    this.rootSet = roots.map(({ path, dev, ino }) => ({ path, dev, ino })); return this.rootSet;
  }
  private read(allowInitialLimitMismatch = false): { state: State | null; text: string | null; legacyLimit?: number } {
    const text = readPrivateStateFileSnapshotSync(this.binding().path, MAX_STATE)?.text ?? null;
    if (text === null) return { state: null, text };
    let value: any; try { value = JSON.parse(text); } catch { return unavailable(); }
    const roots = this.roots();
    if (!value || typeof value !== "object" || Array.isArray(value) || !integer(value.limitBytes) || value.limitBytes < 4096
      || JSON.stringify(value.roots) !== JSON.stringify(roots)) throw new StorageQuotaError("configuration_conflict");
    if (value.schemaVersion === 1 && Object.keys(value).length === 3) {
      if (!allowInitialLimitMismatch && value.limitBytes !== this.initialLimit) throw new StorageQuotaError("configuration_conflict");
      return { state: null, text, legacyLimit: value.limitBytes }; // Upgrade accounting without widening the existing policy.
    }
    if (value.schemaVersion !== 2 || Object.keys(value).length !== 8 || !integer(value.revision) || !value.revision
      || !integer(value.policyRevision) || !value.policyRevision || !integer(value.usageBytes) || !integer(value.sampledAt)
      || !Array.isArray(value.reservations) || value.reservations.length > 64) return unavailable();
    const ids = new Set<string>();
    for (const row of value.reservations) {
      if (!row || Object.keys(row).length !== 4 || typeof row.id !== "string" || !/^[a-f0-9-]{36}$/.test(row.id)
        || ids.has(row.id) || !integer(row.bytes) || !integer(row.pid) || !row.pid || typeof row.active !== "boolean") return unavailable();
      ids.add(row.id);
    }
    if (!this.bound && !allowInitialLimitMismatch && value.limitBytes !== this.initialLimit) throw new StorageQuotaError("configuration_conflict");
    this.bound = true; this.currentLimit = value.limitBytes;
    return { state: value as State, text };
  }
  private save(state: State, previous: string | null): void {
    if (!integer(state.usageBytes) || !integer(++state.revision)) return unavailable();
    const text = JSON.stringify(state); if (Buffer.byteLength(text) > MAX_STATE) return unavailable();
    writePrivateStateFileSync(this.binding(), text, previous === null ? { expectedMissing: true } : { expectedText: previous });
    this.bound = true; this.currentLimit = state.limitBytes;
  }
  private locked<T>(action: (state: State) => T): T {
    return withPrivateStateLockSync(this.home, ["storage-quota"], "global", () => {
      const { state, text } = this.read(); if (!state) return unavailable();
      const result = action(state); this.save(state, text); return result;
    }, { attempts: 10, waitMs: 5 });
  }
  private excluded(path: string): boolean {
    // Charge this record by its current serialized size below. Unknown/orphan lock/temp entries
    // are still part of the census; only the exact accounting record avoids double charging.
    return path === join(this.home, ".hara", "storage-quota", "policy.json");
  }

  private censusSync(): number {
    const roots = this.roots(), stack = roots.map(root => root.path); let bytes = 0, entries = 0;
    while (stack.length) {
      const path = stack.pop()!; if (++entries > 200_000) return unavailable();
      const before = lstatSync(path);
      // lstat FIRST. A link (including a dangling link) is charged by its own inode size; neither
      // realpath nor readdir nor file readers may resolve/open its target.
      if (before.isSymbolicLink()) { bytes += before.size; continue; }
      if (realpathSync.native(path) !== path) return unavailable();
      if (before.isDirectory()) {
        const names = readdirSync(path), after = lstatSync(path);
        if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return unavailable();
        for (const name of names) stack.push(join(path, name));
      } else if (before.isFile()) { if (!this.excluded(path)) bytes += before.size; }
      else return unavailable();
      if (!integer(bytes)) return unavailable();
    }
    for (const root of roots) assertPrivateStateDirectory(root); return bytes;
  }
  private ensure(allowInitialLimitMismatch = false): State {
    const old = this.read(allowInitialLimitMismatch); if (old.state) return old.state;
    // Cold census is startup work, outside the global lock; prepare() is the Host startup boundary.
    const usageBytes = this.censusSync(), roots = this.roots();
    return withPrivateStateLockSync(this.home, ["storage-quota"], "global", () => {
      const current = this.read(allowInitialLimitMismatch); if (current.state) return current.state;
      if (current.text !== old.text) return unavailable();
      const state: State = { schemaVersion: 2, revision: 0, policyRevision: 1, limitBytes: current.legacyLimit ?? this.initialLimit,
        roots, usageBytes, sampledAt: this.now(), reservations: [] };
      this.save(state, current.text); return state;
    }, { attempts: 10, waitMs: 5 });
  }
  private schedule(state: State): void {
    if (this.now() - state.sampledAt < REFRESH_MS || this.refreshing || this.now() < this.nextRefreshAt) return;
    this.nextRefreshAt = this.now() + REFRESH_MS;
    queueMicrotask(() => { void this.refreshUsage().catch(() => {}); });
  }
  /** Call before listening, not from a message handler. A persistent fresh cache makes restart cheap. */
  async prepare(): Promise<void> {
    const state = this.ensure();
    const recovery = state.reservations.some(row => !active(row));
    if ((recovery || this.now() - state.sampledAt >= REFRESH_MS) && !await this.refreshUsage()) throw new StorageQuotaError("unavailable");
  }
  /** Validate an already prepared policy without census, scheduling or accounting mutation. */
  assertPrepared(): void { if (!this.read().state) return unavailable(); }
  /** Request admission, before a synchronous mutation. Only stale/uncertain accounting waits;
   * a shared census stays outside all transaction locks. A timed-out/aborted waiter never writes
   * payloads or cancels another waiter's census. Call prepare() before accepting requests. */
  async prepareWrite(options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return unavailable();
    const deadline = performance.now() + Math.min(options.timeoutMs, 7000);
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted || performance.now() >= deadline) return unavailable();
      const state = this.read().state; if (!state) return unavailable(); // No cold synchronous census on a request.
      if (state.sampledAt !== 0 && this.now() - state.sampledAt < MAX_AGE_MS
        && !state.reservations.some(row => !active(row))) return;
      if (attempt === 2) return unavailable();
      const refresh = this.refreshUsage(); // Single-flight, including a census already scheduled by a reader.
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer); options.signal?.removeEventListener("abort", aborted);
          if (error !== undefined) reject(error); else resolve();
        };
        const aborted = () => finish(new StorageQuotaError("unavailable"));
        const timer = setTimeout(aborted, Math.max(0, deadline - performance.now()));
        options.signal?.addEventListener("abort", aborted, { once: true });
        void refresh.then(() => finish(), finish);
        if (options.signal?.aborted) aborted();
      });
      // Re-read even after a false CAS result: a peer may have refreshed it. At most two censuses,
      // in the original deadline, and never a retry of the caller's mutation/receive operation.
    }
  }
  /** Explicit/background reconciliation, metadata only, with optimistic revision fencing. A busy
   * census is discarded; no scan ever holds the global lock or overwrites a newer reservation. */
  refreshUsage(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const promise = this.reconcile(); this.refreshing = promise;
    void promise.finally(() => { if (this.refreshing === promise) this.refreshing = undefined; }).catch(() => {});
    return promise;
  }
  private async reconcile(): Promise<boolean> {
    const before = this.ensure(); if (before.reservations.some(row => active(row))) return false;
    const roots = this.roots(), stack = roots.map(root => root.path); let bytes = 0, entries = 0;
    while (stack.length) {
      const path = stack.pop()!; if (++entries > 200_000) return unavailable();
      let info;
      try { info = await fs.lstat(path); } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
      if (info.isSymbolicLink()) { bytes += info.size; continue; }
      if (await fs.realpath(path) !== path) return unavailable();
      if (info.isDirectory()) {
        const names = await fs.readdir(path), after = await fs.lstat(path);
        if (!after.isDirectory() || after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino
          || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) return false;
        for (const name of names) stack.push(join(path, name));
      } else if (info.isFile()) { if (!this.excluded(path)) bytes += info.size; }
      else return unavailable();
      if (!integer(bytes)) return unavailable();
    }
    for (const root of roots) assertPrivateStateDirectory(root);
    return withPrivateStateLockSync(this.home, ["storage-quota"], "global", () => {
      const { state, text } = this.read(); if (!state || state.revision !== before.revision
        || state.reservations.some(row => active(row))) return false;
      state.usageBytes = bytes; state.sampledAt = this.now(); state.reservations = [];
      this.save(state, text); return true;
    }, { attempts: 10, waitMs: 5 });
  }
  policy(): StorageQuotaPolicy { const state = this.ensure(true); return { revision: state.policyRevision, limitBytes: state.limitBytes }; }
  /** Trusted Host-only migration. authorize must verify a native human/config action bound to these
   * exact values before the short CAS lock. Shrinking preserves data and blocks only new growth. */
  changeLimit(change: StorageQuotaLimitChange, authorize: (change: Readonly<StorageQuotaLimitChange>) => void): StorageQuotaPolicy {
    const requested = Object.freeze({ expectedRevision: change.expectedRevision, expectedLimitBytes: change.expectedLimitBytes, limitBytes: change.limitBytes });
    if (!integer(requested.limitBytes) || requested.limitBytes < 4096 || !integer(requested.expectedRevision)
      || !integer(requested.expectedLimitBytes)) throw new StorageQuotaError("configuration_conflict");
    this.ensure(true);
    if (authorize(requested) !== undefined) throw new StorageQuotaError("configuration_conflict");
    return this.locked(state => {
      if (state.policyRevision !== requested.expectedRevision || state.limitBytes !== requested.expectedLimitBytes) throw new StorageQuotaError("configuration_conflict");
      state.limitBytes = requested.limitBytes; state.policyRevision++;
      return { revision: state.policyRevision, limitBytes: state.limitBytes };
    });
  }
  run<T>(action: () => T): T {
    if (this.context) return action();
    const state = this.ensure(); this.schedule(state);
    const context: Transaction = { id: randomUUID(), delta: 0, reserved: false, peak: 0, uncertain: false }; this.context = context; ACTIVE_TRANSACTIONS.add(context.id);
    try {
      const result = action();
      if (result && typeof (result as any).then === "function") return unavailable();
      return result;
    } finally {
      try {
        if (context.reserved || context.delta) this.locked(current => {
          const pending = current.reservations.find(row => row.id === context.id);
          if (context.uncertain || current.usageBytes + context.delta < 0) {
            if (pending) pending.active = false;
            current.sampledAt = 0; // Retain the peak until a successful fenced census.
          } else {
            current.usageBytes += context.delta;
            current.reservations = current.reservations.filter(row => row.id !== context.id);
          }
        });
      } finally { this.context = undefined; ACTIVE_TRANSACTIONS.delete(context.id); }
    }
  }
  /** Called only by trusted mutation wrappers, after publication/removal (including error paths). */
  recordChange(delta: number): void {
    if (!this.context || !Number.isSafeInteger(delta) || !Number.isSafeInteger(this.context.delta + delta)) return unavailable();
    this.context.delta += delta;
  }
  uncertainMutation(): void { if (!this.context) return unavailable(); this.context.uncertain = true; }
  usageBytes(): number {
    const state = this.ensure(); this.schedule(state);
    const total = state.usageBytes + Buffer.byteLength(JSON.stringify(state)) + state.reservations.reduce((sum, row) => sum + row.bytes, 0);
    if (!integer(total)) return unavailable(); return total;
  }
  private reserve(bytes: number, control: boolean): void {
    const context = this.context; if (!context || !integer(bytes)) return unavailable();
    const required = Math.max(0, context.delta) + bytes;
    if (context.reserved && required <= context.peak) {
      // An existing durable reservation covers this staging/fence. Atomic metadata reads suffice;
      // no global lock or accounting rewrite is needed for every chunk/file publication fence.
      const state = this.read().state, pending = state?.reservations.find(row => row.id === context.id);
      if (!state || !pending?.active || pending.bytes < required) return unavailable();
      if (!control && this.now() - state.sampledAt >= MAX_AGE_MS) return unavailable();
      const peak = state.usageBytes + state.reservations.reduce((sum, row) => sum + row.bytes, 0)
        + Buffer.byteLength(JSON.stringify(state)) * 2 + 512;
      if (!control && peak > state.limitBytes) throw new StorageQuotaError("quota_exceeded");
      return;
    }
    this.locked(state => {
      if (!control && this.now() - state.sampledAt >= MAX_AGE_MS) return unavailable();
      let pending = state.reservations.find(row => row.id === context.id);
      if (!pending) {
        if (context.reserved || state.reservations.length >= 64) return unavailable();
        pending = { id: context.id, bytes: 0, pid: process.pid, active: true }; state.reservations.push(pending);
      }
      pending.bytes = Math.max(pending.bytes, Math.max(0, context.delta) + bytes);
      // Include control record replacement staging and bounded accounting-lock overhead in the peak.
      const peak = state.usageBytes + state.reservations.reduce((sum, row) => sum + row.bytes, 0)
        + Buffer.byteLength(JSON.stringify(state)) * 2 + 512;
      if (!integer(peak)) return unavailable();
      if (!control && peak > state.limitBytes) throw new StorageQuotaError("quota_exceeded");
      context.reserved = true; context.peak = pending.bytes;
    });
  }
  admitControlReplacement(nextBytes: number, previousBytes: number): void {
    if (!integer(nextBytes) || !integer(previousBytes) || nextBytes > previousBytes || previousBytes > 4 * 1024 * 1024) return unavailable();
    this.reserve(nextBytes, true);
  }
  admitGrowth(bytes: number, control = false): void {
    if (control && bytes > 64 * 1024) return unavailable(); this.reserve(bytes, control);
  }
}
