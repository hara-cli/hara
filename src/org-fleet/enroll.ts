// B-end device enrollment (the OSS client side of the fleet/control-plane story). A hara device joins a
// fleet by exchanging a one-time enrollment code for a scoped, revocable DEVICE TOKEN — it never holds the
// real provider key (that stays at the gateway). hara then points its OpenAI-compatible calls at the
// gateway, which validates the token, maps it to an upstream key, and proxies. Heartbeats give the control
// plane fleet visibility. Token + endpoint live in ~/.hara/org.json (0600).
//
// Protocol (what `hara-control` implements on the other end):
//   POST {gateway}/v1/enroll      {code, device:{name,os,hara_version}} -> {device_token, device_id, model, base_url?}
//   POST {gateway}/v1/heartbeat   Bearer <device_token> {device_id, name, os, hara_version} -> 200/204
//   GET  {gateway}/v1/roles       Bearer <device_token> -> {version, org_policy, roles:[…]}  (B3 digital-employee push-down)
//   POST {gateway}/v1/chat/completions  (OpenAI-compatible; the normal agent traffic, Bearer <device_token>)
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { orgRolesDir } from "../org/roles.js";
import { loadActiveProfile, upsertProfile, useProfile, getProfile, DEFAULT_ORG_ID } from "../profile/profile.js";
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
}

const deviceInfo = (): { name: string; os: string; hara_version: string } => ({ name: hostname(), os: platform(), hara_version: process.env.HARA_BUILD_VERSION ?? "dev" });

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
  const deviceToken = (j.device_token ?? j.deviceToken) as string | undefined;
  if (!deviceToken) throw new Error("enroll response missing device_token");
  return {
    gatewayUrl: gatewayUrl.replace(/\/$/, ""),
    deviceToken,
    deviceId: String(j.device_id ?? j.deviceId ?? ""),
    model: String(j.model ?? ""),
    baseURL: (j.base_url ?? j.baseURL) as string | undefined,
    enrolledAt: now,
  };
}

/** Exchange a one-time code for a device token at the gateway, persist it, and return the Enrollment. */
export async function enrollDevice(gatewayUrl: string, code: string, signal?: AbortSignal): Promise<Enrollment> {
  const base = gatewayUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/enroll`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device: deviceInfo() }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " — bad or expired code" : ""}: ${(await res.text()).slice(0, 200)}`);
  const e = parseEnrollResponse(base, (await res.json()) as Record<string, unknown>, new Date().toISOString());
  saveEnrollment(e);
  return e;
}

/** Best-effort heartbeat so the control plane shows this device online. Never throws. */
export async function heartbeat(signal?: AbortSignal): Promise<boolean> {
  const e = loadEnrollment();
  if (!e) return false;
  try {
    const res = await fetch(`${e.gatewayUrl}/v1/heartbeat`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${e.deviceToken}` },
      body: JSON.stringify({ device_id: e.deviceId, ...deviceInfo() }),
    });
    return res.ok;
  } catch {
    return false;
  }
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
