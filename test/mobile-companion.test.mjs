import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decryptFromPeer,
  encryptionContext,
  encryptForPeer,
  generateDeviceKey,
  publicKeyThumbprint,
  relayEnvelopePayload,
  signPayload,
  verifyPayload,
} from "../dist/mobile/security.js";
import {
  clearMobileState,
  loadMobileState,
  saveMobileState,
} from "../dist/mobile/state.js";
import {
  MobileCompanionRouter,
  parseCompanionRequest,
} from "../dist/mobile/router.js";
import { MobileAccountClient } from "../dist/mobile/account-client.js";
import { MobileRelayBridge } from "../dist/mobile/relay-bridge.js";

const request = (requestId, method, body = {}) => parseCompanionRequest({
  body,
  method,
  protocolVersion: 1,
  requestId,
  type: "companion.request",
});

test("Desktop and mobile P-256 keys sign and encrypt the same relay protocol", () => {
  const desktop = generateDeviceKey();
  const mobile = generateDeviceKey();
  const context = encryptionContext("account-a", "desktop-a", "mobile-a");
  const sealed = encryptForPeer(desktop.privateKeyPem, mobile.publicKeySpki, context, "private session payload");
  assert.equal(
    decryptFromPeer(mobile.privateKeyPem, desktop.publicKeySpki, context, sealed.ciphertext, sealed.nonce),
    "private session payload",
  );
  assert.throws(() =>
    decryptFromPeer(mobile.privateKeyPem, desktop.publicKeySpki, context, sealed.ciphertext, "AAAAAAAAAAAAAAAA"));

  const fields = {
    accountId: "account-a",
    ciphertext: sealed.ciphertext,
    expiresAt: 2_000_030_000,
    messageId: "message-a",
    nonce: sealed.nonce,
    senderDeviceId: "desktop-a",
    targetDeviceId: "mobile-a",
  };
  const payload = relayEnvelopePayload(fields);
  const signature = signPayload(desktop.privateKeyPem, payload);
  assert.equal(verifyPayload(desktop.publicKeySpki, payload, signature), true);
  assert.equal(verifyPayload(desktop.publicKeySpki, `${payload}x`, signature), false);
});

