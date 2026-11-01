import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceRuntimeModels } from "../dist/workspace/runtime-models.js";

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-runtime-models-"))); roots.push(value); return value; }
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("private inventory warm-up did not settle");
}
function binary(path) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex 1.2.3'; exit 0; fi
printf '%s\\n' "$*" >> '${path}.calls'
if [ -f '${path}.require-home' ] && [ ! -d "$CODEX_HOME" ]; then exit 2; fi
if [ "$1" = "app-server" ]; then
  if [ -f '${path}.appfail' ]; then echo 'DO_NOT_LEAK_NATIVE_DETAIL' >&2; exit 1; fi
  while IFS= read -r line; do
    case "$line" in
      *'"id":1,'*) echo '{"id":1,"result":{}}' ;;
      *'"id":2,'*)
        if [ -f '${path}.apprpcfail' ]; then
          echo '{"id":2,"error":{"code":-32601,"message":"DO_NOT_LEAK_NATIVE_DETAIL"}}'
        elif [ -f '${path}.appmodels' ]; then
          printf '{"id":2,"result":'; cat '${path}.appmodels'; printf '}\\n'
        else echo '{"id":2,"result":{"data":[{"id":"fixture-app","displayName":"Fixture App","isDefault":true}]}}'; fi ;;
    esac
  done
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  if [ -f '${path}.fail' ]; then echo 'DO_NOT_LEAK_NATIVE_DETAIL' >&2; exit 1; fi
  if [ -f '${path}.empty' ]; then echo '{"models":[]}'; exit 0; fi
  cat '${path}.models'; exit 0
fi
exit 1
`, { mode: 0o755 });
  fs.writeFileSync(`${path}.models`, JSON.stringify({ models: [
    { slug: "fixture-new", display_name: "Fixture New", description: "Bound binary model" },
    ...Array.from({ length: 8000 }, (_, i) => ({ slug: `fixture-${i}`, display_name: `Fixture ${i}` })),
    { slug: "hidden-only", display_name: "Hidden Only", visibility: "hide" },
  ] }));
}
function openCodeBinary(path) {
  fs.writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'opencode 1.2.3'; exit 0; fi
if [ "$1" = "models" ]; then
  if [ -f '${path}.fail' ]; then exit 1; fi
  printf 'openai/current\\nanthropic/next\\n'; exit 0
fi
exit 1
`, { mode: 0o755 });
}
async function connect(handle) {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); await once(socket, "open"); let nextId = 0;
  return { socket, request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => reject(new Error("RPC timeout")), 5000);
      function receive(raw) { const response = JSON.parse(String(raw)); if (response.id !== id) return;
        clearTimeout(timer); socket.off("message", receive); response.error ? reject(new Error(response.error.message)) : resolve(response.result); }
      socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }, async close() { const closed = once(socket, "close"); socket.close(); await closed; } };
}

