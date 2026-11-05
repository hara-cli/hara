import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { normalizeRuntimeProxyUrl, runtimeProxyEnv, assertRuntimeProxyReachable, runtimeProxyFailureFromText } from "../dist/security/runtime-proxy.js";
import { WorkspaceRuntimeProxy } from "../dist/workspace/runtime-proxy.js";
import { WorkspaceRuntimeModels } from "../dist/workspace/runtime-models.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { classifyError, failoverAction } from "../dist/agent/failover.js";
import { legacyWorkspaceProviderFailure } from "../dist/workspace/provider-recovery.js";
import { parseOpenCodeRun } from "../dist/agent-runtime/opencode-cli.js";

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-runtime-proxy-"))); roots.push(path); return path; }
function storage(home = root()) {
  const value = new WorkspaceResourceStorage(home, { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } });
  value.initialize(); return value;
}
async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; }
function close(server) { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }

test("runtime proxy accepts only credential-free http(s) endpoints and uses fixed validation errors", () => {
  assert.equal(normalizeRuntimeProxyUrl(null), null); assert.equal(normalizeRuntimeProxyUrl(""), null);
  assert.equal(normalizeRuntimeProxyUrl("http://127.0.0.1:18888/"), "http://127.0.0.1:18888");
  assert.equal(normalizeRuntimeProxyUrl("https://[::1]:8888"), "https://[::1]:8888");
  for (const value of [undefined, {}, "socks5://localhost:7", "http://secret-user:secret-password@localhost", "http://localhost/path", "http://localhost?key=secret", "http://localhost#secret", "http://localhost/?", " http://localhost", "http://localhost\n", "http:localhost", "bad-secret-value"]) {
    assert.throws(() => normalizeRuntimeProxyUrl(value), error => error.message === "runtime_proxy_invalid");
  }
});

test("unset leaves every existing environment entry unchanged; explicit proxy overrides both cases without mutating the parent", () => {
  const ambient = { HTTP_PROXY: "http://old-a:1", https_proxy: "http://old-b:2", all_proxy: "socks5://old-c:3", No_PrOxY: "*,provider.invalid,127.0.0.2:9876", no_proxy: "localhost:1234,::1", KEEP: "yes" };
  assert.equal(runtimeProxyEnv(ambient, null), ambient);
  const original = structuredClone(ambient), env = runtimeProxyEnv(ambient, "http://127.0.0.1:18888");
  assert.deepEqual(ambient, original);
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.equal(env[name], "http://127.0.0.1:18888");
  assert.equal(env.NO_PROXY, env.no_proxy);
  const bypass = env.NO_PROXY.split(",");
  for (const value of ["localhost", "127.0.0.1", "::1", "[::1]", "127.0.0.2:9876", "localhost:1234"]) assert.ok(bypass.includes(value));
  assert.ok(!bypass.includes("*") && !bypass.includes("provider.invalid"));
  assert.equal(env.No_PrOxY, undefined); assert.equal(env.KEEP, "yes");
});

test("proxy settings persist per Workspace with revision conflicts and generation binding", () => {
  const a = storage(), b = storage(), first = new WorkspaceRuntimeProxy(a), second = new WorkspaceRuntimeProxy(b);
  assert.deepEqual(first.read(), { revision: 0, proxyUrl: null, readOnly: false });
  assert.equal(first.save("http://127.0.0.1:18888", 0).revision, 1);
  assert.equal(new WorkspaceRuntimeProxy(a).read().proxyUrl, "http://127.0.0.1:18888");
  assert.equal(second.read().proxyUrl, null);
  assert.throws(() => first.save(null, 0), /changed/);
  assert.equal(first.save(null, 1).proxyUrl, null);
  const checked = first.read(); first.save("http://127.0.0.1:18888", 2);
  assert.throws(() => first.applyChecked({ KEEP: "yes" }, checked), /proxy changed/);
});