test("Mobile companion state is private, validated, and removable", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-mobile-state-"));
  const path = join(root, ".hara", "mobile-companion.json");
  const key = generateDeviceKey();
  const mobileKey = generateDeviceKey();
  const state = {
    accessToken: "a".repeat(64),
    accessTokenExpiresAt: 2_000_100_000,
    account: { displayName: "Test User", id: "account-a", region: "cn" },
    desktop: {
      credential: "b".repeat(64),
      credentialExpiresAt: 2_000_100_000,
      id: "desktop-a",
      key,
      platform: "macos",
    },
    pairedMobileDevices: [{
      id: "mobile-a",
      publicKeySpki: mobileKey.publicKeySpki,
      publicKeyThumbprint: publicKeyThumbprint(mobileKey.publicKeySpki),
    }],
    schemaVersion: 1,
  };
  try {
    saveMobileState(state, path);
    assert.equal(loadMobileState(path)?.desktop.id, "desktop-a");
    assert.doesNotMatch(readFileSync(path, "utf8"), /Test User.*accessToken/s,
      "serialized state remains JSON but tests never print its credential values");
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      assert.equal(loadMobileState(path), null);
      chmodSync(path, 0o600);
    }
    clearMobileState(path);
    assert.equal(loadMobileState(path), null);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Account pairing accepts a verified mobile key and rejects a changed thumbprint", async () => {
  const mobile = generateDeviceKey();
  const challenge = {
    expiresAt: "2033-05-18T03:33:20.000Z",
    id: "challenge-a",
    mobileLabel: "Test iPhone",
    mobilePlatform: "ios",
    mobilePublicKeySpki: mobile.publicKeySpki,
    mobilePublicKeyThumbprint: publicKeyThumbprint(mobile.publicKeySpki),
    pairedDeviceId: null,
    sourceDeviceId: "desktop-a",
    state: "claimed",
  };
  const response = (body) => ({
    headers: { get: () => null },
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
  const client = new MobileAccountClient(
    "http://127.0.0.1:7200",
    async () => response({
      challenge,
      pairingCode: "HARA_abcdefghijklmnopqrstuvwxyz",
      protocolVersion: 1,
    }),
    1_000,
    { allowInsecureLoopback: true },
  );
  await assert.doesNotReject(() => client.createChallenge("token", "desktop-a"));

  const changed = new MobileAccountClient(
    "http://127.0.0.1:7200",
    async () => response({
      challenge: { ...challenge, mobilePublicKeyThumbprint: "0".repeat(64) },
      pairingCode: "HARA_abcdefghijklmnopqrstuvwxyz",
      protocolVersion: 1,
    }),
    1_000,
    { allowInsecureLoopback: true },
  );
  await assert.rejects(
    () => changed.createChallenge("token", "desktop-a"),
    { code: "SERVICE_UNAVAILABLE" },
  );
});

test("Relay bridge rejects a paired mobile identity whose public key changed", async () => {
  const desktop = generateDeviceKey();
  const mobile = generateDeviceKey();
  const substituted = generateDeviceKey();
  const now = 2_000_000_000;
  const state = {
    accessToken: "a".repeat(64),
    accessTokenExpiresAt: now + 600_000,
    account: { displayName: "Test User", id: "account-a", region: "cn" },
    desktop: {
      credential: "b".repeat(64),
      credentialExpiresAt: now + 600_000,
      id: "desktop-a",
      key: desktop,
      platform: "macos",
    },
    pairedMobileDevices: [{
      id: "mobile-a",
      publicKeySpki: mobile.publicKeySpki,
      publicKeyThumbprint: publicKeyThumbprint(mobile.publicKeySpki),
    }],
    schemaVersion: 1,
  };
  const bridge = new MobileRelayBridge(
    "wss://relay.example.test/v1/connect",
    state,
    { close: async () => {}, route: async () => ({}) },
    () => now,
  );
  const relayDevice = (key, kind, id, platform) => ({
    credentialExpiresAt: now + 600_000,
    credentialVersion: 1,
    id,
    kind,
    platform,
    publicKeySpki: key.publicKeySpki,
    publicKeyThumbprint: publicKeyThumbprint(key.publicKeySpki),
  });

  await assert.rejects(
    () => bridge.receive(Buffer.from(JSON.stringify({
      device: relayDevice(desktop, "desktop", "desktop-a", "macos"),
      peers: [relayDevice(substituted, "mobile", "mobile-a", "ios")],
      protocolVersion: 1,
      serverTime: now,
      type: "relay.ready",
    })), false),
    /identity changed/,
  );
});

test("Router publishes bounded sessions and enforces terminal leases and command replay", async () => {
  const calls = [];
  const listeners = new Set();
  const local = {
    async call(method, params = {}) {
      calls.push({ method, params });
      if (method === "external.sessions.list") {
        return {
          sources: [{
            id: "runtime",
            capabilities: {
              interrupt: true,
              read: true,
              submit: true,
              terminalInput: true,
              terminalView: true,
            },
          }],
          sessions: [{
            id: "ext_runtime_test-a",
            sourceId: "runtime",
            title: "Release relay",
            workspaceName: "hara",
            state: "waiting",
            updatedAt: "2026-09-06T12:00:00.000Z",
          }],
        };
      }
      if (method === "external.sessions.read") {
        return {
          controlMode: "live",
          messages: [{ id: "message-a", role: "assistant", text: "Waiting for input" }],
          readOnly: false,
        };
      }
      if (method === "external.sessions.terminal.snapshot") {
        return { state: "waiting", text: "$ npm test\nWaiting", updatedAt: "2026-09-06T12:00:01.000Z" };
      }
      if (method === "external.sessions.terminal.attach") {
        return { mode: "control", nextInputSeq: 1, streamId: "terminal-a" };
      }
      if (method === "external.sessions.terminal.raw-input") {
        return { accepted: true, duplicate: false, inputSeq: params.inputSeq, nextInputSeq: params.inputSeq + 1 };
      }
      return {};
    },
    async close() {},
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const now = 2_000_000_000;
  const router = new MobileCompanionRouter(local, "desktop-a", now + 600_000, { clock: () => now });
  const listed = await router.route(request("request-list", "sessions.list"));
  assert.equal(listed.ok, true);
  assert.equal(listed.body[0].status, "needs_input");
  assert.equal(listed.body[0].workspaceLabel, "hara");
  const publication = listed.body[0];

  const read = await router.route(request("request-read", "sessions.read", {
    publicationId: publication.publicationId,
  }));
  assert.deepEqual(read.body.messages, [{ id: "message-a", role: "assistant", text: "Waiting for input" }]);

  const grantRequest = {
    commandId: "control-command-a",
    expiresAt: now + 30_000,
    leaseEpoch: router.leaseEpoch,
    publicationId: publication.publicationId,
    requestedDurationMs: 60_000,
    schemaVersion: 1,
  };
  const grantResponse = await router.route(request("request-control", "terminal.control", grantRequest));
  assert.equal(grantResponse.ok, true);
  const grant = grantResponse.body;

  const inputCommand = {
    commandId: "terminal-command-a",
    expiresAt: now + 30_000,
    kind: "terminal_input",
    leaseEpoch: router.leaseEpoch,
    payload: { dataBase64: Buffer.from("npm test\r").toString("base64"), leaseId: grant.leaseId },
    publicationId: publication.publicationId,
    schemaVersion: 1,
  };
  const first = await router.route(request("request-input-a", "command.execute", inputCommand));
  const replay = await router.route(request("request-input-b", "command.execute", inputCommand));
  assert.equal(first.body.status, "succeeded");
  assert.deepEqual(replay.body, first.body);
  assert.equal(calls.filter((entry) => entry.method === "external.sessions.terminal.raw-input").length, 1);

  const stale = await router.route(request("request-stale", "command.execute", {
    ...inputCommand,
    commandId: "terminal-command-stale",
    leaseEpoch: router.leaseEpoch - 1,
  }));
  assert.equal(stale.body.errorCode, "STALE_EPOCH");
  await router.close();
});

test("Companion request parser rejects extra fields and unknown methods", () => {
  assert.equal(request("request-a", "sessions.list")?.method, "sessions.list");
  assert.equal(parseCompanionRequest({
    body: {},
    extra: true,
    method: "sessions.list",
    protocolVersion: 1,
    requestId: "request-a",
    type: "companion.request",
  }), null);
  assert.equal(request("request-b", "secrets.read"), null);
});
