import { randomUUID } from "node:crypto";
import { WorkspaceConnectionStoreV2, isScopedRunConnection, isConnectionId, isCredentialGeneration, type ScopedConnectionInput, type ScopedConnection, type ScopedConnectionView, type ScopedRunConnection } from "./scoped-connections.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { deepFreeze, plain, positive, text } from "./local-state.js";
import { VersionedSettings, SettingsMigrationPendingError } from "./versioned-settings.js";
import { CredentialVaultError, assertCredentialCall, credentialDeadline, validCredentialKey,
  type AsyncCredentialVault, type CredentialCall, type CredentialEntry } from "./credential-vault.js";
import { WorkspaceCredentialWriteIntents } from "./credential-write-intents.js";
import { connectionModelEfforts } from "./connection-models.js";
import { defaultEffortForLevels } from "./default-effort.js";

interface Metadata extends Omit<ScopedConnection, "apiKey" | "credentialFile"> { keyRef: string; createdAt: string; updatedAt: string; importId?: string; retiredKeyRefs?: string[]; credentialInvalid?: boolean; credentialMissing?: boolean }
interface LegacyImport { state: "pending" | "complete"; rows: { sourceId: string; connectionId: string }[] }
interface Document { schemaVersion: 3; resourceBinding: WorkspaceResourceBinding; revision: number; activeConnectionId: string | null; connections: Metadata[]; legacyImport?: LegacyImport }
export interface LegacyConnectionSeed { id: string; label: string; provider: "openai" | "anthropic"; baseURL: string; defaultModel: string; isDefault?: boolean; keySaved?: boolean }
function checked(value: unknown) {
  if (!plain(value) || !text(value.label, 80) || !text(value.defaultModel) || !text(value.baseURL, 4096) || !["openai", "anthropic"].includes(String(value.provider))
    || value.defaultReasoning !== undefined && value.defaultReasoning !== null
      && !["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.defaultReasoning))) throw new Error("Invalid model connection metadata");
  let url: URL; try { url = new URL(value.baseURL); } catch { throw new Error("Invalid model endpoint"); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Unsafe model endpoint");
  return { label: value.label, provider: value.provider as "openai" | "anthropic", baseURL: value.baseURL, defaultModel: value.defaultModel,
    ...(Object.hasOwn(value, "defaultReasoning") ? { defaultReasoning: value.defaultReasoning as ScopedConnectionInput["defaultReasoning"] } : {}) };
}
type LegacyResolution = { input: ScopedConnectionInput; importId: string };
type StateView = ReturnType<VersionedSettings<Document>["read"]>;
export class WorkspaceSecureConnections {
  private readonly document: VersionedSettings<Document>;
  readonly intents: WorkspaceCredentialWriteIntents;
  private readonly parse: (raw: unknown) => Document;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly vault: AsyncCredentialVault,
    private readonly resolveLegacy?: (id: string, call: CredentialCall) => LegacyResolution | Promise<LegacyResolution>,
    private readonly onGenerationChanged?: (connectionId: string) => void) {
    this.intents = new WorkspaceCredentialWriteIntents(storage);
    // These callbacks run only inside this document's VersionedSettings storage boundary.
    // Reading its immutable provenance is structural work; the enclosing read/update performs
    // the live authority checks, including after parsing and before committing a migration.
    const binding = (): WorkspaceResourceBinding => {
      const current = currentWorkspaceResourceBinding();
      if (!current || current.scopeKey !== storage.scopeKey) throw new Error("Secure settings require their bound Workspace resource context");
      return { ...current };
    };
    const parse = this.parse = (raw: unknown): Document => {
      // One immutable provenance value for this fresh document parse. The surrounding
      // VersionedSettings read/update still checks live storage authority before and after.
      const resourceBinding = binding();
      if (!plain(raw) || raw.schemaVersion !== 3 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, resourceBinding)
        || !Array.isArray(raw.connections) || raw.connections.length > 256) throw new Error("Invalid secure model settings");
      const ids = new Set<string>(), connections: Metadata[] = raw.connections.map(row => {
        if (!plain(row) || Object.hasOwn(row, "apiKey") || Object.hasOwn(row, "credentialFile") || !isConnectionId(row.id) || ids.has(row.id) || !isCredentialGeneration(row.credentialGeneration)
          || !positive(row.revision) || !["active", "revoked"].includes(String(row.status)) || typeof row.keyRef !== "string" || !row.keyRef.startsWith(`${resourceBinding.scopeKey}:${row.id}:`)
          || row.status === "active" && row.keyRef !== `${resourceBinding.scopeKey}:${row.id}:${row.credentialGeneration}`
          || row.credentialInvalid !== undefined && typeof row.credentialInvalid !== "boolean"
          || row.credentialMissing !== undefined && typeof row.credentialMissing !== "boolean"
          || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error("Invalid secure connection");
        const retiredKeyRefs = row.retiredKeyRefs ?? [];
        if (!Array.isArray(retiredKeyRefs) || retiredKeyRefs.length > 256 || retiredKeyRefs.some(ref => typeof ref !== "string" || !ref.startsWith(`${resourceBinding.scopeKey}:${row.id}:`) || !isCredentialGeneration(ref.slice(ref.lastIndexOf(":") + 1)))) throw new Error("Invalid credential cleanup record");
        ids.add(row.id); return { ...checked(row), id: row.id, keyRef: row.keyRef, credentialGeneration: row.credentialGeneration, revision: row.revision,
          status: row.status as "active" | "revoked", createdAt: row.createdAt, updatedAt: row.updatedAt, retiredKeyRefs, credentialInvalid: row.credentialInvalid === true, credentialMissing: row.credentialMissing === true, ...(typeof row.importId === "string" ? { importId: row.importId } : {}) };
      });
      if (raw.activeConnectionId !== null && !connections.some(row => row.id === raw.activeConnectionId && row.status === "active")) throw new Error("Invalid active connection");
      const legacy = raw.legacyImport;
      if (legacy !== undefined && (!plain(legacy) || !["pending", "complete"].includes(String(legacy.state)) || !Array.isArray(legacy.rows) || legacy.rows.length > 256
        || legacy.rows.some(row => !plain(row) || typeof row.sourceId !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceId) || !connections.some(item => item.id === row.connectionId))
        || new Set(legacy.rows.map(row => row.connectionId)).size !== legacy.rows.length)) throw new Error("Invalid legacy import marker");
      return { schemaVersion: 3, resourceBinding: resourceBinding, revision: Number(raw.revision), activeConnectionId: raw.activeConnectionId as string | null, connections,
        ...(legacy ? { legacyImport: structuredClone(legacy) as unknown as LegacyImport } : {}) };
    };
    this.document = new VersionedSettings<Document>(() => storage.run(() => workspaceStateHome()), "workspace-connections-v2.json", 3,
      () => ({ schemaVersion: 3, resourceBinding: binding(), revision: 0, activeConnectionId: null, connections: [] }), parse,
      { 1: raw => ({ ...raw, schemaVersion: 2 }), 2: raw => { this.legacyDocument(raw, false); throw new SettingsMigrationPendingError(); } }, storage);
  }
  private legacyDocument(raw: unknown, fresh: boolean) {
    if (!plain(raw) || ![1, 2].includes(Number(raw.schemaVersion)) || !Array.isArray(raw.connections) || raw.connections.length > 256)
      throw new Error("Invalid old connection store");
    const credentials: CredentialEntry[] = [];
    const connections = raw.connections.map((row, index) => {
      if (!plain(row) || !isConnectionId(row.id) || !isCredentialGeneration(row.credentialGeneration) || !validCredentialKey(row.apiKey))
        throw new Error("Old credential requires explicit recovery");
      const originalGeneration = row.credentialGeneration;
      const generation = fresh && row.status === "active" ? "gen_" + randomUUID() : originalGeneration;
      const keyRef = this.ref(row.id, generation);
      if (fresh && row.status === "active") credentials.push({ ref: keyRef, key: row.apiKey });
      const { apiKey: _key, credentialFile: _file, ...metadata } = row;
      return { ...metadata, keyRef, credentialGeneration: generation, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString() };
    });
    const value = this.parse({ schemaVersion: 3, resourceBinding: raw.resourceBinding, revision: raw.revision,
      activeConnectionId: raw.defaultConnectionId ?? null, connections });
    return { value, credentials };
  }
  private ref(id: string, generation: string) { return this.storage.scopeKey + ":" + id + ":" + generation; }
  private image(raw: unknown): Document | null {
    if (raw === null) return null;
    return plain(raw) && raw.schemaVersion === 3 ? this.parse(raw) : this.legacyDocument(raw, false).value;
  }
  private references(activeOnly = false): Set<string> {
    return this.document.inspect((primary, backup) => new Set([this.image(primary), this.image(backup)].flatMap(doc =>
      doc?.connections.flatMap(row => activeOnly ? row.status === "active" ? [row.keyRef] : [] : [row.keyRef, ...(row.retiredKeyRefs ?? [])]) ?? [])));
  }
  private readonly protectedRef = (ref: string): boolean => this.references().has(ref);

  private confirmPublished(commit: () => Document, isPublished: (document: Document) => boolean): Document {
    try { return commit(); }
    catch (error) {
      // A recovery-copy failure after publication does not undo the primary. Use only a
      // verified current primary and an exact ref match. Unknown outcomes retain the intent.
      try {
        const current = this.document.read();
        if (!current.readOnly && isPublished(current.value)) return current.value;
      } catch { /* Original failure remains authoritative. */ }
      throw error;
    }
  }
  private async writeNew(entries: readonly CredentialEntry[], call: CredentialCall, publish: () => Document,
    beforeWrite?: (refs: readonly string[]) => void, batch = false): Promise<Document> {
    const existing = this.references();
    const refs = entries.map(entry => entry.ref);
    return this.intents.write(this.vault, entries, call, () => this.confirmPublished(publish, document =>
      refs.length > 0 && refs.every(ref => document.connections.some(row => row.keyRef === ref))),
      { protectedRef: this.protectedRef, existingRefs: existing, beforeWrite, batch });
  }
  list(): ReturnType<WorkspaceConnectionStoreV2["list"]> & { activeConnectionId: string | null; readOnly: boolean; recovered: boolean; migrationPending: boolean; cleanupPending: boolean } {
    const state = this.document.read();
    const pending = state.value.legacyImport?.state === "pending", pendingRefs = this.intents.pendingRefs();
    return { revision: state.value.revision, defaultConnectionId: pending || state.value.connections.some(row => row.id === state.value.activeConnectionId && (row.credentialInvalid || row.credentialMissing)) ? null : state.value.activeConnectionId, activeConnectionId: state.value.activeConnectionId, readOnly: state.readOnly || pending, recovered: state.recovered, migrationPending: state.migrationPending || pending, cleanupPending: pendingRefs.size > 0,
      connections: state.value.connections.map(row => ({ id: row.id, label: row.label, provider: row.provider, baseURL: row.baseURL, defaultModel: row.defaultModel,
        defaultReasoning: row.defaultReasoning ?? null,
        credentialGeneration: row.credentialGeneration, revision: row.revision, status: row.status, keySaved: !pending && !row.credentialMissing && row.status === "active", keyState: pending || row.credentialMissing ? "pending" : row.credentialInvalid ? "invalid" : "saved", credentialRequired: row.credentialMissing === true, cleanupPending: Boolean(row.retiredKeyRefs?.length) || pendingRefs.has(row.id), createdAt: row.createdAt, updatedAt: row.updatedAt })) };
  }
  /** Metadata-only prefill, once per personal Workspace. No vault access or secret persistence. */
  stageLegacyImport(rows: readonly LegacyConnectionSeed[], extendReviewedOwnerImport = false): void {
    if (!rows.length) return;
    const state = this.document.read(); if (state.readOnly || state.value.legacyImport && !extendReviewedOwnerImport) return;
    if (rows.length > 256) throw new Error("Too many legacy connections");
    const oldPending = state.value.legacyImport?.state === "pending" ? state.value.legacyImport.rows : [];
    if (oldPending.some(row => !rows.some(source => source.id === row.sourceId))) throw new Error("Legacy source changed after preview; original settings preserved");
    const now = new Date().toISOString(), fresh = rows.filter(row => !state.value.connections.some(old => old.importId === row.id));
    const entries: Metadata[] = fresh.map(row => { const id = `mc_${randomUUID()}`, generation = `gen_${randomUUID()}`;
      return { ...checked(row), id, credentialGeneration: generation, keyRef: `${state.value.resourceBinding.scopeKey}:${id}:${generation}`,
        revision: 1, status: "active", credentialMissing: row.keySaved === false, createdAt: now, updatedAt: now, importId: row.id }; });
    const authorizations = [...oldPending, ...entries.flatMap((row, index) => row.credentialMissing ? [] : [{ connectionId: row.id, sourceId: fresh[index]!.id }])];
    if (!fresh.length && state.value.legacyImport) return;
    this.document.update(state.value.revision, current => ({ ...current, connections: [...current.connections, ...entries],
      activeConnectionId: current.activeConnectionId ?? entries[fresh.findIndex(row => row.isDefault)]?.id ?? entries[0]?.id ?? null,
      legacyImport: { state: authorizations.length ? "pending" : "complete", rows: authorizations } }));
  }
  /** Private owner migration receipts only; never renderer/RPC DTOs, never credential values. */
  inheritanceMetadata() {
    const state = this.document.read(); if (state.readOnly) throw new Error("Secure settings require recovery before inheritance");
    return state.value.connections.filter(row => row.status === "active").map(row => ({ id: row.id, importId: row.importId ?? null,
      keyRef: row.keyRef, keyRequired: row.credentialMissing === true, credentialGeneration: row.credentialGeneration }));
  }
  async retryMigration(expected: number, call: CredentialCall = { signal: credentialDeadline() },
    beforeWrite?: (refs: readonly string[]) => void): Promise<ReturnType<WorkspaceSecureConnections["list"]>> {
    assertCredentialCall(call);
    const state = this.document.read();
    if (state.value.revision !== expected) throw new Error("Legacy batch changed; refresh before retrying");
    if (!state.readOnly && state.value.legacyImport?.state === "pending") {
      if (!this.resolveLegacy) throw new Error("Legacy source unavailable; original preserved");
      const replacements = new Map<string, Metadata>(), entries: CredentialEntry[] = [];
      for (const row of state.value.legacyImport.rows) {
        assertCredentialCall(call);
        const metadata = state.value.connections.find(item => item.id === row.connectionId)!;
        const resolved = await this.resolveLegacy(row.sourceId, call);
        if (resolved.importId !== row.sourceId || JSON.stringify(checked(resolved.input)) !== JSON.stringify(checked(metadata))
          || !validCredentialKey(resolved.input.apiKey)) throw new Error("Legacy source changed; original preserved");
        const generation = "gen_" + randomUUID(), ref = this.ref(metadata.id, generation);
        replacements.set(metadata.id, { ...metadata, keyRef: ref, credentialGeneration: generation });
        entries.push({ ref, key: resolved.input.apiKey });
      }
      const fence = () => {
        assertCredentialCall(call);
        if (this.document.read().value.revision !== expected) throw new Error("Legacy batch changed; original preserved");
      };
      fence();
      await this.writeNew(entries, { ...call, assertCurrent: fence }, () => this.document.update(expected, current => ({ ...current,
        connections: current.connections.map(row => replacements.get(row.id) ?? row),
        legacyImport: { ...current.legacyImport!, state: "complete" },
      }), () => assertCredentialCall(call)), beforeWrite, true);
      return this.list();
    }
    if (!state.migrationPending || state.recovered) throw new Error("Migration state changed or requires backup recovery; original preserved");
    const prepared = this.document.inspect((raw, _backup, fingerprint) => {
      if (!fingerprint) throw new Error("Original settings are missing");
      return { ...this.legacyDocument(raw, true), fingerprint };
    });
    await this.writeNew(prepared.credentials, call, () => this.document.commitDeferredMigration(prepared.fingerprint, prepared.value,
      () => assertCredentialCall(call)), beforeWrite, true);
    return this.list();
  }
  async add(value: ScopedConnectionInput, expected: number, call?: CredentialCall): Promise<ScopedConnectionView> {
    return this.importConnection(value, expected, undefined, call);
  }
  async importConnection(value: ScopedConnectionInput, expected: number, importId?: string, call: CredentialCall = { signal: credentialDeadline() }): Promise<ScopedConnectionView> {
    assertCredentialCall(call);
    const metadata = checked(value), state = this.document.read();
    const prior = importId && state.value.connections.find(row => row.importId === importId && row.status === "active");
    if (prior) return this.list().connections.find(row => row.id === prior.id)!;
    this.requireWritable(state, expected);
    if (!validCredentialKey(value.apiKey) || value.credentialFile) throw new CredentialVaultError("invalid_request");
    if (state.value.connections.length >= 256) throw new Error("Too many secure connections");
    const id = "mc_" + randomUUID(), generation = "gen_" + randomUUID(), keyRef = this.ref(id, generation), now = new Date().toISOString();
    const row: Metadata = { ...metadata, defaultReasoning: Object.hasOwn(value, "defaultReasoning") || importId ? metadata.defaultReasoning ?? null
      : defaultEffortForLevels(connectionModelEfforts(metadata, metadata.defaultModel)) as ScopedConnection["defaultReasoning"],
      id, keyRef, credentialGeneration: generation, revision: 1, status: "active", createdAt: now, updatedAt: now, ...(importId ? { importId } : {}) };
    await this.writeNew([{ ref: keyRef, key: value.apiKey }], call, () => this.document.update(expected, current => ({ ...current,
      activeConnectionId: current.activeConnectionId ?? id, connections: [...current.connections, row],
    }), () => assertCredentialCall(call)));
    return this.list().connections.find(item => item.id === id)!;
  }
  private requireWritable(state: StateView, expected: number) {
    if (state.readOnly || state.value.legacyImport?.state === "pending" || state.value.revision !== expected)
      throw new Error("Refresh or unlock secure settings before saving");
  }
  async edit(id: string, value: unknown, expected: number, call: CredentialCall = { signal: credentialDeadline() }): Promise<void> {
    assertCredentialCall(call);
    const metadata = checked(value), state = this.document.read(), row = state.value.connections.find(item => item.id === id && item.status === "active");
    this.requireWritable(state, expected);
    if (!row || !plain(value)) throw new Error("Connection changed; refresh before editing");
    const key = value.apiKey === "" || value.apiKey === undefined ? row.credentialMissing ? undefined : await this.vault.get(row.keyRef, call) : value.apiKey;
    if (!validCredentialKey(key)) throw new CredentialVaultError("credential_unreadable");
    assertCredentialCall(call); this.requireWritable(this.document.read(), expected);
    const generation = "gen_" + randomUUID(), ref = this.ref(id, generation);
    const retiredKeyRefs = [...new Set([...(row.retiredKeyRefs ?? []), ...(row.credentialMissing ? [] : [row.keyRef])])];
    if (retiredKeyRefs.length > 256) throw new CredentialVaultError("unavailable");
    const next: Metadata = { ...row, ...metadata, defaultReasoning: Object.hasOwn(value, "defaultReasoning") ? metadata.defaultReasoning ?? null
      : metadata.defaultModel === row.defaultModel ? row.defaultReasoning ?? null
      : defaultEffortForLevels(connectionModelEfforts(metadata, metadata.defaultModel)) as ScopedConnection["defaultReasoning"],
      keyRef: ref, credentialInvalid: false, credentialMissing: false, retiredKeyRefs, credentialGeneration: generation, revision: row.revision + 1, updatedAt: new Date().toISOString() };
    const saved = await this.writeNew([{ ref, key }], call, () => this.document.update(expected, current => ({ ...current,
      connections: current.connections.map(item => item.id === id ? next : item),
    }), () => assertCredentialCall(call)));
    this.onGenerationChanged?.(id);
    try { await this.cleanupRetired(id, saved.revision, call); }
    catch { /* The new generation is published. Existing cleanupPending flags the old refs. */ }
  }
  async replace(id: string, value: ScopedConnectionInput, expected: number, call?: CredentialCall) { return this.edit(id, value, expected, call); }
  async revoke(id: string, expected: number, call: CredentialCall = { signal: credentialDeadline() }): Promise<void> {
    assertCredentialCall(call);
    const state = this.document.read(), row = state.value.connections.find(item => item.id === id);
    this.requireWritable(state, expected);
    if (!row) throw new Error("Connection changed; refresh before removal");
    const generation = "gen_" + randomUUID();
    const revoked = row.status === "revoked" ? state.value : this.confirmPublished(() => this.document.update(expected, current => {
      const item = current.connections.find(r => r.id === id)!;
      item.status = "revoked"; item.revision++; item.credentialGeneration = generation;
      item.retiredKeyRefs = [...new Set([...(item.retiredKeyRefs ?? []), ...(item.credentialMissing ? [] : [item.keyRef])])];
      if (current.activeConnectionId === id) current.activeConnectionId = current.connections.filter(r => r.status === "active")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]?.id ?? null;
      return current;
    }, () => assertCredentialCall(call)), document => document.connections.some(item =>
      item.id === id && item.status === "revoked" && item.credentialGeneration === generation));
    this.onGenerationChanged?.(id);
    try { await this.cleanupRetired(id, revoked.revision, call); }
    catch { /* Revocation is already durable and still fails closed. */ }
  }
  async cleanupCredentials(id: string | undefined, expected: number, call: CredentialCall = { signal: credentialDeadline() }): Promise<void> {
    const state = this.document.read();
    if (state.value.revision !== expected || (id !== undefined && (!isConnectionId(id) || state.readOnly))
      || (id === undefined && state.readOnly && (!state.migrationPending || state.recovered)))
      throw new Error("Credential cleanup changed; refresh before retrying");
    if (id !== undefined && state.value.connections.some(row => row.id === id)) await this.cleanupRetired(id, expected, call);
    await this.intents.cleanup(this.vault, this.protectedRef, call, { connectionId: id });
  }
  private async cleanupRetired(id: string, expected: number, call: CredentialCall) {
    const state = this.document.read(), row = state.value.connections.find(item => item.id === id);
    if (!row || state.readOnly || state.value.revision !== expected) throw new Error("Credential cleanup changed; refresh before retrying");
    const refs = row.retiredKeyRefs ?? [];
    if (!refs.length) return;
    for (const ref of refs) {
      const fence = () => {
        assertCredentialCall(call);
        if (this.references(true).has(ref)) throw new CredentialVaultError("cleanup_unconfirmed");
      };
      fence();
      await this.vault.remove(ref, { ...call, assertCurrent: fence });
    }
    this.document.update(expected, current => ({ ...current, connections: current.connections.map(item => item.id === id ? { ...item, retiredKeyRefs: [] } : item) }),
      () => assertCredentialCall(call));
  }
  select(id: string, expected: number, modelId?: string, effort?: ScopedConnectionInput["defaultReasoning"], assertWriteCurrent?: () => void) { this.document.update(expected, current => {
    if (current.legacyImport?.state === "pending") throw new Error("Credential authorization pending");
    const row = current.connections.find(row => row.id === id && row.status === "active");
    if (!row || modelId !== undefined && !text(modelId)) throw new Error("Connection unavailable");
    if (modelId !== undefined) {
      const nextEffort = effort === undefined ? (row.defaultModel === modelId ? row.defaultReasoning ?? null
        : defaultEffortForLevels(connectionModelEfforts(row, modelId)) as ScopedConnection["defaultReasoning"]) : effort;
      row.defaultModel = modelId; row.defaultReasoning = nextEffort; row.updatedAt = new Date().toISOString();
    }
    current.activeConnectionId = id; return current;
  }, assertWriteCurrent); }
  capture(id?: string, model?: string): Readonly<ScopedRunConnection> {
    const state = this.document.read().value;
    if (state.legacyImport?.state === "pending") throw new Error("Credential authorization pending; no model call allowed");
    const row = state.connections.find(row => row.id === (id ?? state.activeConnectionId) && row.status === "active");
    if (!row || row.credentialInvalid || row.credentialMissing || model !== undefined && !text(model)) throw new Error("invalid or unavailable scoped model connection; no fallback was selected");
    return deepFreeze({ connectionId: row.id, credentialGeneration: row.credentialGeneration, connectionRevision: row.revision, model: model ?? row.defaultModel, reasoning: row.defaultReasoning ?? null });
  }
  private boundRow(binding: ScopedRunConnection): Metadata {
    if (!isScopedRunConnection(binding)) throw new Error("Invalid connection binding");
    const state = this.document.read().value;
    if (state.legacyImport?.state === "pending") throw new Error("Credential authorization pending; no model call allowed");
    const row = state.connections.find(item => item.id === binding.connectionId && item.status === "active");
    if (!row || row.credentialInvalid || row.credentialMissing || row.credentialGeneration !== binding.credentialGeneration
      || row.revision !== binding.connectionRevision) throw new Error("Original connection generation unavailable");
    return row;
  }
  /** Synchronous run fences inspect only the published generation and provider route. */
  providerForBinding(binding: ScopedRunConnection): ScopedConnection["provider"] {
    return this.boundRow(binding).provider;
  }
  async resolve(binding: ScopedRunConnection, call: CredentialCall = { signal: credentialDeadline() }): Promise<Readonly<ScopedConnection>> {
    assertCredentialCall(call);
    const row = this.boundRow(binding);
    const apiKey = await this.vault.get(row.keyRef, call);
    assertCredentialCall(call);
    const current = this.boundRow(binding);
    if (current.keyRef !== row.keyRef || current.baseURL !== row.baseURL || current.provider !== row.provider)
      throw new Error("Original connection generation unavailable");
    if (!apiKey) throw new CredentialVaultError("credential_unreadable");
    const { keyRef: _ref, ...metadata } = current;
    return deepFreeze({ ...metadata, apiKey });
  }
  markCredentialInvalid(binding: ScopedRunConnection) {
    const state = this.document.read(), row = state.value.connections.find(item => item.id === binding.connectionId);
    if (state.readOnly || !row || row.credentialInvalid || row.credentialGeneration !== binding.credentialGeneration || row.revision !== binding.connectionRevision) return;
    this.document.update(state.value.revision, current => ({ ...current, connections: current.connections.map(item => item.id === row.id ? { ...item, credentialInvalid: true } : item) }));
  }
}
