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

export type MobileCommandReceipt = Readonly<{
  commandId: string;
  expiresAt: number;
  fingerprint: string;
  receipt: Readonly<{
    commandId: string;
    errorCode: string | null;
    schemaVersion: 1;
    status: "accepted" | "succeeded" | "failed";
  }>;
  recordedAt: number;
}>;

export type MobilePublicationCapabilities = Readonly<{
  approve: boolean;
  interrupt: boolean;
  read: boolean;
  submit: boolean;
  terminalControl: boolean;
  terminalObserve: boolean;
}>;

export type MobileSessionPublication = Readonly<{
  capabilities: MobilePublicationCapabilities;
  sessionId: string;
}>;

const READ_ONLY_PUBLICATION: MobilePublicationCapabilities = Object.freeze({
  approve: false,
  interrupt: false,
  read: true,
  submit: false,
  terminalControl: false,
  terminalObserve: false,
});

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
  /** Bounded, content-free command outcomes let Relay redelivery reproduce an acknowledgement without
   * executing terminal input or another side effect twice. Prompts and model/session output never live here. */
  commandReceipts?: readonly MobileCommandReceipt[];
  pairedMobileDevices: readonly PairedMobileDevice[];
  /** Desktop-owned allowlist of provider session IDs that may be projected to paired phones.
   * Kept only to migrate the first publication preview. Legacy entries become read-only. */
  publishedSessionIds?: readonly string[];
  /** Desktop-owned, per-session Mobile grants. Missing means no sessions are published. */
  publishedSessions?: readonly MobileSessionPublication[];
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  /** Cloud Relay delivery progress for this exact Desktop device. It is intentionally unrelated to
   * Hara Serve's local event cursor and contains no message/session payload. */
  relayCursor?: Readonly<{
    sequence: number;
    streamId: string;
  }>;
  schemaVersion: 1;
}>;

const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const identifier = (value: unknown): value is string => bounded(value, 160) && value.trim() === value && !/\s/u.test(value);
const credential = (value: unknown): value is string => bounded(value, 12_000) && /^[A-Za-z0-9._~-]+$/u.test(value);
const accountRefreshToken = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 50 && value.length <= 200 && /^hara_rt_[A-Za-z0-9_-]+$/u.test(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const relayCursor = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return identifier(cursor.streamId)
    && typeof cursor.sequence === "number"
    && Number.isSafeInteger(cursor.sequence)
    && cursor.sequence >= 0;
};

function commandReceipt(value: unknown): value is MobileCommandReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const receipt = entry.receipt as Record<string, unknown> | undefined;
  return Object.keys(entry).every((key) => ["commandId", "expiresAt", "fingerprint", "receipt", "recordedAt"].includes(key))
    && identifier(entry.commandId)
    && timestamp(entry.expiresAt)
    && typeof entry.fingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(entry.fingerprint)
    && timestamp(entry.recordedAt)
    && !!receipt
    && Object.keys(receipt).every((key) => ["commandId", "errorCode", "schemaVersion", "status"].includes(key))
    && receipt.commandId === entry.commandId
    && receipt.schemaVersion === 1
    && ["accepted", "succeeded", "failed"].includes(String(receipt.status))
    && (receipt.errorCode === null || (bounded(receipt.errorCode, 96) && /^[A-Z0-9_]+$/u.test(receipt.errorCode)));
}

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

export function normalizeMobilePublicationCapabilities(
  value: unknown,
): MobilePublicationCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("mobile publication capabilities are invalid");
  }
  const capabilities = value as Record<string, unknown>;
  const keys = [
    "approve",
    "interrupt",
    "read",
    "submit",
    "terminalControl",
    "terminalObserve",
  ];
  if (
    Object.keys(capabilities).length !== keys.length
    || !keys.every((key) => typeof capabilities[key] === "boolean")
    || capabilities.read !== true
    || (capabilities.terminalControl === true && capabilities.terminalObserve !== true)
  ) {
    throw new TypeError("mobile publication capabilities are invalid");
  }
  return Object.freeze({
    approve: capabilities.approve as boolean,
    interrupt: capabilities.interrupt as boolean,
    read: true,
    submit: capabilities.submit as boolean,
    terminalControl: capabilities.terminalControl as boolean,
    terminalObserve: capabilities.terminalObserve as boolean,
  });
}

