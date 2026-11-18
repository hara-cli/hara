import { randomUUID } from "node:crypto";
import { CredentialVaultError, assertCredentialCall, validCredentialKey, type AsyncCredentialVault, type CredentialCall,
  type CredentialEntry } from "./credential-vault.js";
import { exact, plain, positive, UUID } from "./local-state.js";
import { currentWorkspaceResourceBinding, inspectWorkspaceResourceFile, sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding,
  type WorkspaceResourceStorage } from "./resource-context.js";
import { isConnectionId, isCredentialGeneration } from "./scoped-connections.js";
import { VersionedSettings } from "./versioned-settings.js";

export const LEGACY_CREDENTIAL_BACKUP = "workspace-legacy-source-backup-v1.json";
export const CREDENTIAL_INTENTS_FILE = "workspace-credential-intents-v1.json";
const MAX_REFS = 512;
const active = new Set<string>();
type Intent = {
  id: string;
  refs: string[];
  ownerPid: number;
  workerPid: number | null;
  state: "pending" | "cleanupPending";
  writeSettled: boolean;
};
interface IntentDocument {
  schemaVersion: 1;
  revision: number;
  resourceBinding: WorkspaceResourceBinding;
  intents: Intent[];
}
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH"; }
}
function ownedRef(scopeKey: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [scope, id, generation, ...extra] = value.split(":");
  return scope === scopeKey && !extra.length && (isConnectionId(id) || id === "legacy-source") && isCredentialGeneration(generation);
}
function abandoned(intent: Intent) {
  return !active.has(intent.id) && (intent.ownerPid === process.pid || processGone(intent.ownerPid));
}

