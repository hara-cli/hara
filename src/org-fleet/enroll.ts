// B-end device enrollment (the OSS client side of the fleet/control-plane story). A hara device joins a
// fleet by exchanging a one-time enrollment code for a scoped, revocable DEVICE TOKEN — it never holds the
// real provider key (that stays at the gateway). hara then points its OpenAI-compatible calls at the
// gateway, which validates the token, maps it to an upstream key, and proxies. Heartbeats give the control
// plane fleet visibility. Token + endpoint live in ~/.hara/org.json (0600).
//
// Protocol (what `hara-control` implements on the other end):
//   POST {gateway}/v1/enroll      {code, device:{name,os,hara_version}} -> {device_token, device_id, model, base_url?, expires_at?}
//   POST {gateway}/v1/heartbeat   Bearer <device_token> {device_id, name, os, hara_version} -> 200/204
//   GET  {gateway}/v1/roles       Bearer <device_token> -> {version, org_policy, roles:[…]}  (B3 digital-employee push-down)
//   POST {gateway}/v1/chat/completions  (OpenAI-compatible; the normal agent traffic, Bearer <device_token>)
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { orgRolesDir } from "../org/roles.js";
import {
  loadActiveProfile,
  upsertProfile,
  useProfile,
  getProfile,
  DEFAULT_ORG_ID,
  type Profile,
} from "../profile/profile.js";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  writePrivateStateFileSync,
} from "../security/private-state.js";

export interface Enrollment {
  gatewayUrl: string; // e.g. https://hara-gw.acme.internal  (no trailing slash)
  deviceToken: string; // scoped + revocable; issued by hara-control, NOT a provider key
  deviceId: string;
  model: string; // default model the gateway routes to ("" = gateway decides)
  baseURL?: string; // explicit OpenAI-compatible base; defaults to <gatewayUrl>/v1
  enrolledAt: string;
  /** Device-token expiry shared by Hara Control and the model gateway. Missing on legacy servers. */
  expiresAt?: string;
}

export interface GatewayProfileEnrollmentInput {
  id: string;
  label?: string;
  gatewayUrl: string;
  code: string;
  activate?: boolean;
}

const MAX_ENROLL_RESPONSE_BYTES = 1024 * 1024;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
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
  if (!PROFILE_ID.test(id)) throw new Error("connection id must use 1-64 letters, numbers, dots, underscores, or dashes");
  if (id === "personal") throw new Error("the personal profile id is reserved");
  if (label && (label.length > 80 || CONTROL_CHARACTERS.test(label))) throw new Error("organization name must be 80 characters or fewer");
  if (!code || code.length > 256 || CONTROL_CHARACTERS.test(code)) throw new Error("registration code must be 1-256 printable characters");
  return { ...input, id, ...(label ? { label } : {}), gatewayUrl: normalizeGatewayUrl(input.gatewayUrl), code };
}

/** The effective OpenAI-compatible base URL for an enrollment (explicit, else <gatewayUrl>/v1). */
export function gatewayBaseURL(e: Enrollment): string {
  return e.baseURL || `${e.gatewayUrl.replace(/\/$/, "")}/v1`;
}

export function loadEnrollment(): Enrollment | null {
  // 1) Legacy storage (~/.hara/org.json) for back-compat with pre-profile builds. After the
  //    profile migration runs (lazily on any profile.ts read), org.json is renamed to .legacy
  //    so this branch only fires for users who never touched the new profile layer yet.
  try {
    const binding = bindPrivateHaraStateFile(homedir(), [], "org.json");
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, 1024 * 1024);
    const e = snapshot ? JSON.parse(snapshot.text) as Enrollment : null;
    if (e && typeof e === "object" && e.gatewayUrl && e.deviceToken) return e;
  } catch {
    /* fall through to profile-derived */
  }
  // 2) Active-profile path. profile.ts doesn't import enroll.ts so this static import is safe.
  try {
    const ap = loadActiveProfile();
    if (ap.kind === "gateway" && ap.gatewayUrl && ap.deviceToken) {
      return {
        gatewayUrl: ap.gatewayUrl,
        deviceToken: ap.deviceToken,
        deviceId: ap.deviceId || "",
        model: ap.defaultModel || "",
        baseURL: ap.baseURL,
        enrolledAt: ap.enrolledAt || new Date().toISOString(),
        expiresAt: ap.tokenExpiresAt,
      };
    }
  } catch {
    /* not yet migrated */
  }
  return null;
}

