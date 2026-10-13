import { randomUUID } from "node:crypto";
import { isValidProfileId, isValidSpaceId } from "../profile/profile.js";

/** Business Workspace ids are not paths, profile ids, tenants, or runtime sessions. */
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const WORKSPACE_ID = new RegExp(`^ws_${UUID}$`);
const CONNECTION_ID = new RegExp(`^mc_${UUID}$`);
const GENERATION_ID = new RegExp(`^gen_${UUID}$`);
const FINGERPRINT = /^[a-f0-9]{64}$/;

export interface WorkspaceRecord {
  id: string;
  label: string;
  createdAt: string;
  /** Compatibility alias only. Never use this to merge new Workspace data or grant access. */
  legacySpaceId?: string;
  defaultConnectionId: string | null;
}

export interface WorkspaceConnection {
  id: string;
  workspaceId: string;
  label: string;
  source: "direct" | "managed";
  /** Private host reference to the existing credential store; never a renderer field. */
  profileId: string;
  credentialGeneration: string;
  routeFingerprint: string;
  revision: number;
  status: "active" | "revoked";
}

export interface WorkspaceRegistry {
  schemaVersion: 1;
  revision: number;
  activeWorkspaceId: string;
  workspaces: WorkspaceRecord[];
  connections: WorkspaceConnection[];
}

/** A trusted host supplies this bounded, credential-free projection during explicit initialization. */
export interface LegacyWorkspaceConnection {
  profileId: string;
  legacySpaceId: string;
  workspaceLabel: string;
  label: string;
  source: "direct" | "managed";
  routeFingerprint: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID.test(value);
}

export function validWorkspaceLabel(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && value.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function connectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID.test(value);
}

/** Refuse corrupt/future state without repairing, dropping fields, or guessing ownership. */
export function parseWorkspaceRegistry(value: unknown): WorkspaceRegistry {
  const fail = (): never => { throw new Error("invalid or unsupported Workspace registry; state was not replaced"); };
  if (!object(value) || !exactKeys(value, ["schemaVersion", "revision", "activeWorkspaceId", "workspaces", "connections"])
    || value.schemaVersion !== 1 || !positiveInteger(value.revision) || !isWorkspaceId(value.activeWorkspaceId)
    || !Array.isArray(value.workspaces) || value.workspaces.length < 1 || value.workspaces.length > 128
    || !Array.isArray(value.connections) || value.connections.length > 1024) return fail();
  const workspaces = new Map<string, WorkspaceRecord>();
  const aliases = new Set<string>();
  for (const row of value.workspaces) {
    if (!object(row) || !exactKeys(row, ["id", "label", "createdAt", "defaultConnectionId"], ["legacySpaceId"])
      || !isWorkspaceId(row.id) || workspaces.has(row.id) || !validWorkspaceLabel(row.label)
      || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
      || (row.defaultConnectionId !== null && !connectionId(row.defaultConnectionId))) return fail();
    if (Object.hasOwn(row, "legacySpaceId")) {
      if (!isValidSpaceId(row.legacySpaceId) || aliases.has(row.legacySpaceId)) return fail();
      aliases.add(row.legacySpaceId);
    }
    workspaces.set(row.id, row as unknown as WorkspaceRecord);
  }
  if (!workspaces.has(value.activeWorkspaceId)) return fail();
  const connections = new Map<string, WorkspaceConnection>();
  const profiles = new Set<string>();
  for (const row of value.connections) {
    if (!object(row) || !exactKeys(row, ["id", "workspaceId", "label", "source", "profileId", "credentialGeneration", "routeFingerprint", "revision", "status"])
      || !connectionId(row.id) || connections.has(row.id) || !isWorkspaceId(row.workspaceId) || !workspaces.has(row.workspaceId)
      || !validWorkspaceLabel(row.label) || (row.source !== "direct" && row.source !== "managed")
      || !isValidProfileId(row.profileId) || profiles.has(row.profileId)
      || typeof row.credentialGeneration !== "string" || !GENERATION_ID.test(row.credentialGeneration)
      || typeof row.routeFingerprint !== "string" || !FINGERPRINT.test(row.routeFingerprint)
      || !positiveInteger(row.revision) || (row.status !== "active" && row.status !== "revoked")) return fail();
    // Managed enrollment mappings cannot be invented from a label, cwd, tier, or direct key.
    const alias = workspaces.get(row.workspaceId)!.legacySpaceId;
    if (row.source === "managed" && (!alias || alias === "personal")) return fail();
    connections.set(row.id, row as unknown as WorkspaceConnection);
    profiles.add(row.profileId);
  }
  for (const workspace of workspaces.values()) {
    if (workspace.defaultConnectionId === null) continue;
    const connection = connections.get(workspace.defaultConnectionId);
    if (!connection || connection.workspaceId !== workspace.id || connection.status !== "active") return fail();
  }
  // A caller never receives aliases into a subsequently mutated persistence snapshot.
  return structuredClone(value) as unknown as WorkspaceRegistry;
}

