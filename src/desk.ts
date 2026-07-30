// `hara desk` client — the credential and transport boundary between the open-source Hara runtime
// and an organization-owned Hara Desk. A Desk bearer token is intentionally separate from a Hara
// Control device token. It never crosses Serve's authenticated loopback protocol.
//
// Legacy MCP credentials stay in ~/.hara/desk.json (0600). Native multi-organization bindings live in
// ~/.hara/desk-connections.json (0600) so an older MCP writer can never flatten or overwrite them. Every
// native binding is pinned to the current gateway enrollment identity, not merely a reusable profile id.
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
} from "./security/private-state.js";

export interface DeskCreds {
  url: string;
  agentId: string;
  owner: string;
  token: string;
}

export interface DeskOrganizationIdentity {
  profileId: string;
  gatewayUrl: string;
  deviceId?: string;
  enrolledAt?: string;
}

interface DeskProfileBinding {
  identityFingerprint: string;
  /** Opaque cache epoch. It changes whenever this profile's Desk bearer is replaced. */
  revision: string;
  creds: DeskCreds;
}

interface DeskConnectionsFile {
  version: 1;
  connections: Record<string, DeskProfileBinding>;
}

export type DeskTaskState = "open" | "claimed" | "done" | "cancelled";
export type DeskTaskKind = "feedback" | "dispatch";
export type DeskRisk = "low" | "high";
export type DeskAgentRole = "member" | "owner";

export interface DeskAgentSummary {
  id: string;
  name: string;
  owner: string;
  client: string;
  role: DeskAgentRole;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
}

export interface DeskTaskSummary {
  id: string;
  kind: DeskTaskKind;
  title: string;
  excerpt: string;
  risk: DeskRisk;
  state: DeskTaskState;
  createdBy: string;
  claimedBy: string | null;
  ackedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeskTaskDetail extends DeskTaskSummary {
  body: string;
}

export interface DeskEventSummary {
  id: number;
  taskId: string;
  actor: string;
  action: string;
  detail: string;
  at: number;
  title?: string;
  kind?: DeskTaskKind;
}

export interface DeskCircleSummary {
  id: string;
  name: string;
  owner: string;
  createdAt: number;
}

export interface DeskConnectionSummary {
  profileId: string;
  configured: boolean;
  needsRebind?: boolean;
  /** Non-secret opaque cache epoch. It is never derived from the bearer token. */
  bindingRevision?: string;
  host?: string;
  agentId?: string;
  owner?: string;
}

export interface DeskConnectionsSnapshot {
  connections: DeskConnectionSummary[];
  legacyUnbound: boolean;
}

export interface DeskSnapshot {
  profileId: string;
  fetchedAt: number;
  me: DeskAgentSummary;
  tasks: DeskTaskSummary[];
  agents: DeskAgentSummary[];
  events: DeskEventSummary[];
  circles: DeskCircleSummary[];
  truncated: boolean;
}

export interface DeskTaskDetails {
  profileId: string;
  task: DeskTaskDetail;
  events: DeskEventSummary[];
}

interface ParsedDeskState {
  connections: Record<string, DeskProfileBinding>;
  connectionStoreWritable: boolean;
  legacyUnbound: boolean;
  legacyCreds: DeskCreds | null;
}

const MAX_DESK_STATE_BYTES = 1024 * 1024;
const MAX_DESK_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 4096;
const SNAPSHOT_TASK_LIMIT = 100;
const SNAPSHOT_EVENT_LIMIT = 100;
const SNAPSHOT_AGENT_LIMIT = 200;
const SNAPSHOT_CIRCLE_LIMIT = 100;
const SNAPSHOT_EXCERPT_LENGTH = 280;
const MAX_SNAPSHOT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TASK_PAYLOAD_BYTES = 512 * 1024;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID_PATTERN = /^t_[a-f0-9]+$/;
const IDENTITY_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_METHODS = new Set(["GET", "POST"]);

export class DeskClientError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIGURATION"
      | "NOT_CONFIGURED"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "APPROVAL_REQUIRED"
      | "UNAVAILABLE"
      | "PROTOCOL",
    message: string,
  ) {
    super(message);
    this.name = "DeskClientError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedString = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const safeTimestamp = (value: unknown): number => {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) return 0;
  return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : 0;
};

