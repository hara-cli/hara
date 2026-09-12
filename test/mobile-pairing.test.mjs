import assert from "node:assert/strict";
import test from "node:test";

import {
  MobilePairingCoordinator,
  mobilePairingQrPayload,
} from "../dist/mobile/pairing.js";
import { generateDeviceKey, publicKeyThumbprint } from "../dist/mobile/security.js";

const now = 2_000_000_000_000;

function fixtureState() {
  return {
    accessToken: "a".repeat(64),
    accessTokenExpiresAt: now + 600_000,
    account: { displayName: "Hara User", id: "account-a", region: "cn" },
    desktop: {
      credential: "b".repeat(64),
      credentialExpiresAt: now + 600_000,
      id: "desktop-a",
      key: generateDeviceKey(),
      platform: "macos",
    },
    pairedMobileDevices: [],
    refreshToken: `hara_rt_${"r".repeat(64)}`,
    refreshTokenExpiresAt: now + 86_400_000,
    schemaVersion: 1,
  };
}

test("mobile pairing QR contains only the bounded one-time invitation fields", () => {
  const payload = mobilePairingQrPayload({
    expiresAt: now + 120_000,
    pairingCode: "HARA_abcdefghijklmnopqrstuvwxyz",
    region: "cn",
  });

  assert.equal(
    payload,
    "hara://pair?v=1&region=cn&code=HARA_abcdefghijklmnopqrstuvwxyz&expires=2000000120",
  );
  assert.doesNotMatch(payload, /token|credential|private|account-a/iu);
  assert.throws(() => mobilePairingQrPayload({
    expiresAt: now + 120_000,
    pairingCode: "https://evil.example",
    region: "cn",
  }), /pairingCode/);
});

test("Desktop pairing control plane keeps credentials private and pins the claimed phone key", async () => {
  let state = fixtureState();
  const saved = [];
  const phone = generateDeviceKey();
  const phoneThumbprint = publicKeyThumbprint(phone.publicKeySpki);
  const pending = {
    expiresAt: now + 120_000,
    id: "challenge-a",
    mobileLabel: null,
    mobilePlatform: null,
    mobilePublicKeySpki: null,
    mobilePublicKeyThumbprint: null,
    pairedDeviceId: null,
    sourceDeviceId: "desktop-a",
    state: "pending",
  };
  const claimed = {
    ...pending,
    mobileLabel: "Test iPhone",
    mobilePlatform: "ios",
    mobilePublicKeySpki: phone.publicKeySpki,
    mobilePublicKeyThumbprint: phoneThumbprint,
    state: "claimed",
  };
  const approved = {
    ...claimed,
    pairedDeviceId: "mobile-a",
    state: "approved",
  };
  const account = {
    createChallenge: async () => ({
      challenge: pending,
      pairingCode: "HARA_abcdefghijklmnopqrstuvwxyz",
    }),
    decideChallenge: async () => approved,
    inspectChallenge: async () => claimed,
    refresh: async () => {
      throw new Error("unexpected refresh");
    },
    renewDesktop: async () => {
      throw new Error("unexpected renewal");
    },
  };
  const coordinator = new MobilePairingCoordinator({
    account,
    loadState: () => state,
    now: () => now,
    saveState: (next) => {
      state = next;
      saved.push(next);
    },
  });

  const status = coordinator.status();
  assert.deepEqual(status, {
    account: { displayName: "Hara User", region: "cn" },
    accountSession: "active",
    desktopCredential: "active",
    pairedMobileDevices: 0,
    signedIn: true,
  });
  assert.equal(JSON.stringify(status).includes(state.accessToken), false);

  const invitation = await coordinator.create();
  assert.equal(invitation.challengeId, "challenge-a");
  assert.match(invitation.qrPayload, /^hara:\/\/pair\?/u);

  const inspected = await coordinator.inspect("challenge-a");
  assert.deepEqual(inspected.mobile, {
    label: "Test iPhone",
    platform: "ios",
    publicKeyThumbprint: phoneThumbprint,
  });

  const decision = await coordinator.decide("challenge-a", true);
  assert.equal(decision.state, "approved");
  assert.equal(saved.length, 1);
  assert.deepEqual(state.pairedMobileDevices, [{
    id: "mobile-a",
    publicKeySpki: phone.publicKeySpki,
    publicKeyThumbprint: phoneThumbprint,
  }]);
});

test("Desktop rejects a phone key substitution between review and approval", async () => {
  const state = fixtureState();
  const first = generateDeviceKey();
  const changed = generateDeviceKey();
  let inspectedKey = first;
  let decisionCalled = false;
  const challenge = (key, phase) => ({
    expiresAt: now + 120_000,
    id: "challenge-a",
    mobileLabel: "Test Phone",
    mobilePlatform: "android",
    mobilePublicKeySpki: key.publicKeySpki,
    mobilePublicKeyThumbprint: publicKeyThumbprint(key.publicKeySpki),
    pairedDeviceId: phase === "approved" ? "mobile-a" : null,
    sourceDeviceId: "desktop-a",
    state: phase,
  });
  const coordinator = new MobilePairingCoordinator({
    account: {
      createChallenge: async () => ({
        challenge: challenge(first, "pending"),
        pairingCode: "HARA_abcdefghijklmnopqrstuvwxyz",
      }),
      inspectChallenge: async () => challenge(inspectedKey, "claimed"),
      decideChallenge: async () => {
        decisionCalled = true;
        return challenge(changed, "approved");
      },
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
      renewDesktop: async () => {
        throw new Error("unexpected renewal");
      },
    },
    loadState: () => state,
    now: () => now,
    saveState: () => {
      throw new Error("substituted identity must not be saved");
    },
  });

  await coordinator.inspect("challenge-a");
  inspectedKey = changed;

  await assert.rejects(
    () => coordinator.decide("challenge-a", true),
    /reviewed phone identity changed/,
  );
  assert.equal(decisionCalled, false);
});

test("Desktop refuses an expired phone claim before sending an approval", async () => {
  const state = fixtureState();
  const phone = generateDeviceKey();
  let decisionCalled = false;
  const expiredClaim = {
    expiresAt: now - 1,
    id: "challenge-expired",
    mobileLabel: "Test iPhone",
    mobilePlatform: "ios",
    mobilePublicKeySpki: phone.publicKeySpki,
    mobilePublicKeyThumbprint: publicKeyThumbprint(phone.publicKeySpki),
    pairedDeviceId: null,
    sourceDeviceId: "desktop-a",
    state: "claimed",
  };
  const coordinator = new MobilePairingCoordinator({
    account: {
      createChallenge: async () => ({
        challenge: expiredClaim,
        pairingCode: "HARA_abcdefghijklmnopqrstuvwxyz",
      }),
      inspectChallenge: async () => expiredClaim,
      decideChallenge: async () => {
        decisionCalled = true;
        return { ...expiredClaim, pairedDeviceId: "mobile-a", state: "approved" };
      },
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
      renewDesktop: async () => {
        throw new Error("unexpected renewal");
      },
    },
    loadState: () => state,
    now: () => now,
    saveState: () => {
      throw new Error("expired pairing must not be saved");
    },
  });

  await coordinator.inspect("challenge-expired");
  await assert.rejects(
    () => coordinator.decide("challenge-expired", true),
    /pairing invitation expired/,
  );
  assert.equal(decisionCalled, false);
});