function workspace(label: string, now: string): WorkspaceRecord {
  if (!validWorkspaceLabel(label) || !Number.isFinite(Date.parse(now))) throw new Error("invalid Workspace name or creation time");
  return { id: `ws_${randomUUID()}`, label, createdAt: now, defaultConnectionId: null };
}

/** One compatibility Workspace per old Space, NOT one per key. No source credential/data is rewritten. */
export function bootstrapWorkspaceRegistry(
  legacy: readonly LegacyWorkspaceConnection[],
  activeProfileId: string | null,
  now = new Date().toISOString(),
): WorkspaceRegistry {
  const registry: WorkspaceRegistry = { schemaVersion: 1, revision: 1, activeWorkspaceId: "", workspaces: [], connections: [] };
  const byAlias = new Map<string, WorkspaceRecord>();
  const profileIds = new Set<string>();
  for (const input of legacy) {
    if (!isValidProfileId(input.profileId) || profileIds.has(input.profileId) || !isValidSpaceId(input.legacySpaceId)
      || !FINGERPRINT.test(input.routeFingerprint) || !validWorkspaceLabel(input.label)
      || (input.source !== "direct" && input.source !== "managed")
      || (input.source === "direct" && input.legacySpaceId !== "personal")
      || (input.source === "managed" && input.legacySpaceId === "personal")) throw new Error("invalid legacy Workspace connection projection");
    profileIds.add(input.profileId);
    let owner = byAlias.get(input.legacySpaceId);
    if (!owner) {
      owner = workspace(input.legacySpaceId === "personal" ? "我的空間" : input.workspaceLabel, now);
      owner.legacySpaceId = input.legacySpaceId;
      byAlias.set(input.legacySpaceId, owner);
      registry.workspaces.push(owner);
    }
    const connection: WorkspaceConnection = {
      id: `mc_${randomUUID()}`, workspaceId: owner.id, label: input.label, source: input.source,
      profileId: input.profileId, routeFingerprint: input.routeFingerprint,
      credentialGeneration: `gen_${randomUUID()}`, revision: 1, status: "active",
    };
    registry.connections.push(connection);
    if (owner.defaultConnectionId === null || input.profileId === activeProfileId) owner.defaultConnectionId = connection.id;
    if (input.profileId === activeProfileId) registry.activeWorkspaceId = owner.id;
  }
  if (legacy.length === 0 && activeProfileId === null) {
    const initial = workspace("我的空間", now);
    registry.workspaces.push(initial);
    registry.activeWorkspaceId = initial.id;
  } else if (!registry.activeWorkspaceId) {
    throw new Error("legacy active connection is unavailable; Workspace ownership needs confirmation");
  }
  return parseWorkspaceRegistry(registry);
}

function change(registry: WorkspaceRegistry, update: (next: WorkspaceRegistry) => void): WorkspaceRegistry {
  const next = parseWorkspaceRegistry(registry);
  if (next.revision === Number.MAX_SAFE_INTEGER) throw new Error("Workspace registry revision is exhausted");
  update(next);
  next.revision++;
  return parseWorkspaceRegistry(next);
}

export function addWorkspace(registry: WorkspaceRegistry, label: string, now = new Date().toISOString()): WorkspaceRegistry {
  return change(registry, (next) => { next.workspaces.push(workspace(label, now)); });
}

/** Only front-end selection changes. Existing runs, profiles, credentials, and defaults are untouched. */
export function selectWorkspace(registry: WorkspaceRegistry, workspaceId: string): WorkspaceRegistry {
  return change(registry, (next) => {
    if (!next.workspaces.some((row) => row.id === workspaceId)) throw new Error("Workspace is unavailable");
    next.activeWorkspaceId = workspaceId;
  });
}

