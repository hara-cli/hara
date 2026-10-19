import { createHash } from "node:crypto";
import { canonical } from "./local-state.js";
import { LegacyScopedFileUndo } from "./legacy-file-undo.js";
import type { WorkspaceResourceStorage } from "./resource-context.js";
import type { LegacyDomainAdapter, LegacyDomainId, LegacyDomainReceipt } from "./legacy-coordinator.js";

/** Trusted owner composition for FILE-ONLY imports. The callback must write solely through the
 * private CAS writer; credentials and external side effects need their own receipt/cleanup adapter.
 * Not an RPC/tool. Constructor receives an explicit output set, never a path from a model. */
export class LegacyOwnerFileDomain implements LegacyDomainAdapter {
  private readonly undo: LegacyScopedFileUndo;
  constructor(storage: WorkspaceResourceStorage, readonly id: LegacyDomainId, private readonly sourceFingerprint: string,
    private readonly paths: readonly string[], private readonly objects: number, private readonly importFiles: () => void | Promise<void>) {
    if (!Number.isSafeInteger(objects) || objects < 0 || objects > 100000) throw new Error("Invalid inheritance object count");
    this.undo = new LegacyScopedFileUndo(storage, id, sourceFingerprint);
  }
  private receipt(): LegacyDomainReceipt {
    const state = this.undo.read(); return { objects: this.objects, hash: createHash("sha256").update(canonical({
      source: this.sourceFingerprint, round: state.round, files: state.files.map(row => [row.path, row.afterHash]),
    })).digest("hex") };
  }
  async apply() {
    if (this.undo.read().status !== "applied") {
      this.undo.begin(this.paths); await this.undo.runImport(this.importFiles);
    }
    this.undo.preflightRollback(); return this.receipt();
  }
  async verify(receipt: LegacyDomainReceipt) {
    try { this.undo.preflightRollback(); return this.undo.read().status === "applied" && canonical(receipt) === canonical(this.receipt()); }
    catch { return false; }
  }
  async preflightRollback() {
    if (!this.undo.read().revision) return;
    // Recover only hashes of writes already journaled. Never rerun the import to cancel it.
    if (this.undo.read().status === "open") await this.undo.runImport(() => {});
    this.undo.preflightRollback();
  }
  async rollback() { await this.preflightRollback(); this.undo.rollback(); }
}