for (const mode of ["damaged-source-null-backup", "future-schema", "missing-source-with-backup"]) test(`${mode}: a recovered/read-only proxy never becomes an unset direct launch`, async () => {
  const resource = storage(), settings = new WorkspaceRuntimeProxy(resource);
  settings.save("http://127.0.0.1:18888", 0);
  const file = resource.run(() => join(workspaceStateHome(), ".hara/runtime-proxy-v1.json")), backup = file.replace(".json", "-backup.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (mode === "damaged-source-null-backup") {
    fs.writeFileSync(file, "{damaged"); fs.writeFileSync(backup, JSON.stringify({ ...saved, proxyUrl: null }));
  } else if (mode === "future-schema") fs.writeFileSync(file, JSON.stringify({ ...saved, schemaVersion: 2 }));
  else fs.unlinkSync(file);
  assert.equal(settings.read().readOnly, true);
  assert.throws(() => settings.apply({ KEEP: "yes" }), error => error.message === "runtime_proxy_invalid");
  assert.throws(() => settings.applyWithEndpoint({ KEEP: "yes" }), error => error.message === "runtime_proxy_invalid");
  await assert.rejects(settings.check(), error => error.message === "runtime_proxy_invalid");
});

test("damaged settings without a usable backup produce a fixed non-fallback proxy error", async () => {
  const resource = storage(), settings = new WorkspaceRuntimeProxy(resource);
  settings.save("http://127.0.0.1:18888", 0);
  const file = resource.run(() => join(workspaceStateHome(), ".hara/runtime-proxy-v1.json"));
  fs.writeFileSync(file, "{damaged-secret-value"); fs.writeFileSync(file.replace(".json", "-backup.json"), "{also-damaged");
  assert.throws(() => settings.read(), error => error.code === "runtime_proxy_invalid");
  assert.throws(() => settings.apply({}), error => error.code === "runtime_proxy_invalid");
  await assert.rejects(settings.check(), error => error.code === "runtime_proxy_invalid");
});

test("an unreachable explicit proxy refuses before a runtime subprocess starts", async () => {
  const server = createServer(), endpoint = await listen(server); await close(server);
  await assert.rejects(assertRuntimeProxyReachable(endpoint), error => error.code === "runtime_proxy_unreachable");
  await assertRuntimeProxyReachable(null);
  const installer = new WorkspaceRuntimeInstaller(storage()); installer.proxy.save(endpoint, 0);
  await assert.rejects(installer.prepareBound("codex"), error => error.code === "runtime_proxy_unreachable");
  await installer.close();
});

test("proxy categories remain explicit through native errors and never select a provider/account fallback", async () => {
  for (const code of ["runtime_proxy_invalid", "runtime_proxy_unreachable", "runtime_proxy_failed"]) {
    const kind = classifyError(`[codex error] ${code}`);
    assert.equal(kind, "runtime_proxy");
    assert.equal(failoverAction(kind, { hasFallback: true, triedFallback: false, replaySafe: true, compatible: true, differentAccount: true }), "fail");
    assert.equal(legacyWorkspaceProviderFailure(`[codex error] ${code}`), null);
  }
  assert.equal(runtimeProxyFailureFromText("network econnreset", true), undefined);
  assert.equal(runtimeProxyFailureFromText("proxy connection failed SECRET_VALUE", false), undefined);
  assert.equal(runtimeProxyFailureFromText("proxy connection failed SECRET_VALUE", true), "runtime_proxy_failed");
  const result = await runExternalCommandCapture({ command: process.execPath, env: { PATH: process.env.PATH } },
    ["-e", "process.stderr.write('proxy connection failed SECRET_VALUE'); process.exitCode=1"], { proxyUrl: "http://127.0.0.1:9" });
  assert.equal(result.errorCode, "runtime_proxy_failed"); assert.ok(!JSON.stringify(result).includes("SECRET_VALUE"));
  assert.equal(parseOpenCodeRun({ ok: false, stdout: JSON.stringify({ type: "error", error: "proxy connection failed SECRET_VALUE" }), code: 1, timedOut: false }, true).errorMsg, "runtime_proxy_failed");
});

