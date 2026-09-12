import { MobileAccountClient, type PairingChallenge } from "./account-client.js";
import {
  loadMobileState,
  saveMobileState,
  type MobileCompanionState,
} from "./state.js";

const ACCOUNT_ORIGIN = "https://api.hara.nanhara.tech";
const PAIRING_CODE = /^HARA_[A-Za-z0-9_-]{11,123}$/u;
const CHALLENGE_ID = /^[A-Za-z0-9._~-]{1,160}$/u;

export type MobileCompanionStatus = Readonly<{
  account: Readonly<{
    displayName: string;
    region: "cn" | "global";
  }> | null;
  accountSession: "active" | "expired" | "missing";
  desktopCredential: "active" | "expired" | "missing";
  pairedMobileDevices: number;
  signedIn: boolean;
}>;

export type MobilePairingInvitation = Readonly<{
  accountRegion: "cn" | "global";
  challengeId: string;
  expiresAt: number;
  pairingCode: string;
  protocolVersion: 1;
  qrPayload: string;
  state: PairingChallenge["state"];
}>;

export type MobilePairingSnapshot = Readonly<{
  challengeId: string;
  expiresAt: number;
  mobile: Readonly<{
    label: string;
    platform: "ios" | "android";
    publicKeyThumbprint: string;
  }> | null;
  pairedDeviceId: string | null;
  state: PairingChallenge["state"];
}>;

type AccountClient = Pick<
  MobileAccountClient,
  "createChallenge" | "decideChallenge" | "inspectChallenge" | "refresh" | "renewDesktop"
>;

type MobilePairingCoordinatorOptions = Readonly<{
  account?: AccountClient;
  loadState?: () => MobileCompanionState | null;
  now?: () => number;
  saveState?: (state: MobileCompanionState) => void;
}>;

type ReviewedMobileIdentity = Readonly<{
  label: string;
  platform: "ios" | "android";
  publicKeySpki: string;
  publicKeyThumbprint: string;
}>;

function requireChallengeId(value: unknown): string {
  if (typeof value !== "string" || !CHALLENGE_ID.test(value)) {
    throw new TypeError("challengeId must be a bounded identifier");
  }
  return value;
}

function invitationPayload(input: Readonly<{
  pairingCode: string;
  region: "cn" | "global";
  expiresAt: number;
}>): string {
  if (!PAIRING_CODE.test(input.pairingCode)) {
    throw new TypeError("pairingCode must be a valid Hara one-time code");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new TypeError("expiresAt must be a positive safe integer");
  }
  const expires = Math.floor(input.expiresAt / 1_000);
  return `hara://pair?v=1&region=${input.region}&code=${input.pairingCode}&expires=${expires}`;
}

export function mobilePairingQrPayload(input: Readonly<{
  pairingCode: string;
  region: "cn" | "global";
  expiresAt: number;
}>): string {
  return invitationPayload(input);
}

function snapshot(challenge: PairingChallenge): MobilePairingSnapshot {
  const mobile = challenge.mobileLabel
    && challenge.mobilePlatform
    && challenge.mobilePublicKeyThumbprint
    ? Object.freeze({
        label: challenge.mobileLabel,
        platform: challenge.mobilePlatform,
        publicKeyThumbprint: challenge.mobilePublicKeyThumbprint,
      })
    : null;
  return Object.freeze({
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt,
    mobile,
    pairedDeviceId: challenge.pairedDeviceId,
    state: challenge.state,
  });
}

/**
 * Account/device pairing control plane shared by the CLI and authenticated Desktop Serve clients.
 * Raw Account tokens and private device keys stay in the private state file and never enter an RPC DTO.
 */
export class MobilePairingCoordinator {
  private readonly account: AccountClient;
  private readonly loadState: () => MobileCompanionState | null;
  private readonly now: () => number;
  private readonly reviewedClaims = new Map<string, ReviewedMobileIdentity>();
  private readonly saveState: (state: MobileCompanionState) => void;

  constructor(options: MobilePairingCoordinatorOptions = {}) {
    this.account = options.account ?? new MobileAccountClient(ACCOUNT_ORIGIN);
    this.loadState = options.loadState ?? (() => loadMobileState());
    this.now = options.now ?? Date.now;
    this.saveState = options.saveState ?? ((state) => saveMobileState(state));
  }