const safePositiveInteger = (value: unknown): number => {
  const integer = Number(value);
  return Number.isSafeInteger(integer) && integer > 0 ? integer : 0;
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return !!match && match.slice(1).every((part) => Number(part) <= 255);
};

/** Desk endpoints are fixed-origin API roots. HTTPS is required except for loopback development. */
export function normalizeDeskBaseUrl(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk URL must be a non-empty URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk URL is invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk URL cannot contain credentials, query, or fragment data");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk URL must point to the server origin, without an API path");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk requires HTTPS; HTTP is allowed only for loopback development");
  }
  return parsed.origin;
}

function validCreds(value: unknown): DeskCreds | null {
  if (!isObject(value)) return null;
  const url = boundedString(value.url, MAX_URL_LENGTH);
  const agentId = boundedString(value.agentId, 256);
  const owner = boundedString(value.owner, 256);
  const token = boundedString(value.token, MAX_TOKEN_LENGTH);
  if (!url || !agentId || !token) return null;
  try {
    return { url: normalizeDeskBaseUrl(url), agentId, owner, token };
  } catch {
    return null;
  }
}

function deskStateHome(): string {
  const testHome = process.env.HARA_DESK_STATE_HOME?.trim();
  return testHome || homedir();
}

function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function legacyDeskBinding() {
  return bindPrivateHaraStateFile(deskStateHome(), [], "desk.json");
}

function connectionsDeskBinding() {
  return bindPrivateHaraStateFile(deskStateHome(), [], "desk-connections.json");
}

function normalizedIdentity(identity: DeskOrganizationIdentity): Required<DeskOrganizationIdentity> {
  const profileId = identity.profileId?.trim();
  if (!PROFILE_ID_PATTERN.test(profileId) || profileId.length > MAX_PROFILE_ID_LENGTH) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk organization profile ID is invalid");
  }
  let gatewayOrigin: string;
  try {
    const parsed = new URL(identity.gatewayUrl);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) throw new Error("invalid gateway origin");
    gatewayOrigin = parsed.origin;
  } catch {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk organization gateway identity is invalid");
  }
  const deviceId = boundedString(identity.deviceId, 512);
  const enrolledAt = boundedString(identity.enrolledAt, 128);
  if (!deviceId && !enrolledAt) {
    throw new DeskClientError(
      "INVALID_CONFIGURATION",
      "Organization connection must be re-enrolled before binding Hara Desk",
    );
  }
  return {
    profileId,
    gatewayUrl: gatewayOrigin,
    deviceId,
    enrolledAt,
  };
}

function identityFingerprint(identity: DeskOrganizationIdentity): string {
  const normalized = normalizedIdentity(identity);
  return createHash("sha256")
    .update(JSON.stringify([
      normalized.gatewayUrl,
      normalized.deviceId,
      normalized.enrolledAt,
    ]))
    .digest("hex");
}

export function deskOrganizationIdentityMatches(
  left: DeskOrganizationIdentity,
  right: DeskOrganizationIdentity,
): boolean {
  try {
    const normalizedLeft = normalizedIdentity(left);
    const normalizedRight = normalizedIdentity(right);
    return (
      normalizedLeft.profileId === normalizedRight.profileId
      && identityFingerprint(normalizedLeft) === identityFingerprint(normalizedRight)
    );
  } catch {
    return false;
  }
}

function validProfileBinding(value: unknown): DeskProfileBinding | null {
  if (!isObject(value)) return null;
  const identityFingerprint = boundedString(value.identityFingerprint, 64);
  // Bindings written by a pre-release native client did not have a revision. Preserve them with a
  // stable non-secret epoch; the next registration rotates it to a random UUID.
  const storedRevision = boundedString(value.revision, 64);
  const revision = storedRevision || identityFingerprint;
  const creds = validCreds(value.creds);
  if (
    !IDENTITY_FINGERPRINT_PATTERN.test(identityFingerprint)
    || !BINDING_REVISION_PATTERN.test(revision)
    || !creds
  ) return null;
  return { identityFingerprint, revision, creds };
}

