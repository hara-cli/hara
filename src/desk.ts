// `hara desk` client — the credential and transport boundary between the open-source Hara runtime
// and an organization-owned Hara Desk. A Desk bearer token is intentionally separate from a Hara
// Control device token. It never crosses Serve's authenticated loopback protocol.
//
// Legacy MCP credentials stay in ~/.hara/desk.json (0600). Native multi-organization bindings live in
// ~/.hara/desk-connections.json (0600) so an older MCP writer can never flatten or overwrite them. Every
// native binding is pinned to the current gateway enrollment identity, not merely a reusable profile id.
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "./security/private-state.js";
import { redactSensitiveValue } from "./security/secrets.js";
import { HARA_RUNTIME_VERSION } from "./version.js";
import { optionalPosixOpenFlag } from "./fs-open-flags.js";

export interface DeskCreds {
  url: string;
  agentId: string;
  owner: string;
  token: string;
  /** Monotonic only for Control-provisioned Agent credentials. */
  credentialGeneration?: number;
}

export type DeskMcpClientKind = "anthropic.claude-code" | "openai.codex";

export interface DeskMcpCredentialIdentity {
  client: DeskMcpClientKind;
  installationId: string;
  /** Maps to DESK_PROFILE and separates multiple accounts/instances of the same client. */
  profile: string;
}

