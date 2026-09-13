import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MobileDesktopAuthorizationCoordinator,
  clearPendingDesktopAuthorization,
  desktopAuthorizationQrPayload,
  loadPendingDesktopAuthorization,
  savePendingDesktopAuthorization,
} from "../dist/mobile/desktop-authorization.js";
import { MobileAccountClient } from "../dist/mobile/account-client.js";
import {
  desktopAuthorizationCreateProofPayload,
  desktopAuthorizationSecretProofPayload,
  generateDeviceKey,
  publicKeyThumbprint,
  sha256Text,
  verifyPayload,
} from "../dist/mobile/security.js";

const now = 2_000_000_000_000;
const authorizationCode = `HARA_AUTH_${"a".repeat(32)}`;
const pollSecret = `HARA_DAP_${"s".repeat(43)}`;

const response = (body) => ({
  headers: { get: () => null },
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

function publicAuthorization(key, state = "pending") {
  return {
    approvedAt: state === "pending" ? null : new Date(now + 1_000).toISOString(),
    consumedAt: state === "consumed" ? new Date(now + 2_000).toISOString() : null,
    desktop: {
      label: "Hara Desktop · Test Mac",
      platform: "macos",
      publicKeyThumbprint: publicKeyThumbprint(key.publicKeySpki),
    },
    expiresAt: new Date(now + 300_000).toISOString(),
    id: "authorization-a",
    state,
  };
}

test("Desktop authorization Account client signs each action and pins both returned device identities", async () => {
  const desktop = generateDeviceKey();
  const mobile = generateDeviceKey();
  const requests = [];
  const client = new MobileAccountClient(
    "http://127.0.0.1:7200",
    async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ body, url });
      if (url.endsWith("/v1/device-authorizations")) {
        assert.equal(body.pollSecretHash, sha256Text(pollSecret));
        assert.equal(verifyPayload(
          desktop.publicKeySpki,
          desktopAuthorizationCreateProofPayload({
            accountRegion: "cn",
            desktopLabel: "Hara Desktop · Test Mac",
            desktopPlatform: "macos",
            pollSecret,
            publicKeySpki: desktop.publicKeySpki,
          }),
          body.proofSignature,
        ), true);
        return response({
          authorization: publicAuthorization(desktop),
          authorizationCode,
          protocolVersion: 1,
        });
      }
      const action = url.endsWith("/status") ? "status" : "exchange";
      assert.equal(body.challengeId, "authorization-a");
      assert.equal(body.pollSecret, pollSecret);
      assert.equal(verifyPayload(
        desktop.publicKeySpki,
        desktopAuthorizationSecretProofPayload({
          accountRegion: "cn",
          action,
          challengeId: "authorization-a",
          pollSecret,
          publicKeySpki: desktop.publicKeySpki,
        }),
        body.proofSignature,
      ), true);
      if (action === "status") {
        return response({
          authorization: publicAuthorization(desktop, "approved"),
          protocolVersion: 1,
        });
      }
      return response({
        accessToken: "a".repeat(64),
        account: { displayName: "Hara User", id: "account-a", region: "cn" },
        authorization: publicAuthorization(desktop, "consumed"),
        desktopDevice: {
          credentialVersion: 1,
          id: "desktop-a",
          kind: "desktop",
          label: "Hara Desktop · Test Mac",
          lastSeenAt: new Date(now).toISOString(),
          platform: "macos",
          revokedAt: null,
          state: "active",
        },
        deviceCredential: "b".repeat(64),
        deviceCredentialExpiresInSeconds: 600,
        deviceCredentialReady: true,
        expiresInSeconds: 600,
        pairedMobileDevice: {
          credentialVersion: 1,
          id: "mobile-a",
          kind: "mobile",
          label: "Test iPhone",
          lastSeenAt: new Date(now).toISOString(),
          platform: "ios",
          publicKeySpki: mobile.publicKeySpki,
          publicKeyThumbprint: publicKeyThumbprint(mobile.publicKeySpki),
          revokedAt: null,
          state: "active",
        },
        protocolVersion: 1,
        refreshExpiresInSeconds: 2_592_000,
        refreshToken: `hara_rt_${"r".repeat(64)}`,
        tokenType: "Bearer",
      });
    },
    1_000,
    { allowInsecureLoopback: true },
  );

  const input = {
    accountRegion: "cn",
    desktopLabel: "Hara Desktop · Test Mac",
    key: desktop,
    platform: "macos",
    pollSecret,
  };
  const created = await client.createDesktopAuthorization(input);
  assert.equal(created.authorizationCode, authorizationCode);
  assert.equal((await client.inspectDesktopAuthorization({
    accountRegion: "cn",
    challengeId: created.authorization.id,
    key: desktop,
    pollSecret,
  })).state, "approved");
  const exchanged = await client.exchangeDesktopAuthorization({
    accountRegion: "cn",
    challengeId: created.authorization.id,
    key: desktop,
    platform: "macos",
    pollSecret,
  });
  assert.equal(exchanged.desktopDeviceId, "desktop-a");
  assert.equal(exchanged.pairedMobileDevice.id, "mobile-a");
  assert.equal(requests.length, 3);
  assert.doesNotMatch(JSON.stringify(requests), /BEGIN PRIVATE KEY/u);
});

