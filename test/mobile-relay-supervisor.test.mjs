import assert from "node:assert/strict";
import test from "node:test";

import { MobileRelaySupervisor } from "../dist/mobile/relay-supervisor.js";

const now = 2_000_000_000_000;

function fixtureState({ paired = true, peer = "mobile-a", credentialExpiresAt = now + 600_000 } = {}) {
  return {
    accessToken: "account-access-secret",
    accessTokenExpiresAt: now + 600_000,
    account: { displayName: "Hara User", id: "account-a", region: "cn" },
    desktop: {
      credential: "desktop-credential-secret",
      credentialExpiresAt,
      id: "desktop-a",
      key: { privateKeyPem: "private-key-secret", publicKeySpki: "desktop-public-key" },
      platform: "macos",
    },
    pairedMobileDevices: paired ? [{
      id: peer,
      publicKeySpki: `${peer}-public-key`,
      publicKeyThumbprint: peer.padEnd(64, "a").slice(0, 64),
    }] : [],
    schemaVersion: 1,
  };
}

function fakeConnection() {
  let closeCalls = 0;
  let rejectClosed;
  let resolveClosed;
  const closed = new Promise((resolve, reject) => {
    rejectClosed = reject;
    resolveClosed = resolve;
  });
  return {
    connection: {
      async close() {
        closeCalls += 1;
        resolveClosed();
      },
      waitUntilClosed() {
        return closed;
      },
    },
    disconnect() {
      rejectClosed(new Error("transport detail must stay private"));
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

test("Serve Relay stays dormant until a phone is paired and exposes no credentials", async () => {
  const state = fixtureState({ paired: false });
  let capabilityCalls = 0;
  let openCalls = 0;
  const logs = [];
  const supervisor = new MobileRelaySupervisor({
    accountCapabilities: async () => {
      capabilityCalls += 1;
      return { sessionRelay: true };
    },
    currentState: async () => state,
    loadState: () => state,
    log: (message) => logs.push(message),
    now: () => now,
    openConnection: async () => {
      openCalls += 1;
      return fakeConnection().connection;
    },
    pollIntervalMs: 5,
  });

  supervisor.start();
  await waitFor(() => supervisor.status().reason === "not_paired", "supervisor did not wait for pairing");
  assert.equal(capabilityCalls, 0);
  assert.equal(openCalls, 0);
  assert.deepEqual(supervisor.status(), {
    connectionState: "waiting",
    managedByServe: true,
    reason: "not_paired",
    retryAt: null,
    updatedAt: now,
  });
  assert.doesNotMatch(JSON.stringify({ logs, status: supervisor.status() }), /secret|private-key/iu);
  await supervisor.close();
  assert.equal(supervisor.status().connectionState, "stopped");
});

test("Serve Relay reports a disabled cloud capability without opening a transport", async () => {
  const state = fixtureState();
  let openCalls = 0;
  const supervisor = new MobileRelaySupervisor({
    accountCapabilities: async () => ({ sessionRelay: false }),
    capabilityRecheckMs: 100,
    currentState: async () => state,
    loadState: () => state,
    now: () => now,
    openConnection: async () => {
      openCalls += 1;
      return fakeConnection().connection;
    },
    pollIntervalMs: 5,
  });

  supervisor.start();
  await waitFor(() => supervisor.status().connectionState === "unavailable", "disabled Relay was not reported");
  assert.equal(supervisor.status().reason, "relay_disabled");
  assert.equal(supervisor.status().retryAt, now + 100);
  assert.equal(openCalls, 0);
  await supervisor.close();
});

test("Serve Relay retries a dropped connection with bounded backoff", async () => {
  const state = fixtureState();
  const connections = [];
  const supervisor = new MobileRelaySupervisor({
    accountCapabilities: async () => ({ sessionRelay: true }),
    currentState: async () => state,
    loadState: () => state,
    now: () => now,
    openConnection: async () => {
      const connection = fakeConnection();
      connections.push(connection);
      return connection.connection;
    },
    pollIntervalMs: 5,
    retryDelaysMs: [40, 80],
  });

  supervisor.start();
  await waitFor(() => supervisor.status().connectionState === "online", "Relay did not connect");
  connections[0].disconnect();
  await waitFor(() => supervisor.status().connectionState === "retrying", "Relay did not enter retry state");
  assert.equal(supervisor.status().reason, "relay_disconnected");
  assert.equal(supervisor.status().retryAt, now + 40);
  await waitFor(() => connections.length === 2 && supervisor.status().connectionState === "online", "Relay did not reconnect");
  assert.equal(connections[0].closeCalls, 1);
  await supervisor.close();
  assert.equal(connections[1].closeCalls, 1);
});

test("Serve Relay reconnects immediately when the paired identity changes", async () => {
  let state = fixtureState();
  const connections = [];
  const supervisor = new MobileRelaySupervisor({
    accountCapabilities: async () => ({ sessionRelay: true }),
    currentState: async () => state,
    loadState: () => state,
    now: () => now,
    openConnection: async () => {
      const connection = fakeConnection();
      connections.push(connection);
      return connection.connection;
    },
    pollIntervalMs: 5,
    retryDelaysMs: [500],
  });

  supervisor.start();
  await waitFor(() => connections.length === 1 && supervisor.status().connectionState === "online", "initial Relay did not connect");
  state = fixtureState({ peer: "mobile-b" });
  await waitFor(() => connections.length === 2 && supervisor.status().connectionState === "online", "paired identity change did not reconnect");
  assert.equal(connections[0].closeCalls, 1);
  await supervisor.close();
  assert.equal(connections[1].closeCalls, 1);
});

test("Serve Relay opens with the coordinator-refreshed Desktop credential", async () => {
  const stored = fixtureState({ credentialExpiresAt: now + 30_000 });
  const renewed = {
    ...stored,
    desktop: {
      ...stored.desktop,
      credential: "renewed-desktop-credential",
      credentialExpiresAt: now + 600_000,
    },
  };
  let openedWith;
  const connection = fakeConnection();
  const supervisor = new MobileRelaySupervisor({
    accountCapabilities: async () => ({ sessionRelay: true }),
    currentState: async () => renewed,
    loadState: () => stored,
    now: () => now,
    openConnection: async (state) => {
      openedWith = state;
      return connection.connection;
    },
    pollIntervalMs: 5,
  });

  supervisor.start();
  await waitFor(() => supervisor.status().connectionState === "online", "Relay did not use refreshed state");
  assert.equal(openedWith, renewed);
  assert.equal(openedWith.desktop.credentialExpiresAt, now + 600_000);
  await supervisor.close();
  assert.equal(connection.closeCalls, 1);
});

test("Serve Relay closes immediately and waits when the last paired phone is removed", async () => {
  let state = fixtureState();
  const connection = fakeConnection();
  let openCalls = 0;
  const supervisor = new MobileRelaySupervisor({
    accountCapabilities: async () => ({ sessionRelay: true }),
    currentState: async () => state,
    loadState: () => state,
    now: () => now,
    openConnection: async () => {
      openCalls += 1;
      return connection.connection;
    },
    pollIntervalMs: 5,
  });

  supervisor.start();
  await waitFor(() => supervisor.status().connectionState === "online", "Relay did not connect");
  state = fixtureState({ paired: false });
  await waitFor(
    () => supervisor.status().reason === "not_paired",
    "Relay did not return to paired-device waiting state",
  );
  assert.equal(connection.closeCalls, 1);
  assert.equal(openCalls, 1);
  await supervisor.close();
});