function saveEnrollment(e: Enrollment): void {
  const binding = bindPrivateHaraStateFile(homedir(), [], "org.json");
  writePrivateStateFileSync(binding, JSON.stringify(e, null, 2) + "\n");
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
  if (typeof rawDeviceId !== "string" || rawDeviceId.length > 256 || CONTROL_CHARACTERS.test(rawDeviceId)) {
    throw new Error("enroll response contains an invalid device_id");
  }
  if (typeof rawModel !== "string" || rawModel.length > 512 || CONTROL_CHARACTERS.test(rawModel)) {
    throw new Error("enroll response contains an invalid model");
  }
  const rawExpiresAt = j.expires_at ?? j.expiresAt;
  let expiresAt: string | undefined;
  if (rawExpiresAt !== undefined && rawExpiresAt !== null) {
    if (typeof rawExpiresAt !== "string" || !Number.isFinite(Date.parse(rawExpiresAt))) {
      throw new Error("enroll response contains an invalid expires_at");
    }
    expiresAt = new Date(rawExpiresAt).toISOString();
  }
  return {
    gatewayUrl: normalizeGatewayUrl(gatewayUrl),
    deviceToken,
    deviceId: rawDeviceId,
    model: rawModel,
    baseURL: normalizeGatewayBaseUrl(j.base_url ?? j.baseURL),
    enrolledAt: now,
    expiresAt,
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
    res = await fetch(`${base}/v1/enroll`, {
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
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ENROLL_RESPONSE_BYTES) {
    throw new Error("enroll response is too large");
  }
  const raw = await res.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_ENROLL_RESPONSE_BYTES) throw new Error("enroll response is too large");
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
    label: label || id,
    gatewayUrl: e.gatewayUrl,
    deviceId: e.deviceId,
    deviceToken: e.deviceToken,
    baseURL: e.baseURL,
    defaultModel: e.model || "",
    availableModels: e.model ? [e.model] : [],
    enrolledAt: e.enrolledAt,
    tokenExpiresAt: e.expiresAt,
  };
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
  const profile = gatewayProfileFromEnrollment(validated.id, validated.label, enrollment);
  upsertProfile(profile);
  if (validated.activate !== false) {
    const switched = useProfile(validated.id);
    if (!switched.ok) throw new Error("organization connection was saved but could not be activated");
  }
  return { enrollment, heartbeatOk: await heartbeatEnrollment(enrollment, signal) };
}

export function enrollmentFromProfile(profile: Profile): Enrollment | null {
  if (profile.kind !== "gateway" || !profile.gatewayUrl || !profile.deviceToken) return null;
  return {
    gatewayUrl: profile.gatewayUrl,
    deviceToken: profile.deviceToken,
    deviceId: profile.deviceId || "",
    model: profile.defaultModel || "",
    baseURL: profile.baseURL,
    enrolledAt: profile.enrolledAt || new Date(0).toISOString(),
    expiresAt: profile.tokenExpiresAt,
  };
}