test("Desktop authorization coordinator exposes only QR data and saves an empty publication allowlist", async () => {
  const desktop = generateDeviceKey();
  const mobile = generateDeviceKey();
  let pending = null;
  let state = null;
  let phase = "pending";
  const coordinator = new MobileDesktopAuthorizationCoordinator({
    account: {
      createDesktopAuthorization: async () => ({
        authorization: {
          desktop: publicAuthorization(desktop).desktop,
          expiresAt: now + 300_000,
          id: "authorization-a",
          state: "pending",
        },
        authorizationCode,
      }),
      inspectDesktopAuthorization: async () => ({
        desktop: publicAuthorization(desktop, phase).desktop,
        expiresAt: now + 300_000,
        id: "authorization-a",
        state: phase,
      }),
      exchangeDesktopAuthorization: async () => ({
        accessToken: "a".repeat(64),
        account: { displayName: "Hara User", id: "account-a", region: "cn" },
        authorization: {
          desktop: publicAuthorization(desktop, "consumed").desktop,
          expiresAt: now + 300_000,
          id: "authorization-a",
          state: "consumed",
        },
        desktopCredential: "b".repeat(64),
        desktopCredentialExpiresInSeconds: 600,
        desktopDeviceId: "desktop-a",
        expiresInSeconds: 600,
        pairedMobileDevice: {
          id: "mobile-a",
          publicKeySpki: mobile.publicKeySpki,
          publicKeyThumbprint: publicKeyThumbprint(mobile.publicKeySpki),
        },
        refreshExpiresInSeconds: 2_592_000,
        refreshToken: `hara_rt_${"r".repeat(64)}`,
      }),
    },
    clearPending: () => { pending = null; },
    desktopLabel: "Hara Desktop · Test Mac",
    loadPending: () => pending,
    loadState: () => state,
    now: () => now,
    platform: "macos",
    randomKey: () => desktop,
    randomSecret: () => pollSecret,
    savePending: (next) => { pending = next; },
    saveState: (next) => { state = next; },
  });

  const invitation = await coordinator.create();
  assert.equal(invitation.state, "pending");
  assert.match(invitation.qrPayload, /^hara:\/\/authorize-desktop\?/u);
  assert.doesNotMatch(JSON.stringify(invitation), /HARA_DAP_|BEGIN PRIVATE KEY|accessToken/u);
  assert.equal((await coordinator.status()).state, "pending");

  phase = "approved";
  const signedIn = await coordinator.status();
  assert.equal(signedIn.signedIn, true);
  assert.deepEqual(signedIn.account, { displayName: "Hara User", region: "cn" });
  assert.equal(pending, null);
  assert.equal(state.desktop.key.privateKeyPem, desktop.privateKeyPem);
  assert.deepEqual(state.pairedMobileDevices.map((device) => device.id), ["mobile-a"]);
  assert.deepEqual(state.publishedSessions, []);
  assert.doesNotMatch(JSON.stringify(signedIn), /accessToken|refreshToken|credential|privateKey/u);
});

test("pending Desktop authorization persists privately and its QR has only public invitation fields", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-desktop-authorization-"));
  const path = join(root, ".hara", "mobile-desktop-authorization.json");
  const key = generateDeviceKey();
  const pending = {
    accountRegion: "cn",
    authorizationCode,
    challengeId: "authorization-a",
    desktopLabel: "Hara Desktop · Test Mac",
    expiresAt: now + 300_000,
    key,
    platform: "macos",
    pollSecret,
    schemaVersion: 1,
  };
  try {
    savePendingDesktopAuthorization(pending, path);
    assert.equal(loadPendingDesktopAuthorization(path)?.challengeId, "authorization-a");
    if (process.platform !== "win32") {
      assert.equal(lstatSync(path).mode & 0o077, 0);
      chmodSync(path, 0o644);
      assert.equal(loadPendingDesktopAuthorization(path), null);
      chmodSync(path, 0o600);
    }
    const qr = desktopAuthorizationQrPayload({
      authorizationCode,
      expiresAt: pending.expiresAt,
      region: "cn",
    });
    assert.equal(
      qr,
      `hara://authorize-desktop?v=1&region=cn&code=${authorizationCode}&expires=2000000300`,
    );
    assert.doesNotMatch(qr, /poll|secret|private|token/iu);
    clearPendingDesktopAuthorization(path);
    assert.equal(loadPendingDesktopAuthorization(path), null);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
