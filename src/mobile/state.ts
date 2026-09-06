import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { effectiveHomeDir } from "../runtime.js";
import {
  assertDeviceKey,
  publicKeyThumbprint,
  type DeviceKeyMaterial,
} from "./security.js";

export type PairedMobileDevice = Readonly<{
  id: string;
  publicKeySpki: string;
  publicKeyThumbprint: string;
}>;

export type MobileCompanionState = Readonly<{
  accessToken: string;
  accessTokenExpiresAt: number;
  account: Readonly<{
    displayName: string;
    id: string;
    region: "cn" | "global";
  }>;
  desktop: Readonly<{
    credential: string;
    credentialExpiresAt: number;
    id: string;
    key: DeviceKeyMaterial;
    platform: "macos" | "windows" | "linux";
  }>;
  pairedMobileDevices: readonly PairedMobileDevice[];
  schemaVersion: 1;
}>;

const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const identifier = (value: unknown): value is string => bounded(value, 160) && value.trim() === value && !/\s/u.test(value);
const credential = (value: unknown): value is string => bounded(value, 12_000) && /^[A-Za-z0-9._~-]+$/u.test(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function pairedMobileDevice(value: unknown): value is PairedMobileDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  if (
    !identifier(device.id)
    || !bounded(device.publicKeySpki, 2_048)
    || !/^[A-Za-z0-9_-]+$/u.test(device.publicKeySpki)
    || typeof device.publicKeyThumbprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(device.publicKeyThumbprint)
  ) return false;
  try {
    return publicKeyThumbprint(device.publicKeySpki) === device.publicKeyThumbprint;
  } catch {
    return false;
  }
}

export function mobileStatePath(home = effectiveHomeDir()): string {
  return join(home, ".hara", "mobile-companion.json");
}

export function parseMobileState(value: unknown): MobileCompanionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const account = root.account as Record<string, unknown> | undefined;
  const desktop = root.desktop as Record<string, unknown> | undefined;
  const key = desktop?.key as Record<string, unknown> | undefined;
  if (
    root.schemaVersion !== 1
    || !credential(root.accessToken)
    || !timestamp(root.accessTokenExpiresAt)
    || !account
    || !identifier(account.id)
    || !bounded(account.displayName, 120)
    || (account.region !== "cn" && account.region !== "global")
    || !desktop
    || !identifier(desktop.id)
    || !credential(desktop.credential)
    || !timestamp(desktop.credentialExpiresAt)
    || !["macos", "windows", "linux"].includes(String(desktop.platform))
    || !key
    || !bounded(key.privateKeyPem, 8_192)
    || !bounded(key.publicKeySpki, 2_048)
    || !Array.isArray(root.pairedMobileDevices)
    || root.pairedMobileDevices.length > 20
    || !root.pairedMobileDevices.every(pairedMobileDevice)
    || new Set(root.pairedMobileDevices.map((device) => (device as PairedMobileDevice).id)).size !== root.pairedMobileDevices.length
  ) return null;
  try {
    assertDeviceKey({
      privateKeyPem: key.privateKeyPem as string,
      publicKeySpki: key.publicKeySpki as string,
    });
  } catch {
    return null;
  }
  return value as MobileCompanionState;
}

export function loadMobileState(path = mobileStatePath()): MobileCompanionState | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null;
    const text = readFileSync(path, "utf8");
    if (text.length > 40_000) return null;
    return parseMobileState(JSON.parse(text));
  } catch {
    return null;
  }
}

export function saveMobileState(state: MobileCompanionState, path = mobileStatePath()): void {
  if (!parseMobileState(state)) throw new TypeError("mobile companion state is invalid");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearMobileState(path = mobileStatePath()): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path);
  } catch {
    // Missing or unsafe state already behaves as signed out.
  }
}
