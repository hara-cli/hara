// Host-owner orchestration only. Domain adapters own their private undo journals; this file never
// discovers legacy paths, writes credentials, starts a provider, changes launchd or grants tools.
import { WorkspaceJsonState, plain, canonical } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { LocalWorkspaceCatalog } from "./local-catalog.js";
import { WorkspaceSessionLease } from "./session-lease.js";

// Reserved owner-operation lease; no conversation is created with this identity.
const INHERITANCE_LEASE_ID = "3539c726-43ba-432d-852d-b19a3e2a63f3";

export const LEGACY_DOMAINS = ["connections", "settings", "roles", "memory", "skills", "resources", "history", "schedules"] as const;
export type LegacyDomainId = typeof LEGACY_DOMAINS[number];
export interface LegacySourceBinding { sourceFingerprint: string; planHash: string; backupHash: string }
export interface LegacyDomainReceipt { hash: string; objects: number }
export interface LegacyDomainAdapter {
  id: LegacyDomainId;
  /** Must recover its own durable intent and return the same receipt after a partial write/crash. */
  apply(): Promise<LegacyDomainReceipt>;
  verify(receipt: LegacyDomainReceipt): Promise<boolean>;
  /** Must check every imported object for newer user edits BEFORE rollback effects begin. */
  preflightRollback(receipt: LegacyDomainReceipt | null): Promise<void>;
  rollback(receipt: LegacyDomainReceipt | null): Promise<void>;
}
type Phase = "empty" | "detected" | "backed_up" | "dry_run" | "applying" | "applied" | "verified" | "rolling_back" | "rolled_back";
interface Domain { id: LegacyDomainId; state: "applying" | "applied" | "verified" | "rolled_back"; receipt: LegacyDomainReceipt | null }
interface State { revision: number; schemaVersion: 1; resourceBinding: WorkspaceResourceBinding; source: LegacySourceBinding | null; phase: Phase; round: number; domains: Domain[] }
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function source(value: unknown): value is LegacySourceBinding {
  return plain(value) && Object.keys(value).length === 3 && digest(value.sourceFingerprint) && digest(value.planHash) && digest(value.backupHash);
}
function receipt(value: unknown): value is LegacyDomainReceipt {
  return plain(value) && Object.keys(value).length === 2 && digest(value.hash) && Number.isSafeInteger(value.objects) && Number(value.objects) >= 0 && Number(value.objects) <= 100000;
}
export class WorkspaceLegacyCoordinator {
  private readonly state: WorkspaceJsonState<State>;
  private busy = false;
  private lease?: WorkspaceSessionLease;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly catalog: LocalWorkspaceCatalog,
    private readonly currentSource: () => LegacySourceBinding, private readonly adapters: readonly LegacyDomainAdapter[]) {
    if (adapters.length !== LEGACY_DOMAINS.length || new Set(adapters.map(row => row.id)).size !== LEGACY_DOMAINS.length
      || adapters.some(row => !LEGACY_DOMAINS.includes(row.id))) throw new Error("Every legacy domain must have one explicit owner adapter");
    this.state = new WorkspaceJsonState(storage, "workspace-legacy-inheritance-v1.json", raw => {
      if (!plain(raw) || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !["empty", "detected", "backed_up", "dry_run", "applying", "applied", "verified", "rolling_back", "rolled_back"].includes(String(raw.phase))
        || !Number.isSafeInteger(raw.round) || Number(raw.round) < 1 || !source(raw.source) || !Array.isArray(raw.domains) || raw.domains.length > LEGACY_DOMAINS.length
        || new Set(raw.domains.map(row => plain(row) ? row.id : null)).size !== raw.domains.length) throw new Error("Invalid inheritance journal; existing data preserved");
      for (const row of raw.domains) if (!plain(row) || !LEGACY_DOMAINS.includes(row.id as LegacyDomainId)
        || !["applying", "applied", "verified", "rolled_back"].includes(String(row.state)) || !(row.receipt === null || receipt(row.receipt))
        || row.receipt === null && ["applied", "verified"].includes(String(row.state))) throw new Error("Invalid inheritance domain receipt");
      return structuredClone(raw) as unknown as State;
    }, () => ({ schemaVersion: 1, revision: 0, resourceBinding: this.state.binding(), source: null, phase: "empty", round: 0, domains: [] }));
  }
  read() { return this.state.read(); }
  private assertTarget() {
    const state = this.catalog.read(), candidates = state.workspaces.filter(row => row.personal), row = candidates[0] ?? state.workspaces[0];
    if (!row?.active || candidates.length > 1 || canonical(row.scope) !== canonical(this.storage.scope)) throw new Error("Legacy inheritance requires the unique personal Workspace");
    this.catalog.resolvePersonalWorkspace(); this.storage.run(() => {});
  }
  private assertSource() {
    this.lease?.assertCurrent();
    this.assertTarget(); const current = this.currentSource(), old = this.read().source;
    if (!source(current) || old && canonical(current) !== canonical(old)) throw new Error("Legacy source or reviewed plan changed; stop and preserve both versions");
    return current;
  }
  private change(mutate: (value: State) => State) {
    this.assertSource(); const before = this.read(); return this.state.update(before.revision, mutate);
  }
  /** The trusted source callback must independently verify the backup and reviewed dry-run hashes. */
  private prepareOwned() {
    const current = this.assertSource(), before = this.read();
    if (before.phase === "empty" || before.phase === "rolled_back") this.state.update(before.revision,
      old => ({ ...old, source: current, round: old.round + 1, phase: "detected", domains: [] }));
    if (this.read().phase === "detected") this.change(old => ({ ...old, phase: "backed_up" }));
    if (this.read().phase === "backed_up") this.change(old => ({ ...old, phase: "dry_run" }));
    return this.read();
  }
  prepare() {
    if (this.busy) throw new Error("Inheritance operation is already active");
    const lease = WorkspaceSessionLease.acquire(this.storage, INHERITANCE_LEASE_ID); this.lease = lease;
    try { return this.prepareOwned(); } finally { this.lease = undefined; lease.release(); }
  }
  private async exclusive<T>(operation: () => Promise<T>) {
    if (this.busy) throw new Error("Inheritance operation is already active"); this.busy = true;
    let lease: WorkspaceSessionLease | undefined;
    try { lease = WorkspaceSessionLease.acquire(this.storage, INHERITANCE_LEASE_ID); this.lease = lease; return await operation(); }
    finally { this.lease = undefined; this.busy = false; lease?.release(); }
  }
  async apply() { return this.exclusive(async () => {
    this.prepareOwned();
    if (!["dry_run", "applying", "applied", "verified"].includes(this.read().phase)) throw new Error("Inheritance is not ready to apply");
    if (this.read().phase === "verified") return this.read();
    this.change(old => ({ ...old, phase: "applying" }));
    for (const id of LEGACY_DOMAINS) {
      this.assertSource(); if (this.read().domains.some(row => row.id === id && ["applied", "verified"].includes(row.state))) continue;
      this.change(old => ({ ...old, domains: [...old.domains.filter(row => row.id !== id), { id, state: "applying", receipt: null }] }));
      let result: LegacyDomainReceipt;
      try { result = await this.adapters.find(row => row.id === id)!.apply(); }
      catch { throw new Error(`Legacy ${id} import incomplete; durable intent preserved, resume after repair`); }
      if (!receipt(result)) throw new Error("Legacy domain returned an invalid receipt; preserved for review");
      this.change(old => ({ ...old, domains: old.domains.map(row => row.id === id ? { id, state: "applied", receipt: result } : row) }));
    }
    return this.change(old => ({ ...old, phase: "applied" }));
  }); }
  async verify() { return this.exclusive(async () => {
    this.assertSource(); if (!["applied", "verified"].includes(this.read().phase) || this.read().domains.length !== LEGACY_DOMAINS.length) throw new Error("Inheritance is incomplete");
    for (const id of LEGACY_DOMAINS) {
      const row = this.read().domains.find(row => row.id === id)!;
      this.assertSource(); if (!row.receipt || !await this.adapters.find(item => item.id === id)!.verify(row.receipt)) throw new Error(`Legacy ${id} verification failed; no handoff allowed`);
      this.change(old => ({ ...old, domains: old.domains.map(row => row.id === id ? { ...row, state: "verified" } : row) }));
    }
    return this.change(old => ({ ...old, phase: "verified" }));
  }); }
  /** No OS/service toggles. One owner command calls this; adapters must preflight ALL domains first. */
  async rollback() { return this.exclusive(async () => {
    this.assertSource(); const before = this.read(); if (before.phase === "rolled_back") return before;
    const rows = [...before.domains].reverse();
    for (const row of rows) if (row.state !== "rolled_back") await this.adapters.find(item => item.id === row.id)!.preflightRollback(row.receipt);
    this.change(old => ({ ...old, phase: "rolling_back" }));
    for (const row of rows) {
      this.assertSource(); if (row.state === "rolled_back") continue;
      await this.adapters.find(item => item.id === row.id)!.rollback(row.receipt);
      this.change(old => ({ ...old, domains: old.domains.map(value => value.id === row.id ? { ...value, state: "rolled_back" } : value) }));
    }
    return this.change(old => ({ ...old, phase: "rolled_back" }));
  }); }
}
