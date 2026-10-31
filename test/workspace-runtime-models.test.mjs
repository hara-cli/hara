import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-runtime-models-"))); roots.push(value); return value; }
function binary(path) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex 1.2.3'; exit 0; fi
if [ "$1" = "app-server" ]; then
  if [ -f '${path}.appfail' ]; then exit 1; fi
  while IFS= read -r line; do
    case "$line" in
      *'"id":1,'*) echo '{"id":1,"result":{}}' ;;
      *'"id":2,'*) echo '{"id":2,"result":{"data":[{"id":"fixture-app","displayName":"Fixture App","isDefault":true}]}}' ;;
    esac
  done
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  if [ -f '${path}.fail' ]; then exit 1; fi
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
    assert.deepEqual((await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "opencode" })).models,
      [{ id: "openai/current", label: "openai/current" }, { id: "anthropic/next", label: "anthropic/next" }]);
    fs.writeFileSync(`${openCodeCommand}.fail`, "");
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "opencode" }), /inventory failed/);
    const listed = await client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" });
    assert.deepEqual(Object.keys(listed).sort(), ["models", "revision", "runtimeId", "selectedModelId"]);
    assert.equal(listed.selectedModelId, null); assert.equal(listed.revision, 0);
    assert.deepEqual(listed.models, [{ id: "fixture-app", label: "Fixture App", recommended: true }]);
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
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" }), /inventory failed/);
    await assert.rejects(client.request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "fixture-new", expectedRevision: 1 }), /inventory failed/);
    fs.mkdirSync(join(home, privateCodexHome, ".codex"), { mode: 0o700 });
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
    binary(command); fs.chmodSync(command, 0o755); fs.appendFileSync(command, "# changed\n");
    await assert.rejects(client.request("workspace.runtime.listModels", { ...scope, runtimeId: "codex" }), /not bound/);
  } finally { await client.close(); await handle.close(); }
});
