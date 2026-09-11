import type { DeviceKeyMaterial } from "./security.js";
import {
  publicKeyThumbprint,
  registrationProofPayload,
  signPayload,
} from "./security.js";

const MAX_RESPONSE_CHARACTERS = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 8_000;

export class MobileAccountError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "INPUT_INVALID" | "PAIRING_FAILED" | "SERVICE_UNAVAILABLE") {
    super(code);
    this.name = "MobileAccountError";
  }
}

export type MobileAccountLogin = Readonly<{
  accessToken: string;
  account: Readonly<{ displayName: string; id: string; region: "cn" | "global" }>;
  expiresInSeconds: number;
  refreshExpiresInSeconds: number;
  refreshToken: string;
}>;

export type RegisteredDesktop = Readonly<{
  credential: string;
  deviceId: string;
  expiresInSeconds: number;
}>;

export type PairingChallenge = Readonly<{
  expiresAt: number;
  id: string;
  mobileLabel: string | null;
  mobilePlatform: "ios" | "android" | null;
  mobilePublicKeySpki: string | null;
  mobilePublicKeyThumbprint: string | null;
  pairedDeviceId: string | null;
  sourceDeviceId: string;
  state: "pending" | "claimed" | "approved" | "rejected" | "consumed" | "expired" | "cancelled";
}>;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MobileAccountError("SERVICE_UNAVAILABLE");
  return value as Record<string, unknown>;
};
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const id = (value: unknown): value is string => bounded(value, 160) && value.trim() === value && !/\s/u.test(value);
const token = (value: unknown): value is string => bounded(value, 12_000) && /^[A-Za-z0-9._~-]+$/u.test(value);
const base64url = (value: unknown, max: number): value is string =>
  bounded(value, max) && /^[A-Za-z0-9_-]+$/u.test(value);
const seconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 60 && value <= 3_600;
const refreshSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 60 && value <= 7_776_000;
const refreshToken = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 50 && value.length <= 200 && /^hara_rt_[A-Za-z0-9_-]+$/u.test(value);

function origin(value: string, allowInsecureLoopback: boolean): string {
  const parsed = new URL(value);
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (
    (parsed.protocol !== "https:" && !(allowInsecureLoopback && parsed.protocol === "http:" && loopback.has(parsed.hostname)))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")
  ) throw new TypeError("Account origin must be a credential-free HTTPS origin");
  return parsed.origin;
}

function parseChallenge(value: unknown): PairingChallenge {
  const challenge = record(value);
  const states = new Set(["pending", "claimed", "approved", "rejected", "consumed", "expired", "cancelled"]);
  const mobilePlatform = challenge.mobilePlatform;
  const mobilePublicKeySpki = challenge.mobilePublicKeySpki;
  const mobilePublicKeyThumbprint = challenge.mobilePublicKeyThumbprint;
  const pairedDeviceId = challenge.pairedDeviceId;
  const expiresAt = Date.parse(String(challenge.expiresAt ?? ""));
  const state = String(challenge.state) as PairingChallenge["state"];
  if (
    !id(challenge.id)
    || !id(challenge.sourceDeviceId)
    || !states.has(String(challenge.state))
    || !Number.isFinite(expiresAt)
    || (challenge.mobileLabel !== null && !bounded(challenge.mobileLabel, 120))
    || (mobilePlatform !== null && mobilePlatform !== "ios" && mobilePlatform !== "android")
    || (mobilePublicKeySpki !== null && !base64url(mobilePublicKeySpki, 2_048))
    || (mobilePublicKeyThumbprint !== null
      && (typeof mobilePublicKeyThumbprint !== "string" || !/^[a-f0-9]{64}$/u.test(mobilePublicKeyThumbprint)))
    || (pairedDeviceId !== null && !id(pairedDeviceId))
  ) throw new MobileAccountError("SERVICE_UNAVAILABLE");
  const keyRequired = state === "claimed" || state === "approved" || state === "consumed";
  if (
    (mobilePublicKeySpki === null) !== (mobilePublicKeyThumbprint === null)
    || (keyRequired && (!mobilePublicKeySpki || !mobilePublicKeyThumbprint))
  ) throw new MobileAccountError("SERVICE_UNAVAILABLE");
  if (mobilePublicKeySpki && mobilePublicKeyThumbprint) {
    try {
      if (publicKeyThumbprint(mobilePublicKeySpki) !== mobilePublicKeyThumbprint) {
        throw new MobileAccountError("SERVICE_UNAVAILABLE");
      }
    } catch {
      throw new MobileAccountError("SERVICE_UNAVAILABLE");
    }
  }
  return Object.freeze({
    expiresAt,
    id: challenge.id,
    mobileLabel: challenge.mobileLabel as string | null,
    mobilePlatform: mobilePlatform as "ios" | "android" | null,
    mobilePublicKeySpki: mobilePublicKeySpki as string | null,
    mobilePublicKeyThumbprint: mobilePublicKeyThumbprint as string | null,
    pairedDeviceId: pairedDeviceId as string | null,
    sourceDeviceId: challenge.sourceDeviceId,
    state,
  });
}