function mobileSessionPublication(value: unknown): value is MobileSessionPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const publication = value as Record<string, unknown>;
  if (
    Object.keys(publication).length !== 2
    || !identifier(publication.sessionId)
  ) return false;
  try {
    normalizeMobilePublicationCapabilities(publication.capabilities);
    return true;
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
    || (root.publishedSessionIds !== undefined
      && (!Array.isArray(root.publishedSessionIds)
        || root.publishedSessionIds.length > 100
        || !root.publishedSessionIds.every(identifier)
        || new Set(root.publishedSessionIds).size !== root.publishedSessionIds.length))
    || (root.publishedSessions !== undefined
      && (!Array.isArray(root.publishedSessions)
        || root.publishedSessions.length > 100
        || !root.publishedSessions.every(mobileSessionPublication)
        || new Set(root.publishedSessions.map((entry) => (entry as MobileSessionPublication).sessionId)).size !== root.publishedSessions.length))
    || (root.publishedSessionIds !== undefined && root.publishedSessions !== undefined)
    || (root.commandReceipts !== undefined
      && (!Array.isArray(root.commandReceipts)
        || root.commandReceipts.length > 64
        || !root.commandReceipts.every(commandReceipt)
        || new Set(root.commandReceipts.map((entry) => (entry as MobileCommandReceipt).commandId)).size !== root.commandReceipts.length))
    || (root.relayCursor !== undefined && !relayCursor(root.relayCursor))
    || ((root.refreshToken === undefined) !== (root.refreshTokenExpiresAt === undefined))
    || (root.refreshToken !== undefined && !accountRefreshToken(root.refreshToken))
    || (root.refreshTokenExpiresAt !== undefined && !timestamp(root.refreshTokenExpiresAt))
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

export type MobileSessionPublications = Readonly<{
  publications: readonly MobileSessionPublication[];
  protocolVersion: 1;
  sessionIds: readonly string[];
}>;

function publicationSessionId(value: unknown): string {
  if (!identifier(value)) throw new TypeError("mobile publication session ID is invalid");
  return value;
}

export function mobilePublicationEntries(
  state: MobileCompanionState,
): readonly MobileSessionPublication[] {
  if (state.publishedSessions) {
    return Object.freeze(state.publishedSessions.map((publication) => Object.freeze({
      capabilities: normalizeMobilePublicationCapabilities(publication.capabilities),
      sessionId: publication.sessionId,
    })));
  }
  return Object.freeze((state.publishedSessionIds ?? []).map((sessionId) => Object.freeze({
    capabilities: READ_ONLY_PUBLICATION,
    sessionId,
  })));
}

export function mobileSessionPublications(
  path = mobileStatePath(),
): MobileSessionPublications {
  const state = loadMobileState(path);
  if (!state) throw new Error("Hara Mobile Desktop is not signed in");
  const publications = mobilePublicationEntries(state);
  return Object.freeze({
    publications,
    protocolVersion: 1,
    sessionIds: Object.freeze(publications.map((publication) => publication.sessionId)),
  });
}

export function setMobileSessionPublication(
  sessionIdValue: unknown,
  published: boolean,
  path = mobileStatePath(),
): MobileSessionPublications {
  const sessionId = publicationSessionId(sessionIdValue);
  const state = loadMobileState(path);
  if (!state) throw new Error("Hara Mobile Desktop is not signed in");
  const next = new Map(mobilePublicationEntries(state).map((entry) => [entry.sessionId, entry]));
  if (published) {
    if (!next.has(sessionId) && next.size >= 100) {
      throw new Error("at most 100 sessions can be published to Hara Mobile");
    }
    if (!next.has(sessionId)) {
      next.set(sessionId, Object.freeze({
        capabilities: READ_ONLY_PUBLICATION,
        sessionId,
      }));
    }
  } else {
    next.delete(sessionId);
  }
  const updated: MobileCompanionState = {
    ...state,
    publishedSessionIds: undefined,
    publishedSessions: [...next.values()],
  };
  saveMobileState(updated, path);
  return mobileSessionPublications(path);
}

export function configureMobileSessionPublication(
  sessionIdValue: unknown,
  capabilitiesValue: unknown,
  path = mobileStatePath(),
): MobileSessionPublications {
  const sessionId = publicationSessionId(sessionIdValue);
  const capabilities = normalizeMobilePublicationCapabilities(capabilitiesValue);
  const state = loadMobileState(path);
  if (!state) throw new Error("Hara Mobile Desktop is not signed in");
  const next = new Map(mobilePublicationEntries(state).map((entry) => [entry.sessionId, entry]));
  if (!next.has(sessionId) && next.size >= 100) {
    throw new Error("at most 100 sessions can be published to Hara Mobile");
  }
  next.set(sessionId, Object.freeze({ capabilities, sessionId }));
  saveMobileState({
    ...state,
    publishedSessionIds: undefined,
    publishedSessions: [...next.values()],
  }, path);
  return mobileSessionPublications(path);
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
