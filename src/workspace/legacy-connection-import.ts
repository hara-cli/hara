import { createHash } from "node:crypto";
import { join } from "node:path";
import { writePrivateStateFileSync } from "../security/private-state.js";
import { canonical, plain } from "./local-state.js";
import { inspectWorkspaceResourceFile, workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";
import type { CredentialVault } from "./credential-vault.js";
import { WorkspaceSecureConnections } from "./secure-connections.js";
import { LegacyScopedFileUndo } from "./legacy-file-undo.js";
import type { LegacyConnectionCatalog } from "./legacy-connections.js";
import type { LegacyDomainAdapter, LegacyDomainReceipt } from "./legacy-coordinator.js";

const FILE = ".hara/workspace-connections-v2.json", BACKUP = ".hara/workspace-connections-v2-backup.json", AUDIT = ".hara/workspace-legacy-credential-cleanup-v1.json";
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
interface Audit { schemaVersion: 1; sourceFingerprint: string; rounds: { round: number; refs: string[] }[] }
/** Owner-only, called after verified backup and dry-run. Explicit vault dependency: the caller must
 * supply a fake/temporary vault for rehearsal. No provider is created and source keys are never deleted. */
export class WorkspaceLegacyConnectionImport implements LegacyDomainAdapter {
  readonly id = "connections" as const;
  readonly connections: WorkspaceSecureConnections;
  private readonly undo: LegacyScopedFileUndo;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly source: Pick<LegacyConnectionCatalog, "inheritanceSeeds" | "resolve">,
    private readonly vault: CredentialVault, private readonly sourceFingerprint: string) {
    this.undo = new LegacyScopedFileUndo(storage, this.id, sourceFingerprint);
    this.connections = new WorkspaceSecureConnections(storage, vault, id => source.resolve(id, undefined, true, true));
  }
  private readAudit(text: string | null): Audit {
    if (text === null) return { schemaVersion: 1, sourceFingerprint: this.sourceFingerprint, rounds: [] };
    let raw; try { raw = JSON.parse(text); } catch { throw new Error("Credential cleanup audit is invalid; nothing removed"); }
    if (!plain(raw) || raw.schemaVersion !== 1 || raw.sourceFingerprint !== this.sourceFingerprint || !Array.isArray(raw.rounds) || raw.rounds.length > 64
      || new Set(raw.rounds.map(row => plain(row) ? row.round : null)).size !== raw.rounds.length) throw new Error("Credential cleanup audit scope changed");
    for (const row of raw.rounds) if (!plain(row) || !Number.isSafeInteger(row.round) || Number(row.round) < 1 || !Array.isArray(row.refs) || row.refs.length > 256
      || new Set(row.refs).size !== row.refs.length || row.refs.some(ref => typeof ref !== "string" || !new RegExp(`^${this.storage.scopeKey}:mc_[a-f0-9-]{36}:gen_[a-f0-9-]{36}$`).test(ref))) throw new Error("Credential cleanup reference scope changed");
    return raw as unknown as Audit;
  }
  private beforeRefs(): Set<string> {
    const text = this.undo.read().files.find(row => row.path === FILE)?.before;
    if (!text) return new Set();
    let value; try { value = JSON.parse(text); } catch { throw new Error("Pre-inheritance credential metadata is unavailable"); }
    if (!Array.isArray(value.connections)) throw new Error("Pre-inheritance credential metadata is invalid");
    return new Set(value.connections.flatMap((row: any) => [row.keyRef, ...(Array.isArray(row.retiredKeyRefs) ? row.retiredKeyRefs : [])]).filter((ref: unknown): ref is string => typeof ref === "string"));
  }
  private receipt(): LegacyDomainReceipt {
    const state = this.undo.read(); return { hash: hash({ source: this.sourceFingerprint, round: state.round, files: state.files.map(row => [row.path, row.afterHash]) }), objects: this.source.inheritanceSeeds().length };
  }
  connectionMap() {
    const metadata = this.connections.inheritanceMetadata();
    return this.source.inheritanceSeeds().map(seed => {
      const row = metadata.find(row => row.importId === seed.id); if (!row) throw new Error("Legacy connection mapping incomplete");
      return { legacyId: seed.legacyId, purpose: seed.purpose, sourceId: seed.id, connectionId: row.id, credentialGeneration: row.credentialGeneration, keyRequired: row.keyRequired };
    });
  }
  async apply(): Promise<LegacyDomainReceipt> {
    if (this.undo.read().status === "applied") { this.undo.preflightRollback(); return this.receipt(); }
    this.undo.begin([FILE, BACKUP, AUDIT], [AUDIT]);
    await this.undo.runImport(() => {
      const seeds = this.source.inheritanceSeeds(); this.connections.stageLegacyImport(seeds, true);
      const previous = this.beforeRefs(), refs = this.connections.inheritanceMetadata().filter(row => !previous.has(row.keyRef) && !row.keyRequired).map(row => row.keyRef).sort();
      this.storage.run(() => {
        const file = inspectWorkspaceResourceFile(join(workspaceStateHome(), AUDIT), 128 * 1024), audit = this.readAudit(file.snapshot?.text ?? null), round = this.undo.read().round;
        const old = audit.rounds.find(row => row.round === round);
        if (old && canonical(old.refs) !== canonical(refs)) throw new Error("Credential import intent changed; originals preserved");
        if (!old) audit.rounds.push({ round, refs });
        // References are durable BEFORE the first vault write, so a refused/unknown batch can be
        // cancelled after restart without guessing which credential entries belong to this import.
        writePrivateStateFileSync(file, JSON.stringify(audit) + "\n", file.snapshot ? { expectedText: file.snapshot.text } : { expectedMissing: true });
      });
      const state = this.connections.list();
      if (state.migrationPending) this.connections.retryMigration(state.revision);
      this.connectionMap();
    });
    return this.receipt();
  }
  async verify(receipt: LegacyDomainReceipt): Promise<boolean> {
    try {
      if (this.undo.read().status !== "applied" || receipt.hash !== this.receipt().hash) return false;
      this.undo.preflightRollback(); const state = this.connections.list(); if (state.migrationPending || state.readOnly) return false;
      const map = this.connectionMap(), metadata = this.connections.inheritanceMetadata(), previous = this.beforeRefs();
      for (const seed of this.source.inheritanceSeeds()) if (seed.keySaved) {
        const row = map.find(row => row.sourceId === seed.id)!;
        const stored = this.connections.resolve(this.connections.capture(row.connectionId));
        // Material equality only; not a network/paid connectivity test.
        const existing = metadata.find(item => item.id === row.connectionId)!;
        if (!stored.apiKey || !previous.has(existing.keyRef) && stored.apiKey !== this.source.resolve(seed.id, undefined, true, true).input.apiKey) return false;
      }
      return true;
    } catch { return false; }
  }
  async preflightRollback(): Promise<void> {
    if (!this.undo.read().revision) return;
    // Seal only the write-chain proven by the durable next-image intents; this runs NO importer or
    // vault write. Unknown/concurrent images still refuse rather than guessing a rollback snapshot.
    if (this.undo.read().status === "open") await this.undo.runImport(() => {});
    this.undo.preflightRollback(); this.cleanupRefs();
  }
  private cleanupRefs(): string[] {
    const state = this.undo.read(); if (!state.revision) return [];
    const image = state.files.find(row => row.path === AUDIT); if (!image?.afterHash) return [];
    const audit = this.readAudit(this.undo.retainedAuditText(AUDIT)), previous = this.beforeRefs();
    const refs = audit.rounds.find(row => row.round === state.round)?.refs ?? [];
    if (refs.some(ref => previous.has(ref))) throw new Error("Cleanup would remove a pre-existing credential; refused");
    return refs;
  }
  async rollback(): Promise<void> {
    await this.preflightRollback(); const refs = this.cleanupRefs(); this.undo.rollback();
    // Metadata is revoked/restored first. The immutable reference-only audit remains for retries if
    // the OS refuses cleanup. Never remove an original or another Workspace's credential.
    for (const ref of refs) this.vault.remove(ref);
  }
}