/** Separate revision from public settings. Older plaintext metadata never enters this journal or its backup. */
export class WorkspaceCredentialWriteIntents {
  private readonly document: VersionedSettings<IntentDocument>;
  constructor(private readonly storage: WorkspaceResourceStorage) {
    const binding = () => currentWorkspaceResourceBinding()!;
    this.document = new VersionedSettings<IntentDocument>(() => storage.run(() => workspaceStateHome()), CREDENTIAL_INTENTS_FILE, 1,
      () => ({ schemaVersion: 1, revision: 0, resourceBinding: binding(), intents: [] }), raw => {
        if (!plain(raw) || !exact(raw, ["schemaVersion", "revision", "resourceBinding", "intents"]) || raw.schemaVersion !== 1
          || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0
          || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding()) || !Array.isArray(raw.intents))
          throw new Error("Invalid credential write intents; originals preserved");
        const ids = new Set<string>(), refs = new Set<string>();
        for (const row of raw.intents) {
          if (!plain(row) || !exact(row, ["id", "refs", "ownerPid", "workerPid", "state", "writeSettled"])
            || typeof row.id !== "string" || !UUID.test(row.id) || ids.has(row.id) || !positive(row.ownerPid)
            || !(row.workerPid === null || positive(row.workerPid)) || !["pending", "cleanupPending"].includes(String(row.state))
            || typeof row.writeSettled !== "boolean" || !Array.isArray(row.refs) || !row.refs.length || row.refs.length > 256)
            throw new Error("Invalid credential write intent; originals preserved");
          ids.add(row.id);
          for (const ref of row.refs) {
            if (!ownedRef(storage.scopeKey, ref) || refs.has(ref) || refs.size >= MAX_REFS)
              throw new Error("Invalid credential write reference; originals preserved");
            refs.add(ref);
          }
        }
        return raw as unknown as IntentDocument;
      }, {}, storage);
  }
  private change(change: (intents: Intent[]) => Intent[], assertCurrent?: () => void) {
    const state = this.document.read();
    if (state.readOnly) throw new CredentialVaultError("unavailable");
    this.document.update(state.value.revision, current => ({ ...current, intents: change(current.intents) }), assertCurrent);
  }
  private amend(id: string, change: (row: Intent) => Intent | null, assertCurrent?: () => void) {
    this.change(rows => rows.flatMap(row => row.id !== id ? [row] : change(row) ?? []), assertCurrent);
  }
  reconcile() {
    const state = this.document.read();
    if (state.readOnly) return;
    if (state.value.intents.some(row => row.state === "pending" && abandoned(row))) {
      this.change(rows => rows.map(row => row.state === "pending" && abandoned(row) ? { ...row, state: "cleanupPending" } : row));
    }
  }
  pendingRefs(): Set<string> {
    return new Set(this.document.read().value.intents.flatMap(row => row.state === "cleanupPending" || abandoned(row)
      ? row.refs.map(ref => ref.split(":")[1]!) : []));
  }
  assertCleanupReady(refs: readonly string[]): void {
    const state = this.document.read();
    if (state.readOnly || state.value.intents.some(row => row.refs.some(ref => refs.includes(ref))
      && (!abandoned(row) || row.workerPid !== null && !processGone(row.workerPid))))
      throw new CredentialVaultError("cleanup_unconfirmed");
  }
  retireRemovedRefs(refs: readonly string[], call: CredentialCall): void {
    if (!refs.length) return;
    this.assertCleanupReady(refs);
    this.change(rows => rows.flatMap(row => {
      const retained = row.refs.filter(ref => !refs.includes(ref));
      return retained.length ? [{ ...row, refs: retained }] : [];
    }), () => assertCredentialCall(call));
  }
  private protected(ref: string, published: (ref: string) => boolean): boolean {
    if (ref.split(":")[1] !== "legacy-source") return published(ref);
    return this.storage.run(() => {
      const file = inspectWorkspaceResourceFile(workspaceStateHome() + "/.hara/" + LEGACY_CREDENTIAL_BACKUP, 4 * 1024 * 1024);
      if (!file.snapshot) return false;
      let raw: unknown;
      try { raw = JSON.parse(file.snapshot.text); } catch { throw new CredentialVaultError("cleanup_unconfirmed"); }
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, currentWorkspaceResourceBinding()!)
        || !ownedRef(this.storage.scopeKey, raw.keyRef) || raw.keyRef.split(":")[1] !== "legacy-source")
        throw new CredentialVaultError("cleanup_unconfirmed");
      // A published (or pre-S2 reserved) wrapping key belongs to its encrypted backup.
      return raw.keyRef === ref;
    });
  }
  /** Normal restore uses the already-bound metadata. Recovery never guesses a ref from a filename or age. */
  async cleanup(vault: AsyncCredentialVault, protectedRef: (ref: string) => boolean, call?: CredentialCall,
    options: { id?: string; connectionId?: string } = {}): Promise<void> {
    this.reconcile();
    const state = this.document.read();
    if (state.readOnly) throw new CredentialVaultError("cleanup_unconfirmed");
    for (const row of state.value.intents) {
      if (row.state !== "cleanupPending" || !abandoned(row) || options.id && row.id !== options.id
        || options.connectionId && !row.refs.every(ref => ref.split(":")[1] === options.connectionId)) continue;
      if (row.workerPid !== null && !processGone(row.workerPid)) throw new CredentialVaultError("cleanup_unconfirmed");
      for (const ref of row.refs) {
        assertCredentialCall(call);
        if (this.protected(ref, protectedRef)) continue;
        // A crashed synchronous compatibility backend has no worker PID. Missing is not
        // proof that its child has finished writing, so retain that intent for explicit repair.
        if (!row.writeSettled && row.workerPid === null && !await vault.get(ref, call)) throw new CredentialVaultError("cleanup_unconfirmed");
        assertCredentialCall(call);
        const guard: CredentialCall = { ...call, assertCurrent: () => {
          call?.assertCurrent?.();
          if (this.protected(ref, protectedRef)) throw new CredentialVaultError("cleanup_unconfirmed");
        } };
        if (!this.protected(ref, protectedRef)) await vault.remove(ref, guard);
      }
      this.amend(row.id, () => null, () => assertCredentialCall(call));
    }
  }
  async write<T>(vault: AsyncCredentialVault, entries: readonly CredentialEntry[], call: CredentialCall, publish: () => T,
    options: { protectedRef: (ref: string) => boolean; existingRefs?: ReadonlySet<string>; batch?: boolean; beforeWrite?: (refs: readonly string[]) => void }): Promise<T> {
    assertCredentialCall(call);
    if (entries.some(({ key }) => !validCredentialKey(key))) throw new CredentialVaultError("invalid_request");
    if (!entries.length) return publish();
    const refs = entries.map(entry => entry.ref);
    if (refs.some(ref => options.existingRefs ? options.existingRefs.has(ref) : options.protectedRef(ref))) throw new CredentialVaultError("unavailable");
    const id = randomUUID();
    const intent: Intent = { id, refs, ownerPid: process.pid, workerPid: null, state: "pending", writeSettled: false };
    this.reconcile();
    this.change(rows => {
      if (rows.reduce((count, row) => count + row.refs.length, refs.length) > MAX_REFS) throw new CredentialVaultError("unavailable");
      return [...rows, intent];
    }, () => assertCredentialCall(call));
    active.add(id);
    let writeStarted = false, writeSettled = false, preDispatchFenceFailed = false, workerRecorded = false;
    try {
      options.beforeWrite?.(refs);
      const nativeCall: CredentialCall = { ...call, assertCurrent: () => {
        try { assertCredentialCall(call); }
        catch (error) { if (!workerRecorded) preDispatchFenceFailed = true; throw error; }
      }, recordWorker: workerPid => {
        this.amend(id, row => ({ ...row, workerPid }), () => assertCredentialCall(call));
        workerRecorded = true;
      } };
      writeStarted = true;
      if (entries.length === 1 && !options.batch) await vault.set(entries[0]!.ref, entries[0]!.key, nativeCall);
      else await vault.setMany(entries, nativeCall);
      writeSettled = true;
      assertCredentialCall(call);
      const result = publish();
      try { this.amend(id, () => null); } catch { /* Published refs remain protected during recovery. */ }
      return result;
    } catch (error) {
      active.delete(id);
      try {
        // A pinned pre-existing ref collision proves this batch had no effect.
        if (!writeStarted || preDispatchFenceFailed || error instanceof CredentialVaultError && error.definitelyUnwritten) this.amend(id, () => null);
        else {
          this.amend(id, row => ({ ...row, state: "cleanupPending", writeSettled }));
          if (writeSettled) await this.cleanup(vault, options.protectedRef, { signal: call.signal }, { id });
        }
      } catch { /* Lost scope/unknown deletion leaves the durable intent for recovery. */ }
      throw error;
    } finally { active.delete(id); }
  }
}