  status(): MobileCompanionStatus {
    const state = this.loadState();
    if (!state) {
      return Object.freeze({
        account: null,
        accountSession: "missing",
        desktopCredential: "missing",
        pairedMobileDevices: 0,
        signedIn: false,
      });
    }
    const now = this.now();
    return Object.freeze({
      account: Object.freeze({
        displayName: state.account.displayName,
        region: state.account.region,
      }),
      accountSession: state.accessTokenExpiresAt > now ? "active" : "expired",
      desktopCredential: state.desktop.credentialExpiresAt > now ? "active" : "expired",
      pairedMobileDevices: state.pairedMobileDevices.length,
      signedIn: true,
    });
  }

  private async refreshedState(): Promise<MobileCompanionState> {
    const stored = this.loadState();
    if (!stored) {
      throw new Error("Hara Desktop is not signed in to a Hara account");
    }
    let current = stored;
    const now = this.now();
    if (current.accessTokenExpiresAt <= now + 60_000) {
      if (
        !current.refreshToken
        || !current.refreshTokenExpiresAt
        || current.refreshTokenExpiresAt <= now + 60_000
      ) {
        throw new Error("Hara account session expired; sign in again before pairing");
      }
      const refreshed = await this.account.refresh(current.refreshToken);
      if (
        refreshed.account.id !== current.account.id
        || refreshed.account.region !== current.account.region
      ) {
        throw new Error("Hara account identity changed during refresh; sign in again");
      }
      const observedAt = this.now();
      current = {
        ...current,
        accessToken: refreshed.accessToken,
        accessTokenExpiresAt: observedAt + refreshed.expiresInSeconds * 1_000,
        account: refreshed.account,
        refreshToken: refreshed.refreshToken,
        refreshTokenExpiresAt: observedAt + refreshed.refreshExpiresInSeconds * 1_000,
      };
      this.saveState(current);
    }
    if (current.desktop.credentialExpiresAt > this.now() + 60_000) return current;
    const desktop = await this.account.renewDesktop(
      current.accessToken,
      current.desktop.id,
    );
    const next: MobileCompanionState = {
      ...current,
      desktop: {
        ...current.desktop,
        credential: desktop.credential,
        credentialExpiresAt: this.now() + desktop.expiresInSeconds * 1_000,
        id: desktop.deviceId,
      },
    };
    this.saveState(next);
    return next;
  }

  async create(): Promise<MobilePairingInvitation> {
    const state = await this.refreshedState();
    const created = await this.account.createChallenge(
      state.accessToken,
      state.desktop.id,
    );
    if (created.challenge.sourceDeviceId !== state.desktop.id) {
      throw new Error("Account returned a pairing challenge for another Desktop identity");
    }
    if (
      requireChallengeId(created.challenge.id) !== created.challenge.id
      || created.challenge.state !== "pending"
      || created.challenge.expiresAt <= this.now()
    ) {
      throw new Error("Account returned an invalid pairing challenge");
    }
    this.reviewedClaims.clear();
    return Object.freeze({
      accountRegion: state.account.region,
      challengeId: created.challenge.id,
      expiresAt: created.challenge.expiresAt,
      pairingCode: created.pairingCode,
      protocolVersion: 1,
      qrPayload: invitationPayload({
        pairingCode: created.pairingCode,
        region: state.account.region,
        expiresAt: created.challenge.expiresAt,
      }),
      state: created.challenge.state,
    });
  }

