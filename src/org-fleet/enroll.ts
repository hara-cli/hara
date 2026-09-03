// B-end device enrollment (the OSS client side of the fleet/control-plane story). A hara device joins a
// fleet by exchanging a one-time enrollment code for a scoped, revocable DEVICE TOKEN — it never holds the
// real provider key (that stays at the gateway). hara then points its OpenAI-compatible calls at the
// gateway, which validates the token, maps it to an upstream key, and proxies. Heartbeats give the control
// plane fleet visibility. Token + endpoint live in ~/.hara/org.json (0600).
//
// Protocol (what `hara-control` implements on the other end):
//   POST {gateway}/v1/enroll      {code, device:{name,os,hara_version}} -> {device_token,
//     device_id, model, available_models?, thinking_efforts?, base_url?, expires_at? (null = no fixed expiry),
//     desk?:{url,agent_id,owner,token}}
//   POST {gateway}/v1/heartbeat   Bearer <device_token> {device_id, name, os, hara_version}
//     -> 200 {model, available_models?, thinking_efforts?, expires_at? (null = no fixed expiry)} or legacy 204
//   GET  {gateway}/v1/roles       Bearer <device_token> -> {version, org_policy, roles:[…]}  (B3 digital-employee push-down)
//   POST {gateway}/v1/chat/completions  (OpenAI-compatible; the normal agent traffic, Bearer <device_token>)
import { homedir, hostname, platform } from "node:os";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";
import {
  normalizeDeskBaseUrl,
  removeMismatchedProfileCreds,
  saveProfileCreds,
  type DeskCreds,
} from "../desk.js";
import {
  invalidateRolesCache,
  orgRolesDir,
  parseOrganizationRoleBundleEnvelope,
  type OrganizationBundleRole,
  type OrganizationRoleBundleEnvelope,
  type OrganizationRoleBundleSnapshot,
} from "../org/roles.js";
import {
  loadActiveProfile,
  removeProfile,
  upsertProfile,
  useProfile,
  getProfile,
  DEFAULT_ORG_ID,
  isValidProfileId,
  spaceIdForProfile,
  type GatewayModelCapability,
  type Profile,
} from "../profile/profile.js";
import {
  parseOrganizationServiceBindings,
  type OrganizationServiceBinding,
} from "../profile/organization-service.js";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";
import { userModelFetch } from "../network/model-fetch.js";
import { readBoundedResponseText } from "../network/bounded-response.js";
import {
  applyOrganizationLearningBundle,
  markLearningSubmitted,
  type LearningCandidate,
  type OrganizationLearningWire,
} from "../learning/store.js";

export interface Enrollment {
  gatewayUrl: string; // e.g. https://hara-gw.acme.internal  (no trailing slash)
  deviceToken: string; // scoped + revocable; issued by hara-control, NOT a provider key
  deviceId: string;
  /** Control-authoritative company identity. Local connection ids are presentation/routing aliases only. */
  tenantId?: string;
  tenantName?: string;
  model: string; // default model the gateway routes to ("" = gateway decides)
  /** Server-authoritative models permitted by this scoped token. Legacy servers omit this field. */
  availableModels?: string[];
  /** Thinking controls accepted by the selected managed model. Legacy servers omit this field. */
  thinkingEfforts?: string[];
  /** Per-model reasoning controls from modern Controls. */
  modelCapabilities?: GatewayModelCapability[];
  /** Company-admin default for new chats/tasks/Agents; absent means model automatic. */
  defaultReasoningEffort?: string;
  baseURL?: string; // explicit OpenAI-compatible base; defaults to <gatewayUrl>/v1
  enrolledAt: string;
  /** Device-token expiry shared by Hara Control and the model gateway. Missing on legacy servers. */
  expiresAt?: string;
  /** Explicit null expiry advertised by modern Control: no fixed date expiry, still revocable. */
  tokenNeverExpires?: boolean;
  /** Optional separately scoped Desk credential provisioned by Control during the same enrollment.
   * It is consumed into desk-connections.json and is never persisted in the gateway profile. */
  desk?: DeskCreds;
  /** Redacted active services advertised for this tenant. Never contains a bearer or credential. */
  serviceBindings?: OrganizationServiceBinding[];
}

export interface GatewayProfileEnrollmentInput {
  id: string;
  label?: string;
  gatewayUrl: string;
  code: string;
  activate?: boolean;
}

const MAX_ENROLL_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEARTBEAT_RESPONSE_BYTES = 64 * 1024;
const MAX_ROLE_BUNDLE_RESPONSE_BYTES = 2 * 1024 * 1024;
const ROLE_BUNDLE_REQUEST_TIMEOUT_MS = 20_000;
const MAX_LEARNING_RESPONSE_BYTES = 2 * 1024 * 1024;
const LEARNING_REQUEST_TIMEOUT_MS = 20_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const THINKING_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const loopbackHostname = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

const deviceInfo = (): { name: string; os: string; hara_version: string } => ({ name: hostname(), os: platform(), hara_version: process.env.HARA_BUILD_VERSION ?? "dev" });

/** Enrollment codes are sent to a security-sensitive endpoint. Only HTTPS is accepted outside a
 * loopback development server, and userinfo/path/query/fragment are rejected so a code cannot be
 * redirected or accidentally embedded in a URL. */
export function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("organization URL must be a valid absolute URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHostname(url.hostname))) {
    throw new Error("organization URL must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password) throw new Error("organization URL must not contain credentials");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("organization URL must contain only scheme, host, and optional port");
  }
  return url.origin;
}

function normalizeGatewayBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("enroll response contains an invalid base_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("enroll response contains an invalid base_url");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHostname(url.hostname))) {
    throw new Error("enroll response contains an insecure base_url");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("enroll response contains an invalid base_url");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function validateGatewayProfileInput(input: GatewayProfileEnrollmentInput): GatewayProfileEnrollmentInput {
  const id = input.id.trim();
  const label = input.label?.trim();
  const code = input.code.trim();
  if (!isValidProfileId(id)) throw new Error("connection id must use 1-64 letters, numbers, dots, underscores, or dashes");
  if (id === "personal") throw new Error("the personal profile id is reserved");
  if (label && (label.length > 80 || CONTROL_CHARACTERS.test(label))) throw new Error("organization name must be 80 characters or fewer");
  if (!code || code.length > 256 || CONTROL_CHARACTERS.test(code)) throw new Error("registration code must be 1-256 printable characters");
  return { ...input, id, ...(label ? { label } : {}), gatewayUrl: normalizeGatewayUrl(input.gatewayUrl), code };
}

/** The effective OpenAI-compatible base URL for an enrollment (explicit, else <gatewayUrl>/v1). */
export function gatewayBaseURL(e: Enrollment): string {
  return e.baseURL || `${e.gatewayUrl.replace(/\/$/, "")}/v1`;
}

function loadLegacyEnrollment(): Enrollment | null {
  try {
    const binding = bindPrivateHaraStateFile(homedir(), [], "org.json");
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, 1024 * 1024);
    const e = snapshot ? JSON.parse(snapshot.text) as Enrollment : null;
    if (e && typeof e === "object" && e.gatewayUrl && e.deviceToken) return e;
  } catch {
    /* invalid or absent legacy state */
  }
  return null;
}

export function loadEnrollment(): Enrollment | null {
  // 1) Legacy storage (~/.hara/org.json) for back-compat with pre-profile builds. After the
  //    profile migration runs (lazily on any profile.ts read), org.json is renamed to .legacy
  //    so this branch only fires for users who never touched the new profile layer yet.
  const legacy = loadLegacyEnrollment();
  if (legacy) return legacy;
  // 2) Active-profile path. profile.ts doesn't import enroll.ts so this static import is safe.
  try {
    const ap = loadActiveProfile();
    if (ap.kind === "gateway" && ap.gatewayUrl && ap.deviceToken) {
      return {
        gatewayUrl: ap.gatewayUrl,
        deviceToken: ap.deviceToken,
        deviceId: ap.deviceId || "",
        model: ap.defaultModel || "",
        availableModels: ap.availableModels,
        thinkingEfforts: ap.thinkingEfforts,
        modelCapabilities: ap.modelCapabilities,
        defaultReasoningEffort: ap.defaultReasoningEffort,
        baseURL: ap.baseURL,
        enrolledAt: ap.enrolledAt || new Date().toISOString(),
        expiresAt: ap.tokenExpiresAt,
        tokenNeverExpires: ap.tokenNeverExpires,
        serviceBindings: ap.serviceBindings,
      };
    }
  } catch {
    /* not yet migrated */
  }
  return null;
}

function parseAdvertisedStringList(
  value: unknown,
  field: string,
  { maxItems, maxLength, allowed }: { maxItems: number; maxLength: number; allowed?: Set<string> },
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`enroll response contains an invalid ${field}`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || !entry
      || entry.length > maxLength
      || CONTROL_CHARACTERS.test(entry)
      || (allowed && !allowed.has(entry))
    ) {
      throw new Error(`enroll response contains an invalid ${field}`);
    }
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function inferredGatewayThinkingEfforts(model: string): string[] {
  return /^(?:deepseek-v4-(?:flash|pro|flash-vision-exp)|deepseek-(?:chat|reasoner|pro))$/i.test(model)
    ? ["off", "low", "high", "max"]
    : [];
}

function parseModelCapabilities(
  value: unknown,
  availableModels: readonly string[],
): GatewayModelCapability[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("enroll response contains invalid model_capabilities");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("enroll response contains invalid model_capabilities");
    }
    const record = entry as Record<string, unknown>;
    const model = record.model ?? record.id;
    if (
      typeof model !== "string"
      || !availableModels.includes(model)
      || seen.has(model)
    ) {
      throw new Error("enroll response contains invalid model_capabilities");
    }
    seen.add(model);
    const thinkingEfforts = parseAdvertisedStringList(
      record.thinking_efforts ?? record.thinkingEfforts,
      "model_capabilities.thinking_efforts",
      { maxItems: THINKING_EFFORTS.size, maxLength: 16, allowed: THINKING_EFFORTS },
    ) ?? [];
    return { model, thinkingEfforts };
  });
}

function parseDefaultReasoningEffort(
  value: unknown,
  model: string,
  modelCapabilities: readonly GatewayModelCapability[] | undefined,
  sharedEfforts: readonly string[],
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !THINKING_EFFORTS.has(value)) {
    throw new Error("enroll response contains an invalid default_reasoning_effort");
  }
  const supported = modelCapabilities?.find((capability) => capability.model === model)?.thinkingEfforts
    ?? sharedEfforts;
  if (!supported.includes(value)) {
    throw new Error("enroll response default_reasoning_effort is not supported by its default model");
  }
  return value;
}

