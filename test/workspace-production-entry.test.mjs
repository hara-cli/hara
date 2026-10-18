import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { createWorkspaceSyntheticProvider, SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
const temporary = [];
function dir() { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-production-entry-"))); temporary.push(path); return path; }
after(() => { for (const path of temporary) fs.rmSync(path, { recursive: true, force: true }); });
async function until(check) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("Formal fixture did not settle"); }
test("formal six-step Host flow uses an explicit mock Provider; no DEV flags, lab markers or key-lane inheritance", async () => {
  const root = dir(), options = { mode: "workspace", credentialVault: new MemoryCredentialVault(), providerFactory: createWorkspaceSyntheticProvider }, host = new LocalWorkspaceHost(root, options);
  let restored;
  try {
    assert.equal(host.list().executionMode, "workspace"); assert.equal(host.list().syntheticOnly, false);
    const workspace = host.createWorkspace("Personal", host.list().revision), id = workspace.workspaceId, main = workspace.selectedAgentId;
    assert.throws(() => host.configureSynthetic(id, 0), /explicit isolated Lab/);
    assert.throws(() => host.start("client", id, main, "hello", randomUUID()), /connection/); assert.equal(host.snapshot(id).conversation.usage.modelCalls, 0);
    host.configureConnection(id, { ...SYNTHETIC_CONNECTION }, 0); host.select("client", id, host.list().revision);
    const hello = host.start("client", id, main, "hello", randomUUID()); await host.wait(hello.runId); assert.equal(host.snapshot(id).conversation.state, "completed");
    const create = host.start("client", id, main, "建立 Pi 同事 Coder", randomUUID()); const card = await until(() => host.snapshot(id, main, "client").approvals[0]);
    host.answerApproval("client", id, card.id, true); await host.wait(create.runId); assert.equal(host.snapshot(id).agents.length, 2);
    const task = host.start("client", id, main, "委派 Coder 生成 hello.md 並驗證", randomUUID()); await host.wait(task.runId);
    const before = host.snapshot(id, main, "client"); assert.equal(before.conversation.completion.state, "verified"); assert.equal(fs.readFileSync(join(root, "project", id, "hello.md"), "utf8"), "hello workspace\n");
    assert.equal(fs.existsSync(join(root, ".hara/workspace-dev-fixture.json")), false); assert.equal(JSON.parse(fs.readFileSync(join(root, ".hara/workspace-root-v1.json"))).kind, "hara-workspace");
    await host.close(); restored = new LocalWorkspaceHost(root, { mode: "workspace", providerFactory() { throw new Error("restart/read must not construct a provider"); } });
    assert.deepEqual(restored.snapshot(id, main, "client").conversation, before.conversation); assert.equal(restored.snapshot(id).agents.length, 2);
    assert.throws(() => new LocalWorkspaceHost(root), /different|isolated|identity|unmarked|marker|fixture/);
    assert.throws(() => new LocalWorkspaceHost(dir(), { mode: "workspace", realKeyFile: "/not-read" }), /cannot inherit/);
  } finally { await restored?.close(); await host.close(); }
});
test("formal protocol advertises only workspace.v1 and rejects Lab configuration and renderer-selected sources", async () => {
  const root = dir(), handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root, mode: "workspace", version: "test" });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); await once(socket, "open"); let serial = 0;
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { socket.off("message", message); reject(new Error("bounded formal RPC wait")); }, 3000);
    const message = raw => { const value = JSON.parse(String(raw)); if (value.id === id) { clearTimeout(timer); socket.off("message", message); value.error ? reject(new Error(value.error.message)) : resolve(value.result); } };
    socket.on("message", message); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  try {
    const init = await request("initialize", { token: handle.token }); assert.deepEqual(init.capabilities, ["workspace.v1"]); assert.equal(init.executionMode, "workspace");
    const workspace = await request("workspace.create", { label: "P", expectedRevision: init.workspace.revision }), scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
    await assert.rejects(request("workspace.connection.synthetic", { ...scope, expectedRevision: 0 }), /Lab/);
    await assert.rejects(request("workspace.runtime.propose", { ...scope, runtimeId: "codex", url: "http://127.0.0.1:9/tool" }), /unsupported/);
    const discovery = JSON.parse(fs.readFileSync(join(root, "home/.hara/workspace-runtime/serve-v2.json"))); assert.equal(discovery.capability, "workspace.v1"); assert.equal(discovery.executionMode, "workspace");
    assert.equal(fs.existsSync(join(root, "home/.hara/workspace-local-dev/serve-v2.json")), false);
  } finally { socket.terminate(); await handle.close(); }
});
test("actual formal CLI routes before legacy startup, never imports caller Home or accepts an ark key file", async () => {
  const root = dir(), home = dir(), execute = promisify(execFile), env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  const result = await execute(process.execPath, [resolve("dist/cli.js"), "workspace", "init", "--root", root], { env, cwd: dir() });
  assert.equal(JSON.parse(result.stdout).executionMode, "workspace"); assert.deepEqual(fs.readdirSync(home), []);
  await assert.rejects(execute(process.execPath, [resolve("dist/cli.js"), "workspace", "status", "--root", root, "--ark-key-file", "/not-read"], { env }));
  assert.deepEqual(fs.readdirSync(home), []);
});
test("formal default factory sends exactly the scoped fake credential/model to a loopback mock, never ambient keys", async () => {
  let received = [];
  const server = createServer(async (request, response) => { let raw = ""; for await (const bytes of request) raw += bytes; received.push({ auth: request.headers.authorization, body: JSON.parse(raw), url: request.url });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Local mock received" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const root = dir(), host = new LocalWorkspaceHost(root, { mode: "workspace", credentialVault: new MemoryCredentialVault() });
  try {
    const workspace = host.createWorkspace("Mock", host.list().revision);
    host.configureConnection(workspace.workspaceId, { label: "Mock only", provider: "openai", baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-fake-workspace-credential", defaultModel: "local-mock-model" }, 0);
    const run = host.start("client", workspace.workspaceId, workspace.selectedAgentId, "hello", randomUUID()); await host.wait(run.runId);
    assert.equal(host.snapshot(workspace.workspaceId).conversation.state, "completed"); assert.equal(received.length, 1); assert.equal(received[0].auth, "Bearer local-fake-workspace-credential"); assert.equal(received[0].body.model, "local-mock-model");
    assert.equal(JSON.stringify(host.snapshot(workspace.workspaceId)).includes("local-fake-workspace-credential"), false);
  } finally { await host.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