  async inspect(challengeIdValue: unknown): Promise<MobilePairingSnapshot> {
    const challengeId = requireChallengeId(challengeIdValue);
    const state = await this.refreshedState();
    const challenge = await this.account.inspectChallenge(
      state.accessToken,
      challengeId,
      state.desktop.id,
    );
    if (challenge.id !== challengeId || challenge.sourceDeviceId !== state.desktop.id) {
      throw new Error("Account returned a pairing challenge for another Desktop identity");
    }
    if (
      challenge.mobileLabel
      && challenge.mobilePlatform
      && challenge.mobilePublicKeySpki
      && challenge.mobilePublicKeyThumbprint
      && (challenge.state === "claimed"
        || challenge.state === "approved"
        || challenge.state === "consumed")
    ) {
      const identity = Object.freeze({
        label: challenge.mobileLabel,
        platform: challenge.mobilePlatform,
        publicKeySpki: challenge.mobilePublicKeySpki,
        publicKeyThumbprint: challenge.mobilePublicKeyThumbprint,
      });
      const reviewed = this.reviewedClaims.get(challengeId);
      if (
        reviewed
        && (reviewed.label !== identity.label
          || reviewed.platform !== identity.platform
          || reviewed.publicKeySpki !== identity.publicKeySpki
          || reviewed.publicKeyThumbprint !== identity.publicKeyThumbprint)
      ) {
        throw new Error("The phone identity changed after review; create a new invitation");
      }
      this.reviewedClaims.set(challengeId, identity);
    }
    return snapshot(challenge);
  }

  async decide(
    challengeIdValue: unknown,
    approved: boolean,
  ): Promise<MobilePairingSnapshot> {
    if (typeof approved !== "boolean") {
      throw new TypeError("approved must be a boolean");
    }
    const challengeId = requireChallengeId(challengeIdValue);
    const state = await this.refreshedState();
    const observed = await this.account.inspectChallenge(
      state.accessToken,
      challengeId,
      state.desktop.id,
    );
    if (observed.id !== challengeId || observed.sourceDeviceId !== state.desktop.id) {
      throw new Error("Account returned a pairing challenge for another Desktop identity");
    }
    if (approved && observed.expiresAt <= this.now()) {
      throw new Error("The pairing invitation expired; create a new invitation");
    }
    if (approved && observed.state !== "claimed" && observed.state !== "approved" && observed.state !== "consumed") {
      throw new Error("The phone has not claimed this pairing request");
    }
    const reviewed = this.reviewedClaims.get(challengeId);
    if (
      approved
      && (!reviewed
        || observed.mobileLabel !== reviewed.label
        || observed.mobilePlatform !== reviewed.platform
        || observed.mobilePublicKeySpki !== reviewed.publicKeySpki
        || observed.mobilePublicKeyThumbprint !== reviewed.publicKeyThumbprint)
    ) {
      throw new Error("The reviewed phone identity changed; create a new invitation");
    }
    const decided = await this.account.decideChallenge(
      state.accessToken,
      challengeId,
      state.desktop.id,
      approved,
    );
    if (decided.id !== challengeId || decided.sourceDeviceId !== state.desktop.id) {
      throw new Error("Account returned a pairing decision for another Desktop identity");
    }
    if (approved && reviewed && (
      decided.mobileLabel !== reviewed.label
      || decided.mobilePlatform !== reviewed.platform
      || decided.mobilePublicKeySpki !== reviewed.publicKeySpki
      || decided.mobilePublicKeyThumbprint !== reviewed.publicKeyThumbprint
    )) {
      throw new Error("The phone identity changed while pairing; create a new invitation");
    }
    if (approved) {
      if (
        (decided.state !== "approved" && decided.state !== "consumed")
        || !decided.pairedDeviceId
        || !decided.mobilePublicKeySpki
        || !decided.mobilePublicKeyThumbprint
      ) {
        throw new Error("Account did not return an approved, key-bound mobile device");
      }
      const latest = this.loadState();
      if (
        !latest
        || latest.account.id !== state.account.id
        || latest.account.region !== state.account.region
        || latest.desktop.id !== state.desktop.id
      ) {
        throw new Error("Hara account state changed while pairing; create a new invitation");
      }
      const pairedMobileDevices = [
        ...latest.pairedMobileDevices.filter((device) => device.id !== decided.pairedDeviceId),
        {
          id: decided.pairedDeviceId,
          publicKeySpki: decided.mobilePublicKeySpki,
          publicKeyThumbprint: decided.mobilePublicKeyThumbprint,
        },
      ].slice(-20);
      this.saveState({ ...latest, pairedMobileDevices });
    }
    this.reviewedClaims.delete(challengeId);
    return snapshot(decided);
  }

  async currentState(): Promise<MobileCompanionState> {
    return await this.refreshedState();
  }
}
