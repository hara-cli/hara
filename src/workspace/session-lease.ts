import { readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { AgentLifecycleLease } from "./agent-lifecycle-state.js";
import { WorkspaceAgentBoundaryAuthority } from "./agent-boundary-authority.js";
import type { AgentBoundaryTransport } from "./agent-boundary-transport.js";
import {
  assertPrivateStateDirectory, ensurePrivateStateSubdirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, removePrivateStateFile,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateFileBinding, type PrivateStateFileSnapshot,
} from "../security/private-state.js";
import { currentWorkspaceResourceBinding, isWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceResourceCommitGuard,
  workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { exact, plain, positive, UUID } from "./local-state.js";

const PROCESS_INSTANCE = randomUUID();
// Only marks a genuine in-process receipt AFTER positive persisted closure and actual release.
// It never supplies authority, replaces durable epochs or proves quiescence.
const leaseReceipts = new Map<string, WeakRef<WorkspaceSessionLease>>();
interface Owner { schemaVersion: 1; resourceBinding: WorkspaceResourceBinding; sessionId: string; attemptId: string; token: string; pid: number; processInstance: string }
function owner(value: unknown): value is Owner {
  return plain(value) && exact(value, ["schemaVersion", "resourceBinding", "sessionId", "attemptId", "token", "pid", "processInstance"])
    && value.schemaVersion === 1 && isWorkspaceResourceBinding(value.resourceBinding) && typeof value.sessionId === "string" && UUID.test(value.sessionId)
    && typeof value.attemptId === "string" && UUID.test(value.attemptId) && typeof value.token === "string" && UUID.test(value.token)
    && positive(value.pid) && typeof value.processInstance === "string" && UUID.test(value.processInstance);
}
function knownDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error: any) { return error?.code === "ESRCH"; }
}
function decode(snapshot: PrivateStateFileSnapshot): Owner {
  let parsed: unknown;
  try { parsed = JSON.parse(snapshot.text); } catch { throw new Error("unreadable Workspace session owner; lock retained"); }
  if (!owner(parsed)) throw new Error("invalid Workspace session owner; lock retained");
  return parsed;
}