export interface DeskOrganizationIdentity {
  profileId: string;
  gatewayUrl: string;
  tenantId?: string;
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

interface DeskWorkbenchSession {
  identityFingerprint: string;
  bindingRevision: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

interface DeskWorkbenchSessionsFile {
  version: 1;
  sessions: Record<string, DeskWorkbenchSession>;
}

export type DeskTaskState =
  | "open"
  | "claimed"
  | "blocked"
  | "waiting_user"
  | "waiting_release"
  | "waiting_verification"
  | "review"
  | "done"
  | "cancelled";
export type DeskTaskKind = "feedback" | "dispatch";
export type DeskRisk = "low" | "high";
export type DeskPriority = "urgent" | "high" | "normal" | "low";
export type DeskSeverity = "critical" | "major" | "minor" | "cosmetic";
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
  priority: DeskPriority;
  severity: DeskSeverity;
  slaDueAt: number | null;
  parentId: string | null;
  createdBy: string;
  claimedBy: string | null;
  ackedBy: string | null;
  reporterRef: string;
  occurrenceCount: number;
  sourceCount: number;
  releaseVersion: string;
  verificationSteps: string;
  claimedSessionId: string | null;
  claimExpiresAt: number | null;
  claimFence: number;
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

export interface DeskTaskComment {
  id: string;
  taskId: string;
  actor: string;
  sessionId: string | null;
  body: string;
  at: number;
}

export interface DeskTaskAttachment {
  id: string;
  taskId: string;
  commentId: string | null;
  actor: string;
  sessionId: string | null;
  name: string;
  contentType: string;
  size: number;
  url: string;
  storageRef: string;
  sha256: string;
  at: number;
}

export interface DeskTaskSource {
  id: number;
  sourceKind: string;
  sourceChatId: string;
  sourceMessageId: string;
  sourceUrl: string;
  reporterRef: string;
  createdAt: number;
}

export interface DeskTaskLink {
  parentTaskId: string;
  childTaskId: string;
  relation: string;
  createdBy: string;
  createdAt: number;
  parentTitle: string;
  childTitle: string;
  childState: DeskTaskState;
}

export interface DeskExecutionEvent {
  id: number;
  eventKey: string;
  agentId: string;
  sessionId: string | null;
  taskId: string | null;
  kind: string;
  payload: unknown;
  at: number;
}

export interface DeskDiffArtifact {
  id: string;
  artifactKey: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  worktreeLabel: string;
  baseRef: string;
  headRef: string;
  patchSha256: string;
  summary: string;
  state: "pending" | "approved" | "rejected" | "merged";
  createdAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewNote: string;
  mergeRef: string;
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
  comments: DeskTaskComment[];
  attachments: DeskTaskAttachment[];
  sources: DeskTaskSource[];
  links: DeskTaskLink[];
  executionEvents: DeskExecutionEvent[];
  diffs: DeskDiffArtifact[];
}

export interface DeskCreateTaskInput {
  kind: DeskTaskKind;
  title: string;
  body?: string;
  risk?: DeskRisk;
  priority?: DeskPriority;
  severity?: DeskSeverity;
  slaDueAt?: number;
}

export interface DeskTransitionTaskInput {
  state: DeskTaskState;
  note?: string;
  releaseVersion?: string;
  verificationSteps?: string;
  claimFence?: number;
}

export interface DeskCompleteTaskInput {
  detail?: string;
  releaseVersion?: string;
  verificationSteps?: string;
  claimFence?: number;
}

export interface DeskTaskMutationResult {
  profileId: string;
  task: DeskTaskDetail;
}

interface ParsedDeskState {
  connections: Record<string, DeskProfileBinding>;
  connectionStoreWritable: boolean;
  legacyUnbound: boolean;
  legacyCreds: DeskCreds | null;
}

const MAX_DESK_STATE_BYTES = 1024 * 1024;
const MAX_DESK_RESPONSE_BYTES = 1024 * 1024;
const MAX_DESK_WORKBENCH_STATE_BYTES = 1024 * 1024;
const WORKBENCH_SESSION_REUSE_MARGIN_MS = 60_000;
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
const TASK_COMMENT_LIMIT = 500;
const TASK_ATTACHMENT_LIMIT = 100;
const TASK_SOURCE_LIMIT = 100;
const TASK_LINK_LIMIT = 200;
const TASK_EXECUTION_EVENT_LIMIT = 500;
const TASK_DIFF_LIMIT = 100;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STANDALONE_WORKBENCH_KEY = "standalone";
const TASK_ID_PATTERN = /^t_[a-f0-9]+$/;
const IDENTITY_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID_PATTERN = /^s_[a-f0-9]+$/;
const SESSION_TOKEN_PATTERN = /^hds_[a-f0-9]{48}$/;
const AGENT_TOKEN_PATTERN = /^hdk_[a-f0-9]{48}$/;
const MCP_RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_METHODS = new Set(["GET", "POST"]);
const DESK_TASK_STATES = new Set<DeskTaskState>([
  "open",
  "claimed",
  "blocked",
  "waiting_user",
  "waiting_release",
  "waiting_verification",
  "review",
  "done",
  "cancelled",
]);
const DESK_PRIORITIES = new Set<DeskPriority>(["urgent", "high", "normal", "low"]);
const DESK_SEVERITIES = new Set<DeskSeverity>(["critical", "major", "minor", "cosmetic"]);

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

const safeNonNegativeInteger = (value: unknown, fallback = 0): number => {
  if (value === undefined || value === null || value === "") return fallback;
  const integer = Number(value);
  return Number.isSafeInteger(integer) && integer >= 0 ? integer : fallback;
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
  const rawCredentialGeneration = value.credentialGeneration ?? value.credential_generation;
  if (!url || !agentId || !token) return null;
  if (
    rawCredentialGeneration !== undefined
    && (
      typeof rawCredentialGeneration !== "number"
      || !Number.isSafeInteger(rawCredentialGeneration)
      || rawCredentialGeneration < 1
    )
  ) return null;
  try {
    return {
      url: normalizeDeskBaseUrl(url),
      agentId,
      owner,
      token,
      ...(rawCredentialGeneration === undefined
        ? {}
        : { credentialGeneration: rawCredentialGeneration }),
    };
  } catch {
    return null;
  }
}

function deskStateHome(): string {
  const testHome = process.env.HARA_DESK_STATE_HOME?.trim();
  return testHome || homedir();
}

/** A readable, case-sensitive identity component for a credential path. The digest prevents two
 * distinct identities (including values differing only by case on macOS) from sharing a file. */
export const mcpCredentialPathPart = (value: string, fallback: string): string => {
  const exact = value.trim();
  const readable = exact.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || fallback;
  const digest = createHash("sha256").update(exact).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
};

/** Persist a Control-minted Agent bearer exactly where hara-desk's MCP bridge expects it.
 * The bearer never enters a model profile, renderer response, log, or stdout. */
export function saveMcpClientCreds(
  creds: DeskCreds,
  identity: DeskMcpCredentialIdentity,
): void {
  const installationId = identity.installationId.trim();
  const profile = identity.profile.trim();
  if (
    !["anthropic.claude-code", "openai.codex"].includes(identity.client)
    || !installationId
    || installationId.length > 160
    || !MCP_RUNTIME_ID_PATTERN.test(installationId)
    || !profile
    || profile.length > 80
    || profile !== profile.toLowerCase()
    || !/^[a-z0-9][a-z0-9._-]*$/.test(profile)
  ) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk MCP client identity is invalid");
  }
  const normalized = validCreds(creds);
  if (
    !normalized
    || !normalized.owner
    || !AGENT_TOKEN_PATTERN.test(normalized.token)
    || !Number.isSafeInteger(normalized.credentialGeneration)
    || normalized.credentialGeneration! < 1
  ) {
    throw new DeskClientError("PROTOCOL", "Control returned an invalid Desk Agent credential");
  }
  const originHash = createHash("sha256")
    .update(new URL(normalized.url).origin)
    .digest("hex")
    .slice(0, 16);
  const home = deskStateHome();
  const subdirectories = [
    "desk",
    "credentials",
    originHash,
    mcpCredentialPathPart(installationId, "unbound-installation"),
    mcpCredentialPathPart(identity.client, "unbound-client"),
  ];
  const filename = `${mcpCredentialPathPart(profile, "default")}.json`;
  const binding = bindPrivateHaraStateFile(home, subdirectories, filename);
  const serialized = JSON.stringify({
    url: normalized.url,
    agentId: normalized.agentId,
    owner: normalized.owner,
    token: normalized.token,
    credentialGeneration: normalized.credentialGeneration,
    client: identity.client,
    installationId,
    profile,
  }, null, 2) + "\n";
  withPrivateStateLockSync(home, subdirectories, `${filename}.write`, () => {
    const previous = readPrivateStateFileSnapshotSync(binding.path, 64 * 1024);
    if (previous) {
      let current: Record<string, unknown>;
      try {
        const parsed = JSON.parse(previous.text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        current = parsed as Record<string, unknown>;
      } catch {
        throw new DeskClientError(
          "INVALID_CONFIGURATION",
          "existing Desk MCP credential is unreadable; remove it before provisioning again",
        );
      }
      const currentGeneration = current.credentialGeneration;
      if (
        current.url !== normalized.url
        || current.agentId !== normalized.agentId
        || current.owner !== normalized.owner
        || current.client !== identity.client
        || current.installationId !== installationId
        || current.profile !== profile
        || typeof currentGeneration !== "number"
        || !Number.isSafeInteger(currentGeneration)
        || currentGeneration < 1
      ) {
        throw new DeskClientError(
          "INVALID_CONFIGURATION",
          "existing Desk MCP credential belongs to another or invalid identity",
        );
      }
      if (currentGeneration > normalized.credentialGeneration!) return;
      if (currentGeneration === normalized.credentialGeneration!) {
        if (current.token === normalized.token) return;
        throw new DeskClientError(
          "PROTOCOL",
          "Desk returned conflicting credentials for the same generation",
        );
      }
    }
    writePrivateStateFileSync(
      binding,
      serialized,
      previous ? { expectedText: previous.text } : { expectedMissing: true },
    );
  }, {
    busyMessage: "Desk MCP credential is busy; retry Agent provisioning",
  });
}

/** Read a standalone Desk enrollment key without exposing it in argv, shell history, or Agent text.
 * Organization profiles never use this path: their Control server holds the enrollment credential. */
export function readStandaloneDeskEnrollmentKeyFile(target: string): string {
  const targetPath = resolve(target);
  let fd: number | undefined;
  try {
    fd = openSync(
      targetPath,
      constants.O_RDONLY | optionalPosixOpenFlag("O_NOFOLLOW"),
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 4097) {
      throw new DeskClientError("INVALID_CONFIGURATION", "Desk enrollment key file must be a small regular file");
    }
    if (process.platform !== "win32") {
      if ((info.mode & 0o777) !== 0o600) {
        throw new DeskClientError("INVALID_CONFIGURATION", "Desk enrollment key file must have mode 0600");
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new DeskClientError("INVALID_CONFIGURATION", "Desk enrollment key file must be owned by the current user");
      }
    }
    const value = readFileSync(fd, "utf8").trim();
    if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new DeskClientError("INVALID_CONFIGURATION", "Desk enrollment key file is invalid");
    }
    return value;
  } catch (error) {
    if (error instanceof DeskClientError) throw error;
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk enrollment key file could not be read safely");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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

function workbenchSessionsDeskBinding() {
  return bindPrivateHaraStateFile(deskStateHome(), [], "desk-workbench-sessions.json");
}

function validWorkbenchSession(value: unknown): DeskWorkbenchSession | null {
  if (!isObject(value)) return null;
  const fingerprint = boundedString(value.identityFingerprint, 64);
  const bindingRevision = boundedString(value.bindingRevision, 64);
  const sessionId = boundedString(value.sessionId, 128);
  const token = boundedString(value.token, MAX_TOKEN_LENGTH);
  const expiresAt = safeTimestamp(value.expiresAt);
  if (
    !IDENTITY_FINGERPRINT_PATTERN.test(fingerprint)
    || !BINDING_REVISION_PATTERN.test(bindingRevision)
    || !SESSION_ID_PATTERN.test(sessionId)
    || !SESSION_TOKEN_PATTERN.test(token)
    || expiresAt <= 0
  ) return null;
  return { identityFingerprint: fingerprint, bindingRevision, sessionId, token, expiresAt };
}

function readWorkbenchSessions(): Record<string, DeskWorkbenchSession> {
  const sessions = nullRecord<DeskWorkbenchSession>();
  try {
    const snapshot = readPrivateStateFileSnapshotSync(
      workbenchSessionsDeskBinding().path,
      MAX_DESK_WORKBENCH_STATE_BYTES,
    );
    if (!snapshot) return sessions;
    const parsed = JSON.parse(snapshot.text) as unknown;
    if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.sessions)) return sessions;
    for (const [profileId, value] of Object.entries(parsed.sessions)) {
      if (!PROFILE_ID_PATTERN.test(profileId)) continue;
      const session = validWorkbenchSession(value);
      if (session) sessions[profileId] = session;
    }
  } catch {
    // Runtime Session credentials are renewable and short-lived. A corrupt cache is ignored rather
    // than weakening the Agent credential boundary or surfacing secret-bearing parse errors.
  }
  return sessions;
}

function writeWorkbenchSessions(sessions: Record<string, DeskWorkbenchSession>): void {
  const file: DeskWorkbenchSessionsFile = { version: 1, sessions };
  writePrivateStateFileSync(workbenchSessionsDeskBinding(), JSON.stringify(file, null, 2) + "\n");
}

function removeWorkbenchSession(profileId: string, expectedToken?: string): void {
  if (!PROFILE_ID_PATTERN.test(profileId)) return;
  const sessions = readWorkbenchSessions();
  if (!Object.hasOwn(sessions, profileId)) return;
  if (expectedToken && sessions[profileId].token !== expectedToken) return;
  delete sessions[profileId];
  writeWorkbenchSessions(sessions);
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
  const tenantId = boundedString(identity.tenantId, 128);
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
    tenantId,
    deviceId,
    enrolledAt,
  };
}

