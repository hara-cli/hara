import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { effectiveHomeDir } from "../runtime.js";
import {
  MobileAccountClient,
  type DesktopAuthorizationChallenge,
} from "./account-client.js";
import { assertDeviceKey, generateDeviceKey, type DeviceKeyMaterial } from "./security.js";
import {
  loadMobileState,
  saveMobileState,
  type MobileCompanionState,
} from "./state.js";

const ACCOUNT_ORIGIN = "https://api.hara.nanhara.tech";
const AUTHORIZATION_CODE = /^HARA_AUTH_[A-Za-z0-9_-]{22,118}$/u;
const POLL_SECRET = /^HARA_DAP_[A-Za-z0-9_-]{32,151}$/u;
const IDENTIFIER = /^[A-Za-z0-9._~-]{1,160}$/u;

export type PendingDesktopAuthorization = Readonly<{
  accountRegion: "cn" | "global";
  authorizationCode: string;
  challengeId: string;
  desktopLabel: string;
  expiresAt: number;
  key: DeviceKeyMaterial;
  platform: "macos" | "windows" | "linux";
  pollSecret: string;
  schemaVersion: 1;
}>;

export type DesktopAuthorizationInvitation = Readonly<{
  accountRegion: "cn" | "global";
  authorizationCode: string;
  challengeId: string;
  desktop: Readonly<{
    label: string;
    platform: "macos" | "windows" | "linux";
    publicKeyThumbprint: string;
  }>;
  expiresAt: number;
  protocolVersion: 1;
  qrPayload: string;
  signedIn: false;
  state: "pending";
}>;

export type DesktopAuthorizationSnapshot = Readonly<{
  account: Readonly<{
    displayName: string;
    region: "cn" | "global";
  }> | null;
  challengeId: string | null;
  desktop: Readonly<{
    label: string;
    platform: "macos" | "windows" | "linux";
    publicKeyThumbprint: string;
  }> | null;
  expiresAt: number | null;
  protocolVersion: 1;
  signedIn: boolean;
  state: DesktopAuthorizationChallenge["state"] | "missing";
}>;

type AuthorizationAccountClient = Pick<
  MobileAccountClient,
  | "createDesktopAuthorization"
  | "exchangeDesktopAuthorization"
  | "inspectDesktopAuthorization"
>;

type DesktopAuthorizationCoordinatorOptions = Readonly<{
  account?: AuthorizationAccountClient;
  accountRegion?: "cn" | "global";
  clearPending?: () => void;
  desktopLabel?: string;
  loadPending?: () => PendingDesktopAuthorization | null;
  loadState?: () => MobileCompanionState | null;
  now?: () => number;
  platform?: "macos" | "windows" | "linux";
  randomKey?: () => DeviceKeyMaterial;
  randomSecret?: () => string;
  savePending?: (state: PendingDesktopAuthorization) => void;
  saveState?: (state: MobileCompanionState) => void;
}>;

function desktopPlatform(): "macos" | "windows" | "linux" {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function normalizedDesktopLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  if (!normalized) throw new TypeError("Desktop label is invalid");
  return normalized;
}

function defaultDesktopLabel(): string {
  const machine = normalizedDesktopLabel(hostname() || "Computer");
  return normalizedDesktopLabel(`Hara Desktop · ${machine}`);
}

function validPending(value: unknown): value is PendingDesktopAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  const key = pending.key as Record<string, unknown> | undefined;
  if (
    pending.schemaVersion !== 1
    || (pending.accountRegion !== "cn" && pending.accountRegion !== "global")
    || typeof pending.authorizationCode !== "string"
    || !AUTHORIZATION_CODE.test(pending.authorizationCode)
    || typeof pending.challengeId !== "string"
    || !IDENTIFIER.test(pending.challengeId)
    || typeof pending.desktopLabel !== "string"
    || normalizedDesktopLabel(pending.desktopLabel) !== pending.desktopLabel
    || !Number.isSafeInteger(pending.expiresAt)
    || (pending.expiresAt as number) <= 0
    || !["macos", "windows", "linux"].includes(String(pending.platform))
    || typeof pending.pollSecret !== "string"
    || !POLL_SECRET.test(pending.pollSecret)
    || !key
    || typeof key.privateKeyPem !== "string"
    || typeof key.publicKeySpki !== "string"
  ) return false;
  try {
    assertDeviceKey({
      privateKeyPem: key.privateKeyPem,
      publicKeySpki: key.publicKeySpki,
    });
    return true;
  } catch {
    return false;
  }
}

export function desktopAuthorizationStatePath(home = effectiveHomeDir()): string {
  return join(home, ".hara", "mobile-desktop-authorization.json");
}