function readDeskState(): ParsedDeskState {
  const connections = nullRecord<DeskProfileBinding>();
  let connectionStoreWritable = true;
  try {
    const binding = connectionsDeskBinding();
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_DESK_STATE_BYTES);
    if (snapshot) {
      const parsed = JSON.parse(snapshot.text) as unknown;
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.connections)) {
        throw new Error("invalid Desk connections file");
      }
      for (const [profileId, value] of Object.entries(parsed.connections)) {
        if (!PROFILE_ID_PATTERN.test(profileId)) continue;
        const profileBinding = validProfileBinding(value);
        if (profileBinding) connections[profileId] = profileBinding;
      }
    }
  } catch {
    // Fail closed: a malformed profile store must never make a token appear bound.
    connectionStoreWritable = false;
  }

  try {
    const binding = legacyDeskBinding();
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_DESK_STATE_BYTES);
    if (!snapshot) {
      return {
        connections,
        connectionStoreWritable,
        legacyUnbound: false,
        legacyCreds: null,
      };
    }
    const parsed = JSON.parse(snapshot.text) as unknown;
    const legacyCreds = validCreds(parsed);
    const experimentalMultiProfileFile =
      isObject(parsed) && parsed.version === 2 && isObject(parsed.connections);
    return {
      connections,
      connectionStoreWritable,
      legacyUnbound: legacyCreds !== null || experimentalMultiProfileFile,
      legacyCreds,
    };
  } catch {
    return {
      connections,
      connectionStoreWritable,
      legacyUnbound: false,
      legacyCreds: null,
    };
  }
}

function writeDeskConnections(connections: Record<string, DeskProfileBinding>): void {
  const binding = connectionsDeskBinding();
  const file: DeskConnectionsFile = { version: 1, connections };
  writePrivateStateFileSync(binding, JSON.stringify(file, null, 2) + "\n");
}

/** Legacy compatibility for the hara-desk MCP. Native profile-aware code never guesses this token. */
export function loadCreds(): DeskCreds | null {
  return readDeskState().legacyCreds;
}

export function loadProfileCreds(identity: DeskOrganizationIdentity): DeskCreds | null {
  const normalized = normalizedIdentity(identity);
  const connections = readDeskState().connections;
  if (!Object.hasOwn(connections, normalized.profileId)) return null;
  const binding = connections[normalized.profileId];
  return binding.identityFingerprint === identityFingerprint(normalized) ? binding.creds : null;
}

/** Legacy flat-file writer retained for hara-desk MCP compatibility. */
export function saveCreds(creds: DeskCreds): void {
  const normalized: DeskCreds = {
    ...creds,
    url: normalizeDeskBaseUrl(creds.url),
  };
  if (!normalized.agentId || !normalized.token || normalized.token.length > MAX_TOKEN_LENGTH) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk credentials are incomplete");
  }
  writePrivateStateFileSync(legacyDeskBinding(), JSON.stringify(normalized, null, 2) + "\n");
}

export function saveProfileCreds(
  creds: DeskCreds,
  identity: DeskOrganizationIdentity,
): void {
  const normalizedIdentityValue = normalizedIdentity(identity);
  const normalizedCreds: DeskCreds = {
    ...creds,
    url: normalizeDeskBaseUrl(creds.url),
  };
  if (
    !normalizedCreds.agentId
    || !normalizedCreds.token
    || normalizedCreds.token.length > MAX_TOKEN_LENGTH
  ) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk credentials are incomplete");
  }
  const state = readDeskState();
  if (!state.connectionStoreWritable) {
    throw new DeskClientError(
      "INVALID_CONFIGURATION",
      "Desk connection store is unreadable; repair or remove it before registering",
    );
  }
  const connections = nullRecord<DeskProfileBinding>();
  Object.assign(connections, state.connections);
  connections[normalizedIdentityValue.profileId] = {
    identityFingerprint: identityFingerprint(normalizedIdentityValue),
    revision: randomUUID(),
    creds: normalizedCreds,
  };
  writeDeskConnections(connections);
}