test("runtime model RPC requires binding, persists a per-runtime choice, and leaves workspace connections untouched", async () => {
  const data = root(), discovery = root(), command = join(discovery, ".local/bin/codex"); binary(command);
  const openCodeCommand = join(discovery, ".local/bin/opencode"); openCodeBinary(openCodeCommand);
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root: data, mode: "workspace", version: "fixture",
    runtimeInstallerOptions: { discovery: { home: discovery, path: "/usr/bin:/bin", systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } } });
  const client = await connect(handle);
  try {
    const init = await client.request("initialize", { token: handle.token });
    const workspace = await client.request("workspace.create", { label: "Models", expectedRevision: init.workspace.revision });
    const scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
    const before = await client.request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" }), /not bound/);
    await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "o3", expectedRevision: 0 }), /not bound/);
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "other" }), /runtimeId/);
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, expectedGeneration: "stale", runtimeId: "codex" }), /generation/);
    const detected = await client.request("workspace.runtime.detect", scope);
    const codex = detected.options.find(row => row.runtimeId === "codex"); assert.equal(codex.state, "detected");
    const opencode = detected.options.find(row => row.runtimeId === "opencode"); assert.equal(opencode.state, "detected");
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" }), /not bound/);
    await client.request("workspace.runtime.registerLocal", { ...scope, runtimeId: "codex", fingerprint: codex.fingerprint, approved: true });
    await client.request("workspace.runtime.registerLocal", { ...scope, runtimeId: "opencode", fingerprint: opencode.fingerprint, approved: true });
    const registeredCache = await until(() => fs.readdirSync(join(data, "home"), { recursive: true })
      .find(name => name.endsWith("runtime-homes/codex/.codex/models_cache.json")));
    const warmedCache = join(data, "home", registeredCache);
    assert.equal(JSON.parse(fs.readFileSync(warmedCache, "utf8")).models[0].slug, "fixture-app", "registration warms private inventory");
    assert.deepEqual((await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "opencode" })).models,
      [{ id: "openai/current", label: "openai/current" }, { id: "anthropic/next", label: "anthropic/next" }]);
    fs.writeFileSync(`${openCodeCommand}.fail`, "");
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "opencode" }), /inventory failed/);
    const listed = await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert.deepEqual(Object.keys(listed).sort(), ["models", "revision", "runtimeId", "selectedModelId"]);
    assert.equal(listed.selectedModelId, null); assert.equal(listed.revision, 0);
    assert.deepEqual(listed.models, [{ id: "fixture-app", label: "Fixture App", recommended: true }]);
    fs.unlinkSync(warmedCache);
    const main = before.agents[0];
    await client.request("workspace.agents.setRuntime", { ...scope, agentId: main.agentId, runtimeId: "codex",
      configRevision: main.configRevision, agentEpoch: main.agentEpoch });
    await until(() => fs.existsSync(warmedCache));
    assert.equal(JSON.parse(fs.readFileSync(warmedCache, "utf8")).models[0].slug, "fixture-app", "binding warms private inventory");
    fs.writeFileSync(`${command}.appfail`, "");
    const debug = await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert(debug.models.some(row => row.id === "fixture-new")); assert.equal(debug.models.length, 8001);
    assert(listed.models.every(row => !Object.hasOwn(row, "connectionId")));
    for (const modelId of ["", "../o3", "o3;rm", "https://example.test/model", "unknown", "o3"]) {
      await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId, expectedRevision: 0 }), /modelId/);
    }
    await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, expectedGeneration: "stale", runtimeId: "codex", modelId: "o3", expectedRevision: 0 }), /generation/);
    assert.deepEqual(await client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "fixture-new", expectedRevision: 0 }), { selected: true });
    const chosen = await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert.equal(chosen.selectedModelId, "fixture-new"); assert.equal(chosen.revision, 1);
    fs.writeFileSync(`${command}.fail`, "");
    const home = join(data, "home");
    const privateCodexHome = fs.readdirSync(home, { recursive: true }).find(name => name.endsWith("runtime-homes/codex"));
    assert(privateCodexHome, "bound runtime private home exists");
    const cache = join(home, privateCodexHome, ".codex", "models_cache.json");
    assert.equal((await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" })).models.length, 8001);
    fs.unlinkSync(cache);
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" }), /app-server model\/list:.*debug models:.*cache missing/);
    await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "fixture-new", expectedRevision: 1 }), /cache missing/);
    fs.mkdirSync(join(home, privateCodexHome, ".codex"), { mode: 0o700, recursive: true });
    fs.writeFileSync(join(home, privateCodexHome, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "cached-only", display_name: "Cached Only" }] }));
    assert.deepEqual((await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" })).models,
      [{ id: "cached-only", label: "Cached Only" }]);
    fs.rmSync(`${command}.fail`); fs.writeFileSync(`${command}.empty`, "");
    assert.deepEqual((await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" })).models, []);
    await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "fixture-new", expectedRevision: 1 }), /modelId/);
    fs.rmSync(`${command}.empty`);
    await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "fixture-new", expectedRevision: 0 }), /revision/);
    const after = await client.request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    assert.deepEqual(after.connections, before.connections);
    const state = join(data, "home");
    const files = fs.readdirSync(state, { recursive: true }).filter(name => name.endsWith("runtime-models-v1.json"));
    assert.equal(files.length, 1);
    const stored = JSON.parse(fs.readFileSync(join(state, files[0]), "utf8"));
    assert.deepEqual(stored.selections.map(row => [row.runtimeId, row.selectedModelId, row.revision]), [["codex", "fixture-new", 1]]);
    const second = await client.request("workspace.create", { label: "Other", expectedRevision: (await client.request("workspace.list")).revision });
    await assert.rejects(client.request("workspace.runtime.listModels", { workspaceId: second.workspaceId, expectedGeneration: second.resourceGeneration, runtimeId: "codex" }), /not bound/);
    const otherScope = { workspaceId: second.workspaceId, expectedGeneration: second.resourceGeneration };
    fs.writeFileSync(`${command}.fail`, "");
    const otherCodex = (await client.request("workspace.runtime.detect", otherScope)).options.find(row => row.runtimeId === "codex");
    assert.deepEqual(await client.request("workspace.runtime.registerLocal", { ...otherScope, runtimeId: "codex",
      fingerprint: otherCodex.fingerprint, approved: true }), { registered: true }, "cold inventory does not block registration");
    const otherMain = (await client.request("workspace.snapshot", { workspaceId: second.workspaceId, agentId: null })).agents[0];
    const otherBound = await client.request("workspace.agents.setRuntime", { ...otherScope, agentId: otherMain.agentId, runtimeId: "codex",
      configRevision: otherMain.configRevision, agentEpoch: otherMain.agentEpoch });
    assert.equal(otherBound.runtime.id, "codex", "cold inventory does not block binding");
    await assert.rejects(client.request("workspace.runtime.listModels", { ...otherScope, runtimeId: "codex" }), /app-server model\/list:.*debug models:.*cache missing/);
    binary(command); fs.chmodSync(command, 0o755); fs.appendFileSync(command, "# changed\n");
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" }), /not bound/);
  } finally { await client.close(); await handle.close(); }
});

