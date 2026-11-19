import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createJsonRpcRequester } from "./helpers/observable-wait.mjs";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import {
  AGENT_HUB_NATIVE_CONTRACT, NATIVE_HUB_LIMITS, NativeHubError,
  decodeNativeRequest, decodeNativeHandoff, parseNativeRequest, parseNativeHandoff,
  parseNativeControlIntent, parseNativeControlResult, parsePreparedNativeControl,
  nativeControlSchema, nativeAttachProof, nativeIntentDigest, nativeSha256,
} from "../dist/agent-hub/native-control-contract.js";

const asset = suffix => readFileSync(new URL("../docs/contracts/agent-hub-native-v1." + suffix, import.meta.url));
const fixtures = JSON.parse(asset("fixtures.json"));
const invalid = error => error instanceof NativeHubError && error.code === "invalid_request";
const encode = value => Buffer.from(JSON.stringify(value), "utf8");

test("the Native wire shape, cross-language vectors and source are locked together", () => {
  const codec = readFileSync(new URL("../src/agent-hub/native-control-contract.ts", import.meta.url));
  const { contract, sourceSha256, schemaSha256, fixturesSha256 } = JSON.parse(asset("lock.json"));
  assert.equal(contract, AGENT_HUB_NATIVE_CONTRACT);
  assert.equal(fixtures.synthetic, true);
  assert.equal(nativeSha256(codec), sourceSha256);
  assert.equal(nativeSha256(asset("schema.json")), schemaSha256);
  assert.equal(nativeSha256(asset("fixtures.json")), fixturesSha256);
  assert.deepEqual(JSON.parse(asset("schema.json")), nativeControlSchema);
  const { ownerCredential, workspaceToken, hello, serverNonce, serverProof, clientProof } = fixtures.handshake;
  const transportDigest = nativeSha256(workspaceToken);
  assert.equal(nativeAttachProof(ownerCredential, "attach.server", hello, serverNonce, transportDigest), serverProof);
  assert.equal(nativeAttachProof(ownerCredential, "attach.client", hello, serverNonce, transportDigest), clientProof);
  assert.notEqual(serverProof, clientProof);
  assert.equal(nativeIntentDigest(fixtures.prepared.intent), fixtures.prepared.intentDigest);
  const unordered = Object.fromEntries(Object.entries(fixtures.prepared.intent).reverse());
  assert.equal(nativeIntentDigest(unordered), fixtures.prepared.intentDigest);
  assert.deepEqual(parsePreparedNativeControl(fixtures.prepared), fixtures.prepared);
  assert.deepEqual(parseNativeControlResult(fixtures.result), fixtures.result);
  for (const request of fixtures.requests) assert.deepEqual(decodeNativeRequest(encode(request)), request);
  for (const handoff of fixtures.handoffs) assert.deepEqual(decodeNativeHandoff(encode(handoff)), handoff);
});

test("private request and handoff decoding reject unrecognized fields, malformed UTF-8 and excess bytes", () => {
  for (const request of fixtures.rejectedRequests) assert.throws(() => decodeNativeRequest(encode(request)), invalid);
  for (const handoff of fixtures.rejectedHandoffs) assert.throws(() => decodeNativeHandoff(encode(handoff)), invalid);
  for (const [decode, limit] of [[decodeNativeRequest, NATIVE_HUB_LIMITS.requestBytes], [decodeNativeHandoff, NATIVE_HUB_LIMITS.handoffBytes]]) {
    assert.throws(() => decode(Buffer.from([0xc0, 0xaf])), invalid);
    assert.throws(() => decode(Buffer.alloc(limit + 1, " ")), invalid);
    assert.throws(() => decode(Buffer.from('{"schemaVersion":')), invalid);
  }
  const commit = fixtures.requests.find(row => row.method === "control.commit");
  const access = { ...commit.params };
  Object.defineProperty(access, "challenge", { enumerable: true, get() { assert.fail("getter was evaluated"); } });
  assert.throws(() => parseNativeRequest({ ...commit, params: access }), invalid);
  const intent = structuredClone(fixtures.prepared.intent);
  intent.facts.summary.details = Array(2);
  assert.throws(() => parseNativeControlIntent(intent), invalid);
  intent.facts.summary.details = ["ok"];
  Object.defineProperty(intent.facts.summary.details, "0", { get() { assert.fail("array getter was evaluated"); } });
  assert.throws(() => parseNativeControlIntent(intent), invalid);
  const other = structuredClone(fixtures.prepared.intent);
  other.facts.subject.instanceId = randomUUID();
  assert.throws(() => parseNativeControlIntent(other), invalid);
  assert.throws(() => parsePreparedNativeControl({ ...fixtures.prepared, intentDigest: "0".repeat(64) }), invalid);
  assert.throws(() => parseNativeHandoff({ ...fixtures.handoffs[0], from: fixtures.handoffs[0].from + "\n" }), invalid);
});

test("ordinary Workspace WS and HTTP cannot reach private Native operations", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-native-hidden-")));
  let handle, socket;
  t.after(async () => {
    socket?.terminate();
    await handle?.close();
    rmSync(root, { recursive: true, force: true });
  });
  handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, {
    root, version: "native-contract-fixture", credentialVault: new MemoryCredentialVault(),
    providerFactory() { assert.fail("private Native negatives must not activate a provider"); },
  });
  socket = new WebSocket("ws://127.0.0.1:" + handle.port);
  await once(socket, "open");
  const rpc = createJsonRpcRequester(socket, { idleMs: 5_000, maxMs: 10_000, errorText: "Native fixture RPC timeout",
    mapError: error => Object.assign(new Error(error.message), { rpc: error.code }) });
  const initialized = await rpc("initialize", { token: handle.token });
  assert.ok(Array.isArray(initialized.capabilities));
  assert.ok(!initialized.capabilities.some(name => name.includes("agent-hub-native")));
  const parameters = fixtures.requests.find(row => row.method === "control.commit").params;
  await assert.rejects(rpc("control.commit", parameters), error => typeof error.rpc === "number" && !/timeout/u.test(error.message));
  const status = await new Promise((resolve, reject) => {
    const sent = httpRequest({ host: "127.0.0.1", port: handle.port, path: "/v1/native/agent-hub",
      method: "POST", headers: { Authorization: "Bearer " + handle.token } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    sent.once("error", reject);
    sent.setTimeout(5000, () => sent.destroy(new Error("Native fixture HTTP timeout")));
    sent.end(JSON.stringify(fixtures.requests.find(row => row.method === "control.commit")));
  });
  assert.equal(status, 404);
});
