import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveGatewaySenderAuthorization,
  inspectGatewaySenderAuthorization,
  loadAuthorizedGatewaySenders,
  requestGatewaySenderAuthorization,
} from "../dist/gateway/sender-authorization.js";
import { saveFeishuGatewayCredentials } from "../dist/gateway/credentials.js";
import { gatewayRuntimeScope } from "../dist/gateway/runtime-state.js";
import {
  approveGatewaySenderAuthorization as approveGatewaySenderThroughStatus,
  gatewayStatus,
} from "../dist/gateway/serve.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hara-gateway-sender-auth-"));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Feishu sender enrollment exposes only an opaque matching code and persists the approved id privately", () => {
  const fx = fixture();
  const scope = "feishu-1234567890abcdef";
  const senderId = "ou_private_sender_must_not_cross_rpc";
  const stateFile = join(fx.home, ".hara", "gateway", `authorization-${scope}.json`);
  try {
    assert.deepEqual(inspectGatewaySenderAuthorization(scope, fx.home, 1_000), {
      state: "missing",
      authorized: false,
    });
    const requested = requestGatewaySenderAuthorization(scope, senderId, fx.home, 1_000);
    assert.match(requested.id, /^[a-f0-9-]{36}$/u);
    assert.match(requested.code, /^[A-F0-9]{6}$/u);
    assert.equal(JSON.stringify(requested).includes(senderId), false);
    assert.deepEqual(requestGatewaySenderAuthorization(scope, senderId, fx.home, 2_000), requested,
      "repeated messages retain one matchable request instead of rotating codes");

    const summary = inspectGatewaySenderAuthorization(scope, fx.home, 2_000);
    assert.equal(summary.authorized, false);
    assert.deepEqual(summary.pending, requested);
    assert.equal(JSON.stringify(summary).includes(senderId), false);
    if (process.platform !== "win32") assert.equal(lstatSync(stateFile).mode & 0o777, 0o600);
    assert.match(readFileSync(stateFile, "utf8"), new RegExp(senderId));

    assert.throws(
      () => approveGatewaySenderAuthorization(scope, "00000000-0000-4000-8000-000000000000", fx.home, 2_000),
      /expired or was not found/,
    );
    const approved = approveGatewaySenderAuthorization(scope, requested.id, fx.home, 3_000);
    assert.deepEqual(approved, { state: "ready", authorized: true });
    assert.deepEqual([...loadAuthorizedGatewaySenders(scope, fx.home, 3_000)], [senderId]);
    const after = inspectGatewaySenderAuthorization(scope, fx.home, 3_000);
    assert.deepEqual(after, { state: "ready", authorized: true });
    assert.equal(JSON.stringify(after).includes(senderId), false);
  } finally {
    fx.cleanup();
  }
});

test("expired and unsafe sender authorization state fails closed", { skip: process.platform === "win32" }, () => {
  const expired = fixture();
  const scope = "feishu-expired";
  try {
    const request = requestGatewaySenderAuthorization(scope, "ou_expired", expired.home, 1_000);
    assert.equal(inspectGatewaySenderAuthorization(scope, expired.home, request.expiresAt + 1).pending, undefined);
    assert.throws(
      () => approveGatewaySenderAuthorization(scope, request.id, expired.home, request.expiresAt + 1),
      /expired or was not found/,
    );
  } finally {
    expired.cleanup();
  }

  const linked = fixture();
  try {
    const directory = join(linked.home, ".hara", "gateway");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const outside = join(linked.root, "outside.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, join(directory, "authorization-feishu-linked.json"));
    assert.deepEqual(inspectGatewaySenderAuthorization("feishu-linked", linked.home), {
      state: "unreadable",
      authorized: false,
    });
    assert.throws(
      () => requestGatewaySenderAuthorization("feishu-linked", "ou_sender", linked.home),
      /symbolic link/,
    );
  } finally {
    linked.cleanup();
  }
});

test("gateway status exposes a redacted Feishu pairing request and the protocol approval clears it", async () => {
  const fx = fixture();
  const appId = "cli_sender_status_fixture";
  const senderId = "ou_status_sender_private";
  try {
    saveFeishuGatewayCredentials({ appId, appSecret: "status-secret-private" }, fx.home);
    const scope = gatewayRuntimeScope("feishu", appId);
    const pending = requestGatewaySenderAuthorization(scope, senderId, fx.home);
    const before = await gatewayStatus("feishu", { home: fx.home, env: {} });
    assert.deepEqual(before.pendingAuthorization, pending);
    assert.equal(JSON.stringify(before).includes(senderId), false);

    const after = await approveGatewaySenderThroughStatus("feishu", pending.id, {
      home: fx.home,
      env: {},
    });
    assert.equal(after.pendingAuthorization, undefined);
    assert.equal(JSON.stringify(after).includes(senderId), false);
    assert.deepEqual([...loadAuthorizedGatewaySenders(scope, fx.home)], [senderId]);
  } finally {
    fx.cleanup();
  }
});