export function setWorkspaceDefault(registry: WorkspaceRegistry, workspaceId: string, id: string): WorkspaceRegistry {
  return change(registry, (next) => {
    const owner = next.workspaces.find((row) => row.id === workspaceId);
    const connection = next.connections.find((row) => row.id === id);
    if (!owner || !connection || connection.workspaceId !== workspaceId || connection.status !== "active") {
      throw new Error("model connection is unavailable in this Workspace");
    }
    owner.defaultConnectionId = id;
  });
}

export function revokeWorkspaceConnection(registry: WorkspaceRegistry, workspaceId: string, id: string): WorkspaceRegistry {
  return change(registry, (next) => {
    const connection = next.connections.find((row) => row.id === id && row.workspaceId === workspaceId);
    if (!connection) throw new Error("model connection is unavailable in this Workspace");
    connection.status = "revoked";
    connection.revision++;
    const owner = next.workspaces.find((row) => row.id === workspaceId)!;
    if (owner.defaultConnectionId === id) owner.defaultConnectionId = null;
  });
}

/** Explicit host-side assignment of a previously unassigned direct connection. Not a credential import
 * or authorization grant; callers must verify the owner's action before using this persistence primitive. */
export function attachDirectWorkspaceConnection(
  registry: WorkspaceRegistry, workspaceId: string, input: LegacyWorkspaceConnection,
): WorkspaceRegistry {
  return change(registry, (next) => {
    if (!next.workspaces.some((row) => row.id === workspaceId) || input.source !== "direct"
      || input.legacySpaceId !== "personal" || !isValidProfileId(input.profileId)
      || !validWorkspaceLabel(input.label) || !FINGERPRINT.test(input.routeFingerprint)
      || next.connections.some((row) => row.profileId === input.profileId)) {
      throw new Error("direct connection needs an explicit, unassigned Workspace owner");
    }
    next.connections.push({
      id: `mc_${randomUUID()}`, workspaceId, label: input.label, source: "direct", profileId: input.profileId,
      credentialGeneration: `gen_${randomUUID()}`, routeFingerprint: input.routeFingerprint,
      revision: 1, status: "active",
    });
    // Adding a key does not silently choose it as the default or revive an old run.
  });
}

/** After explicit host reauthorization, rotate the connection generation even if the route is unchanged.
 * Never silently adopt a different enrollment/Workspace, source type, or profile id. */
export function reauthorizeWorkspaceConnection(
  registry: WorkspaceRegistry, workspaceId: string, id: string, input: LegacyWorkspaceConnection,
): WorkspaceRegistry {
  return change(registry, (next) => {
    const owner = next.workspaces.find((row) => row.id === workspaceId);
    const connection = next.connections.find((row) => row.id === id && row.workspaceId === workspaceId);
    if (!owner || !connection || connection.profileId !== input.profileId || connection.source !== input.source
      || !FINGERPRINT.test(input.routeFingerprint) || !validWorkspaceLabel(input.label)
      || (connection.source === "managed" && owner.legacySpaceId !== input.legacySpaceId)
      || (connection.source === "direct" && input.legacySpaceId !== "personal")) {
      throw new Error("connection reauthorization cannot change Workspace ownership or enrollment");
    }
    connection.label = input.label;
    connection.routeFingerprint = input.routeFingerprint;
    connection.credentialGeneration = `gen_${randomUUID()}`;
    connection.revision++;
    connection.status = "active";
  });
}

/** Renderer projection: no profile refs, route/credential fingerprints, or legacy audience aliases. */
export function workspaceDirectory(registry: WorkspaceRegistry) {
  const valid = parseWorkspaceRegistry(registry);
  return {
    schemaVersion: valid.schemaVersion,
    revision: valid.revision,
    activeWorkspaceId: valid.activeWorkspaceId,
    workspaces: valid.workspaces.map(({ id, label, createdAt, defaultConnectionId }) => ({ id, label, createdAt, defaultConnectionId })),
  };
}

/** Call only after the trusted host verifies membership and visibility for this exact Workspace. */
export function workspaceConnections(registry: WorkspaceRegistry, workspaceId: string) {
  const valid = parseWorkspaceRegistry(registry);
  if (!valid.workspaces.some((row) => row.id === workspaceId)) throw new Error("Workspace is unavailable");
  return valid.connections.filter((row) => row.workspaceId === workspaceId)
    .map(({ id, workspaceId: owner, label, source, revision, status }) => ({ id, workspaceId: owner, label, source, revision, status }));
}