export function removeProfileCreds(profileId: string): boolean {
  if (!PROFILE_ID_PATTERN.test(profileId)) return false;
  const state = readDeskState();
  if (!state.connectionStoreWritable) {
    throw new DeskClientError(
      "INVALID_CONFIGURATION",
      "Desk connection store is unreadable; refusing to modify it",
    );
  }
  if (!Object.hasOwn(state.connections, profileId)) return false;
  const connections = nullRecord<DeskProfileBinding>();
  Object.assign(connections, state.connections);
  delete connections[profileId];
  writeDeskConnections(connections);
  return true;
}

export function removeMismatchedProfileCreds(identity: DeskOrganizationIdentity): boolean {
  const normalized = normalizedIdentity(identity);
  const state = readDeskState();
  if (!state.connectionStoreWritable) {
    throw new DeskClientError(
      "INVALID_CONFIGURATION",
      "Desk connection store is unreadable; refusing to modify it",
    );
  }
  if (!Object.hasOwn(state.connections, normalized.profileId)) return false;
  if (
    state.connections[normalized.profileId].identityFingerprint
    === identityFingerprint(normalized)
  ) return false;
  return removeProfileCreds(normalized.profileId);
}

export function deskConnectionsSnapshot(
  identities: DeskOrganizationIdentity[],
): DeskConnectionsSnapshot {
  const state = readDeskState();
  const uniqueIdentities = new Map<string, Required<DeskOrganizationIdentity>>();
  for (const identity of identities) {
    try {
      const normalized = normalizedIdentity(identity);
      if (!uniqueIdentities.has(normalized.profileId)) {
        uniqueIdentities.set(normalized.profileId, normalized);
      }
    } catch {
      // Invalid/legacy organization profiles cannot safely receive a Desk token.
    }
  }
  return {
    connections: [...uniqueIdentities.values()].map((identity) => {
      if (!Object.hasOwn(state.connections, identity.profileId)) {
        return { profileId: identity.profileId, configured: false };
      }
      const binding = state.connections[identity.profileId];
      if (binding.identityFingerprint !== identityFingerprint(identity)) {
        return {
          profileId: identity.profileId,
          configured: false,
          needsRebind: true,
          bindingRevision: binding.revision,
        };
      }
      const creds = binding.creds;
      let host = "";
      try {
        host = new URL(creds.url).host;
      } catch {
        // validCreds already rejects this; keep the summary fail-closed if disk changes mid-read.
      }
      return {
        profileId: identity.profileId,
        configured: true,
        bindingRevision: binding.revision,
        ...(host ? { host } : {}),
        agentId: creds.agentId,
        owner: creds.owner,
      };
    }),
    legacyUnbound: state.legacyUnbound,
  };
}