test("a registered runtime child sends HTTPS CONNECT to its Workspace proxy while its loopback tool bridge stays direct", { skip: process.platform === "win32" }, async () => {
  const resource = storage(), discovery = root(), bin = join(discovery, "bin"), command = join(bin, "codex"); fs.mkdirSync(bin);
  let loopbackCalls = 0; const connectTargets = [], directProxyRequests = [];
  const loopback = createServer((_request, response) => { loopbackCalls++; response.end("mcp-loopback-ok"); });
  const localUrl = await listen(loopback);
  const proxy = createServer((request, response) => { directProxyRequests.push(request.url); response.writeHead(502); response.end(); });
  proxy.on("connect", (request, socket) => { connectTargets.push(request.url); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  const endpoint = await listen(proxy), entry = import.meta.resolve("undici");
  fs.writeFileSync(command, `#!/usr/bin/env node\n(async()=>{const {fetch,EnvHttpProxyAgent}=await import(${JSON.stringify(entry)}); const dispatcher=new EnvHttpProxyAgent(); try {const local=await fetch(${JSON.stringify(localUrl)}, {dispatcher});console.log(await local.text());try {await fetch('https://runtime-provider.invalid/v1/read-only',{dispatcher,signal:AbortSignal.timeout(1500)});}catch {console.log('provider-proxy-refused');}}finally{await dispatcher.close();}})().catch(()=>{process.exitCode=1});\n`, { mode: 0o700 });
  const installer = new WorkspaceRuntimeInstaller(resource, { accountHome: () => discovery, discovery: { home: discovery, path: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, systemBins: [], run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } });
  try {
    await installer.discover(); const detected = installer.list().options.find(row => row.runtimeId === "codex");
    installer.registerLocal("codex", detected.fingerprint, "host"); installer.proxy.save(endpoint, 0);
    const resolved = await installer.prepareBound("codex");
    const result = await runExternalCommandCapture({ command: resolved.command, env: resolved.env }, [], { cwd: discovery, timeoutMs: 5000, proxyUrl: resolved.proxyUrl });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.match(result.stdout, /mcp-loopback-ok/); assert.match(result.stdout, /provider-proxy-refused/);
    assert.equal(loopbackCalls, 1); assert.ok(connectTargets.includes("runtime-provider.invalid:443"));
    assert.ok(connectTargets.every(value => value === "runtime-provider.invalid:443")); assert.deepEqual(directProxyRequests, []);
  } finally { await installer.close(); await close(proxy); await close(loopback); }
});

test("Codex inventory fallback rechecks a proxy saved during the async app-server query before spawning debug", { skip: process.platform === "win32" }, async () => {
  const resource = storage(), discovery = root(), bin = join(discovery, "bin"), command = join(bin, "codex"); fs.mkdirSync(bin);
  fs.mkdirSync(join(discovery,".codex/log"),{recursive:true,mode:0o700});
  const started = join(discovery, ".codex/log/app-server-started"), debug = join(discovery, ".codex/log/debug-spawned");
  fs.writeFileSync(command, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv[2]==='app-server'){fs.writeFileSync(${JSON.stringify(started)},'1');setTimeout(()=>process.exit(1),700);}else{fs.writeFileSync(${JSON.stringify(debug)},'1');console.log('{"models":[{"slug":"fake","display_name":"Fake"}]}');}\n`, { mode: 0o700 });
  const installer = new WorkspaceRuntimeInstaller(resource, { accountHome: () => discovery, discovery: { home: discovery, path: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, systemBins: [], run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } });
  try {
    await installer.discover(); installer.registerLocal("codex", installer.list().options.find(row => row.runtimeId === "codex").fingerprint, "host");
    const server = createServer(), endpoint = await listen(server); await close(server);
    const models = new WorkspaceRuntimeModels(resource, installer), pending = models.list("codex");
    // Attach a handler immediately; later refusal must not become an unhandled rejection while waiting.
    const checked = pending.then(value => ({ value }), error => ({ error }));
    for (let n = 0; n < 200 && !fs.existsSync(started); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(started)); installer.proxy.save(endpoint, 0);
    const result = await checked; assert.equal(result.error?.code, "runtime_proxy_unreachable");
    assert.equal(fs.existsSync(debug), false);
  } finally { await installer.close(); }
});

test("proxy RPC enforces explicit Workspace generation and revision without changing another Workspace", async () => {
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root: root(), version: "fixture" });
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); await once(socket, "open"); let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(new Error("RPC timeout")), 5000);
    const receive = raw => { const value = JSON.parse(String(raw)); if (value.id !== id) return; clearTimeout(timer); socket.off("message", receive); value.error ? reject(new Error(value.error.message)) : resolve(value.result); };
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  try {
    const init = await request("initialize", { token: handle.token }); assert.ok(init.capabilities.includes("workspace.runtime-proxy.v1"));
    const a = await request("workspace.create", { label: "Proxy A", expectedRevision: init.workspace.revision });
    const catalog = await request("workspace.list"); const b = await request("workspace.create", { label: "Proxy B", expectedRevision: catalog.revision });
    const scope = { workspaceId: a.workspaceId, expectedGeneration: a.resourceGeneration };
    assert.equal((await request("workspace.runtime.proxy.get", scope)).proxyUrl, null);
    const saved = await request("workspace.runtime.proxy.set", { ...scope, proxyUrl: "http://127.0.0.1:18888", expectedRevision: 0 });
    assert.equal(saved.revision, 1); assert.equal(saved.resourceGeneration, a.resourceGeneration);
    await assert.rejects(request("workspace.runtime.proxy.set", { ...scope, proxyUrl: null, expectedRevision: 0 }), /changed/);
    await assert.rejects(request("workspace.runtime.proxy.set", { ...scope, expectedGeneration: "stale", proxyUrl: null, expectedRevision: 1 }), /generation/);
    await assert.rejects(request("workspace.runtime.proxy.get", { workspaceId: a.workspaceId }), /generation/);
    await assert.rejects(request("workspace.runtime.proxy.set", { ...scope, proxyUrl: "http://secret:credential@127.0.0.1", expectedRevision: 1 }), error => error.message === "runtime_proxy_invalid");
    assert.equal((await request("workspace.runtime.proxy.get", { workspaceId: b.workspaceId, expectedGeneration: b.resourceGeneration })).proxyUrl, null);
  } finally { socket.close(); await once(socket, "close"); await handle.close(); }
});

test("fresh proxy environment and endpoint identity come from the same guarded read", () => {
  const settings = new WorkspaceRuntimeProxy(storage()), input = { KEEP: "owned", HTTP_PROXY: "http://old.invalid:1" };
  assert.deepEqual(settings.applyWithEndpoint(input), { env: input, proxyUrl: null });
  settings.save("http://127.0.0.1:18888", 0);
  const current = settings.applyWithEndpoint(input);
  assert.equal(current.proxyUrl, "http://127.0.0.1:18888");
  assert.equal(current.env.HTTP_PROXY, current.proxyUrl);
  assert.equal(current.env.HTTPS_PROXY, current.proxyUrl);
  assert.equal(input.HTTP_PROXY, "http://old.invalid:1");
  settings.save("http://127.0.0.1:18889", 1);
  const changed = settings.applyWithEndpoint(input);
  assert.equal(changed.proxyUrl, "http://127.0.0.1:18889");
  assert.equal(changed.env.HTTP_PROXY, changed.proxyUrl);
  assert.equal(current.proxyUrl, "http://127.0.0.1:18888", "a previous result cannot silently become a new configuration");
});