async function inventoryFixture() {
  const discovery = root(), command = join(discovery, ".local/bin/codex"); binary(command);
  const storage = new WorkspaceResourceStorage(root(), { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`,
    authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const runtimes = new WorkspaceRuntimeInstaller(storage, { discovery: { home: discovery, path: "/usr/bin:/bin", systemBins: [],
    run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } });
  await runtimes.discover();
  const detected = runtimes.list().options.find(row => row.runtimeId === "codex");
  runtimes.registerLocal("codex", detected.fingerprint);
  const models = new WorkspaceRuntimeModels(storage, runtimes);
  const { env } = runtimes.resolveBound("codex");
  return { discovery, command, storage, runtimes, models, env, cache: join(env.CODEX_HOME, "models_cache.json") };
}

test("an empty private Codex home can list live models and retain a selectable inventory across restart", async () => {
  const f = await inventoryFixture();
  try {
    fs.writeFileSync(`${f.command}.require-home`, "");
    assert(fs.statSync(f.env.CODEX_HOME).isDirectory(), "CODEX_HOME is created before launching Codex");
    assert(!fs.existsSync(f.cache));
    const listed = await f.models.list("codex");
    assert.deepEqual(listed.models, [{ id: "fixture-app", label: "Fixture App", recommended: true }]);
    assert(!fs.readFileSync(`${f.command}.calls`, "utf8").includes("debug models"), "app-server success short-circuits debug");
    assert.equal(fs.statSync(f.cache).mode & 0o777, 0o600);
    fs.writeFileSync(`${f.command}.appfail`, ""); fs.writeFileSync(`${f.command}.fail`, "");
    const reopened = new WorkspaceRuntimeModels(f.storage, f.runtimes);
    assert.deepEqual((await reopened.list("codex")).models, listed.models);
    await reopened.select("codex", "fixture-app", 0);
    assert.equal((await reopened.list("codex")).selectedModelId, "fixture-app");
    assert(!fs.existsSync(join(f.env.CODEX_HOME, "auth.json")), "inventory does not import credentials");
  } finally { await f.runtimes.close(); }
});

test("debug inventory warms only the private cache and preserves visibility/default metadata", async () => {
  const f = await inventoryFixture();
  try {
    fs.writeFileSync(`${f.command}.appfail`, "");
    fs.writeFileSync(`${f.command}.models`, JSON.stringify({ models: [
      { slug: "debug-current", display_name: "Debug Current", description: "Local model", isDefault: true, nativeSecret: "DO_NOT_COPY" },
      { slug: "hidden", display_name: "Hidden", visibility: "hide" },
    ] }));
    const expected = [{ id: "debug-current", label: "Debug Current", description: "Local model", recommended: true }];
    assert.deepEqual((await f.models.list("codex")).models, expected);
    assert(!fs.readFileSync(f.cache, "utf8").includes("DO_NOT_COPY"));
    fs.writeFileSync(`${f.command}.fail`, "");
    assert.deepEqual((await f.models.list("codex")).models, expected);
    await f.models.select("codex", "debug-current", 0);
    await assert.rejects(f.models.select("codex", "hidden", 1), /modelId/);
  } finally { await f.runtimes.close(); }
});

test("missing private cache reports every failed stage without reading the discovery/user home", async () => {
  const f = await inventoryFixture();
  try {
    const userCodex = join(f.discovery, ".codex"); fs.mkdirSync(userCodex, { mode: 0o700 });
    const userCache = join(userCodex, "models_cache.json");
    const content = JSON.stringify({ models: [{ slug: "ambient-only", display_name: "Must Not Read" }] });
    fs.writeFileSync(userCache, content);
    fs.writeFileSync(`${f.command}.apprpcfail`, ""); fs.writeFileSync(`${f.command}.fail`, "");
    await assert.rejects(f.models.list("codex"), error => {
      assert.match(error.message, /app-server model\/list: RPC error -32601; debug models: command failed \(code 1\); cache missing/);
      assert(!error.message.includes("DO_NOT_LEAK") && !error.message.includes(f.discovery)); return true;
    });
    assert.equal(fs.readFileSync(userCache, "utf8"), content);
    assert(!fs.existsSync(f.cache));
  } finally { await f.runtimes.close(); }
});

test("cache diagnostics distinguish invalid JSON/model data from unsafe filesystem entries", async () => {
  const f = await inventoryFixture();
  try {
    fs.writeFileSync(`${f.command}.appfail`, ""); fs.writeFileSync(`${f.command}.fail`, "");
    for (const content of ["{broken", '{"models":[{"slug":"../bad","display_name":"Bad"}]}',
      '{"models":[{"slug":"same","display_name":"A"},{"slug":"same","display_name":"B"}]}']) {
      fs.writeFileSync(f.cache, content);
      await assert.rejects(f.models.list("codex"), /app-server model\/list:.*debug models:.*cache invalid/);
    }
    fs.unlinkSync(f.cache);
    const external = join(root(), "models.json"), content = '{"models":[{"slug":"outside","display_name":"Outside"}]}';
    fs.writeFileSync(external, content);
    for (const kind of ["symlink", "hardlink", "directory", "oversize"]) {
      if (kind === "symlink") fs.symlinkSync(external, f.cache);
      if (kind === "hardlink") fs.linkSync(external, f.cache);
      if (kind === "directory") fs.mkdirSync(f.cache);
      if (kind === "oversize") fs.writeFileSync(f.cache, "x".repeat(4 * 1024 * 1024 + 1));
      await assert.rejects(f.models.list("codex"), /cache unsafe/);
      assert.equal(fs.readFileSync(external, "utf8"), content);
      fs.rmSync(f.cache, { recursive: true });
    }
  } finally { await f.runtimes.close(); }
});

test("invalid app-server/debug inventories fall back to a validated private cache", async () => {
  const f = await inventoryFixture();
  try {
    fs.writeFileSync(f.cache, '{"models":[{"slug":"private-cached","display_name":"Private Cached"},{"slug":"hidden","display_name":"Hidden","visibility":"hide"}]}');
    fs.writeFileSync(`${f.command}.appmodels`, '{"data":[{"id":"../bad","displayName":"Bad"}]}');
    fs.writeFileSync(`${f.command}.models`, "not JSON");
    assert.deepEqual((await f.models.list("codex")).models, [{ id: "private-cached", label: "Private Cached" }]);
    fs.unlinkSync(f.cache);
    await assert.rejects(f.models.list("codex"), /app-server model\/list: codex model inventory is invalid; debug models: invalid JSON; cache missing/);
    fs.writeFileSync(`${f.command}.models`, '{"models":[{"slug":"same","display_name":"A"},{"slug":"same","display_name":"B"}]}');
    await assert.rejects(f.models.list("codex"), /debug models: codex model inventory has duplicate IDs; cache missing/);
  } finally { await f.runtimes.close(); }
});

test("a successful live inventory refuses cache aliases without overwriting their targets", async () => {
  const f = await inventoryFixture();
  try {
    const external = join(root(), "unchanged.json"); fs.writeFileSync(external, "unchanged");
    fs.symlinkSync(external, f.cache);
    assert.equal((await f.models.list("codex")).models[0].id, "fixture-app");
    assert(fs.lstatSync(f.cache).isSymbolicLink());
    assert.equal(fs.readFileSync(external, "utf8"), "unchanged");
  } finally { await f.runtimes.close(); }
});