async function readBoundedResponse(response: Response, maxBytes = MAX_DESK_RESPONSE_BYTES): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new DeskClientError("PROTOCOL", "Desk response exceeded the safe size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new DeskClientError("PROTOCOL", "Desk response exceeded the safe size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function responseError(status: number): DeskClientError {
  if (status === 401) return new DeskClientError("UNAUTHORIZED", "Desk authorization expired; re-register this organization connection");
  if (status === 403) return new DeskClientError("FORBIDDEN", "Desk access was denied for this organization connection");
  if (status === 404) return new DeskClientError("NOT_FOUND", "Desk item was not found");
  if (status === 409) return new DeskClientError("CONFLICT", "Desk task changed; refresh the organization board and try again");
  if (status === 428) return new DeskClientError("APPROVAL_REQUIRED", "Desk task requires an organization owner approval");
  return new DeskClientError("UNAVAILABLE", `Desk request failed (HTTP ${status})`);
}

/** One fixed-origin JSON request. Redirects are refused so an Authorization header cannot be carried
 * to another host. Server response bodies never become exception text. */
export async function deskCall(
  url: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const baseUrl = normalizeDeskBaseUrl(url);
  const normalizedMethod = method.toUpperCase();
  if (!ALLOWED_METHODS.has(normalizedMethod)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk request method is not allowed");
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk request path is invalid");
  }
  const endpoint = new URL(path, `${baseUrl}/`);
  if (endpoint.origin !== baseUrl || endpoint.username || endpoint.password) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk request must stay on the configured server");
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: normalizedMethod,
      redirect: "error",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (error) {
    if (error instanceof DeskClientError) throw error;
    throw new DeskClientError("UNAVAILABLE", "Desk is unavailable; check this organization's Desk connection");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw responseError(response.status);
  }
  const text = await readBoundedResponse(response);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DeskClientError("PROTOCOL", "Desk returned an invalid JSON response");
  }
}

function arrayField(value: unknown, field: string): unknown[] {
  if (!isObject(value) || !Array.isArray(value[field])) {
    throw new DeskClientError("PROTOCOL", `Desk response is missing ${field}`);
  }
  return value[field] as unknown[];
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value) || !isObject(value[field])) {
    throw new DeskClientError("PROTOCOL", `Desk response is missing ${field}`);
  }
  return value[field] as Record<string, unknown>;
}

function requiredTimestamp(value: unknown): number | null {
  const timestamp = safeTimestamp(value);
  return timestamp > 0 ? timestamp : null;
}

function strictNullableString(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.slice(0, max);
  return normalized || null;
}

function strictArray<T>(
  values: unknown[],
  limit: number,
  decoder: (value: unknown) => T | null,
  label: string,
): T[] {
  const decoded: T[] = [];
  for (const value of values.slice(0, limit)) {
    const item = decoder(value);
    if (!item) {
      throw new DeskClientError("PROTOCOL", `Desk response contains an invalid ${label}`);
    }
    decoded.push(item);
  }
  return decoded;
}

function assertPayloadSize(value: unknown, maxBytes: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    throw new DeskClientError("PROTOCOL", `Desk ${label} exceeded the safe aggregate size limit`);
  }
}

function toAgent(value: unknown): DeskAgentSummary | null {
  if (!isObject(value)) return null;
  const id = boundedString(value.id, 256);
  const name = boundedString(value.name, 120);
  const owner = boundedString(value.owner, 120);
  const client = boundedString(value.client, 80);
  const createdAt = requiredTimestamp(value.createdAt);
  const lastSeen = requiredTimestamp(value.lastSeen);
  if (
    !id
    || !name
    || !owner
    || !client
    || (value.role !== "owner" && value.role !== "member")
    || createdAt === null
    || lastSeen === null
    || typeof value.revoked !== "boolean"
  ) return null;
  return {
    id,
    name,
    owner,
    client,
    role: value.role,
    createdAt,
    lastSeen,
    revoked: value.revoked,
  };
}

function taskCore(value: unknown): {
  id: string;
  kind: DeskTaskKind;
  title: string;
  body: string;
  risk: DeskRisk;
  state: DeskTaskState;
  createdBy: string;
  claimedBy: string | null;
  ackedBy: string | null;
  createdAt: number;
  updatedAt: number;
} | null {
  if (!isObject(value)) return null;
  const id = boundedString(value.id, 256);
  const title = boundedString(value.title, 240);
  const body = typeof value.body === "string" ? value.body.slice(0, 20_000) : null;
  const createdBy = boundedString(value.createdBy, 256);
  const claimedBy = strictNullableString(value.claimedBy, 256);
  const ackedBy = strictNullableString(value.ackedBy, 256);
  const createdAt = requiredTimestamp(value.createdAt);
  const updatedAt = requiredTimestamp(value.updatedAt);
  if (
    !id
    || !TASK_ID_PATTERN.test(id)
    || !title
    || body === null
    || (value.kind !== "feedback" && value.kind !== "dispatch")
    || (value.risk !== "low" && value.risk !== "high")
    || (
      value.state !== "open"
      && value.state !== "claimed"
      && value.state !== "done"
      && value.state !== "cancelled"
    )
    || !createdBy
    || claimedBy === undefined
    || ackedBy === undefined
    || createdAt === null
    || updatedAt === null
  ) return null;
  return {
    id,
    kind: value.kind,
    title,
    body,
    risk: value.risk,
    state: value.state,
    createdBy,
    claimedBy,
    ackedBy,
    createdAt,
    updatedAt,
  };
}

