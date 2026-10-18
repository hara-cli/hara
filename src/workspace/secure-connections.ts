import { randomUUID } from "node:crypto";
import { WorkspaceConnectionStoreV2, isScopedRunConnection, isConnectionId, isCredentialGeneration, type ScopedConnectionInput, type ScopedConnection, type ScopedConnectionView, type ScopedRunConnection } from "./scoped-connections.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { deepFreeze, plain, positive, text } from "./local-state.js";
import { VersionedSettings, SettingsMigrationPendingError } from "./versioned-settings.js";
import type { CredentialVault } from "./credential-vault.js";

interface Metadata extends Omit<ScopedConnection, "apiKey" | "credentialFile"> { keyRef: string; createdAt: string; updatedAt: string; importId?: string; retiredKeyRefs?: string[]; credentialInvalid?: boolean }
interface LegacyImport { state: "pending" | "complete"; rows: { sourceId: string; connectionId: string }[] }
interface Document { schemaVersion: 3; resourceBinding: WorkspaceResourceBinding; revision: number; activeConnectionId: string | null; connections: Metadata[]; legacyImport?: LegacyImport }
export interface LegacyConnectionSeed { id: string; label: string; provider: "openai" | "anthropic"; baseURL: string; defaultModel: string; isDefault?: boolean }
function checked(value: unknown) {
  if (!plain(value) || !text(value.label, 80) || !text(value.defaultModel) || !text(value.baseURL, 4096) || !["openai", "anthropic"].includes(String(value.provider))) throw new Error("Invalid model connection metadata");
  let url: URL; try { url = new URL(value.baseURL); } catch { throw new Error("Invalid model endpoint"); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Unsafe model endpoint");
  return { label: value.label, provider: value.provider as "openai" | "anthropic", baseURL: value.baseURL, defaultModel: value.defaultModel };
}
export class WorkspaceSecureConnections extends WorkspaceConnectionStoreV2 {
  private readonly document: VersionedSettings<Document>;
  constructor(storage: WorkspaceResourceStorage, private readonly vault: CredentialVault,
    private readonly resolveLegacy?: (id: string) => { input: ScopedConnectionInput; importId: string }) {
    super(storage);
    const binding = () => storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
    const parse = (raw: unknown): Document => {
      if (!plain(raw) || raw.schemaVersion !== 3 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding())
        || !Array.isArray(raw.connections) || raw.connections.length > 256) throw new Error("Invalid secure model settings");
      const ids = new Set<string>(), connections: Metadata[] = raw.connections.map(row => {
        if (!plain(row) || Object.hasOwn(row, "apiKey") || Object.hasOwn(row, "credentialFile") || !isConnectionId(row.id) || ids.has(row.id) || !isCredentialGeneration(row.credentialGeneration)
          || !positive(row.revision) || !["active", "revoked"].includes(String(row.status)) || typeof row.keyRef !== "string" || !row.keyRef.startsWith(`${binding().scopeKey}:${row.id}:`)
          || row.status === "active" && row.keyRef !== `${binding().scopeKey}:${row.id}:${row.credentialGeneration}`
          || row.credentialInvalid !== undefined && typeof row.credentialInvalid !== "boolean"
          || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error("Invalid secure connection");
        const retiredKeyRefs = row.retiredKeyRefs ?? [];
        if (!Array.isArray(retiredKeyRefs) || retiredKeyRefs.length > 256 || retiredKeyRefs.some(ref => typeof ref !== "string" || !ref.startsWith(`${binding().scopeKey}:${row.id}:`) || !isCredentialGeneration(ref.slice(ref.lastIndexOf(":") + 1)))) throw new Error("Invalid credential cleanup record");
        ids.add(row.id); return { ...checked(row), id: row.id, keyRef: row.keyRef, credentialGeneration: row.credentialGeneration, revision: row.revision,
          status: row.status as "active" | "revoked", createdAt: row.createdAt, updatedAt: row.updatedAt, retiredKeyRefs, credentialInvalid: row.credentialInvalid === true, ...(typeof row.importId === "string" ? { importId: row.importId } : {}) };
      });
      if (raw.activeConnectionId !== null && !connections.some(row => row.id === raw.activeConnectionId && row.status === "active")) throw new Error("Invalid active connection");
      const legacy = raw.legacyImport;
      if (legacy !== undefined && (!plain(legacy) || !["pending", "complete"].includes(String(legacy.state)) || !Array.isArray(legacy.rows) || legacy.rows.length > 256
        || legacy.rows.some(row => !plain(row) || typeof row.sourceId !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceId) || !connections.some(item => item.id === row.connectionId))
        || new Set(legacy.rows.map(row => row.connectionId)).size !== legacy.rows.length)) throw new Error("Invalid legacy import marker");
      return { schemaVersion: 3, resourceBinding: binding(), revision: Number(raw.revision), activeConnectionId: raw.activeConnectionId as string | null, connections,
        ...(legacy ? { legacyImport: structuredClone(legacy) as unknown as LegacyImport } : {}) };
    };
    this.document = new VersionedSettings<Document>(() => storage.run(() => workspaceStateHome()), "workspace-connections-v2.json", 3,
      () => ({ schemaVersion: 3, resourceBinding: binding(), revision: 0, activeConnectionId: null, connections: [] }), parse,
      { 1: raw => ({ ...raw, schemaVersion: 2 }), 2: (raw, options) => {
        if (!Array.isArray(raw.connections) || !sameWorkspaceResourceBinding(raw.resourceBinding, binding())) throw new Error("Invalid old connection store");
        const credentials: { ref: string; key: string }[] = [];
        const connections = raw.connections.map((row: any, index: number) => {
          checked(row); if (!isConnectionId(row.id) || !isCredentialGeneration(row.credentialGeneration) || !text(row.apiKey, 16384)) throw new Error("Old credential requires explicit recovery");
          const keyRef = `${binding().scopeKey}:${row.id}:${row.credentialGeneration}`; if (row.status === "active") credentials.push({ ref: keyRef, key: row.apiKey });
          const { apiKey: _key, credentialFile: _file, ...metadata } = row;
          return { ...metadata, keyRef, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString() };
        });
        const next = parse({ schemaVersion: 3, resourceBinding: raw.resourceBinding, revision: raw.revision, activeConnectionId: raw.defaultConnectionId ?? null, connections });
        // Validate every source row before any external side effect. A backup is never migrated by
        // writing the vault; unavailable/denied vault access must not be classified as damaged JSON.
        if (options.readOnly && credentials.length) throw new SettingsMigrationPendingError();
        try { if (this.vault.setMany) this.vault.setMany(credentials); else for (const credential of credentials) this.vault.set(credential.ref, credential.key); }
        catch { throw new SettingsMigrationPendingError(); }
        return next;
      } }, storage, (_old, next) => next);
  }
  override list(): ReturnType<WorkspaceConnectionStoreV2["list"]> & { activeConnectionId: string | null; readOnly: boolean; recovered: boolean; migrationPending: boolean } {
    const state = this.document.read();
    const pending = state.value.legacyImport?.state === "pending";
    return { revision: state.value.revision, defaultConnectionId: pending || state.value.connections.some(row => row.id === state.value.activeConnectionId && row.credentialInvalid) ? null : state.value.activeConnectionId, activeConnectionId: state.value.activeConnectionId, readOnly: state.readOnly || pending, recovered: state.recovered, migrationPending: state.migrationPending || pending,
      connections: state.value.connections.map(row => ({ id: row.id, label: row.label, provider: row.provider, baseURL: row.baseURL, defaultModel: row.defaultModel,
        credentialGeneration: row.credentialGeneration, revision: row.revision, status: row.status, keySaved: !pending && row.status === "active", keyState: pending ? "pending" : row.credentialInvalid ? "invalid" : "saved", cleanupPending: Boolean(row.retiredKeyRefs?.length), createdAt: row.createdAt, updatedAt: row.updatedAt })) };
  }
  /** Metadata-only prefill, once per personal Workspace. No vault access or secret persistence. */
  stageLegacyImport(rows: readonly LegacyConnectionSeed[]): void {
    if (!rows.length) return;
    const state = this.document.read(); if (state.readOnly || state.value.legacyImport) return;
    if (rows.length > 256) throw new Error("Too many legacy connections");
    const now = new Date().toISOString(), fresh = rows.filter(row => !state.value.connections.some(old => old.importId === row.id));
    const entries: Metadata[] = fresh.map(row => { const id = `mc_${randomUUID()}`, generation = `gen_${randomUUID()}`;
      return { ...checked(row), id, credentialGeneration: generation, keyRef: `${state.value.resourceBinding.scopeKey}:${id}:${generation}`,
        revision: 1, status: "active", createdAt: now, updatedAt: now, importId: row.id }; });
    this.document.update(state.value.revision, current => ({ ...current, connections: [...current.connections, ...entries],
      activeConnectionId: current.activeConnectionId ?? entries[fresh.findIndex(row => row.isDefault)]?.id ?? entries[0]?.id ?? null,
      legacyImport: { state: entries.length ? "pending" : "complete", rows: entries.map((row, index) => ({ connectionId: row.id, sourceId: fresh[index]!.id })) } }));
  }
  retryMigration(expected: number): ReturnType<WorkspaceSecureConnections["list"]> {
    const state = this.document.read();
    if (!state.readOnly && state.value.legacyImport?.state === "pending") {
      if (state.value.revision !== expected || !this.resolveLegacy || !this.vault.setMany) throw new Error("Legacy batch changed or vault batch unavailable; original preserved");
      const entries = state.value.legacyImport.rows.map(row => {
        const metadata = state.value.connections.find(item => item.id === row.connectionId)!, resolved = this.resolveLegacy!(row.sourceId);
        if (resolved.importId !== row.sourceId || JSON.stringify(checked(resolved.input)) !== JSON.stringify(checked(metadata)) || !resolved.input.apiKey) throw new Error("Legacy source changed; original preserved");
        return { ref: metadata.keyRef, key: resolved.input.apiKey };
      });
      try { this.vault.setMany(entries); }
      catch { throw new Error("Credential authorization pending; the entire batch remains unconfirmed, original preserved"); }
      this.document.update(expected, current => ({ ...current, legacyImport: { ...current.legacyImport!, state: "complete" } }));
      return this.list();
    }
    // Pending schema migrations deliberately expose no source content/revision. Current resource
    // generation + pending/not-recovered state are the authority guards, not empty().revision (0).
    if (!state.migrationPending || state.recovered || !Number.isSafeInteger(expected) || expected < 0) throw new Error("Migration state changed or requires backup recovery; original preserved");
    this.document.retryMigration(); return this.list();
  }
  override add(value: ScopedConnectionInput, expected: number): ScopedConnectionView { return this.importConnection(value, expected); }
  importConnection(value: ScopedConnectionInput, expected: number, importId?: string): ScopedConnectionView {
    const metadata = checked(value), state = this.document.read();
    const prior = importId && state.value.connections.find(row => row.importId === importId && row.status === "active");
    if (prior) return this.list().connections.find(row => row.id === prior.id)!;
    if (state.readOnly || state.value.legacyImport?.state === "pending" || state.value.revision !== expected || !value.apiKey || value.credentialFile) throw new Error("Refresh or unlock secure settings before saving");
    const id = `mc_${randomUUID()}`, generation = `gen_${randomUUID()}`, keyRef = `${state.value.resourceBinding.scopeKey}:${id}:${generation}`, now = new Date().toISOString();
    this.vault.set(keyRef, value.apiKey);
    try { this.document.update(expected, current => ({ ...current, activeConnectionId: current.activeConnectionId ?? id, connections: [...current.connections,
      { ...metadata, id, keyRef, credentialGeneration: generation, revision: 1, status: "active", createdAt: now, updatedAt: now, ...(importId ? { importId } : {}) }] })); }
    catch (error) { this.discardUncommittedCredential(keyRef, expected); throw error; }
    return this.list().connections.find(row => row.id === id)!;
  }
  edit(id: string, value: unknown, expected: number): void {
    const metadata = checked(value), state = this.document.read(), row = state.value.connections.find(row => row.id === id && row.status === "active");
    if (!row || state.readOnly || state.value.legacyImport?.state === "pending" || state.value.revision !== expected || !plain(value)) throw new Error("Connection changed; refresh before editing");
    const key = value.apiKey === "" || value.apiKey === undefined ? this.vault.get(row.keyRef) : value.apiKey;
    if (typeof key !== "string" || !key) throw new Error("Saved credential is unavailable");
    const generation = `gen_${randomUUID()}`, ref = `${state.value.resourceBinding.scopeKey}:${id}:${generation}`;
    this.vault.set(ref, key);
    try { this.document.update(expected, current => ({ ...current, connections: current.connections.map(item => item.id === id
      ? { ...item, ...metadata, keyRef: ref, credentialInvalid: false, retiredKeyRefs: [...new Set([...(item.retiredKeyRefs ?? []), item.keyRef])], credentialGeneration: generation, revision: item.revision + 1, updatedAt: new Date().toISOString() } : item) })); }
    catch (error) { this.discardUncommittedCredential(ref, expected); throw error; }
    this.cleanupCredentials(id, this.document.read().value.revision);
  }
  override replace(id: string, value: ScopedConnectionInput, expected: number) { this.edit(id, value, expected); }
  private discardUncommittedCredential(ref: string, beforeRevision: number) {
    // A post-commit recovery-copy failure is not a rollback. Remove only when the unchanged primary
    // positively proves no commit; on unknown outcome retain the credential, never destroy valid data.
    try {
      const current = this.document.read();
      if (!current.readOnly && current.value.revision === beforeRevision && !current.value.connections.some(row => row.keyRef === ref || row.retiredKeyRefs?.includes(ref))) this.vault.remove(ref);
    } catch { /* Unknown outcome: preserve the private credential for recovery, never log it. */ }
  }
  override revoke(id: string, expected: number): void {
    const state = this.document.read(), row = state.value.connections.find(row => row.id === id);
    if (!row || state.readOnly || state.value.legacyImport?.state === "pending" || state.value.revision !== expected) throw new Error("Connection changed; refresh before removal");
    if (row.status === "active") this.document.update(expected, current => {
      const item = current.connections.find(r => r.id === id)!; item.status = "revoked"; item.revision++; item.credentialGeneration = `gen_${randomUUID()}`;
      item.retiredKeyRefs = [...new Set([...(item.retiredKeyRefs ?? []), item.keyRef])];
      if (current.activeConnectionId === id) current.activeConnectionId = current.connections.filter(r => r.status === "active")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]?.id ?? null;
      return current;
    });
    this.cleanupCredentials(id, this.document.read().value.revision);
  }
  cleanupCredentials(id: string, expected: number): void {
    const state = this.document.read(), row = state.value.connections.find(item => item.id === id);
    if (!row || state.readOnly || state.value.revision !== expected) throw new Error("Credential cleanup changed; refresh before retrying");
    const refs = row.retiredKeyRefs ?? []; if (!refs.length) return;
    // Persist revocation/rotation BEFORE deleting old secrets. A denied cleanup survives restart and
    // can be explicitly retried; no reader auto-mutates the Keychain or revives the old generation.
    for (const ref of refs) this.vault.remove(ref);
    this.document.update(expected, current => ({ ...current, connections: current.connections.map(item => item.id === id ? { ...item, retiredKeyRefs: [] } : item) }));
  }
  override select(id: string, expected: number) { this.document.update(expected, current => {
    if (current.legacyImport?.state === "pending") throw new Error("Credential authorization pending");
    if (!current.connections.some(row => row.id === id && row.status === "active")) throw new Error("Connection unavailable");
    current.activeConnectionId = id; return current;
  }); }
  override capture(id?: string, model?: string): Readonly<ScopedRunConnection> {
    const state = this.document.read().value;
    if (state.legacyImport?.state === "pending") throw new Error("Credential authorization pending; no model call allowed");
    const row = state.connections.find(row => row.id === (id ?? state.activeConnectionId) && row.status === "active");
    if (!row || row.credentialInvalid || model !== undefined && !text(model)) throw new Error("invalid or unavailable scoped model connection; no fallback was selected");
    return deepFreeze({ connectionId: row.id, credentialGeneration: row.credentialGeneration, connectionRevision: row.revision, model: model ?? row.defaultModel, reasoning: null });
  }
  override resolve(binding: ScopedRunConnection): Readonly<ScopedConnection> {
    if (!isScopedRunConnection(binding)) throw new Error("Invalid connection binding");
    const state = this.document.read().value;
    if (state.legacyImport?.state === "pending") throw new Error("Credential authorization pending; no model call allowed");
    const row = state.connections.find(row => row.id === binding.connectionId && row.status === "active");
    if (!row || row.credentialInvalid || row.credentialGeneration !== binding.credentialGeneration || row.revision !== binding.connectionRevision) throw new Error("Original connection generation unavailable");
    const apiKey = this.vault.get(row.keyRef); if (!apiKey) throw new Error("Original credential unavailable; no fallback selected");
    const { keyRef: _ref, ...metadata } = row; return deepFreeze({ ...metadata, apiKey });
  }
  markCredentialInvalid(binding: ScopedRunConnection) {
    const state = this.document.read(), row = state.value.connections.find(item => item.id === binding.connectionId);
    if (state.readOnly || !row || row.credentialInvalid || row.credentialGeneration !== binding.credentialGeneration || row.revision !== binding.connectionRevision) return;
    this.document.update(state.value.revision, current => ({ ...current, connections: current.connections.map(item => item.id === row.id ? { ...item, credentialInvalid: true } : item) }));
  }
}
