import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { legacyWorkspaceProviderFailure, workspaceProviderFailure, WorkspaceProviderRecovery } from "../dist/workspace/provider-recovery.js";

const temporary = () => fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-provider-recovery-")));
const files = (host, w) => {
  const storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(w.workspaceId).scope);storage.initialize();
  return storage.run(() => ({ conversation: join(workspaceStateHome(), ".hara", `conversation-${w.selectedAgentId.slice(3)}.json`),
    failure: join(workspaceStateHome(), ".hara", `provider-recovery-${w.selectedAgentId.slice(3)}.json`) }));
};
test("configuration, authentication and allowance failures stay distinct from transient provider failures", () => {
  for (const [message, metadata, reason] of [
    ["generic route missing", { status: 404 }, "connection_model_unavailable"],
    ["无效模型", { status: 404 }, "connection_model_unavailable"],
    ["The requested model does not support the agent plan feature", { status: 400 }, "connection_model_unavailable"],
    ["fixture", { status: 401 }, "connection_auth_required"], ["fixture", { status: 403 }, "connection_auth_required"],
    ["insufficient quota", { status: 429 }, "connection_quota_exhausted"], ["fixture", { status: 402 }, "connection_quota_exhausted"],
    ["model is unsupported in this region", { status: 400 }, "connection_region_unavailable"],
    ["temporary failure", { status: 503 }, null], ["rate limit", { status: 429 }, null], ["network timeout", {}, null],
  ]) assert.equal(workspaceProviderFailure(message, metadata), reason);
  assert.equal(legacyWorkspaceProviderFailure("[openai error] 404 model unavailable"), "connection_model_unavailable");
  assert.equal(workspaceProviderFailure("exceeded your requests per minute quota", { status: 429 }), null);
  assert.equal(workspaceProviderFailure("429", { status: 429, code: "insufficient_quota" }), "connection_quota_exhausted");
  assert.equal(legacyWorkspaceProviderFailure("[openai error] 429 exceeded your requests per minute quota — the provider reported this account allowance or balance is exhausted; select another authorized connection or wait for its reset"), null);
  for (const text of ["404", "User asked about model not found", "Tool failed: [openai error] 404", "[openai error] network timeout"]) assert.equal(legacyWorkspaceProviderFailure(text), null);
});

