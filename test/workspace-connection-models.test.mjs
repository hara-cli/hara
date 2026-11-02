import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { listModelsWithSource } from "../dist/providers/models.js";
import { connectionModelEfforts } from "../dist/workspace/connection-models.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { WebSocket } from "ws";

const temporary = [];
after(() => temporary.forEach(path => fs.rmSync(path, { recursive: true, force: true })));
function dir() { const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-connection-models-"))); temporary.push(path); return path; }

test("reasoning choices follow known provider wire semantics and hide unknown models", () => {
  assert.deepEqual(connectionModelEfforts({ provider: "anthropic", baseURL: "https://api.anthropic.com" }, "claude-sonnet-4-5"),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(connectionModelEfforts({ provider: "anthropic", baseURL: "https://api.anthropic.com" }, "claude-opus-4-8"), ["off", "medium"]);
  assert.deepEqual(connectionModelEfforts({ provider: "openai", baseURL: "https://unknown.example/v1" }, "unknown-model"), []);
});

test("provider discovery keeps live results and labels 401, empty and timeout fallbacks", async () => {
  const baseURL = "https://coding.dashscope.aliyuncs.com/v1", key = "fixture-secret-never-return";
  const live = async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return new Response(JSON.stringify({ data: [{ id: "qwen3.7-plus" }, { id: "embed-embedding-v1" }, { id: "seedream-v1" }] }), { status: 200 });
  };
  const found = await listModelsWithSource(baseURL, key, live);
  assert.deepEqual(found, { source: "live", models: ["qwen3.7-plus"] });
  for (const fake of [
    async () => new Response("denied", { status: 401 }),
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    async () => { throw new DOMException("timed out", "TimeoutError"); },
  ]) {
    const result = await listModelsWithSource(baseURL, key, fake);
    assert.equal(result.source, "documented");
    assert(result.models.includes("qwen3.7-plus"));
    assert(!JSON.stringify(result).includes(key));
  }
  assert.deepEqual(await listModelsWithSource("https://unknown.example/v1", key, async () => new Response("denied", { status: 401 })),
    { source: "documented", models: [] });
  const agentPlan = await listModelsWithSource("https://ark.cn-beijing.volces.com/api/plan/v3", key,
    async () => new Response("denied", { status: 401 }));
  assert.equal(agentPlan.source, "documented");
  assert(agentPlan.models.includes("ark-code-latest"));
  const tokenPlan = await listModelsWithSource("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", key,
    async () => new Response("denied", { status: 401 }));
  assert.equal(tokenPlan.source, "documented");
  assert.deepEqual(tokenPlan.models, [], "Token Plan entitlement is key scoped and cannot be guessed");
});

test("Workspace authority lists one connection for main and colleague without returning its key", async () => {
  const key = "fixture-secret-never-return", root = dir(), hostHome = dir();
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-image-1" }, { id: `reflected-${key}` }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const host = new LocalWorkspaceHost(root, { mode: "workspace", hostHome, legacySourceHome: hostHome,
    credentialVault: new MemoryCredentialVault() });
  try {
    const workspace = host.createWorkspace("Personal", host.list().revision), workspaceId = workspace.workspaceId;
    host.select("client", workspaceId, host.list().revision);
    host.configureConnection(workspaceId, { label: "Fixture", provider: "openai",
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: key, defaultModel: "gpt-5.6-sol" }, 0);
    const view = host.snapshot(workspaceId, workspace.selectedAgentId), connectionId = view.connections.connections[0].id;
    const main = await host.listConnectionModels(workspaceId, workspace.selectedAgentId, connectionId);
    assert.equal(main.source, "live");
    assert.deepEqual(main.models.map(row => row.id), ["gpt-5.6-sol"]);
    assert.deepEqual(main.models[0].supportedReasoningEfforts, ["off", "low", "medium", "high", "xhigh", "max"]);
    assert(!JSON.stringify(main).includes(key));
    const resources = host.context(workspaceId).resources;
    const colleague = resources.agents.create({ username: "tester", profile: { displayName: "Tester" } }, resources.agents.list().revision);
    const colleagueModels = await host.listConnectionModels(workspaceId, colleague.agentId, connectionId);
    assert.deepEqual(colleagueModels.models, main.models);
    const frozen = host.context(workspaceId).connections.capture();
    host.selectConnection(workspaceId, connectionId, main.revision, "gpt-5.6-sol", "high");
    const selected = host.snapshot(workspaceId, colleague.agentId).connections;
    assert.equal(selected.connections[0].defaultModel, "gpt-5.6-sol");
    assert.equal(selected.connections[0].defaultReasoning, "high");
    assert.equal(host.context(workspaceId).connections.capture().reasoning, "high");
    assert.equal(frozen.reasoning, null, "an already frozen run keeps its original effort");
    assert.equal(host.context(workspaceId).connections.resolve(frozen).apiKey, key, "model selection leaves the credential generation usable");
    await assert.rejects(host.listConnectionModels(workspaceId, "ag_00000000-0000-4000-8000-000000000000", connectionId), /Pi agent unavailable/);
    assert.throws(() => host.selectConnection(workspaceId, connectionId, selected.revision, "gpt-5.6-sol", "ultra"), /reasoning effort/);
    assert(!JSON.stringify(host.snapshot(workspaceId, colleague.agentId)).includes(key));
  } finally { await host.close(); server.close(); await once(server, "close"); }
});