function parseDeskBinding(value: unknown): DeskCreds | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("enroll response contains an invalid desk binding");
  }
  const record = value as Record<string, unknown>;
  const rawUrl = record.url ?? record.base_url ?? record.baseURL;
  const rawAgentId = record.agent_id ?? record.agentId;
  const rawOwner = record.owner ?? "";
  const rawToken = record.token;
  if (
    typeof rawUrl !== "string"
    || typeof rawAgentId !== "string"
    || typeof rawOwner !== "string"
    || typeof rawToken !== "string"
    || !rawAgentId
    || rawAgentId.length > 256
    || rawOwner.length > 256
    || !rawToken
    || rawToken.length > 4096
    || CONTROL_CHARACTERS.test(rawAgentId)
    || CONTROL_CHARACTERS.test(rawOwner)
    || CONTROL_CHARACTERS.test(rawToken)
  ) {
    throw new Error("enroll response contains an invalid desk binding");
  }
  let url: string;
  try {
    url = normalizeDeskBaseUrl(rawUrl);
  } catch {
    throw new Error("enroll response contains an invalid desk binding");
  }
  return {
    url,
    agentId: rawAgentId,
    owner: rawOwner,
    token: rawToken,
  };
}

function saveEnrollment(e: Enrollment): void {
  const binding = bindPrivateHaraStateFile(homedir(), [], "org.json");
  const { desk: _desk, ...gatewayEnrollment } = e;
  writePrivateStateFileSync(binding, JSON.stringify(gatewayEnrollment, null, 2) + "\n");
}

export function clearEnrollment(): boolean {
  const binding = bindPrivateHaraStateFile(homedir(), [], "org.json");
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, 1024 * 1024);
  if (!snapshot) return false;
  removePrivateStateFile(binding.path, snapshot, binding.directory);
  return true;
}

/** Parse a control-plane enroll response (tolerant of snake_case / camelCase) into an Enrollment. */
export function parseEnrollResponse(gatewayUrl: string, j: Record<string, unknown>, now: string): Enrollment {
  const deviceToken = j.device_token ?? j.deviceToken;
  if (typeof deviceToken !== "string" || !deviceToken || deviceToken.length > 16 * 1024 || CONTROL_CHARACTERS.test(deviceToken)) {
    throw new Error("enroll response missing or contains an invalid device_token");
  }
  const rawDeviceId = j.device_id ?? j.deviceId ?? "";
  const rawModel = j.model ?? "";
  const rawTenantId = j.tenant_id ?? j.tenantId;
  const rawTenantName = j.tenant_name ?? j.tenantName;
  if (typeof rawDeviceId !== "string" || rawDeviceId.length > 256 || CONTROL_CHARACTERS.test(rawDeviceId)) {
    throw new Error("enroll response contains an invalid device_id");
  }
  if (typeof rawModel !== "string" || rawModel.length > 512 || CONTROL_CHARACTERS.test(rawModel)) {
    throw new Error("enroll response contains an invalid model");
  }
  if (
    rawTenantId !== undefined
    && (typeof rawTenantId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rawTenantId))
  ) {
    throw new Error("enroll response contains an invalid tenant_id");
  }
  if (
    rawTenantName !== undefined
    && (typeof rawTenantName !== "string" || !rawTenantName.trim() || rawTenantName.length > 80 || CONTROL_CHARACTERS.test(rawTenantName))
  ) {
    throw new Error("enroll response contains an invalid tenant_name");
  }
  const availableModels = parseAdvertisedStringList(
    j.available_models ?? j.availableModels,
    "available_models",
    { maxItems: 64, maxLength: 512 },
  ) ?? (rawModel ? [rawModel] : []);
  if (rawModel && !availableModels.includes(rawModel)) {
    throw new Error("enroll response model is not present in available_models");
  }
  const thinkingEfforts = parseAdvertisedStringList(
    j.thinking_efforts ?? j.thinkingEfforts,
    "thinking_efforts",
    { maxItems: THINKING_EFFORTS.size, maxLength: 16, allowed: THINKING_EFFORTS },
  ) ?? inferredGatewayThinkingEfforts(rawModel);
  const modelCapabilities = parseModelCapabilities(
    j.model_capabilities ?? j.modelCapabilities,
    availableModels,
  );
  const defaultReasoningEffort = parseDefaultReasoningEffort(
    j.default_reasoning_effort ?? j.defaultReasoningEffort,
    rawModel,
    modelCapabilities,
    thinkingEfforts,
  );
  const hasExpiry = Object.hasOwn(j, "expires_at") || Object.hasOwn(j, "expiresAt");
  const rawExpiresAt = Object.hasOwn(j, "expires_at") ? j.expires_at : j.expiresAt;
  let expiresAt: string | undefined;
  let tokenNeverExpires: boolean | undefined;
  if (rawExpiresAt !== undefined && rawExpiresAt !== null) {
    if (typeof rawExpiresAt !== "string" || !Number.isFinite(Date.parse(rawExpiresAt))) {
      throw new Error("enroll response contains an invalid expires_at");
    }
    expiresAt = new Date(rawExpiresAt).toISOString();
    tokenNeverExpires = false;
  } else if (hasExpiry && rawExpiresAt === null) {
    tokenNeverExpires = true;
  }
  return {
    gatewayUrl: normalizeGatewayUrl(gatewayUrl),
    deviceToken,
    deviceId: rawDeviceId,
    ...(rawTenantId ? { tenantId: rawTenantId } : {}),
    ...(typeof rawTenantName === "string" ? { tenantName: rawTenantName.trim() } : {}),
    model: rawModel,
    availableModels,
    thinkingEfforts,
    modelCapabilities,
    defaultReasoningEffort,
    baseURL: normalizeGatewayBaseUrl(j.base_url ?? j.baseURL),
    enrolledAt: now,
    expiresAt,
    tokenNeverExpires,
    desk: parseDeskBinding(j.desk ?? j.desk_binding ?? j.deskBinding),
    serviceBindings: parseOrganizationServiceBindings(
      j.service_bindings ?? j.serviceBindings,
    ),
  };
}