function toTaskSummary(value: unknown): DeskTaskSummary | null {
  const task = taskCore(value);
  if (!task) return null;
  const { body, ...summary } = task;
  return {
    ...summary,
    excerpt: body.slice(0, SNAPSHOT_EXCERPT_LENGTH),
  };
}

function toTaskDetail(value: unknown): DeskTaskDetail | null {
  const task = taskCore(value);
  if (!task) return null;
  return {
    ...task,
    excerpt: task.body.slice(0, SNAPSHOT_EXCERPT_LENGTH),
  };
}

function toEvent(value: unknown): DeskEventSummary | null {
  if (!isObject(value)) return null;
  const id = safePositiveInteger(value.id);
  const taskId = boundedString(value.taskId, 256);
  const actor = boundedString(value.actor, 256);
  const action = boundedString(value.action, 80);
  const at = requiredTimestamp(value.at);
  const hasKind = value.kind !== undefined && value.kind !== null;
  if (
    !id
    || !TASK_ID_PATTERN.test(taskId)
    || !actor
    || !action
    || typeof value.detail !== "string"
    || at === null
    || (value.title !== undefined && typeof value.title !== "string")
    || (hasKind && value.kind !== "feedback" && value.kind !== "dispatch")
  ) return null;
  return {
    id,
    taskId,
    actor,
    action,
    detail: value.detail.slice(0, 2_000),
    at,
    ...(typeof value.title === "string" ? { title: value.title.slice(0, 240) } : {}),
    ...(hasKind ? { kind: value.kind as DeskTaskKind } : {}),
  };
}

function toCircle(value: unknown): DeskCircleSummary | null {
  if (!isObject(value)) return null;
  const id = boundedString(value.id, 256);
  const name = boundedString(value.name, 120);
  const owner = boundedString(value.owner, 120);
  const createdAt = requiredTimestamp(value.createdAt);
  if (!id || !name || !owner || createdAt === null) return null;
  return {
    id,
    name,
    owner,
    createdAt,
  };
}

function requireProfileCreds(identity: DeskOrganizationIdentity): DeskCreds {
  const creds = loadProfileCreds(identity);
  if (!creds) {
    throw new DeskClientError("NOT_CONFIGURED", "Desk is not configured for this organization");
  }
  return creds;
}

function assertProfileCredsUnchanged(
  identity: DeskOrganizationIdentity,
  expected: DeskCreds,
): void {
  const current = loadProfileCreds(identity);
  if (
    !current
    || current.url !== expected.url
    || current.agentId !== expected.agentId
    || current.token !== expected.token
  ) {
    throw new DeskClientError(
      "CONFLICT",
      "Desk organization connection changed during the read; refresh and try again",
    );
  }
}