function identityFingerprint(identity: DeskOrganizationIdentity): string {
  const normalized = normalizedIdentity(identity);
  return createHash("sha256")
    .update(JSON.stringify([
      normalized.gatewayUrl,
      normalized.tenantId,
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
  removeWorkbenchSession(STANDALONE_WORKBENCH_KEY);
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
  removeWorkbenchSession(normalizedIdentityValue.profileId);
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
  removeWorkbenchSession(profileId);
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
async function deskJsonCall(
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

/** Public Desk transport boundary. Credential exchanges use the private helper above; every value
 * returned through this exported function is scrubbed before it can reach Serve, Desktop, or logs. */
export async function deskCall(
  url: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
  const result = await deskJsonCall(url, method, path, opts);
  return redactSensitiveValue(result, [opts.token]).value;
}

function arrayField(value: unknown, field: string): unknown[] {
  if (!isObject(value) || !Array.isArray(value[field])) {
    throw new DeskClientError("PROTOCOL", `Desk response is missing ${field}`);
  }
  return value[field] as unknown[];
}

function optionalArrayField(value: unknown, field: string): unknown[] {
  if (!isObject(value) || value[field] === undefined) return [];
  if (!Array.isArray(value[field])) {
    throw new DeskClientError("PROTOCOL", `Desk response contains an invalid ${field} collection`);
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

function optionalNullableString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return null;
  return strictNullableString(value, max);
}

function optionalNullableTimestamp(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = safeTimestamp(value);
  return timestamp > 0 ? timestamp : undefined;
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
  priority: DeskPriority;
  severity: DeskSeverity;
  slaDueAt: number | null;
  parentId: string | null;
  createdBy: string;
  claimedBy: string | null;
  ackedBy: string | null;
  reporterRef: string;
  occurrenceCount: number;
  sourceCount: number;
  releaseVersion: string;
  verificationSteps: string;
  claimedSessionId: string | null;
  claimExpiresAt: number | null;
  claimFence: number;
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
  const slaDueAt = optionalNullableTimestamp(value.slaDueAt);
  const parentId = optionalNullableString(value.parentId, 256);
  const claimedSessionId = optionalNullableString(value.claimedSessionId, 256);
  const claimExpiresAt = optionalNullableTimestamp(value.claimExpiresAt);
  const createdAt = requiredTimestamp(value.createdAt);
  const updatedAt = requiredTimestamp(value.updatedAt);
  if (
    !id
    || !TASK_ID_PATTERN.test(id)
    || !title
    || body === null
    || (value.kind !== "feedback" && value.kind !== "dispatch")
    || (value.risk !== "low" && value.risk !== "high")
    || typeof value.state !== "string"
    || !DESK_TASK_STATES.has(value.state as DeskTaskState)
    || (value.priority !== undefined && (typeof value.priority !== "string" || !DESK_PRIORITIES.has(value.priority as DeskPriority)))
    || (value.severity !== undefined && (typeof value.severity !== "string" || !DESK_SEVERITIES.has(value.severity as DeskSeverity)))
    || !createdBy
    || claimedBy === undefined
    || ackedBy === undefined
    || slaDueAt === undefined
    || parentId === undefined
    || claimedSessionId === undefined
    || claimExpiresAt === undefined
    || createdAt === null
    || updatedAt === null
  ) return null;
  return {
    id,
    kind: value.kind,
    title,
    body,
    risk: value.risk,
    state: value.state as DeskTaskState,
    priority: (value.priority as DeskPriority | undefined) ?? "normal",
    severity: (value.severity as DeskSeverity | undefined) ?? "minor",
    slaDueAt,
    parentId,
    createdBy,
    claimedBy,
    ackedBy,
    reporterRef: boundedString(value.reporterRef, 512),
    occurrenceCount: safeNonNegativeInteger(value.occurrenceCount, 1),
    sourceCount: safeNonNegativeInteger(value.sourceCount),
    releaseVersion: boundedString(value.releaseVersion, 64),
    verificationSteps: boundedString(value.verificationSteps, 4_000),
    claimedSessionId,
    claimExpiresAt,
    claimFence: safeNonNegativeInteger(value.claimFence),
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

function toComment(value: unknown): DeskTaskComment | null {
  if (!isObject(value)) return null;
  const id = boundedString(value.id, 256);
  const taskId = boundedString(value.taskId, 256);
  const actor = boundedString(value.actor, 256);
  const sessionId = optionalNullableString(value.sessionId, 256);
  const at = requiredTimestamp(value.at);
  if (!id || !TASK_ID_PATTERN.test(taskId) || !actor || sessionId === undefined || typeof value.body !== "string" || at === null) {
    return null;
  }
  return { id, taskId, actor, sessionId, body: value.body.slice(0, 8_000), at };
}

function toAttachment(value: unknown): DeskTaskAttachment | null {
  if (!isObject(value)) return null;
  const id = boundedString(value.id, 256);
  const taskId = boundedString(value.taskId, 256);
  const commentId = optionalNullableString(value.commentId, 256);
  const actor = boundedString(value.actor, 256);
  const sessionId = optionalNullableString(value.sessionId, 256);
  const at = requiredTimestamp(value.at);
  const size = safeNonNegativeInteger(value.size, -1);
  if (!id || !TASK_ID_PATTERN.test(taskId) || !actor || commentId === undefined || sessionId === undefined || at === null || size < 0) {
    return null;
  }
  return {
    id,
    taskId,
    commentId,
    actor,
    sessionId,
    name: boundedString(value.name, 240),
    contentType: boundedString(value.contentType, 160),
    size,
    url: boundedString(value.url, 1_200),
    storageRef: boundedString(value.storageRef, 500),
    sha256: boundedString(value.sha256, 64),
    at,
  };
}

function toSource(value: unknown): DeskTaskSource | null {
  if (!isObject(value)) return null;
  const id = safePositiveInteger(value.id);
  const createdAt = requiredTimestamp(value.createdAt);
  if (!id || createdAt === null) return null;
  return {
    id,
    sourceKind: boundedString(value.sourceKind, 80),
    sourceChatId: boundedString(value.sourceChatId, 256),
    sourceMessageId: boundedString(value.sourceMessageId, 256),
    sourceUrl: boundedString(value.sourceUrl, 1_200),
    reporterRef: boundedString(value.reporterRef, 512),
    createdAt,
  };
}

function toLink(value: unknown): DeskTaskLink | null {
  if (!isObject(value)) return null;
  const parentTaskId = boundedString(value.parentTaskId, 256);
  const childTaskId = boundedString(value.childTaskId, 256);
  const createdBy = boundedString(value.createdBy, 256);
  const createdAt = requiredTimestamp(value.createdAt);
  if (
    !TASK_ID_PATTERN.test(parentTaskId)
    || !TASK_ID_PATTERN.test(childTaskId)
    || !createdBy
    || createdAt === null
    || typeof value.childState !== "string"
    || !DESK_TASK_STATES.has(value.childState as DeskTaskState)
  ) return null;
  return {
    parentTaskId,
    childTaskId,
    relation: boundedString(value.relation, 80),
    createdBy,
    createdAt,
    parentTitle: boundedString(value.parentTitle, 240),
    childTitle: boundedString(value.childTitle, 240),
    childState: value.childState as DeskTaskState,
  };
}

function safeStructuredPayload(value: unknown): unknown {
  if (value === undefined) return {};
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) return { truncated: true };
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function toExecutionEvent(value: unknown): DeskExecutionEvent | null {
  if (!isObject(value)) return null;
  const id = safePositiveInteger(value.id);
  const eventKey = boundedString(value.eventKey, 160);
  const agentId = boundedString(value.agentId, 256);
  const sessionId = optionalNullableString(value.sessionId, 256);
  const taskId = optionalNullableString(value.taskId, 256);
  const kind = boundedString(value.kind, 80);
  const at = requiredTimestamp(value.at);
  if (!id || !eventKey || !agentId || sessionId === undefined || taskId === undefined || !kind || at === null) return null;
  if (taskId && !TASK_ID_PATTERN.test(taskId)) return null;
  return { id, eventKey, agentId, sessionId, taskId, kind, payload: safeStructuredPayload(value.payload), at };
}

function toDiff(value: unknown): DeskDiffArtifact | null {
  if (!isObject(value)) return null;
  const id = boundedString(value.id, 256);
  const taskId = boundedString(value.taskId, 256);
  const agentId = boundedString(value.agentId, 256);
  const sessionId = boundedString(value.sessionId, 256);
  const createdAt = requiredTimestamp(value.createdAt);
  const reviewedBy = optionalNullableString(value.reviewedBy, 256);
  const reviewedAt = optionalNullableTimestamp(value.reviewedAt);
  if (
    !id
    || !TASK_ID_PATTERN.test(taskId)
    || !agentId
    || !sessionId
    || createdAt === null
    || reviewedBy === undefined
    || reviewedAt === undefined
    || (value.state !== "pending" && value.state !== "approved" && value.state !== "rejected" && value.state !== "merged")
  ) return null;
  return {
    id,
    artifactKey: boundedString(value.artifactKey, 160),
    taskId,
    agentId,
    sessionId,
    worktreeLabel: boundedString(value.worktreeLabel, 240),
    baseRef: boundedString(value.baseRef, 160),
    headRef: boundedString(value.headRef, 160),
    patchSha256: boundedString(value.patchSha256, 64),
    summary: boundedString(value.summary, 4_000),
    state: value.state,
    createdAt,
    reviewedBy,
    reviewedAt,
    reviewNote: boundedString(value.reviewNote, 2_000),
    mergeRef: boundedString(value.mergeRef, 200),
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

function requireProfileBinding(identity: DeskOrganizationIdentity): DeskProfileBinding {
  const normalized = normalizedIdentity(identity);
  const state = readDeskState();
  const binding = state.connections[normalized.profileId];
  if (!binding || binding.identityFingerprint !== identityFingerprint(normalized)) {
    throw new DeskClientError("NOT_CONFIGURED", "Desk is not configured for this organization");
  }
  return binding;
}

function requireProfileCreds(identity: DeskOrganizationIdentity): DeskCreds {
  return requireProfileBinding(identity).creds;
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
      "Desk organization connection changed during the request; refresh and try again",
    );
  }
}

const workbenchSessionRequests = new Map<string, Promise<DeskWorkbenchSession>>();

function parseWorkbenchSession(
  result: unknown,
  binding: DeskProfileBinding,
): DeskWorkbenchSession {
  const session = objectField(result, "session");
  const sessionId = boundedString(session.id, 128);
  const token = isObject(result) ? boundedString(result.token, MAX_TOKEN_LENGTH) : "";
  const expiresAt = safeTimestamp(session.leaseExpiresAt);
  if (!SESSION_ID_PATTERN.test(sessionId) || !SESSION_TOKEN_PATTERN.test(token) || expiresAt <= Date.now()) {
    throw new DeskClientError("PROTOCOL", "Desk returned an invalid workbench Session credential");
  }
  return {
    identityFingerprint: binding.identityFingerprint,
    bindingRevision: binding.revision,
    sessionId,
    token,
    expiresAt,
  };
}

async function openOrRenewWorkbenchSession(
  identity: DeskOrganizationIdentity,
  binding: DeskProfileBinding,
): Promise<DeskWorkbenchSession> {
  const normalized = normalizedIdentity(identity);
  const sessions = readWorkbenchSessions();
  const cached = sessions[normalized.profileId];
  const cacheMatches = cached
    && cached.identityFingerprint === binding.identityFingerprint
    && cached.bindingRevision === binding.revision;
  if (cacheMatches && cached.expiresAt > Date.now() + WORKBENCH_SESSION_REUSE_MARGIN_MS) {
    return cached;
  }

  let result: unknown | null = null;
  if (cacheMatches) {
    try {
      result = await deskJsonCall(
        binding.creds.url,
        "POST",
        `/sessions/${cached.sessionId}/renew`,
        { token: binding.creds.token },
      );
    } catch (error) {
      if (!(error instanceof DeskClientError) || error.code !== "NOT_FOUND") throw error;
    }
  }
  if (!result) {
    result = await deskJsonCall(binding.creds.url, "POST", "/sessions", {
      token: binding.creds.token,
      body: {
        name: "Hara Desktop task workbench",
        workspaceLabel: `organization:${normalized.profileId}`,
      },
    });
  }
  const workbench = parseWorkbenchSession(result, binding);
  assertProfileCredsUnchanged(normalized, binding.creds);
  const currentSessions = readWorkbenchSessions();
  currentSessions[normalized.profileId] = workbench;
  writeWorkbenchSessions(currentSessions);
  return workbench;
}

async function ensureWorkbenchSession(
  identity: DeskOrganizationIdentity,
): Promise<DeskWorkbenchSession> {
  const normalized = normalizedIdentity(identity);
  const binding = requireProfileBinding(normalized);
  const requestKey = `${normalized.profileId}:${binding.revision}`;
  const active = workbenchSessionRequests.get(requestKey);
  if (active) return active;
  const request = openOrRenewWorkbenchSession(normalized, binding).finally(() => {
    if (workbenchSessionRequests.get(requestKey) === request) {
      workbenchSessionRequests.delete(requestKey);
    }
  });
  workbenchSessionRequests.set(requestKey, request);
  return request;
}

function standaloneWorkbenchBinding(creds: DeskCreds): DeskProfileBinding {
  const normalized = validCreds(creds);
  if (!normalized) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Standalone Desk credentials are invalid");
  }
  return {
    identityFingerprint: createHash("sha256")
      .update(JSON.stringify(["standalone", normalized.url, normalized.agentId, normalized.owner]))
      .digest("hex"),
    // The revision changes when the permanent bearer rotates, without persisting that bearer in
    // another long-lived field. The Session cache itself remains in the private Hara state store.
    revision: createHash("sha256").update(normalized.token).digest("hex"),
    creds: normalized,
  };
}

function assertStandaloneCredsUnchanged(expected: DeskCreds): void {
  const current = loadCreds();
  if (
    !current
    || current.url !== expected.url
    || current.agentId !== expected.agentId
    || current.token !== expected.token
  ) {
    throw new DeskClientError(
      "CONFLICT",
      "Standalone Desk registration changed during the request; retry the command",
    );
  }
}

async function openOrRenewStandaloneWorkbenchSession(
  binding: DeskProfileBinding,
): Promise<DeskWorkbenchSession> {
  const sessions = readWorkbenchSessions();
  const cached = sessions[STANDALONE_WORKBENCH_KEY];
  const cacheMatches = cached
    && cached.identityFingerprint === binding.identityFingerprint
    && cached.bindingRevision === binding.revision;
  if (cacheMatches && cached.expiresAt > Date.now() + WORKBENCH_SESSION_REUSE_MARGIN_MS) {
    return cached;
  }

  let result: unknown | null = null;
  if (cacheMatches) {
    try {
      result = await deskJsonCall(
        binding.creds.url,
        "POST",
        `/sessions/${cached.sessionId}/renew`,
        { token: binding.creds.token },
      );
    } catch (error) {
      if (!(error instanceof DeskClientError) || error.code !== "NOT_FOUND") throw error;
    }
  }
  if (!result) {
    result = await deskJsonCall(binding.creds.url, "POST", "/sessions", {
      token: binding.creds.token,
      body: {
        name: "Hara CLI task workbench",
        workspaceLabel: "standalone",
      },
    });
  }
  const workbench = parseWorkbenchSession(result, binding);
  assertStandaloneCredsUnchanged(binding.creds);
  const currentSessions = readWorkbenchSessions();
  currentSessions[STANDALONE_WORKBENCH_KEY] = workbench;
  writeWorkbenchSessions(currentSessions);
  return workbench;
}

async function ensureStandaloneWorkbenchSession(
  creds: DeskCreds,
): Promise<DeskWorkbenchSession> {
  const binding = standaloneWorkbenchBinding(creds);
  const requestKey = `${STANDALONE_WORKBENCH_KEY}:${binding.revision}`;
  const active = workbenchSessionRequests.get(requestKey);
  if (active) return active;
  const request = openOrRenewStandaloneWorkbenchSession(binding).finally(() => {
    if (workbenchSessionRequests.get(requestKey) === request) {
      workbenchSessionRequests.delete(requestKey);
    }
  });
  workbenchSessionRequests.set(requestKey, request);
  return request;
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
  const comments = strictArray(
    optionalArrayField(result, "comments"),
    TASK_COMMENT_LIMIT,
    toComment,
    "comment",
  ).filter((comment) => comment.taskId === taskId);
  const attachments = strictArray(
    optionalArrayField(result, "attachments"),
    TASK_ATTACHMENT_LIMIT,
    toAttachment,
    "attachment",
  ).filter((attachment) => attachment.taskId === taskId);
  const sources = strictArray(
    optionalArrayField(result, "sources"),
    TASK_SOURCE_LIMIT,
    toSource,
    "source",
  );
  const links = strictArray(
    optionalArrayField(result, "links"),
    TASK_LINK_LIMIT,
    toLink,
    "task link",
  ).filter((link) => link.parentTaskId === taskId || link.childTaskId === taskId);
  const executionEvents = strictArray(
    optionalArrayField(result, "executionEvents"),
    TASK_EXECUTION_EVENT_LIMIT,
    toExecutionEvent,
    "execution event",
  ).filter((event) => event.taskId === taskId);
  const diffs = strictArray(
    optionalArrayField(result, "diffs"),
    TASK_DIFF_LIMIT,
    toDiff,
    "diff artifact",
  ).filter((diff) => diff.taskId === taskId);
  assertProfileCredsUnchanged(normalized, creds);
  const details: DeskTaskDetails = {
    profileId: normalized.profileId,
    task,
    events,
    comments,
    attachments,
    sources,
    links,
    executionEvents,
    diffs,
  };
  assertPayloadSize(details, MAX_TASK_PAYLOAD_BYTES, "task details");
  return details;
}

const requiredTrimmed = (value: unknown, max: number, label: string): string => {
  const normalized = typeof value === "string" ? value.trim().slice(0, max) : "";
  if (!normalized) throw new DeskClientError("INVALID_CONFIGURATION", `${label} is required`);
  return normalized;
};

const optionalTrimmed = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

async function mutateDeskTask(
  identity: DeskOrganizationIdentity,
  taskId: string,
  pathSuffix: string,
  body: unknown,
  credential: "agent" | "workbench" = "agent",
): Promise<DeskTaskMutationResult> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task ID is invalid");
  }
  const normalized = normalizedIdentity(identity);
  const creds = requireProfileCreds(normalized);
  const invoke = (token: string) => deskCall(
    creds.url,
    "POST",
    `/tasks/${taskId}/${pathSuffix}`,
    { token, body },
  );
  const claimFence = isObject(body) && Number.isSafeInteger(body.claimFence)
    ? Number(body.claimFence)
    : undefined;
  const invokeWorkbench = async (token: string): Promise<unknown> => {
    if (claimFence !== undefined && pathSuffix !== "claim") {
      await deskCall(creds.url, "POST", `/tasks/${taskId}/claim/renew`, {
        token,
        body: { claimFence },
      });
    }
    return invoke(token);
  };
  let result: unknown;
  if (credential === "workbench") {
    let workbench = await ensureWorkbenchSession(normalized);
    try {
      result = await invokeWorkbench(workbench.token);
    } catch (error) {
      if (!(error instanceof DeskClientError) || error.code !== "UNAUTHORIZED") throw error;
      removeWorkbenchSession(normalized.profileId, workbench.token);
      workbench = await ensureWorkbenchSession(normalized);
      result = await invokeWorkbench(workbench.token);
    }
  } else {
    result = await invoke(creds.token);
  }
  const task = toTaskDetail(objectField(result, "task"));
  if (!task || task.id !== taskId) {
    throw new DeskClientError("PROTOCOL", "Desk returned an unexpected task after the update");
  }
  assertProfileCredsUnchanged(normalized, creds);
  const response = { profileId: normalized.profileId, task };
  assertPayloadSize(response, MAX_TASK_PAYLOAD_BYTES, "task update");
  return response;
}

async function mutateStandaloneDeskTask(
  creds: DeskCreds,
  taskId: string,
  pathSuffix: string,
  body: unknown,
  credential: "agent" | "workbench" = "agent",
): Promise<DeskTaskMutationResult> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task ID is invalid");
  }
  const normalized = validCreds(creds);
  if (!normalized) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Standalone Desk credentials are invalid");
  }
  const invoke = (token: string) => deskCall(
    normalized.url,
    "POST",
    `/tasks/${taskId}/${pathSuffix}`,
    { token, body },
  );
  const claimFence = isObject(body) && Number.isSafeInteger(body.claimFence)
    ? Number(body.claimFence)
    : undefined;
  const invokeWorkbench = async (token: string): Promise<unknown> => {
    if (claimFence !== undefined && pathSuffix !== "claim") {
      await deskCall(normalized.url, "POST", `/tasks/${taskId}/claim/renew`, {
        token,
        body: { claimFence },
      });
    }
    return invoke(token);
  };
  let result: unknown;
  if (credential === "workbench") {
    let workbench = await ensureStandaloneWorkbenchSession(normalized);
    try {
      result = await invokeWorkbench(workbench.token);
    } catch (error) {
      if (!(error instanceof DeskClientError) || error.code !== "UNAUTHORIZED") throw error;
      removeWorkbenchSession(STANDALONE_WORKBENCH_KEY, workbench.token);
      workbench = await ensureStandaloneWorkbenchSession(normalized);
      result = await invokeWorkbench(workbench.token);
    }
  } else {
    result = await invoke(normalized.token);
  }
  const task = toTaskDetail(objectField(result, "task"));
  if (!task || task.id !== taskId) {
    throw new DeskClientError("PROTOCOL", "Desk returned an unexpected task after the update");
  }
  assertStandaloneCredsUnchanged(normalized);
  const response = { profileId: STANDALONE_WORKBENCH_KEY, task };
  assertPayloadSize(response, MAX_TASK_PAYLOAD_BYTES, "task update");
  return response;
}

export async function createDeskTask(
  identity: DeskOrganizationIdentity,
  input: DeskCreateTaskInput,
): Promise<DeskTaskMutationResult> {
  const normalized = normalizedIdentity(identity);
  const creds = requireProfileCreds(normalized);
  const title = requiredTrimmed(input.title, 200, "Desk task title");
  if (input.kind !== "feedback" && input.kind !== "dispatch") {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task kind is invalid");
  }
  if (input.risk !== undefined && input.risk !== "low" && input.risk !== "high") {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task risk is invalid");
  }
  if (input.priority !== undefined && !DESK_PRIORITIES.has(input.priority)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task priority is invalid");
  }
  if (input.severity !== undefined && !DESK_SEVERITIES.has(input.severity)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task severity is invalid");
  }
  const slaDueAt = input.slaDueAt;
  if (slaDueAt !== undefined && (!Number.isSafeInteger(slaDueAt) || slaDueAt <= Date.now())) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task SLA must be a future timestamp");
  }
  const result = await deskCall(creds.url, "POST", "/tasks", {
    token: creds.token,
    body: {
      kind: input.kind,
      title,
      body: typeof input.body === "string" ? input.body.slice(0, 20_000) : "",
      risk: input.risk ?? "low",
      priority: input.priority ?? "normal",
      severity: input.severity ?? "minor",
      ...(slaDueAt !== undefined ? { slaDueAt } : {}),
    },
  });
  const task = toTaskDetail(objectField(result, "task"));
  if (!task) throw new DeskClientError("PROTOCOL", "Desk returned an invalid created task");
  assertProfileCredsUnchanged(normalized, creds);
  const response = { profileId: normalized.profileId, task };
  assertPayloadSize(response, MAX_TASK_PAYLOAD_BYTES, "created task");
  return response;
}

export const claimDeskTask = (
  identity: DeskOrganizationIdentity,
  taskId: string,
): Promise<DeskTaskMutationResult> => mutateDeskTask(identity, taskId, "claim", {}, "workbench");

/** Legacy standalone Desk commands keep the same Session-only execution boundary as organization
 * profiles. The permanent Agent bearer can administer/approve, but never claims executable work. */
export const claimStandaloneDeskTask = (
  creds: DeskCreds,
  taskId: string,
): Promise<DeskTaskMutationResult> => mutateStandaloneDeskTask(creds, taskId, "claim", {}, "workbench");

export const ackDeskTask = (
  identity: DeskOrganizationIdentity,
  taskId: string,
): Promise<DeskTaskMutationResult> => mutateDeskTask(identity, taskId, "ack", {});

export const ackStandaloneDeskTask = (
  creds: DeskCreds,
  taskId: string,
): Promise<DeskTaskMutationResult> => mutateStandaloneDeskTask(creds, taskId, "ack", {});

export function transitionDeskTask(
  identity: DeskOrganizationIdentity,
  taskId: string,
  input: DeskTransitionTaskInput,
): Promise<DeskTaskMutationResult> {
  if (!DESK_TASK_STATES.has(input.state)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task state is invalid");
  }
  const claimFence = input.claimFence;
  if (claimFence !== undefined && (!Number.isSafeInteger(claimFence) || claimFence < 1)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task claim fence is invalid");
  }
  return mutateDeskTask(identity, taskId, "transition", {
    state: input.state,
    note: optionalTrimmed(input.note, 2_000),
    releaseVersion: optionalTrimmed(input.releaseVersion, 64),
    verificationSteps: optionalTrimmed(input.verificationSteps, 4_000),
    ...(claimFence !== undefined ? { claimFence } : {}),
  }, input.state === "claimed" || claimFence !== undefined ? "workbench" : "agent");
}

export function completeDeskTask(
  identity: DeskOrganizationIdentity,
  taskId: string,
  input: DeskCompleteTaskInput = {},
): Promise<DeskTaskMutationResult> {
  const claimFence = input.claimFence;
  if (claimFence !== undefined && (!Number.isSafeInteger(claimFence) || claimFence < 1)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task claim fence is invalid");
  }
  return mutateDeskTask(identity, taskId, "complete", {
    detail: optionalTrimmed(input.detail, 2_000),
    releaseVersion: optionalTrimmed(input.releaseVersion, 64),
    verificationSteps: optionalTrimmed(input.verificationSteps, 4_000),
    ...(claimFence !== undefined ? { claimFence } : {}),
  }, claimFence !== undefined ? "workbench" : "agent");
}

export function completeStandaloneDeskTask(
  creds: DeskCreds,
  taskId: string,
  input: DeskCompleteTaskInput = {},
): Promise<DeskTaskMutationResult> {
  const claimFence = input.claimFence;
  if (claimFence !== undefined && (!Number.isSafeInteger(claimFence) || claimFence < 1)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task claim fence is invalid");
  }
  return mutateStandaloneDeskTask(creds, taskId, "complete", {
    detail: optionalTrimmed(input.detail, 2_000),
    releaseVersion: optionalTrimmed(input.releaseVersion, 64),
    verificationSteps: optionalTrimmed(input.verificationSteps, 4_000),
    ...(claimFence !== undefined ? { claimFence } : {}),
  }, claimFence !== undefined ? "workbench" : "agent");
}

export function cancelDeskTask(
  identity: DeskOrganizationIdentity,
  taskId: string,
  detail: string,
  claimFence?: number,
): Promise<DeskTaskMutationResult> {
  const reason = requiredTrimmed(detail, 2_000, "Desk cancellation reason");
  if (claimFence !== undefined && (!Number.isSafeInteger(claimFence) || claimFence < 1)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task claim fence is invalid");
  }
  return mutateDeskTask(identity, taskId, "cancel", {
    detail: reason,
    ...(claimFence !== undefined ? { claimFence } : {}),
  }, claimFence !== undefined ? "workbench" : "agent");
}

export function cancelStandaloneDeskTask(
  creds: DeskCreds,
  taskId: string,
  detail: string,
  claimFence?: number,
): Promise<DeskTaskMutationResult> {
  const reason = requiredTrimmed(detail, 2_000, "Desk cancellation reason");
  if (claimFence !== undefined && (!Number.isSafeInteger(claimFence) || claimFence < 1)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task claim fence is invalid");
  }
  return mutateStandaloneDeskTask(creds, taskId, "cancel", {
    detail: reason,
    ...(claimFence !== undefined ? { claimFence } : {}),
  }, claimFence !== undefined ? "workbench" : "agent");
}

export async function commentDeskTask(
  identity: DeskOrganizationIdentity,
  taskId: string,
  body: string,
): Promise<{ profileId: string; comment: DeskTaskComment }> {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new DeskClientError("INVALID_CONFIGURATION", "Desk task ID is invalid");
  }
  const normalized = normalizedIdentity(identity);
  const creds = requireProfileCreds(normalized);
  const commentBody = requiredTrimmed(body, 8_000, "Desk comment");
  const result = await deskCall(creds.url, "POST", `/tasks/${taskId}/comments`, {
    token: creds.token,
    body: { body: commentBody },
  });
  const comment = toComment(objectField(result, "comment"));
  if (!comment || comment.taskId !== taskId) {
    throw new DeskClientError("PROTOCOL", "Desk returned an unexpected task comment");
  }
  assertProfileCredsUnchanged(normalized, creds);
  const response = { profileId: normalized.profileId, comment };
  assertPayloadSize(response, MAX_TASK_PAYLOAD_BYTES, "task comment");
  return response;
}