/** Serializes the first C3 migration with physical attempt acquisition across Host processes. */
export function withWorkspaceSessionAdmission<T>(storage: WorkspaceResourceStorage, operation: () => T): T {
  return storage.run(() => withPrivateStateLockSync(workspaceStateHome(), [], "workspace-command-admission", operation));
}
/** No age/death heuristic authorizes migration over an existing or ambiguous physical owner. */
export function assertNoWorkspaceSessionLeases(storage: WorkspaceResourceStorage): void {
  storage.run(() => {
    const directory = ensurePrivateStateSubdirectory(workspaceStateHome(), [".hara", "workspace-run-locks"]);
    const entries = readdirSync(directory.path); assertPrivateStateDirectory(directory);
    if (entries.length) throw new Error("Workspace has physical attempt ownership; command migration refused");
  });
}
/** Only this receipt can release the exact captured owner inode. It grants no business write authority. */
export class WorkspaceSessionLease {
  private released = false;
  private draining = false;
  private constructor(private readonly file: PrivateStateFileBinding, private readonly snapshot: PrivateStateFileSnapshot,
    readonly sessionId: string, readonly attemptId: string) {}
  static acquire(storage: WorkspaceResourceStorage, sessionId: string, attemptId = randomUUID()): WorkspaceSessionLease {
    if (!UUID.test(sessionId) || !UUID.test(attemptId)) throw new Error("invalid Workspace session lease identity");
    let acquired: WorkspaceSessionLease | undefined;
    try {
      return withWorkspaceSessionAdmission(storage, () => withPrivateStateLockSync(workspaceStateHome(), ["workspace-run-locks"], `lease-${sessionId}`, () => {
        const file = bindPrivateHaraStateFile(workspaceStateHome(), ["workspace-run-locks"], `${sessionId}.json`);
        const previous = readPrivateStateFileSnapshotSync(file.path, 4096);
        if (previous) {
          const held = decode(previous);
          if (held.sessionId !== sessionId || !sameWorkspaceResourceBinding(held.resourceBinding, currentWorkspaceResourceBinding()!)
            || !knownDead(held.pid)) throw new Error("Workspace session is busy or owner death is unproven");
          // Every contender uses the same private critical section. A live/same-process holder is
          // never re-entrant, and no age heuristic or malformed lock authorizes takeover.
          removePrivateStateFile(file.path, previous, file.directory);
        }
        const claim: Owner = { schemaVersion: 1, resourceBinding: { ...currentWorkspaceResourceBinding()! },
          sessionId, attemptId, token: randomUUID(), pid: process.pid, processInstance: PROCESS_INSTANCE };
        writePrivateStateFileSync(file, JSON.stringify(claim) + "\n", { expectedMissing: true, assertCurrent: workspaceResourceCommitGuard() });
        const published = readPrivateStateFileSnapshotSync(file.path, 4096);
        if (!published || published.text !== JSON.stringify(claim) + "\n") throw new Error("Workspace session lease publication changed");
        acquired = new WorkspaceSessionLease(file, published, sessionId, attemptId);
        leaseReceipts.set(createHash("sha256").update(published.text).digest("hex"), new WeakRef(acquired));
        return acquired;
      }));
    } catch (error) {
      // storage.run can revoke AFTER the callback has published its lock. Cleanup uses only the
      // previously captured owner receipt and never re-enters revoked business authority.
      acquired?.release();
      throw error;
    }
  }
  assertCurrent(): void {
    if (this.released) throw new Error("Workspace attempt lease was released");
    const current = readPrivateStateFileSnapshotSync(this.file.path, 4096);
    if (!current || current.text !== this.snapshot.text || current.dev !== this.snapshot.dev || current.ino !== this.snapshot.ino
      || current.ctimeMs !== this.snapshot.ctimeMs || current.mtimeMs !== this.snapshot.mtimeMs) throw new Error("Workspace attempt lease owner changed");
  }
  private static observeReleasedReceipt(ownerDigest: string): void {
    const receipt = leaseReceipts.get(ownerDigest)?.deref();
    if (receipt && createHash("sha256").update(receipt.snapshot.text).digest("hex") === ownerDigest) {
      receipt.released = true; receipt.draining = false;
    }
    leaseReceipts.delete(ownerDigest);
  }
  /** Observation of this genuine captured owner; never an execution/release capability. */
  captureOwner(): Readonly<AgentLifecycleLease> {
    this.assertCurrent(); const held = decode(this.snapshot);
    if (held.pid !== process.pid || held.processInstance !== PROCESS_INSTANCE || held.sessionId !== this.sessionId || held.attemptId !== this.attemptId)
      throw new Error("Workspace lease does not belong to this process instance");
    return Object.freeze({ sessionId: held.sessionId, attemptId: held.attemptId, ownerPid: held.pid, processInstance: held.processInstance,
      ownerDigest: createHash("sha256").update(this.snapshot.text).digest("hex"), dev: this.snapshot.dev, ino: this.snapshot.ino,
      ctimeMs: this.snapshot.ctimeMs, mtimeMs: this.snapshot.mtimeMs });
  }
  /** Explicit safe closure only. The real authority re-reads its published positive quiescence;
   * caller JSON, a missing file or a dead PID cannot manufacture that evidence. Never acquires. */
  static reconcileQuiescentRelease(storage: WorkspaceResourceStorage, authority: WorkspaceAgentBoundaryAuthority,
    transport: AgentBoundaryTransport, runId: string): { released: true; alreadyMissing: boolean } {
    if (!(authority instanceof WorkspaceAgentBoundaryAuthority)) throw new Error("Genuine lifecycle authority required");
    return withWorkspaceSessionAdmission(storage, () => {
      const facts = authority.lifecycleLeaseReleaseFacts(transport, runId), owner = facts.lease;
      if (!sameWorkspaceResourceBinding(facts.context.resourceBinding, currentWorkspaceResourceBinding()!)) throw new Error("Lifecycle lease scope changed");
      return withPrivateStateLockSync(workspaceStateHome(), ["workspace-run-locks"], `lease-${owner.sessionId}`, () => {
        const currentFacts = authority.lifecycleLeaseReleaseFacts(transport, runId);
        if (JSON.stringify(currentFacts) !== JSON.stringify(facts)) throw new Error("Lifecycle closure evidence changed");
        const file = bindPrivateHaraStateFile(workspaceStateHome(), ["workspace-run-locks"], `${owner.sessionId}.json`);
        const current = readPrivateStateFileSnapshotSync(file.path, 4096);
        if (!current) { WorkspaceSessionLease.observeReleasedReceipt(owner.ownerDigest); return { released: true as const, alreadyMissing: true }; } // Positive evidence was verified FIRST.
        const held = decode(current);
        if (held.sessionId !== owner.sessionId || held.attemptId !== owner.attemptId || held.pid !== owner.ownerPid
          || held.processInstance !== owner.processInstance || !sameWorkspaceResourceBinding(held.resourceBinding, currentWorkspaceResourceBinding()!)
          || createHash("sha256").update(current.text).digest("hex") !== owner.ownerDigest || current.dev !== owner.dev || current.ino !== owner.ino
          || current.ctimeMs !== owner.ctimeMs || current.mtimeMs !== owner.mtimeMs) throw new Error("Original lifecycle lease identity changed; retained");
        if (!(held.pid === process.pid && held.processInstance === PROCESS_INSTANCE) && !knownDead(held.pid))
          throw new Error("Original lifecycle owner death is unproven; lease retained");
        removePrivateStateFile(file.path, current, file.directory);
        WorkspaceSessionLease.observeReleasedReceipt(owner.ownerDigest);
        return { released: true as const, alreadyMissing: false };
      });
    });
  }
  /** A non-cooperative physical operation keeps its lease even when the UI has stopped awaiting it. */
  setDraining(value: boolean): void { this.assertCurrent(); this.draining = value; }
  release(): void {
    if (this.released) return;
    if (this.draining) throw new Error("Workspace physical operations are still draining; lease retained");
    this.assertCurrent();
    removePrivateStateFile(this.file.path, this.snapshot, this.file.directory);
    this.released = true;
    leaseReceipts.delete(createHash("sha256").update(this.snapshot.text).digest("hex"));
  }
}