test("connection model RPC advertises capability, keeps key in Core, and selects without another vault write", async () => {
  const key = "rpc-secret-never-return", root = dir(), hostHome = dir();
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const memory = new MemoryCredentialVault(); let writes = 0;
  const vault = { get: ref => memory.get(ref), set(ref, value) { writes++; memory.set(ref, value); }, remove: ref => memory.remove(ref) };
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root, mode: "workspace", version: "fixture",
    hostHome, legacySourceHome: hostHome, credentialVault: vault });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); await once(socket, "open");
  let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(Error("RPC timeout")), 8000);
    const listener = raw => { const packet = JSON.parse(String(raw)); if (packet.id !== id) return;
      clearTimeout(timer); socket.off("message", listener); packet.error ? reject(Error(packet.error.message)) : resolve(packet.result); };
    socket.on("message", listener); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  try {
    const init = await request("initialize", { token: handle.token });
    assert(init.capabilities.includes("workspace.connection-models.v1"));
    const created = await request("workspace.create", { label: "Fixture", expectedRevision: init.workspace.revision });
    const scope = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration };
    const catalog = await request("workspace.list");
    await request("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: catalog.revision });
    await request("workspace.connection.add", { ...scope, expectedRevision: 0,
      input: { label: "Fixture", provider: "openai", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: key, defaultModel: "gpt-5.6-sol" } });
    const view = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    const connectionId = view.connections.connections[0].id, agentId = view.agents.find(row => row.kind === "main").agentId;
    const listed = await request("workspace.connection.listModels", { ...scope, agentId, connectionId });
    assert.equal(listed.source, "live");
    assert.deepEqual(listed.models.map(row => row.id), ["gpt-5.6-sol"]);
    assert(!JSON.stringify(listed).includes(key));
    await request("workspace.connection.select", { ...scope, connectionId, expectedRevision: listed.revision, modelId: "gpt-5.6-sol", effort: "high" });
    assert.equal(writes, 1, "model selection is metadata-only and never writes Keychain");
    const after = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId });
    assert.equal(after.connections.connections[0].defaultReasoning, "high");
    assert(!JSON.stringify(after).includes(key));
    await assert.rejects(request("workspace.connection.listModels", { ...scope, agentId, connectionId: "mc_00000000-0000-4000-8000-000000000000" }), /Connection unavailable/);
  } finally { socket.close(); await handle.close(); server.close(); await once(server, "close"); }
});