/** Legacy control planes did not advertise token expiry, so absence remains compatible. New control
 * planes provide it and the CLI can fail early with an actionable re-enrollment message. */
export function deviceTokenExpired(expiresAt: string | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  const expiryMs = Date.parse(expiresAt);
  // A present-but-corrupt lifecycle boundary must not silently become a legacy non-expiring token.
  return !Number.isFinite(expiryMs) || expiryMs <= now.getTime();
}

/** Only warn near the boundary; healthy week-long tokens should not add startup noise. */
export function deviceTokenExpiryWarning(expiresAt: string | undefined, now = new Date()): string | null {
  if (!expiresAt) return null;
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return "organization access expiry is unreadable; re-enroll this profile";
  const remainingMs = expiryMs - now.getTime();
  if (remainingMs <= 0) return "organization access expired; re-enroll this profile before running a task";
  if (remainingMs > 24 * 60 * 60_000) return null;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const remaining =
    remainingMinutes < 60
      ? `${remainingMinutes}m`
      : `${Math.ceil(remainingMinutes / 60)}h`;
  return `organization access expires in ${remaining}; ask your admin for a new enrollment code`;
}

/** Exchange a one-time code without persisting it. Redirects are rejected so the credential is sent
 * only to the exact origin the user entered. Server bodies are never reflected into errors. */
export async function exchangeEnrollment(gatewayUrl: string, code: string, signal?: AbortSignal): Promise<Enrollment> {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!code.trim() || code.length > 256 || CONTROL_CHARACTERS.test(code)) {
    throw new Error("registration code must be 1-256 printable characters");
  }
  let res: Response;
  try {
    res = await userModelFetch(`${base}/v1/enroll`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim(), device: deviceInfo() }),
    });
  } catch {
    throw new Error("organization enrollment request failed");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — bad or expired code" : ""}`);
  }
  const raw = await readBoundedResponseText(res, MAX_ENROLL_RESPONSE_BYTES, "enroll response is too large");
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new Error("enroll response is not valid JSON");
  }
  return parseEnrollResponse(base, payload, new Date().toISOString());
}

/** Legacy enrollment path: exchange, then persist ~/.hara/org.json for older callers. */
export async function enrollDevice(gatewayUrl: string, code: string, signal?: AbortSignal): Promise<Enrollment> {
  const e = await exchangeEnrollment(gatewayUrl, code, signal);
  saveEnrollment(e);
  return e;
}

export function gatewayProfileFromEnrollment(id: string, label: string | undefined, e: Enrollment): Profile {
  return {
    id,
    kind: "gateway",
    label: label || e.tenantName || id,
    tenantId: e.tenantId,
    ...(!e.tenantId ? { enrollmentAudience: randomBytes(16).toString("hex") } : {}),
    tenantName: e.tenantName,
    gatewayUrl: e.gatewayUrl,
    deviceId: e.deviceId,
    deviceToken: e.deviceToken,
    baseURL: e.baseURL,
    defaultModel: e.model || "",
    availableModels: e.availableModels ?? (e.model ? [e.model] : []),
    thinkingEfforts: e.thinkingEfforts,
    modelCapabilities: e.modelCapabilities,
    defaultReasoningEffort: e.defaultReasoningEffort,
    enrolledAt: e.enrolledAt,
    tokenExpiresAt: e.expiresAt,
    tokenNeverExpires: e.tokenNeverExpires,
    serviceBindings: e.serviceBindings,
  };
}

/** Persist a gateway enrollment and retire any Desk bearer pinned to the prior identity at this id.
 * All enrollment entry points use this helper so legacy aliases cannot leave an old organization
 * binding behind after a device-token rotation or tenant replacement. */
export function upsertGatewayProfileFromEnrollment(
  id: string,
  label: string | undefined,
  enrollment: Enrollment,
): Profile {
  const profile = gatewayProfileFromEnrollment(id, label, enrollment);
  const identity = {
    profileId: profile.id,
    gatewayUrl: enrollment.gatewayUrl,
    deviceId: enrollment.deviceId,
    enrolledAt: enrollment.enrolledAt,
  };
  const previous = getProfile(profile.id);
  const nextProfile = previous?.visionModel && profile.availableModels?.includes(previous.visionModel)
    ? {
        ...profile,
        visionModel: previous.visionModel,
        visionSource: "current" as const,
      }
    : profile;
  upsertProfile(nextProfile);
  try {
    if (enrollment.desk) saveProfileCreds(enrollment.desk, identity);
    else removeMismatchedProfileCreds(identity);
  } catch (error) {
    // Keep the local model profile and Desk binding as one user-visible unit. A failed protected
    // Desk write restores the previous profile so an older credential cannot suddenly appear
    // attached to a replacement organization identity.
    if (previous) upsertProfile(previous);
    else removeProfile(profile.id);
    throw error;
  }
  return nextProfile;
}

/** Desktop/profile-native enrollment: no legacy file is written, and the one-time code is never
 * stored. An existing id is intentionally replaced so re-enrollment rotates the scoped token. */
export async function enrollGatewayProfile(
  input: GatewayProfileEnrollmentInput,
  signal?: AbortSignal,
): Promise<{ enrollment: Enrollment; heartbeatOk: boolean }> {
  const validated = validateGatewayProfileInput(input);
  const existing = getProfile(validated.id);
  if (existing && existing.kind !== "gateway") throw new Error("connection id already belongs to a personal provider profile");
  const enrollment = await exchangeEnrollment(validated.gatewayUrl, validated.code, signal);
  upsertGatewayProfileFromEnrollment(validated.id, validated.label, enrollment);
  if (validated.activate !== false) {
    const switched = useProfile(validated.id);
    if (!switched.ok) throw new Error("organization connection was saved but could not be activated");
  }
  return {
    enrollment,
    heartbeatOk: await heartbeatEnrollment(enrollment, signal, { profileId: validated.id }),
  };
}