export class MobileAccountClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl = "https://api.hara.nanhara.tech",
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    options: Readonly<{ allowInsecureLoopback?: boolean }> = {},
  ) {
    this.baseUrl = origin(baseUrl, options.allowInsecureLoopback === true);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new TypeError("timeoutMs must be from 1000 to 30000");
    }
  }

  private async request(
    path: string,
    options: Readonly<{ accessToken?: string; body?: unknown; method?: "GET" | "POST" }> = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
        },
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        redirect: "error",
        signal: controller.signal,
      });
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_RESPONSE_CHARACTERS) {
        throw new MobileAccountError("SERVICE_UNAVAILABLE");
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARACTERS) throw new MobileAccountError("SERVICE_UNAVAILABLE");
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        throw new MobileAccountError("SERVICE_UNAVAILABLE");
      }
      if (!response.ok) {
        const errorBody = record(body);
        const errorCode = typeof errorBody?.code === "string" ? errorBody.code : "";
        if (response.status === 400) throw new MobileAccountError("INPUT_INVALID");
        if (response.status === 401 || response.status === 403 || errorCode.startsWith("ACCOUNT_AUTH_")) {
          throw new MobileAccountError("AUTH_REQUIRED");
        }
        if (errorCode.startsWith("PAIRING_")) throw new MobileAccountError("PAIRING_FAILED");
        throw new MobileAccountError("SERVICE_UNAVAILABLE");
      }
      return body;
    } catch (error) {
      if (error instanceof MobileAccountError) throw error;
      throw new MobileAccountError("SERVICE_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendSms(phone: string): Promise<number> {
    if (!/^1[3-9][0-9]{9}$/u.test(phone)) throw new MobileAccountError("INPUT_INVALID");
    const response = record(await this.request("/v1/auth/code/send", {
      body: {
        channel: "phone",
        identifier: phone,
        locale: "zh-Hans",
      },
    }));
    if (
      response.protocolVersion !== 1
      || response.accepted !== true
      || typeof response.cooldownSeconds !== "number"
      || !Number.isInteger(response.cooldownSeconds)
      || response.cooldownSeconds < 30
      || response.cooldownSeconds > 300
    ) throw new MobileAccountError("SERVICE_UNAVAILABLE");
    return response.cooldownSeconds;
  }

  async login(phone: string, code: string, platform: "macos" | "windows" | "linux"): Promise<MobileAccountLogin> {
    if (!/^1[3-9][0-9]{9}$/u.test(phone) || !/^[0-9]{6}$/u.test(code)) {
      throw new MobileAccountError("INPUT_INVALID");
    }
    void platform;
    return this.parseLogin(await this.request("/v1/auth/code/login", {
      body: { channel: "phone", code, identifier: phone },
    }));
  }

  private parseLogin(value: unknown): MobileAccountLogin {
    const response = record(value);
    const account = record(response.account);
    if (
      response.protocolVersion !== 1
      || !token(response.accessToken)
      || !seconds(response.expiresInSeconds)
      || !refreshToken(response.refreshToken)
      || !refreshSeconds(response.refreshExpiresInSeconds)
      || !id(account.id)
      || !bounded(account.displayName, 120)
      || (account.region !== "cn" && account.region !== "global")
    ) throw new MobileAccountError("SERVICE_UNAVAILABLE");
    return Object.freeze({
      accessToken: response.accessToken,
      account: {
        displayName: account.displayName,
        id: account.id,
        region: account.region as "cn" | "global",
      },
      expiresInSeconds: response.expiresInSeconds,
      refreshExpiresInSeconds: response.refreshExpiresInSeconds,
      refreshToken: response.refreshToken,
    });
  }

  async refresh(value: string): Promise<MobileAccountLogin> {
    if (!refreshToken(value)) throw new MobileAccountError("INPUT_INVALID");
    return this.parseLogin(await this.request("/v1/auth/refresh", {
      body: { refreshToken: value },
    }));
  }

  async logout(value: string): Promise<void> {
    if (!refreshToken(value)) throw new MobileAccountError("INPUT_INVALID");
    const response = record(await this.request("/v1/auth/logout", {
      body: { refreshToken: value },
    }));
    if (response.protocolVersion !== 1 || response.revoked !== true) {
      throw new MobileAccountError("SERVICE_UNAVAILABLE");
    }
  }

  async registerDesktop(input: Readonly<{
    accessToken: string;
    accountId: string;
    accountRegion: "cn" | "global";
    key: DeviceKeyMaterial;
    platform: "macos" | "windows" | "linux";
  }>): Promise<RegisteredDesktop> {
    const proofSignature = signPayload(
      input.key.privateKeyPem,
      registrationProofPayload({
        accountId: input.accountId,
        accountRegion: input.accountRegion,
        publicKeySpki: input.key.publicKeySpki,
      }),
    );
    const response = record(await this.request("/v1/devices/desktop", {
      accessToken: input.accessToken,
      body: {
        label: "Hara Desktop",
        platform: input.platform,
        proofSignature,
        publicKeySpki: input.key.publicKeySpki,
      },
    }));
    const device = record(response.device);
    if (
      response.protocolVersion !== 1
      || response.deviceCredentialReady !== true
      || !token(response.deviceCredential)
      || !seconds(response.expiresInSeconds)
      || !id(device.id)
      || device.kind !== "desktop"
      || device.platform !== input.platform
    ) throw new MobileAccountError("SERVICE_UNAVAILABLE");
    return Object.freeze({
      credential: response.deviceCredential,
      deviceId: device.id,
      expiresInSeconds: response.expiresInSeconds,
    });
  }

  async renewDesktop(
    accessToken: string,
    deviceId: string,
  ): Promise<RegisteredDesktop> {
    if (!token(accessToken) || !id(deviceId)) {
      throw new MobileAccountError("INPUT_INVALID");
    }
    const response = record(await this.request(
      `/v1/devices/${encodeURIComponent(deviceId)}/credential`,
      { accessToken, method: "POST" },
    ));
    const device = record(response.device);
    if (
      response.protocolVersion !== 1
      || response.deviceCredentialReady !== true
      || !token(response.deviceCredential)
      || !seconds(response.expiresInSeconds)
      || device.id !== deviceId
      || device.kind !== "desktop"
    ) throw new MobileAccountError("SERVICE_UNAVAILABLE");
    return Object.freeze({
      credential: response.deviceCredential,
      deviceId,
      expiresInSeconds: response.expiresInSeconds,
    });
  }

  async createChallenge(accessToken: string, sourceDeviceId: string): Promise<Readonly<{
    challenge: PairingChallenge;
    pairingCode: string;
  }>> {
    const response = record(await this.request("/v1/pairing/challenges", {
      accessToken,
      body: {
        requestedCapabilities: ["read", "submit", "approve", "interrupt", "terminalObserve", "terminalControl"],
        sourceDeviceId,
      },
    }));
    if (response.protocolVersion !== 1 || !bounded(response.pairingCode, 128) || !/^HARA_[A-Za-z0-9_-]+$/u.test(response.pairingCode)) {
      throw new MobileAccountError("SERVICE_UNAVAILABLE");
    }
    return Object.freeze({ challenge: parseChallenge(response.challenge), pairingCode: response.pairingCode });
  }

  async inspectChallenge(accessToken: string, challengeId: string, sourceDeviceId: string): Promise<PairingChallenge> {
    const response = record(await this.request(
      `/v1/pairing/challenges/${encodeURIComponent(challengeId)}?sourceDeviceId=${encodeURIComponent(sourceDeviceId)}`,
      { accessToken },
    ));
    if (response.protocolVersion !== 1) throw new MobileAccountError("SERVICE_UNAVAILABLE");
    return parseChallenge(response.challenge);
  }

  async decideChallenge(
    accessToken: string,
    challengeId: string,
    sourceDeviceId: string,
    approved: boolean,
  ): Promise<PairingChallenge> {
    const response = record(await this.request(
      `/v1/pairing/challenges/${encodeURIComponent(challengeId)}/decision`,
      { accessToken, body: { approved, sourceDeviceId } },
    ));
    if (response.protocolVersion !== 1) throw new MobileAccountError("SERVICE_UNAVAILABLE");
    return parseChallenge(response.challenge);
  }
}