/** Register this machine's agent with a Desk and bind the returned credential to one existing local
 * organization profile. The server derives owner authorization from the enroll key. */
export async function registerAgent(
  url: string,
  enrollKey: string,
  name: string,
  owner: string,
  client = "nanhara.hara-cli",
  identity?: DeskOrganizationIdentity,
): Promise<DeskCreds> {
  const normalizedUrl = normalizeDeskBaseUrl(url);
  const normalizedOrganization = identity ? normalizedIdentity(identity) : undefined;
  let realmId = "";
  let provisioningId = "";
  if (normalizedOrganization) {
    if (!normalizedOrganization.tenantId || !normalizedOrganization.deviceId) {
      throw new DeskClientError(
        "INVALID_CONFIGURATION",
        "Organization connection must be re-enrolled before registering its Desk Agent",
      );
    }
    const health = await deskJsonCall(normalizedUrl, "GET", "/health");
    const deployment = isObject(health) && isObject(health.deployment)
      ? health.deployment
      : null;
    realmId = boundedString(deployment?.realmId, 128);
    if (realmId !== normalizedOrganization.tenantId) {
      throw new DeskClientError(
        "CONFLICT",
        "Desk belongs to a different organization realm",
      );
    }
    provisioningId = `hara_${createHash("sha256")
      .update(JSON.stringify([
        normalizedOrganization.tenantId,
        normalizedOrganization.deviceId,
        client,
        "default",
      ]))
      .digest("hex")}`;
  }
  // Registration is one of two private credential exchanges (the other is Session creation). Keep
  // the returned bearer inside this module; exported deskCall deliberately redacts token fields.
  const result = await deskJsonCall(normalizedUrl, "POST", "/register", {
    body: {
      enrollKey,
      name,
      owner,
      client,
      ...(normalizedOrganization?.deviceId
        ? {
            realmId,
            provisioningId,
            installationId: normalizedOrganization.deviceId.slice(0, 160),
            deviceName: hostname().slice(0, 120) || "Hara device",
            platform: process.platform,
            version: HARA_RUNTIME_VERSION,
            capabilities: ["tasks", "comments", "organization-workbench", "session-lease"],
          }
        : {}),
    },
  });
  if (!isObject(result)) throw new DeskClientError("PROTOCOL", "Desk registration returned invalid credentials");
  const creds = validCreds({
    url: normalizedUrl,
    agentId: result.agentId,
    owner: result.owner,
    token: result.token,
  });
  if (!creds) throw new DeskClientError("PROTOCOL", "Desk registration returned incomplete credentials");
  if (normalizedOrganization) saveProfileCreds(creds, normalizedOrganization);
  else saveCreds(creds);
  return creds;
}