export function enrollmentFromProfile(profile: Profile): Enrollment | null {
  if (profile.kind !== "gateway" || !profile.gatewayUrl || !profile.deviceToken) return null;
  return {
    gatewayUrl: profile.gatewayUrl,
    deviceToken: profile.deviceToken,
    deviceId: profile.deviceId || "",
    tenantId: profile.tenantId,
    tenantName: profile.tenantName,
    model: profile.defaultModel || "",
    availableModels: profile.availableModels,
    thinkingEfforts: profile.thinkingEfforts,
    modelCapabilities: profile.modelCapabilities,
    defaultReasoningEffort: profile.defaultReasoningEffort,
    baseURL: profile.baseURL,
    enrolledAt: profile.enrolledAt || new Date(0).toISOString(),
    expiresAt: profile.tokenExpiresAt,
    tokenNeverExpires: profile.tokenNeverExpires,
    serviceBindings: profile.serviceBindings,
  };
}

type HeartbeatPersistence = { profileId?: string; legacy?: boolean };

function updatedEnrollmentFromHeartbeat(e: Enrollment, body: Record<string, unknown>): Enrollment {
  const rawModel = body.model;
  const model = rawModel === undefined || rawModel === null ? e.model : rawModel;
  if (typeof model !== "string" || model.length > 512 || CONTROL_CHARACTERS.test(model)) {
    throw new Error("heartbeat response contains an invalid model");
  }
  const advertisedModels = parseAdvertisedStringList(
    body.available_models ?? body.availableModels,
    "available_models",
    { maxItems: 64, maxLength: 512 },
  );
  const availableModels = advertisedModels ?? e.availableModels ?? (model ? [model] : []);
  if (model && !availableModels.includes(model)) {
    throw new Error("heartbeat response model is not present in available_models");
  }
  const advertisedEfforts = parseAdvertisedStringList(
    body.thinking_efforts ?? body.thinkingEfforts,
    "thinking_efforts",
    { maxItems: THINKING_EFFORTS.size, maxLength: 16, allowed: THINKING_EFFORTS },
  );
  const advertisedCapabilities = parseModelCapabilities(
    body.model_capabilities ?? body.modelCapabilities,
    availableModels,
  );
  const modelCapabilities = advertisedCapabilities
    ?? e.modelCapabilities?.filter((capability) => availableModels.includes(capability.model));
  const thinkingEfforts = advertisedEfforts ?? e.thinkingEfforts ?? inferredGatewayThinkingEfforts(model);
  const hasDefaultReasoningEffort = Object.hasOwn(body, "default_reasoning_effort")
    || Object.hasOwn(body, "defaultReasoningEffort");
  const rawDefaultReasoningEffort = Object.hasOwn(body, "default_reasoning_effort")
    ? body.default_reasoning_effort
    : body.defaultReasoningEffort;
  const defaultReasoningEffort = hasDefaultReasoningEffort
    ? parseDefaultReasoningEffort(
        rawDefaultReasoningEffort,
        model,
        modelCapabilities,
        thinkingEfforts,
      )
    : e.defaultReasoningEffort;
  const hasExpiry = Object.hasOwn(body, "expires_at") || Object.hasOwn(body, "expiresAt");
  const rawExpiresAt = Object.hasOwn(body, "expires_at") ? body.expires_at : body.expiresAt;
  let expiresAt = e.expiresAt;
  let tokenNeverExpires = e.tokenNeverExpires;
  if (rawExpiresAt !== undefined && rawExpiresAt !== null) {
    if (typeof rawExpiresAt !== "string" || !Number.isFinite(Date.parse(rawExpiresAt))) {
      throw new Error("heartbeat response contains an invalid expires_at");
    }
    expiresAt = new Date(rawExpiresAt).toISOString();
    tokenNeverExpires = false;
  } else if (hasExpiry && rawExpiresAt === null) {
    expiresAt = undefined;
    tokenNeverExpires = true;
  }
  return {
    ...e,
    model,
    availableModels,
    thinkingEfforts,
    modelCapabilities,
    defaultReasoningEffort,
    expiresAt,
    tokenNeverExpires,
  };
}

function persistHeartbeatCatalog(e: Enrollment, persistence: HeartbeatPersistence): void {
  if (persistence.legacy) saveEnrollment(e);
  if (!persistence.profileId) return;
  const current = getProfile(persistence.profileId);
  // A concurrent re-enrollment may already have rotated this profile. Never let an older heartbeat
  // put its catalog or expiry onto the new credential.
  if (
    !current
    || current.kind !== "gateway"
    || current.deviceToken !== e.deviceToken
    || current.gatewayUrl !== e.gatewayUrl
  ) return;
  const selected = current.model && e.availableModels?.includes(current.model)
    ? current.model
    : undefined;
  const visionModel = current.visionModel && e.availableModels?.includes(current.visionModel)
    ? current.visionModel
    : undefined;
  upsertProfile({
    ...current,
    defaultModel: e.model,
    ...(selected ? { model: selected } : { model: undefined }),
    ...(visionModel
      ? { visionModel, visionSource: "current" }
      : {
          visionModel: undefined,
          visionSource: undefined,
          visionProvider: undefined,
          visionBaseURL: undefined,
          visionApiKey: undefined,
        }),
    availableModels: e.availableModels,
    thinkingEfforts: e.thinkingEfforts,
    modelCapabilities: e.modelCapabilities,
    defaultReasoningEffort: e.defaultReasoningEffort,
    tokenExpiresAt: e.expiresAt,
    tokenNeverExpires: e.tokenNeverExpires,
  });
}