export async function fetchDeskSnapshot(
  identity: DeskOrganizationIdentity,
  state: DeskTaskState = "open",
): Promise<DeskSnapshot> {
  const normalized = normalizedIdentity(identity);
  const creds = requireProfileCreds(normalized);
  const token = creds.token;
  const [who, taskResult, agentResult, eventResult, circleResult] = await Promise.all([
    deskCall(creds.url, "GET", "/whoami", { token }),
    deskCall(
      creds.url,
      "GET",
      `/tasks?state=${encodeURIComponent(state)}&limit=${SNAPSHOT_TASK_LIMIT}`,
      { token },
    ),
    deskCall(creds.url, "GET", "/agents", { token }),
    deskCall(creds.url, "GET", `/events?since=0&limit=${SNAPSHOT_EVENT_LIMIT}`, { token }),
    deskCall(creds.url, "GET", "/circles", { token }),
  ]);
  const me = toAgent(objectField(who, "agent"));
  if (!me) throw new DeskClientError("PROTOCOL", "Desk response contains an invalid agent");
  if (me.id !== creds.agentId) {
    throw new DeskClientError("PROTOCOL", "Desk returned an unexpected organization agent identity");
  }
  const rawTasks = arrayField(taskResult, "tasks");
  const rawAgents = arrayField(agentResult, "agents");
  const rawEvents = arrayField(eventResult, "events");
  const rawCircles = arrayField(circleResult, "circles");
  assertProfileCredsUnchanged(normalized, creds);
  const snapshot: DeskSnapshot = {
    profileId: normalized.profileId,
    fetchedAt: Date.now(),
    me,
    tasks: strictArray(rawTasks, SNAPSHOT_TASK_LIMIT, toTaskSummary, "task"),
    agents: strictArray(rawAgents, SNAPSHOT_AGENT_LIMIT, toAgent, "agent"),
    events: strictArray(rawEvents, SNAPSHOT_EVENT_LIMIT, toEvent, "event"),
    circles: strictArray(rawCircles, SNAPSHOT_CIRCLE_LIMIT, toCircle, "circle"),
    truncated:
      rawTasks.length >= SNAPSHOT_TASK_LIMIT
      || rawAgents.length > SNAPSHOT_AGENT_LIMIT
      || rawEvents.length >= SNAPSHOT_EVENT_LIMIT
      || rawCircles.length > SNAPSHOT_CIRCLE_LIMIT,
  };
  assertPayloadSize(snapshot, MAX_SNAPSHOT_PAYLOAD_BYTES, "snapshot");
  return snapshot;
}

export async function fetchDeskTask(
  identity: DeskOrganizationIdentity,
  taskId: string,
): Promise<DeskTaskDetails> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task ID is invalid");
  }
  const normalized = normalizedIdentity(identity);
  const creds = requireProfileCreds(normalized);
  const result = await deskCall(creds.url, "GET", `/tasks/${taskId}`, { token: creds.token });
  const task = toTaskDetail(objectField(result, "task"));
  if (!task) throw new DeskClientError("PROTOCOL", "Desk response contains an invalid task");
  if (task.id !== taskId) {
    throw new DeskClientError("PROTOCOL", "Desk returned an unexpected task identity");
  }
  const events = strictArray(
    arrayField(result, "events"),
    SNAPSHOT_EVENT_LIMIT,
    toEvent,
    "event",
  ).filter((event) => event.taskId === taskId);
  assertProfileCredsUnchanged(normalized, creds);
  const details = { profileId: normalized.profileId, task, events };
  assertPayloadSize(details, MAX_TASK_PAYLOAD_BYTES, "task details");
  return details;
}

/** Register this machine's agent with a Desk and bind the returned credential to one existing local
 * organization profile. The server derives owner authorization from the enroll key. */
export async function registerAgent(
  url: string,
  enrollKey: string,
  name: string,
  owner: string,
  client = "hara-cli",
  identity?: DeskOrganizationIdentity,
): Promise<DeskCreds> {
  const normalizedUrl = normalizeDeskBaseUrl(url);
  const result = await deskCall(normalizedUrl, "POST", "/register", {
    body: { enrollKey, name, owner, client },
  });
  if (!isObject(result)) throw new DeskClientError("PROTOCOL", "Desk registration returned invalid credentials");
  const creds = validCreds({
    url: normalizedUrl,
    agentId: result.agentId,
    owner: result.owner,
    token: result.token,
  });
  if (!creds) throw new DeskClientError("PROTOCOL", "Desk registration returned incomplete credentials");
  if (identity) saveProfileCreds(creds, identity);
  else saveCreds(creds);
  return creds;
}
