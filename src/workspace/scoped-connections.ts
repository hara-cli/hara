import { randomUUID } from "node:crypto";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { deepFreeze, exact, plain, positive, text, UUID, WorkspaceJsonState } from "./local-state.js";

export interface ScopedConnection {
  id: string;
  label: string;
  provider: "openai" | "anthropic";
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  credentialGeneration: string;
  revision: number;
  status: "active" | "revoked";
}
export interface ScopedConnectionState {
  schemaVersion: 2;
  resourceBinding: WorkspaceResourceBinding;
  revision: number;
  defaultConnectionId: string | null;
  connections: ScopedConnection[];
}
export interface ScopedRunConnection {
  connectionId: string;
  credentialGeneration: string;
  connectionRevision: number;
  model: string;
  reasoning: string | null;
}
export type ScopedConnectionInput = Pick<ScopedConnection, "label" | "provider" | "baseURL" | "apiKey" | "defaultModel">;
export type ScopedConnectionView = Omit<ScopedConnection, "apiKey" | "baseURL">;
const fail = (): never => { throw new Error("invalid or unavailable scoped model connection; no fallback was selected"); };
export function isConnectionId(value: unknown): value is string { return typeof value === "string" && value.startsWith("mc_") && UUID.test(value.slice(3)); }
export function isCredentialGeneration(value: unknown): value is string { return typeof value === "string" && value.startsWith("gen_") && UUID.test(value.slice(4)); }
function input(value: unknown): ScopedConnectionInput {
  if (!plain(value) || !exact(value, ["label", "provider", "baseURL", "apiKey", "defaultModel"])
    || !text(value.label, 80) || !text(value.apiKey, 16_384) || /\s/.test(value.apiKey)
    || !text(value.defaultModel) || !text(value.baseURL, 4096)
    || (value.provider !== "openai" && value.provider !== "anthropic")) return fail();
  let url: URL;
  try { url = new URL(value.baseURL); } catch { return fail(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail();
  if (url.protocol !== "https:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) return fail();
  return value as unknown as ScopedConnectionInput;
}
export function isScopedRunConnection(value: unknown): value is ScopedRunConnection {
  return plain(value) && exact(value, ["connectionId", "credentialGeneration", "connectionRevision", "model", "reasoning"])
    && isConnectionId(value.connectionId) && isCredentialGeneration(value.credentialGeneration)
    && positive(value.connectionRevision) && text(value.model) && (value.reasoning === null || text(value.reasoning, 64));
}

/** The v2 connection and its credential generation are one atomic, owner-only Workspace snapshot. */
export class WorkspaceConnectionStoreV2 {
  private readonly state: WorkspaceJsonState<ScopedConnectionState>;
  constructor(storage: WorkspaceResourceStorage) {
    const binding = () => this.state.binding();
    this.state = new WorkspaceJsonState(storage, "workspace-connections-v2.json", value => {
      if (!plain(value) || !exact(value, ["schemaVersion", "resourceBinding", "revision", "defaultConnectionId", "connections"])
        || value.schemaVersion !== 2 || !positive(value.revision)
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, binding())
        || !Array.isArray(value.connections) || value.connections.length > 256) return fail();
      const seen = new Set<string>();
      for (const row of value.connections) {
        if (!plain(row) || !exact(row, ["id", "label", "provider", "baseURL", "apiKey", "defaultModel", "credentialGeneration", "revision", "status"])
          || !isConnectionId(row.id) || seen.has(row.id) || !isCredentialGeneration(row.credentialGeneration)
          || !positive(row.revision) || !["active", "revoked"].includes(String(row.status))) return fail();
        input({ label: row.label, provider: row.provider, baseURL: row.baseURL, apiKey: row.apiKey, defaultModel: row.defaultModel });
        seen.add(row.id);
      }
      if (value.defaultConnectionId !== null && !value.connections.some(row => row.id === value.defaultConnectionId && row.status === "active")) return fail();
      return structuredClone(value) as unknown as ScopedConnectionState;
    }, () => ({ schemaVersion: 2, revision: 0, resourceBinding: binding(), defaultConnectionId: null, connections: [] }));
  }
  list(): { revision: number; defaultConnectionId: string | null; connections: ScopedConnectionView[] } {
    const state = this.state.read();
    return { revision: state.revision, defaultConnectionId: state.defaultConnectionId,
      connections: state.connections.map(({ apiKey: _key, baseURL: _url, ...safe }) => safe) };
  }
  add(value: ScopedConnectionInput, expectedRevision: number): ScopedConnectionView {
    const checked = input(value), id = `mc_${randomUUID()}`;
    const next = this.state.update(expectedRevision, state => ({ ...state, defaultConnectionId: state.defaultConnectionId ?? id,
      connections: [...state.connections, { ...checked, id, credentialGeneration: `gen_${randomUUID()}`, revision: 1, status: "active" }] }));
    const { apiKey: _key, baseURL: _url, ...safe } = next.connections.find(row => row.id === id)!;
    return safe;
  }
  replace(id: string, value: ScopedConnectionInput, expectedRevision: number): void {
    const checked = input(value);
    this.state.update(expectedRevision, state => {
      const row = state.connections.find(row => row.id === id && row.status === "active");
      if (!row || row.revision >= Number.MAX_SAFE_INTEGER) return fail();
      Object.assign(row, checked, { credentialGeneration: `gen_${randomUUID()}`, revision: row.revision + 1 });
      return state;
    });
  }
  revoke(id: string, expectedRevision: number): void {
    this.state.update(expectedRevision, state => {
      const row = state.connections.find(row => row.id === id && row.status === "active");
      if (!row || row.revision >= Number.MAX_SAFE_INTEGER) return fail();
      row.status = "revoked"; row.credentialGeneration = `gen_${randomUUID()}`; row.revision++;
      if (state.defaultConnectionId === id) state.defaultConnectionId = null;
      return state;
    });
  }
  select(id: string, expectedRevision: number): void {
    this.state.update(expectedRevision, state => {
      if (!state.connections.some(row => row.id === id && row.status === "active")) return fail();
      state.defaultConnectionId = id; return state;
    });
  }
  capture(id?: string, model?: string): Readonly<ScopedRunConnection> {
    const state = this.state.read(), row = state.connections.find(r => r.id === (id ?? state.defaultConnectionId) && r.status === "active");
    if (!row || (model !== undefined && !text(model))) return fail();
    return deepFreeze({ connectionId: row.id, credentialGeneration: row.credentialGeneration,
      connectionRevision: row.revision, model: model ?? row.defaultModel, reasoning: null });
  }
  /** Host-private; never serialize this result into renderer/history/event DTOs. */
  resolve(binding: ScopedRunConnection): Readonly<ScopedConnection> {
    if (!isScopedRunConnection(binding)) return fail();
    const row = this.state.read().connections.find(r => r.id === binding.connectionId);
    if (!row || row.status !== "active" || row.credentialGeneration !== binding.credentialGeneration || row.revision !== binding.connectionRevision) return fail();
    return deepFreeze(row);
  }
}