export async function heartbeatEnrollment(e: Enrollment, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${e.gatewayUrl}/v1/heartbeat`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${e.deviceToken}` },
      body: JSON.stringify({ device_id: e.deviceId, ...deviceInfo() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Best-effort heartbeat so the control plane shows this device online. Never throws. */
export async function heartbeat(signal?: AbortSignal): Promise<boolean> {
  const e = loadEnrollment();
  if (!e) return false;
  return heartbeatEnrollment(e, signal);
}

// ── B3: org role bundle push-down ────────────────────────────────────────────────────────────────
// The control plane resolves which digital-employee roles this device's person/team should run, governs
// them (model/tool/approval floors), and serves them at GET /v1/roles. Wire types are snake_case (server
// convention); we map them to the camelCase frontmatter keys the CLI role loader expects.

export interface BundleRole {
  name: string;
  description?: string;
  owns?: string[];
  rejects?: string[];
  model?: string;
  allow_tools?: string[];
  deny_tools?: string[];
  system: string;
}
export interface RoleBundle {
  version?: number;
  org_policy?: Record<string, unknown>;
  roles?: BundleRole[];
}

const SAFE_ORG_ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function isSafeBundleRole(value: unknown): value is BundleRole {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value as Record<string, unknown>;
  if (
    typeof role.name !== "string" || !SAFE_ORG_ROLE_NAME.test(role.name) || WINDOWS_RESERVED_NAME.test(role.name) ||
    typeof role.system !== "string" || !role.system.trim()
  ) return false;
  for (const key of ["description", "model"] as const) {
    if (role[key] !== undefined && typeof role[key] !== "string") return false;
  }
  for (const key of ["owns", "rejects", "allow_tools", "deny_tools"] as const) {
    if (role[key] !== undefined && (!Array.isArray(role[key]) || !(role[key] as unknown[]).every((item) => typeof item === "string"))) return false;
  }
  return true;
}

/** Render one bundle role into the markdown frontmatter the CLI role loader expects
 *  (src/org/roles.ts parseFrontmatter): name/description/owns/rejects/model/allowTools/denyTools, body=system. */
function renderRoleMd(r: BundleRole): string {
  const fm: string[] = ["---", `name: ${r.name}`];
  if (r.description) fm.push(`description: ${r.description}`);
  if (r.owns?.length) fm.push(`owns: [${r.owns.join(", ")}]`);
  if (r.rejects?.length) fm.push(`rejects: [${r.rejects.join(", ")}]`);
  if (r.model) fm.push(`model: ${r.model}`);
  if (r.allow_tools?.length) fm.push(`allowTools: [${r.allow_tools.join(", ")}]`); // snake_case wire → camelCase fm
  if (r.deny_tools?.length) fm.push(`denyTools: [${r.deny_tools.join(", ")}]`);
  fm.push("---", "", (r.system || "").trim(), "");
  return fm.join("\n");
}

/** Pull this device's governed role bundle from the control plane and materialize it into
 *  `~/.hara/org-roles/*.md` — a managed precedence layer below the dev's own global/project roles
 *  (see src/org/roles.ts loadRoles). The org bundle is AUTHORITATIVE: the dir is wiped and rewritten on
 *  every sync, so a server-side revoke/rename actually removes the local role. Best-effort: never throws;
 *  returns the count of roles written (0 on any failure / not enrolled / empty bundle). */
export async function syncOrgRoles(signal?: AbortSignal): Promise<number> {
  const e = loadEnrollment();
  if (!e) return 0;
  try {
    const res = await fetch(`${e.gatewayUrl}/v1/roles`, { signal, headers: { authorization: `Bearer ${e.deviceToken}` } });
    if (!res.ok) return 0;
    const bundle = (await res.json()) as RoleBundle;
    const roles = Array.isArray(bundle.roles)
      ? [...new Map(bundle.roles.filter(isSafeBundleRole).map((role) => [role.name, role])).values()]
      : [];
    const dir = orgRolesDir();
    rmSync(dir, { recursive: true, force: true }); // authoritative replace
    mkdirSync(dir, { recursive: true });
    const root = resolve(dir);
    for (const r of roles) {
      const target = resolve(root, `${r.name}.md`);
      if (dirname(target) !== root) continue;
      writeFileSync(target, renderRoleMd(r), "utf8");
    }
    // org policy sidecar (model/tool/approval floors the CLI enforces; skipped by the .md-only role loader)
    writeFileSync(join(dir, "_policy.json"), JSON.stringify({ version: bundle.version ?? 0, org_policy: bundle.org_policy ?? {} }, null, 2) + "\n", "utf8");
    return roles.length;
  } catch {
    return 0;
  }
}