export async function heartbeatEnrollment(
  e: Enrollment,
  signal?: AbortSignal,
  persistence: HeartbeatPersistence = {},
): Promise<boolean> {
  try {
    const res = await userModelFetch(`${e.gatewayUrl}/v1/heartbeat`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${e.deviceToken}` },
      body: JSON.stringify({ device_id: e.deviceId, ...deviceInfo() }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    if (res.status === 204) return true;
    const text = await readBoundedResponseText(res, MAX_HEARTBEAT_RESPONSE_BYTES, "heartbeat response is too large");
    if (!text.trim()) return true;
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const next = updatedEnrollmentFromHeartbeat(e, body as Record<string, unknown>);
    Object.assign(e, next);
    persistHeartbeatCatalog(next, persistence);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort heartbeat so the control plane shows this device online. Never throws. */
export async function heartbeat(signal?: AbortSignal): Promise<boolean> {
  // Do not call loadActiveProfile while a real legacy file exists: that migration intentionally
  // renames org.json, which would turn a harmless heartbeat into a storage-state mutation.
  const legacy = loadLegacyEnrollment();
  if (legacy) return heartbeatEnrollment(legacy, signal, { legacy: true });
  const e = loadEnrollment();
  if (!e) return false;
  try {
    const active = loadActiveProfile();
    if (
      active.kind === "gateway"
      && active.deviceToken === e.deviceToken
      && active.gatewayUrl === e.gatewayUrl
    ) {
      return heartbeatEnrollment(e, signal, { profileId: active.id });
    }
  } catch {
    // A pre-profile legacy enrollment remains refreshable without triggering migration failure.
  }
  return heartbeatEnrollment(e, signal);
}

// ── B3: org role bundle push-down ────────────────────────────────────────────────────────────────
// The control plane resolves which digital-employee roles this device's person/team should run, governs
// them (model/tool/approval floors), and serves them at GET /v1/roles. Wire types are snake_case (server
// convention); we map them to the camelCase frontmatter keys the CLI role loader expects.

/** Render one bundle role into the markdown frontmatter the CLI role loader expects
 *  (src/org/roles.ts parseFrontmatter): identity, execution defaults, tool policy, body=system. */
function renderRoleMd(r: OrganizationBundleRole): string {
  const fm: string[] = ["---", `name: ${r.name}`];
  if (r.description) fm.push(`description: ${r.description}`);
  if (r.owns?.length) fm.push(`owns: [${r.owns.join(", ")}]`);
  if (r.rejects?.length) fm.push(`rejects: [${r.rejects.join(", ")}]`);
  if (r.model) fm.push(`model: ${r.model}`);
  if (r.reasoning_effort) fm.push(`reasoning-effort: ${r.reasoning_effort}`);
  if (r.allow_tools?.length) fm.push(`allowTools: [${r.allow_tools.join(", ")}]`); // snake_case wire → camelCase fm
  if (r.deny_tools?.length) fm.push(`denyTools: [${r.deny_tools.join(", ")}]`);
  fm.push("---", "", (r.system || "").trim(), "");
  return fm.join("\n");
}

function writeManagedBundleFile(
  stateHome: string,
  storageKey: string,
  filename: string,
  text: string,
): void {
  // The hardened private-state CAS move-claims an old inode while replacing it. Serialize both readers and
  // writers for the authoritative bundle so separate Serve/Desktop/gateway processes never observe that
  // internal gap or collide while committing the same Space snapshot.
  withPrivateStateLockSync(stateHome, ["org-roles", storageKey], `${filename}.snapshot`, () => {
    const binding = bindPrivateHaraStateFile(stateHome, ["org-roles", storageKey], filename);
    writePrivateStateFileSync(binding, text);
  }, { busyMessage: `managed organization bundle '${filename}' is busy; retry the sync` });
}

/** Pull one exact profile's governed role bundle and materialize it into the profile-scoped managed
 * directory. The bundle is authoritative for that profile only: another active connection can never
 * overwrite or supply role prompts to a resumed session. */
async function syncOrgRolesEnrollment(
  profileId: string,
  expectedSpaceId: string,
  e: Enrollment,
  signal?: AbortSignal,
  required = false,
): Promise<OrganizationRoleBundleSnapshot | null> {
  try {
    const enrollmentIsCurrent = (): boolean => {
      const current = getProfile(profileId);
      const currentEnrollment = current ? enrollmentFromProfile(current) : null;
      return current?.kind === "gateway"
        && currentEnrollment !== null
        && spaceIdForProfile(current) === expectedSpaceId
        && currentEnrollment.gatewayUrl === e.gatewayUrl
        && currentEnrollment.deviceId === e.deviceId
        && currentEnrollment.deviceToken === e.deviceToken
        && currentEnrollment.enrolledAt === e.enrolledAt;
    };
    // The profile id is a mutable route alias. Freeze both its immutable audience and enrollment
    // generation before issuing a request so an in-flight A response cannot populate B after re-enroll.
    if (!enrollmentIsCurrent()) throw new Error("organization connection changed before role sync");
    const deadline = AbortSignal.timeout(ROLE_BUNDLE_REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const res = await userModelFetch(`${e.gatewayUrl}/v1/roles`, {
      signal: requestSignal,
      redirect: "error",
      headers: { authorization: `Bearer ${e.deviceToken}` },
    });
    if (!res.ok) throw new Error(`organization role sync failed with HTTP ${res.status}`);
    const raw = await readBoundedResponseText(
      res,
      MAX_ROLE_BUNDLE_RESPONSE_BYTES,
      "organization role sync response is too large",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("organization role sync response is not valid JSON");
    }
    const snapshot = parseOrganizationRoleBundleEnvelope(parsed);
    const bundle: OrganizationRoleBundleEnvelope = snapshot.envelope;
    const roles = bundle.roles;
    if (!enrollmentIsCurrent()) throw new Error("organization connection changed during role sync");
    const dir = orgRolesDir(expectedSpaceId);
    const storageKey = basename(dir);
    // Security authority is one atomically replaced envelope. Readers never derive company roles from the
    // compatibility .md files below, so a concurrent refresh cannot mix persona v1 with policy v2.
    writeManagedBundleFile(homedir(), storageKey, "_bundle.json", `${JSON.stringify(bundle, null, 2)}\n`);
    if (!enrollmentIsCurrent()) throw new Error("organization connection changed while role bundle was committed");

    // Keep the old on-disk presentation for one release (`hara roles` tooling and operator inspection),
    // but it is derived/non-authoritative. Remove only verified regular .md files in the bound private dir.
    try {
      const directoryBinding = bindPrivateHaraStateFile(homedir(), ["org-roles", storageKey], "_bundle.json");
      for (const filename of readdirSync(directoryBinding.directory.path)) {
        if (!filename.endsWith(".md")) continue;
        const target = join(directoryBinding.directory.path, filename);
        try {
          const existing = readPrivateStateFileSnapshotSync(target);
          if (existing) removePrivateStateFile(target, existing, directoryBinding.directory);
        } catch {
          // Derived compatibility files never participate in authorization; a concurrent refresher wins.
        }
      }
      for (const r of roles) {
        try { writeManagedBundleFile(homedir(), storageKey, `${r.name}.md`, renderRoleMd(r)); } catch { /* derived */ }
      }
      // Compatibility sidecar only; execution always parses the atomic `_bundle.json` envelope.
      try {
        writeManagedBundleFile(
          homedir(),
          storageKey,
          "_policy.json",
          `${JSON.stringify({ version: bundle.version, org_policy: bundle.org_policy }, null, 2)}\n`,
        );
      } catch {
        /* derived */
      }
    } catch {
      /* The authoritative atomic bundle is already durable; presentation materialization is best-effort. */
    }
    invalidateRolesCache();
    return snapshot;
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

/** Exact authenticated snapshot used by company provider/tool authorization. Returning the in-memory
 * response prevents another local Hara process from swapping the cache between sync and policy use. */
export async function syncOrganizationRoleBundleForProfile(
  profile: Profile,
  signal?: AbortSignal,
  options: { required?: boolean } = {},
): Promise<OrganizationRoleBundleSnapshot | null> {
  const e = enrollmentFromProfile(profile);
  if (!e) return null;
  return syncOrgRolesEnrollment(
    profile.id,
    spaceIdForProfile(profile),
    e,
    signal,
    options.required === true,
  );
}

/** Count-only compatibility API used by explicit role-sync commands and older embedders. */
export async function syncOrgRolesForProfile(
  profile: Profile,
  signal?: AbortSignal,
  options: { required?: boolean } = {},
): Promise<number> {
  return (await syncOrganizationRoleBundleForProfile(profile, signal, options))?.roles.length ?? 0;
}

/** Active-profile compatibility wrapper for explicit `hara roles sync`-style commands. */
export async function syncOrgRoles(signal?: AbortSignal): Promise<number> {
  const active = loadActiveProfile();
  const exact = enrollmentFromProfile(active);
  if (exact) return (await syncOrgRolesEnrollment(active.id, spaceIdForProfile(active), exact, signal))?.roles.length ?? 0;
  // A legacy caller can create ~/.hara/org.json after profiles.json was already initialized. Preserve that
  // pre-profile flow without exposing its bundle to Personal: migrate it into a real immutable-Space
  // gateway profile before materializing policy. Never replace an unrelated existing default-org route.
  const legacy = loadEnrollment();
  if (!legacy) return 0;
  let migrated = getProfile(DEFAULT_ORG_ID);
  if (!migrated) {
    migrated = upsertGatewayProfileFromEnrollment(
      DEFAULT_ORG_ID,
      legacy.tenantName || "Default Org",
      legacy,
    );
  }
  if (!migrated || migrated.kind !== "gateway") return 0;
  const migratedEnrollment = enrollmentFromProfile(migrated);
  if (
    !migratedEnrollment
    || migratedEnrollment.gatewayUrl !== legacy.gatewayUrl
    || migratedEnrollment.deviceToken !== legacy.deviceToken
    || migratedEnrollment.deviceId !== legacy.deviceId
  ) return 0;
  return (await syncOrgRolesEnrollment(DEFAULT_ORG_ID, spaceIdForProfile(migrated), migratedEnrollment, signal))?.roles.length ?? 0;
}

// ── Reviewable organization learning ─────────────────────────────────────────────────────────────

function exactGatewayProfile(profileId: string): Profile {
  const profile = getProfile(profileId);
  if (!profile || profile.kind !== "gateway" || !profile.gatewayUrl || !profile.deviceToken) {
    throw new Error(`organization connection '${profileId}' is unavailable; re-enroll it before syncing learning`);
  }
  if (deviceTokenExpired(profile.tokenExpiresAt)) {
    throw new Error(`organization connection '${profileId}' has expired; re-enroll it before syncing learning`);
  }
  return profile;
}

function sameGatewayIdentity(expected: Profile): boolean {
  const current = getProfile(expected.id);
  return Boolean(
    current
    && current.kind === "gateway"
    && current.gatewayUrl === expected.gatewayUrl
    && current.deviceId === expected.deviceId
    && current.deviceToken === expected.deviceToken
    && current.enrolledAt === expected.enrolledAt,
  );
}

async function boundedControlJson(
  url: string,
  profile: Profile,
  init: RequestInit,
  failureLabel: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  const deadline = AbortSignal.timeout(LEARNING_REQUEST_TIMEOUT_MS);
  const requestSignal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    response = await userModelFetch(url, {
      ...init,
      signal: requestSignal,
      redirect: "error",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${profile.deviceToken}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new Error(`${failureLabel} request failed`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${failureLabel} failed (HTTP ${response.status})`);
  }
  const text = await readBoundedResponseText(
    response,
    MAX_LEARNING_RESPONSE_BYTES,
    `${failureLabel} response is too large`,
  );
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${failureLabel} response is invalid`);
  }
}

export interface OrganizationLearningSubmitResult {
  remoteId: string;
  status: string;
  revision: number;
  candidate: LearningCandidate;
}

/** Submit one already-redacted local proposal. This is always an explicit user action: runtime capture
 * creates a local candidate only, and Control remains the sole authority that can approve it. */
export async function submitOrganizationLearning(
  profileId: string,
  candidate: LearningCandidate,
  context: { cwd: string; stateHome?: string; organizationScopeId?: string },
  signal?: AbortSignal,
): Promise<OrganizationLearningSubmitResult> {
  if (candidate.scope !== "organization") throw new Error("only organization learning can be submitted to Hara Control");
  if (candidate.stability !== "stable") throw new Error("organization learning needs recurring evidence before submission");
  const localEvidence = candidate.evidence.filter((item) => item.source !== "organization");
  if (!localEvidence.length) throw new Error("organization learning has no local reviewable evidence");
  const profile = exactGatewayProfile(profileId);
  const organizationScopeId = context.organizationScopeId ?? spaceIdForProfile(profile);
  if (organizationScopeId !== spaceIdForProfile(profile)) {
    throw new Error("organization connection changed before learning submission; refresh and retry");
  }
  const payload = {
    client_id: candidate.clientId,
    pattern_key: candidate.patternKey,
    kind: candidate.kind,
    summary: candidate.summary,
    ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
    source_version: candidate.sourceVersion,
    evidence: localEvidence.map((item) => ({
      task_hash: item.taskHash,
      fingerprint: item.fingerprint,
      summary: item.summary,
      source: item.source,
      source_version: item.sourceVersion,
      observed_at: item.observedAt,
    })),
  };
  const result = await boundedControlJson(
    `${profile.gatewayUrl}/v1/learnings/candidates`,
    profile,
    { method: "POST", body: JSON.stringify(payload), signal },
    "organization learning submission",
  );
  if (!sameGatewayIdentity(profile)) {
    throw new Error("organization connection changed during learning submission; refresh and retry");
  }
  const remoteId = result.id;
  const remoteStatus = result.status;
  const revision = result.revision;
  if (
    typeof remoteId !== "string"
    || !remoteId
    || remoteId.length > 100
    || typeof remoteStatus !== "string"
    || !["pending", "approved", "rejected", "revoked"].includes(remoteStatus)
    || !Number.isSafeInteger(revision)
    || Number(revision) < 1
  ) {
    throw new Error("organization learning submission response is invalid");
  }
  const local = markLearningSubmitted(candidate.id, remoteId, {
    cwd: context.cwd,
    stateHome: context.stateHome,
    profileId: organizationScopeId,
  });
  return { remoteId, status: remoteStatus, revision: Number(revision), candidate: local };
}

function organizationLearningItem(value: unknown): value is OrganizationLearningWire {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 100
    && typeof item.pattern_key === "string"
    && typeof item.kind === "string"
    && typeof item.summary === "string"
    && (item.rationale === undefined || typeof item.rationale === "string")
    && Number.isSafeInteger(item.occurrence_count)
    && Number.isSafeInteger(item.distinct_task_count)
    && Number.isSafeInteger(item.revision)
    && typeof item.updated_at === "string";
}

/** Pull one full, versioned approved bundle. Missing remote IDs revoke their local projection on the
 * same atomic write, so a Control revocation cannot linger in a future prompt. */
export async function syncOrganizationLearnings(
  profileId: string,
  context: { cwd: string; stateHome?: string; organizationScopeId?: string },
  signal?: AbortSignal,
): Promise<{ version: number; learnings: LearningCandidate[] }> {
  const profile = exactGatewayProfile(profileId);
  const organizationScopeId = context.organizationScopeId ?? spaceIdForProfile(profile);
  if (organizationScopeId !== spaceIdForProfile(profile)) {
    throw new Error("organization connection changed before learning sync; refresh and retry");
  }
  const result = await boundedControlJson(
    `${profile.gatewayUrl}/v1/learnings`,
    profile,
    { method: "GET", signal },
    "organization learning sync",
  );
  if (!sameGatewayIdentity(profile)) {
    throw new Error("organization connection changed during learning sync; refresh and retry");
  }
  const version = result.version;
  const learnings = result.learnings;
  if (
    !Number.isSafeInteger(version)
    || Number(version) < 0
    || !Array.isArray(learnings)
    || learnings.length > 5_000
    || !learnings.every(organizationLearningItem)
  ) {
    throw new Error("organization learning sync response is invalid");
  }
  return {
    version: Number(version),
    learnings: applyOrganizationLearningBundle(
      organizationScopeId,
      Number(version),
      learnings as OrganizationLearningWire[],
      context,
    ),
  };
}