export function loadPendingDesktopAuthorization(
  path = desktopAuthorizationStatePath(),
): PendingDesktopAuthorization | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return null;
    const text = readFileSync(path, "utf8");
    if (text.length > 24_000) return null;
    const parsed: unknown = JSON.parse(text);
    return validPending(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePendingDesktopAuthorization(
  pending: PendingDesktopAuthorization,
  path = desktopAuthorizationStatePath(),
): void {
  if (!validPending(pending)) {
    throw new TypeError("Desktop authorization state is invalid");
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(pending, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearPendingDesktopAuthorization(
  path = desktopAuthorizationStatePath(),
): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) rmSync(path);
  } catch {
    // Missing or unsafe state is already unavailable.
  }
}

export function desktopAuthorizationQrPayload(input: Readonly<{
  authorizationCode: string;
  expiresAt: number;
  region: "cn" | "global";
}>): string {
  if (!AUTHORIZATION_CODE.test(input.authorizationCode)) {
    throw new TypeError("authorizationCode must be a valid Hara one-time code");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new TypeError("expiresAt must be a positive safe integer");
  }
  return `hara://authorize-desktop?v=1&region=${input.region}&code=${input.authorizationCode}&expires=${Math.floor(input.expiresAt / 1_000)}`;
}

function signedInSnapshot(state: MobileCompanionState): DesktopAuthorizationSnapshot {
  return Object.freeze({
    account: Object.freeze({
      displayName: state.account.displayName,
      region: state.account.region,
    }),
    challengeId: null,
    desktop: null,
    expiresAt: null,
    protocolVersion: 1,
    signedIn: true,
    state: "consumed",
  });
}

function pendingSnapshot(
  pending: PendingDesktopAuthorization,
  authorization: DesktopAuthorizationChallenge,
): DesktopAuthorizationSnapshot {
  return Object.freeze({
    account: null,
    challengeId: pending.challengeId,
    desktop: authorization.desktop,
    expiresAt: authorization.expiresAt,
    protocolVersion: 1,
    signedIn: false,
    state: authorization.state,
  });
}

/**
 * A signed-in phone can authorize this unsigned Desktop and establish the first same-account pairing.
 * Secrets and tokens remain in Core-owned 0600 files; Desktop receives only the public QR and redacted state.
 */
export class MobileDesktopAuthorizationCoordinator {
  private readonly account: AuthorizationAccountClient;
  private readonly accountRegion: "cn" | "global";
  private readonly clearPending: () => void;
  private readonly desktopLabel: string;
  private readonly loadPending: () => PendingDesktopAuthorization | null;
  private readonly loadState: () => MobileCompanionState | null;
  private readonly now: () => number;
  private readonly platform: "macos" | "windows" | "linux";
  private readonly randomKey: () => DeviceKeyMaterial;
  private readonly randomSecret: () => string;
  private readonly savePending: (state: PendingDesktopAuthorization) => void;
  private readonly saveState: (state: MobileCompanionState) => void;

  constructor(options: DesktopAuthorizationCoordinatorOptions = {}) {
    this.account = options.account ?? new MobileAccountClient(ACCOUNT_ORIGIN);
    this.accountRegion = options.accountRegion ?? "cn";
    this.clearPending = options.clearPending ?? (() => clearPendingDesktopAuthorization());
    this.desktopLabel = normalizedDesktopLabel(
      options.desktopLabel ?? defaultDesktopLabel(),
    );
    this.loadPending = options.loadPending ?? (() => loadPendingDesktopAuthorization());
    this.loadState = options.loadState ?? (() => loadMobileState());
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? desktopPlatform();
    this.randomKey = options.randomKey ?? generateDeviceKey;
    this.randomSecret = options.randomSecret
      ?? (() => `HARA_DAP_${randomBytes(32).toString("base64url")}`);
    this.savePending = options.savePending
      ?? ((state) => savePendingDesktopAuthorization(state));
    this.saveState = options.saveState ?? ((state) => saveMobileState(state));
  }

  async create(): Promise<DesktopAuthorizationInvitation> {
    if (this.loadState()) {
      throw new Error("Hara Desktop is already signed in");
    }
    const existing = this.loadPending();
    if (existing && existing.expiresAt > this.now()) {
      const authorization = await this.account.inspectDesktopAuthorization({
        accountRegion: existing.accountRegion,
        challengeId: existing.challengeId,
        key: existing.key,
        pollSecret: existing.pollSecret,
      });
      if (authorization.state === "pending") {
        return this.invitation(existing, authorization);
      }
      if (authorization.state === "approved" || authorization.state === "consumed") {
        await this.status();
        throw new Error("Hara Desktop is already signed in");
      }
    }
    this.clearPending();
    const key = this.randomKey();
    assertDeviceKey(key);
    const pollSecret = this.randomSecret();
    if (!POLL_SECRET.test(pollSecret)) {
      throw new TypeError("Desktop authorization poll secret is invalid");
    }
    const created = await this.account.createDesktopAuthorization({
      accountRegion: this.accountRegion,
      desktopLabel: this.desktopLabel,
      key,
      platform: this.platform,
      pollSecret,
    });
    if (created.authorization.expiresAt <= this.now()) {
      throw new Error("Account returned an expired Desktop authorization");
    }
    const pending: PendingDesktopAuthorization = Object.freeze({
      accountRegion: this.accountRegion,
      authorizationCode: created.authorizationCode,
      challengeId: created.authorization.id,
      desktopLabel: this.desktopLabel,
      expiresAt: created.authorization.expiresAt,
      key,
      platform: this.platform,
      pollSecret,
      schemaVersion: 1,
    });
    this.savePending(pending);
    return this.invitation(pending, created.authorization);
  }

  private invitation(
    pending: PendingDesktopAuthorization,
    authorization: DesktopAuthorizationChallenge,
  ): DesktopAuthorizationInvitation {
    if (
      authorization.id !== pending.challengeId
      || authorization.state !== "pending"
      || authorization.desktop.label !== pending.desktopLabel
      || authorization.desktop.platform !== pending.platform
    ) throw new Error("Account returned another Desktop authorization identity");
    return Object.freeze({
      accountRegion: pending.accountRegion,
      authorizationCode: pending.authorizationCode,
      challengeId: pending.challengeId,
      desktop: authorization.desktop,
      expiresAt: authorization.expiresAt,
      protocolVersion: 1,
      qrPayload: desktopAuthorizationQrPayload({
        authorizationCode: pending.authorizationCode,
        expiresAt: authorization.expiresAt,
        region: pending.accountRegion,
      }),
      signedIn: false,
      state: "pending",
    });
  }

  async status(): Promise<DesktopAuthorizationSnapshot> {
    const signedIn = this.loadState();
    if (signedIn) {
      this.clearPending();
      return signedInSnapshot(signedIn);
    }
    const pending = this.loadPending();
    if (!pending) {
      return Object.freeze({
        account: null,
        challengeId: null,
        desktop: null,
        expiresAt: null,
        protocolVersion: 1,
        signedIn: false,
        state: "missing",
      });
    }
    if (pending.expiresAt <= this.now()) {
      this.clearPending();
      return Object.freeze({
        account: null,
        challengeId: pending.challengeId,
        desktop: null,
        expiresAt: pending.expiresAt,
        protocolVersion: 1,
        signedIn: false,
        state: "expired",
      });
    }
    const authorization = await this.account.inspectDesktopAuthorization({
      accountRegion: pending.accountRegion,
      challengeId: pending.challengeId,
      key: pending.key,
      pollSecret: pending.pollSecret,
    });
    if (
      authorization.id !== pending.challengeId
      || authorization.desktop.label !== pending.desktopLabel
      || authorization.desktop.platform !== pending.platform
    ) throw new Error("Account returned another Desktop authorization identity");
    if (authorization.state === "pending") {
      return pendingSnapshot(pending, authorization);
    }
    if (authorization.state === "expired" || authorization.state === "cancelled") {
      this.clearPending();
      return pendingSnapshot(pending, authorization);
    }
    const exchanged = await this.account.exchangeDesktopAuthorization({
      accountRegion: pending.accountRegion,
      challengeId: pending.challengeId,
      key: pending.key,
      platform: pending.platform,
      pollSecret: pending.pollSecret,
    });
    if (exchanged.account.region !== pending.accountRegion) {
      throw new Error("Hara account region changed during Desktop authorization");
    }
    if (this.loadState()) {
      throw new Error("Hara Desktop sign-in state changed during phone authorization");
    }
    const observedAt = this.now();
    const state: MobileCompanionState = {
      accessToken: exchanged.accessToken,
      accessTokenExpiresAt: observedAt + exchanged.expiresInSeconds * 1_000,
      account: exchanged.account,
      desktop: {
        credential: exchanged.desktopCredential,
        credentialExpiresAt:
          observedAt + exchanged.desktopCredentialExpiresInSeconds * 1_000,
        id: exchanged.desktopDeviceId,
        key: pending.key,
        platform: pending.platform,
      },
      pairedMobileDevices: [exchanged.pairedMobileDevice],
      publishedSessions: [],
      refreshToken: exchanged.refreshToken,
      refreshTokenExpiresAt:
        observedAt + exchanged.refreshExpiresInSeconds * 1_000,
      schemaVersion: 1,
    };
    this.saveState(state);
    this.clearPending();
    return signedInSnapshot(state);
  }
}