for (const refusal of [
  { message: "exceeded your requests per minute quota", code: "rate_limit_exceeded", terminal: false },
  { message: "quota exceeded", code: "insufficient_quota", terminal: true },
  { message: "account balance is exhausted", terminal: true },
]) test(`a real loopback 429 ${refusal.terminal ? "refuses exhausted allowance" : "allows manual continuation after a rate window"} across restart: ${refusal.message}`, async () => {
  const root = temporary(), requests = [], server = createServer(async (request, response) => {
    let raw = "";for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, model: JSON.parse(raw).model });
    response.writeHead(429, { "content-type": "application/json" });response.end(JSON.stringify({ error: { message: refusal.message, ...(refusal.code ? { code: refusal.code } : {}) } }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const options = { mode: "workspace", credentialVault: new MemoryCredentialVault(), legacySourceHome: root, hostHome: root };
  let host = new LocalWorkspaceHost(root, options);
  try {
    const w = host.createWorkspace("HTTP quota fixture", host.list().revision);
    host.configureConnection(w.workspaceId, { label: "Loopback fixture", provider: "openai", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-fixture-credential", defaultModel: "fixture-model" }, 0);
    const first = host.start("ui", w.workspaceId, w.selectedAgentId, "hello", randomUUID());await host.wait(first.runId);
    assert.equal(requests.length, 1, "no automatic Workspace resend");
    const paths = files(host, w), bytes = fs.readFileSync(paths.conversation);
    await host.close();host = new LocalWorkspaceHost(root, options);
    assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.allowed, !refusal.terminal);
    assert.equal(fs.readFileSync(paths.conversation).equals(bytes), true);
    if (refusal.terminal) {
      assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.reason, "connection_quota_exhausted");
      assert.throws(() => host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /no new model call/);
      assert.equal(requests.length, 1);
    } else {
      assert.equal(fs.existsSync(paths.failure), false);
      const resumed = host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true);await host.wait(resumed.runId);
      assert.equal(resumed.runId, first.runId);assert.equal(requests.length, 2);
    }
  } finally { await host.close();server.closeAllConnections();await new Promise(done => server.close(done));fs.rmSync(root, { recursive: true, force: true }); }
});
test("recovery observation preserves provider capabilities, preparation and health methods with their original receiver", async () => {
  const root = temporary(), host = new LocalWorkspaceHost(root);
  try {
    const w = host.createWorkspace("Provider contract", host.list().revision), storage = new WorkspaceResourceStorage(host.home, host.catalog.resolve(w.workspaceId).scope);storage.initialize();
    class Provider {
      #label = "local-contract";
      get id() { return this.#label; }get model() { return this.#label; }get supportsToolImages() { return true; }get trailingTurnContext() { return true; }
      prepareTurn() { return { organizationPolicyVersion: this.#label.length }; }
      connectionHealth() { return { state: this.#label }; }
      async turn() { return { text: this.#label, toolUses: [], stop: "end" }; }
    }
    const observed = new WorkspaceProviderRecovery(storage, w.selectedAgentId).observe(new Provider(), randomUUID());
    assert.equal(observed.id, "local-contract");assert.equal(observed.supportsToolImages, true);assert.equal(observed.trailingTurnContext, true);
    assert.deepEqual(observed.prepareTurn([]), { organizationPolicyVersion: 14 });assert.deepEqual(observed.connectionHealth(), { state: "local-contract" });
    assert.equal((await observed.turn({ history: [], tools: [], system: "", onText() {} })).text, "local-contract");
  } finally { await host.close();fs.rmSync(root, { recursive: true, force: true }); }
});
test("unverifiable or foreign recovery evidence refuses continuation without treating it as an authorization or retry", async () => {
  const root = temporary();let calls = 0;
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
    calls++;return { text: "", toolUses: [], stop: "error", errorMsg: "temporary failure", errorMetadata: { status: 503 } };
  } }; } });
  try {
    const w = host.createWorkspace("Unverifiable evidence", host.list().revision);host.configureSynthetic(w.workspaceId, 0);
    const first = host.start("ui", w.workspaceId, w.selectedAgentId, "hello", randomUUID());await host.wait(first.runId);
    const paths = files(host, w), bytes = fs.readFileSync(paths.conversation);
    fs.writeFileSync(paths.failure, JSON.stringify({ schemaVersion: 1, revision: 1, resourceBinding: {}, agentId: w.selectedAgentId,
      runId: first.runId, reason: "connection_model_unavailable" }), { mode: 0o600 });
    assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.reason, "connection_recovery_unavailable");
    assert.throws(() => host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /connection_recovery_unavailable/);
    assert.equal(calls, 1);assert.equal(fs.readFileSync(paths.conversation).equals(bytes), true);
  } finally { await host.close();fs.rmSync(root, { recursive: true, force: true }); }
});
for (const status of [404, 401, 403, 402]) test(`${status} refuses every continuation before provider construction and survives restart without rewriting history or budget`, async () => {
  const root = temporary();let factories = 0, calls = 0;
  const options = { providerFactory(_connection, binding) { factories++;return { id: "openai", model: binding.model, async turn() {
    calls++;return { text: "", toolUses: [], stop: "error", errorMsg: "synthetic refusal", errorMetadata: { status } };
  } }; } };
  let host = new LocalWorkspaceHost(root, options);
  try {
    const w = host.createWorkspace("Local recovery fixture", host.list().revision);host.configureSynthetic(w.workspaceId, 0);
    const first = host.start("ui", w.workspaceId, w.selectedAgentId, "hello", randomUUID());await host.wait(first.runId);
    const before = host.snapshot(w.workspaceId), paths = files(host, w), bytes = fs.readFileSync(paths.conversation);
    assert.equal(before.conversation.resumeAdmission.allowed, false);assert.equal(factories, 1);assert.equal(calls, 1);
    const reason = before.conversation.resumeAdmission.reason;
    assert.equal(reason, status === 404 ? "connection_model_unavailable" : status === 402 ? "connection_quota_exhausted" : "connection_auth_required");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(paths.failure))), ["schemaVersion", "revision", "resourceBinding", "agentId", "runId", "reason"]);
    for (const source of ["ui", "cli", "automatic_retry"]) {
      const nonce = randomUUID();
      assert.throws(() => host.start(source, w.workspaceId, w.selectedAgentId, "/continue", nonce, false, undefined, undefined,
        { source, channel: source === "cli" ? "cli" : "rpc", clientId: source }), /continuation refused/);
      assert.equal(host.requestReceipt(w.workspaceId, w.selectedAgentId, nonce).reason, reason);
      assert.equal(fs.readFileSync(paths.conversation).equals(bytes), true);
    }
    await host.close();host = new LocalWorkspaceHost(root, options);
    assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.reason, reason);
    assert.throws(() => host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /no new model call/);
    assert.equal(factories, 1);assert.equal(calls, 1);assert.equal(fs.readFileSync(paths.conversation).equals(bytes), true);
    assert.deepEqual(host.snapshot(w.workspaceId).conversation.runUsage, before.conversation.runUsage);
    if (status === 404) {
      fs.unlinkSync(paths.failure);
      const old = JSON.parse(fs.readFileSync(paths.conversation));old.task.checkpoint.blockReason = "[openai error] 404 The requested model does not support the agent plan feature";
      fs.writeFileSync(paths.conversation, JSON.stringify(old), { mode: 0o600 });
      assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.reason, reason, "old conversation checkpoints also stop the loop");
      assert.throws(() => host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /continuation refused/);
    }
  } finally { await host.close();fs.rmSync(root, { recursive: true, force: true }); }
});
test("a transient error still permits explicit continuation on the original frozen run without an automatic resend", async () => {
  const root = temporary();let calls = 0;
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
    calls++;return { text: "", toolUses: [], stop: "error", errorMsg: "temporarily unavailable", errorMetadata: { status: 503 } };
  } }; } });
  try {
    const w = host.createWorkspace("Transient fixture", host.list().revision);host.configureSynthetic(w.workspaceId, 0);
    const first = host.start("ui", w.workspaceId, w.selectedAgentId, "hello", randomUUID());await host.wait(first.runId);
    assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.allowed, true);assert.equal(calls, 1);
    const resumed = host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true);await host.wait(resumed.runId);
    assert.equal(resumed.runId, first.runId);assert.equal(calls, 2);
  } finally { await host.close();fs.rmSync(root, { recursive: true, force: true }); }
});
test("repairing the selected connection does not rebind or replay the old run; an explicit new task captures it once", async () => {
  const root = temporary(), models = [];
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn() {
    models.push(binding.model);return { text: "", toolUses: [], stop: "error", errorMsg: "synthetic refusal", errorMetadata: { status: 404 } };
  } }; } });
  try {
    const w = host.createWorkspace("Repair fixture", host.list().revision);host.configureSynthetic(w.workspaceId, 0);
    const first = host.start("ui", w.workspaceId, w.selectedAgentId, "hello", randomUUID());await host.wait(first.runId);
    const old = host.snapshot(w.workspaceId), paths = files(host, w), originalBinding = JSON.parse(fs.readFileSync(paths.conversation)).task.workspaceRunBinding;
    host.configureConnection(w.workspaceId, { label: "New fixture", provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "synthetic-new-key", defaultModel: "explicit-new-model" }, old.connections.revision);
    let connections = host.snapshot(w.workspaceId).connections;
    host.selectConnection(w.workspaceId, connections.connections.find(item => item.defaultModel === "explicit-new-model").id, connections.revision);
    assert.throws(() => host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /continuation refused/);
    assert.deepEqual(models, [originalBinding.connection.model]);assert.deepEqual(JSON.parse(fs.readFileSync(paths.conversation)).task.workspaceRunBinding, originalBinding);
    const next = host.start("ui", w.workspaceId, w.selectedAgentId, "Start a new diagnostic task; do not repeat any previous actions", randomUUID());await host.wait(next.runId);
    assert.notEqual(next.runId, first.runId);assert.deepEqual(models, [originalBinding.connection.model, "explicit-new-model"]);
    const saved = JSON.parse(fs.readFileSync(paths.conversation));assert.deepEqual(saved.pastTasks.at(-1).task.workspaceRunBinding, originalBinding);
    assert.equal(saved.pastTasks.at(-1).usage.modelCalls, old.conversation.runUsage.modelCalls);
  } finally { await host.close();fs.rmSync(root, { recursive: true, force: true }); }
});
test("a real loopback provider 404 makes one request; continuation refuses without a second HTTP call or credential fallback", async () => {
  const root = temporary(), requests = [], server = createServer(async (request, response) => {
    let raw = "";for await (const chunk of request) raw += chunk;
    requests.push({ path: request.url, model: JSON.parse(raw).model });assert.equal(request.headers.authorization, "Bearer local-fixture-credential");
    response.writeHead(404, { "content-type": "application/json" });response.end(JSON.stringify({ error: { message: "The requested model does not support the agent plan feature" } }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const host = new LocalWorkspaceHost(root, { mode: "workspace", credentialVault: new MemoryCredentialVault(), legacySourceHome: root, hostHome: root });
  try {
    const w = host.createWorkspace("HTTP refusal", host.list().revision);
    host.configureConnection(w.workspaceId, { label: "Loopback fixture", provider: "openai", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-fixture-credential", defaultModel: "fixture-model" }, 0);
    const first = host.start("ui", w.workspaceId, w.selectedAgentId, "hello", randomUUID());await host.wait(first.runId);
    assert.equal(host.snapshot(w.workspaceId).conversation.resumeAdmission.reason, "connection_model_unavailable");
    assert.throws(() => host.start("ui", w.workspaceId, w.selectedAgentId, "/continue", randomUUID(), true), /no new model call/);
    assert.deepEqual(requests, [{ path: "/v1/chat/completions", model: "fixture-model" }]);
  } finally { await host.close();server.closeAllConnections();await new Promise(done => server.close(done));fs.rmSync(root, { recursive: true, force: true }); }
});
