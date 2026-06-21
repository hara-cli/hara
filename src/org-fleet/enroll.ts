// B-end device enrollment (the OSS client side of the fleet/control-plane story). A hara device joins a
// fleet by exchanging a one-time enrollment code for a scoped, revocable DEVICE TOKEN — it never holds the
// real provider key (that stays at the gateway). hara then points its OpenAI-compatible calls at the
// gateway, which validates the token, maps it to an upstream key, and proxies. Heartbeats give the control
// plane fleet visibility. Token + endpoint live in ~/.hara/org.json (0600).
//
// Protocol (what `hara-control` implements on the other end):
//   POST {gateway}/v1/enroll      {code, device:{name,os,hara_version}} -> {device_token, device_id, model, base_url?}
//   POST {gateway}/v1/heartbeat   Bearer <device_token> {device_id, name, os, hara_version} -> 200/204
//   POST {gateway}/v1/chat/completions  (OpenAI-compatible; the normal agent traffic, Bearer <device_token>)
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";

export interface Enrollment {
  gatewayUrl: string; // e.g. https://hara-gw.acme.internal  (no trailing slash)
  deviceToken: string; // scoped + revocable; issued by hara-control, NOT a provider key
  deviceId: string;
  model: string; // default model the gateway routes to ("" = gateway decides)
  baseURL?: string; // explicit OpenAI-compatible base; defaults to <gatewayUrl>/v1
  enrolledAt: string;
}

const orgPath = (): string => join(homedir(), ".hara", "org.json");
const deviceInfo = (): { name: string; os: string; hara_version: string } => ({ name: hostname(), os: platform(), hara_version: process.env.HARA_BUILD_VERSION ?? "dev" });

/** The effective OpenAI-compatible base URL for an enrollment (explicit, else <gatewayUrl>/v1). */
export function gatewayBaseURL(e: Enrollment): string {
  return e.baseURL || `${e.gatewayUrl.replace(/\/$/, "")}/v1`;
}

export function loadEnrollment(): Enrollment | null {
  const p = orgPath();
  if (!existsSync(p)) return null;
  try {
    const e = JSON.parse(readFileSync(p, "utf8")) as Enrollment;
    return e && typeof e === "object" && e.gatewayUrl && e.deviceToken ? e : null;
  } catch {
    return null;
  }
}

function saveEnrollment(e: Enrollment): void {
  mkdirSync(join(homedir(), ".hara"), { recursive: true });
  writeFileSync(orgPath(), JSON.stringify(e, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); // holds a device token → 0600
  try {
    chmodSync(orgPath(), 0o600);
  } catch {
    /* best-effort */
  }
}

export function clearEnrollment(): boolean {
  if (!existsSync(orgPath())) return false;
  rmSync(orgPath());
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
