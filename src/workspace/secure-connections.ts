import { randomUUID } from "node:crypto";
import { WorkspaceConnectionStoreV2, isScopedRunConnection, isConnectionId, isCredentialGeneration, type ScopedConnectionInput, type ScopedConnection, type ScopedConnectionView, type ScopedRunConnection } from "./scoped-connections.js";
import { currentWorkspaceResourceBinding, sameWorkspaceResourceBinding, workspaceStateHome, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { deepFreeze, plain, positive, text } from "./local-state.js";
import { VersionedSettings } from "./versioned-settings.js";
import type { CredentialVault } from "./credential-vault.js";

interface Metadata extends Omit<ScopedConnection, "apiKey" | "credentialFile"> { keyRef: string; createdAt: string; updatedAt: string; importId?: string; retiredKeyRefs?: string[] }
interface Document { schemaVersion: 3; resourceBinding: WorkspaceResourceBinding; revision: number; activeConnectionId: string | null; connections: Metadata[] }
function checked(value: unknown) {
  if (!plain(value) || !text(value.label, 80) || !text(value.defaultModel) || !text(value.baseURL, 4096) || !["openai", "anthropic"].includes(String(value.provider))) throw new Error("Invalid model connection metadata");
  let url: URL; try { url = new URL(value.baseURL); } catch { throw new Error("Invalid model endpoint"); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Unsafe model endpoint");
  return { label: value.label, provider: value.provider as "openai" | "anthropic", baseURL: value.baseURL, defaultModel: value.defaultModel };
}
export class WorkspaceSecureConnections extends WorkspaceConnectionStoreV2 {
  private readonly document: VersionedSettings<Document>;
  constructor(storage: WorkspaceResourceStorage, private readonly vault: CredentialVault) {
    super(storage);
    const binding = () => storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
    const parse = (raw: unknown): Document => {
      if (!plain(raw) || raw.schemaVersion !== 3 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding())
        || !Array.isArray(raw.connections) || raw.connections.length > 256) throw new Error("Invalid secure model settings");
      const ids = new Set<string>(), connections: Metadata[] = raw.connections.map(row => {
        if (!plain(row) || Object.hasOwn(row, "apiKey") || Object.hasOwn(row, "credentialFile") || !isConnectionId(row.id) || ids.has(row.id) || !isCredentialGeneration(row.credentialGeneration)
          || !positive(row.revision) || !["active", "revoked"].includes(String(row.status)) || typeof row.keyRef !== "string" || !row.keyRef.startsWith(`${binding().scopeKey}:${row.id}:`)
          || row.status === "active" && row.keyRef !== `${binding().scopeKey}:${row.id}:${row.credentialGeneration}`
          || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error("Invalid secure connection");
        const retiredKeyRefs = row.retiredKeyRefs ?? [];
        if (!Array.isArray(retiredKeyRefs) || retiredKeyRefs.length > 256 || retiredKeyRefs.some(ref => typeof ref !== "string" || !ref.startsWith(`${binding().scopeKey}:${row.id}:`) || !isCredentialGeneration(ref.slice(ref.lastIndexOf(":") + 1)))) throw new Error("Invalid credential cleanup record");
        ids.add(row.id); return { ...checked(row), id: row.id, keyRef: row.keyRef, credentialGeneration: row.credentialGeneration, revision: row.revision,
          status: row.status as "active" | "revoked", createdAt: row.createdAt, updatedAt: row.updatedAt, retiredKeyRefs, ...(typeof row.importId === "string" ? { importId: row.importId } : {}) };
      });
      if (raw.activeConnectionId !== null && !connections.some(row => row.id === raw.activeConnectionId && row.status === "active")) throw new Error("Invalid active connection");
      return { schemaVersion: 3, resourceBinding: binding(), revision: Number(raw.revision), activeConnectionId: raw.activeConnectionId as string | null, connections };
    };
    this.document = new VersionedSettings(() => storage.run(() => workspaceStateHome()), "workspace-connections-v2.json", 3,
      () => ({ schemaVersion: 3, resourceBinding: binding(), revision: 0, activeConnectionId: null, connections: [] }), parse,
      { 1: raw => ({ ...raw, schemaVersion: 2 }), 2: raw => {
        if (!Array.isArray(raw.connections) || !sameWorkspaceResourceBinding(raw.resourceBinding, binding())) throw new Error("Invalid old connection store");
        const connections = raw.connections.map((row: any, index: number) => {
          checked(row); if (!isConnectionId(row.id) || !isCredentialGeneration(row.credentialGeneration) || !text(row.apiKey, 16384)) throw new Error("Old credential requires explicit recovery");
          const keyRef = `${binding().scopeKey}:${row.id}:${row.credentialGeneration}`; if (row.status === "active") this.vault.set(keyRef, row.apiKey);
          const { apiKey: _key, credentialFile: _file, ...metadata } = row;
          return { ...metadata, keyRef, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString() };
        });
        return { schemaVersion: 3, resourceBinding: raw.resourceBinding, revision: raw.revision, activeConnectionId: raw.defaultConnectionId ?? null, connections };
      } }, storage, (_old, next) => next);
  }
  override list(): ReturnType<WorkspaceConnectionStoreV2["list"]> & { activeConnectionId: string | null; readOnly: boolean; recovered: boolean } {
    const state = this.document.read();
    return { revision: state.value.revision, defaultConnectionId: state.value.activeConnectionId, activeConnectionId: state.value.activeConnectionId, readOnly: state.readOnly, recovered: state.recovered,
      connections: state.value.connections.map(row => ({ id: row.id, label: row.label, provider: row.provider, baseURL: row.baseURL, defaultModel: row.defaultModel,
        credentialGeneration: row.credentialGeneration, revision: row.revision, status: row.status, keySaved: row.status === "active", cleanupPending: Boolean(row.retiredKeyRefs?.length), createdAt: row.createdAt, updatedAt: row.updatedAt })) };
  }
  override add(value: ScopedConnectionInput, expected: number): ScopedConnectionView { return this.importConnection(value, expected); }
  importConnection(value: ScopedConnectionInput, expected: number, importId?: string): ScopedConnectionView {
    const metadata = checked(value), state = this.document.read();
    const prior = importId && state.value.connections.find(row => row.importId === importId && row.status === "active");
    if (prior) return this.list().connections.find(row => row.id === prior.id)!;
    if (state.readOnly || state.value.revision !== expected || !value.apiKey || value.credentialFile) throw new Error("Refresh or unlock secure settings before saving");
    const id = `mc_${randomUUID()}`, generation = `gen_${randomUUID()}`, keyRef = `${state.value.resourceBinding.scopeKey}:${id}:${generation}`, now = new Date().toISOString();
    this.vault.set(keyRef, value.apiKey);
    try { this.document.update(expected, current => ({ ...current, activeConnectionId: current.activeConnectionId ?? id, connections: [...current.connections,
      { ...metadata, id, keyRef, credentialGeneration: generation, revision: 1, status: "active", createdAt: now, updatedAt: now, ...(importId ? { importId } : {}) }] })); }
    catch (error) { this.discardUncommittedCredential(keyRef, expected); throw error; }
    return this.list().connections.find(row => row.id === id)!;
  }
  edit(id: string, value: unknown, expected: number): void {
    const metadata = checked(value), state = this.document.read(), row = state.value.connections.find(row => row.id === id && row.status === "active");
    if (!row || state.readOnly || state.value.revision !== expected || !plain(value)) throw new Error("Connection changed; refresh before editing");
    const key = value.apiKey === "" || value.apiKey === undefined ? this.vault.get(row.keyRef) : value.apiKey;
    if (typeof key !== "string" || !key) throw new Error("Saved credential is unavailable");
    const generation = `gen_${randomUUID()}`, ref = `${state.value.resourceBinding.scopeKey}:${id}:${generation}`;
    this.vault.set(ref, key);
    try { this.document.update(expected, current => ({ ...current, connections: current.connections.map(item => item.id === id
      ? { ...item, ...metadata, keyRef: ref, retiredKeyRefs: [...new Set([...(item.retiredKeyRefs ?? []), item.keyRef])], credentialGeneration: generation, revision: item.revision + 1, updatedAt: new Date().toISOString() } : item) })); }
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
    if (!row || state.readOnly || state.value.revision !== expected) throw new Error("Connection changed; refresh before removal");
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
    if (!current.connections.some(row => row.id === id && row.status === "active")) throw new Error("Connection unavailable");
    current.activeConnectionId = id; return current;
  }); }
  override capture(id?: string, model?: string): Readonly<ScopedRunConnection> {
    const state = this.document.read().value, row = state.connections.find(row => row.id === (id ?? state.activeConnectionId) && row.status === "active");
    if (!row || model !== undefined && !text(model)) throw new Error("invalid or unavailable scoped model connection; no fallback was selected");
    return deepFreeze({ connectionId: row.id, credentialGeneration: row.credentialGeneration, connectionRevision: row.revision, model: model ?? row.defaultModel, reasoning: null });
  }
  override resolve(binding: ScopedRunConnection): Readonly<ScopedConnection> {
    if (!isScopedRunConnection(binding)) throw new Error("Invalid connection binding");
    const row = this.document.read().value.connections.find(row => row.id === binding.connectionId && row.status === "active");
    if (!row || row.credentialGeneration !== binding.credentialGeneration || row.revision !== binding.connectionRevision) throw new Error("Original connection generation unavailable");
    const apiKey = this.vault.get(row.keyRef); if (!apiKey) throw new Error("Original credential unavailable; no fallback selected");
    const { keyRef: _ref, ...metadata } = row; return deepFreeze({ ...metadata, apiKey });
  }
}
