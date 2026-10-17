import { randomUUID } from "node:crypto";
import {
  bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, removePrivateStateFile,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateFileBinding, type PrivateStateFileSnapshot,
} from "../security/private-state.js";
import { currentWorkspaceResourceBinding, isWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceResourceCommitGuard,
  workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { exact, plain, positive, UUID } from "./local-state.js";

const PROCESS_INSTANCE = randomUUID();
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
      return storage.run(() => withPrivateStateLockSync(workspaceStateHome(), ["workspace-run-locks"], `lease-${sessionId}`, () => {
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
  /** A non-cooperative physical operation keeps its lease even when the UI has stopped awaiting it. */
  setDraining(value: boolean): void { this.assertCurrent(); this.draining = value; }
  release(): void {
    if (this.released) return;
    if (this.draining) throw new Error("Workspace physical operations are still draining; lease retained");
    this.assertCurrent();
    removePrivateStateFile(this.file.path, this.snapshot, this.file.directory);
    this.released = true;
  }
}
