import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { discoverWorkspaceExtensionSources, projectHostMcpConfig, readHostWorkspaceExtensionCatalog, validateExtensionCatalog } from "../dist/workspace/extension-catalog.js";
import { WorkspaceExtensions } from "../dist/workspace/extensions.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";

const roots = [];
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const root = () => { const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-extension-"))); roots.push(value); return value; };
function storage(home = root()) { const value = new WorkspaceResourceStorage(home, { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); value.initialize(); return value; }
const agentId = `ag_${randomUUID()}`;
function catalog() {
  const [source] = discoverWorkspaceExtensionSources({ hostId: "host", hostRevision: "1", globalServers: { docs: { command: "/private/fixture/node", description: "Synthetic documentation" } } });
  return [{ ...source, tools: [{ toolId: "read", name: "Read docs", description: "Synthetic read" }, { toolId: "search", name: "Search docs", description: "Synthetic search" }] }];
}
const change = (source, enabled = true, allowedTools = ["read"]) => ({ target: "workspace", sourceId: source.sourceId, sourceRevision: source.sourceRevision, enabled, allowedTools });
const assign = (source, enabled = true, allowedTools = ["read"], epoch = 1) => ({ ...change(source, enabled, allowedTools), target: "agent", agentId, agentEpoch: epoch });
function configured() { const resource = storage(), sources = catalog(), store = new WorkspaceExtensions(resource, sources); store.apply(change(sources[0]), 0); store.apply(assign(sources[0]), 1); return { resource, sources, store }; }

test("source discovery never accesses env, args, headers, URL or other plugin contributions; same names retain distinct identities", () => {
  const server = { command: "/Users/private/operator/node", description: "Use https://user:secret@private.invalid/path?token=hidden for documentation" };
  for (const key of ["env", "args", "headers", "url"]) Object.defineProperty(server, key, { enumerable: true, get() { throw Error(`secret field accessed: ${key}`); } });
  const rows = discoverWorkspaceExtensionSources({ hostId: "host", hostRevision: "revision", globalServers: { docs: server }, verifiedPlugins: [{ packageDigest: "a".repeat(64), servers: { docs: server } }] });
  assert.equal(rows.length, 2); assert.notEqual(rows[0].sourceId, rows[1].sourceId);
  assert.equal(rows[0].name, rows[1].name); assert.equal(rows[0].transport, "stdio");
  assert.doesNotMatch(JSON.stringify(rows), /secret|hidden|private.invalid|operator|env|headers/);
  assert.deepEqual(rows.map(row => row.tools), [[], []]);
  assert.throws(() => validateExtensionCatalog([rows[0], rows[0]]), /catalog/);
});

test("host config projection decodes only MCP metadata and rejects ambiguous or malformed JSON", () => {
  const projected = projectHostMcpConfig(JSON.stringify({ apiKey: "TOP_SECRET", profiles: [{ secret: "PROFILE_SECRET" }], mcpServers: { docs: { command: "node", args: ["ARGS_SECRET"], env: { TOKEN: "ENV_SECRET", NESTED: { a: [1, true, null] } }, description: "Safe docs" } } }));
  assert.equal(projected.docs.command, "node"); assert.doesNotMatch(JSON.stringify(projected), /SECRET|env|args|profiles/);
  for (const raw of ['{"mcpServers":{},"mcpServers":{}}', '{"env":"bad\\q"}', '{"env":"bad\nline"}', '{"env":undefined}', '[]', '{"mcpServers":{}} trailing']) assert.throws(() => projectHostMcpConfig(raw));
});

test("isolated Host discovery lists verified manifests without activation and invalidates configuration metadata changes", () => {
  const home = root(), dir = join(home, ".hara"), plugin = join(dir, "plugins", "fixture"); fs.mkdirSync(plugin, { recursive: true, mode: 0o700 });
  const config = join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { docs: { command: "node", env: { TOKEN: "ENV_SECRET" }, args: ["ARGS_SECRET"] } } }), { mode: 0o600 });
  fs.writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "fixture", mcpServers: { docs: { command: "node", args: ["server.mjs"], env: { TOKEN: "PLUGIN_SECRET" } } } }));
  fs.writeFileSync(join(plugin, "server.mjs"), 'throw Error("MUST_NOT_EXECUTE")');
  fs.mkdirSync(join(dir, "plugins", "invalid")); fs.writeFileSync(join(dir, "plugins", "invalid", "plugin.json"), "{broken");
  const rows = readHostWorkspaceExtensionCatalog(home, "fixture-host"); assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|server.mjs|MUST_NOT_EXECUTE|env|args/);
  const old = rows.find(row => row.kind === "global").sourceRevision;
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { docs: { command: "node", env: { TOKEN: "CHANGED_SECRET" }, args: ["changed"] } } }));
  assert.notEqual(readHostWorkspaceExtensionCatalog(home, "fixture-host").find(row => row.kind === "global").sourceRevision, old);
  fs.symlinkSync(config, join(dir, "alias")); fs.renameSync(config, config + ".saved"); fs.symlinkSync(config + ".saved", config);
  assert.throws(() => readHostWorkspaceExtensionCatalog(home, "fixture-host"), error => error.message === "Extension source discovery unavailable");
});

test("new Workspace, colleagues and main Hara default off; enabling the space alone grants no tools", () => {
  const sources = catalog(), store = new WorkspaceExtensions(storage(), sources);
  assert.equal(store.list().revision, 0); assert.equal(store.list().sources[0].enabled, false); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  assert.throws(() => store.apply(assign(sources[0]), 0), /Workspace first/);
  store.apply(change(sources[0], true, ["read", "search"]), 0); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  store.apply(assign(sources[0], true, []), 1); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  store.apply(assign(sources[0], true, ["read"]), 2); assert.deepEqual(store.snapshot(agentId, 1).tools.map(row => row.toolId), ["read"]);
  assert.deepEqual(store.snapshot(`ag_${randomUUID()}`, 1).tools, []);
  assert.throws(() => store.apply(assign(sources[0], true, ["unreviewed-tool"]), 3), /catalog/);
});

test("agent tool sets must be explicit subsets and never inherit wildcard/null/new catalog tools", () => {
  const { sources, store } = configured();
  assert.throws(() => store.apply(assign(sources[0], true, ["search"]), 2), /Workspace first/);
  for (const allowedTools of [null, "*", ["*"], ["read", "read"]]) assert.throws(() => store.apply({ ...assign(sources[0]), allowedTools }, 2));
  const next = [{ ...sources[0], tools: [...sources[0].tools, { toolId: "new", name: "New", description: "Added later" }] }];
  const old = store.snapshot(agentId, 1); store.refreshCatalog(next);
  assert.equal(store.list().sources[0].status, "needs-review"); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  assert.throws(() => store.assertCurrentTool(old, sources[0].sourceId, "read", 1), /changed/);
});

test("revocation and allowlist narrowing reject old snapshots on every dispatch; expansion needs a new snapshot", () => {
  const { sources, store } = configured(), snapshot = store.snapshot(agentId, 1), sourceId = sources[0].sourceId;
  store.assertCurrentTool(snapshot, sourceId, "read", 1);
  store.apply(assign(sources[0], false), 2); assert.throws(() => store.assertCurrentTool(snapshot, sourceId, "read", 1), /changed/);
  store.apply(assign(sources[0]), 3); const resumed = store.snapshot(agentId, 1);
  store.apply(change(sources[0], true, []), 4); assert.throws(() => store.assertCurrentTool(resumed, sourceId, "read", 1), /changed/);
  store.apply(change(sources[0], true, ["read", "search"]), 5); const beforeExpansion = store.snapshot(agentId, 1);
  store.apply(assign(sources[0], true, ["read", "search"]), 6);
  assert.throws(() => store.assertCurrentTool(beforeExpansion, sourceId, "search", 1), /changed/);
  const expanded = store.snapshot(agentId, 1); store.assertCurrentTool(expanded, sourceId, "search", 1);
  store.apply(change(sources[0], false), 7); assert.throws(() => store.assertCurrentTool(expanded, sourceId, "read", 1), /changed/);
});

test("turning a source off preserves its explicit selections while blocking every effective tool", () => {
  const { sources, store } = configured(); store.apply(change(sources[0], false), 2);
  assert.deepEqual(store.list().sources[0].allowedTools, ["read"]); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  store.apply(change(sources[0]), 3); assert.equal(store.snapshot(agentId, 1).tools.length, 1);
});

test("a rejected catalog refresh fails closed until a valid Host catalog is explicitly restored", () => {
  const { sources, store } = configured(), snapshot = store.snapshot(agentId, 1);
  assert.throws(() => store.refreshCatalog([{ ...sources[0], transport: "invalid" }]), /descriptor/);
  assert.equal(store.list().readOnly, true); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  assert.throws(() => store.assertCurrentTool(snapshot, sources[0].sourceId, "read", 1), /changed/);
  store.refreshCatalog(sources); assert.equal(store.snapshot(agentId, 1).tools.length, 1);
});

test("snapshots are immutable, cannot be forged/shared across Workspaces, and lose authority on epoch changes", () => {
  const { sources, store } = configured(), snapshot = store.snapshot(agentId, 1), other = configured().store;
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.tools) && Object.isFrozen(snapshot.tools[0]));
  assert.throws(() => store.assertCurrentTool({ ...snapshot }, sources[0].sourceId, "read", 1), /unavailable/);
  assert.throws(() => other.assertCurrentTool(snapshot, sources[0].sourceId, "read", 1), /unavailable/);
  assert.throws(() => store.assertCurrentTool(snapshot, sources[0].sourceId, "read", 2), /unavailable/);
  assert.deepEqual(store.snapshot(agentId, 2).tools, []);
});

test("permissions persist in a separate Workspace domain, preserve old data, and enforce CAS without partial writes", () => {
  const resource = storage(), sources = catalog(), file = resource.run(() => join(workspaceStateHome(), ".hara/workspace-features-v1.json"));
  fs.writeFileSync(file, "legacy-sentinel", { mode: 0o600 });
  const store = new WorkspaceExtensions(resource, sources); store.apply(change(sources[0]), 0); store.apply(assign(sources[0]), 1);
  const reopened = new WorkspaceExtensions(resource, sources); assert.equal(reopened.list().revision, 2); assert.equal(reopened.snapshot(agentId, 1).tools.length, 1);
  assert.throws(() => reopened.apply(change(sources[0], false), 1), /changed/); assert.equal(reopened.list().revision, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "legacy-sentinel");
  const state = resource.run(() => join(workspaceStateHome(), ".hara/workspace-extensions-v1.json"));
  assert.doesNotMatch(fs.readFileSync(state, "utf8"), /env|args|private\/fixture|credential|token/);
});

for (const mode of ["future", "damaged", "missing-with-backup"]) test(`${mode}: preserved extension state is read-only and grants no tools`, () => {
  const { resource, sources, store } = configured(), file = resource.run(() => join(workspaceStateHome(), ".hara/workspace-extensions-v1.json"));
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (mode === "future") fs.writeFileSync(file, JSON.stringify({ ...data, schemaVersion: 2 }));
  else if (mode === "damaged") fs.writeFileSync(file, "{broken"); else fs.unlinkSync(file);
  assert.equal(store.list().readOnly, true); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  assert.throws(() => store.apply(change(sources[0], false), 2), /read-only/);
});

test("missing/changed source identities cannot reuse same-name authorization; revocation remains possible", () => {
  const { sources, store } = configured(); store.refreshCatalog([]);
  assert.equal(store.list().sources[0].status, "unavailable"); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
  store.apply(change(sources[0], false), 2);
  store.refreshCatalog([{ ...sources[0], kind: "plugin", sourceId: `plugin:${"b".repeat(64)}:docs` }]);
  const plugin = store.list().sources.find(row => row.kind === "global" ? false : true);
  assert.equal(plugin.enabled, false); assert.deepEqual(store.snapshot(agentId, 1).tools, []);
});

test("authenticated catalog RPC requires exact scope, proposal approval, current revision/epoch and owning client", async () => {
  const path = root(), sources = catalog(); let modelCalls = 0;
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: path }, { root: path, version: "test", extensionCatalog: () => sources,
    providerFactory() { modelCalls++; throw Error("No model should start"); } });
  const sockets = [], pending = new Map(); let id = 0;
  const client = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); sockets.push(socket); socket.on("error", () => {});
    socket.on("message", raw => { const message = JSON.parse(String(raw)), item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); });
    await once(socket, "open");
    return (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id, timer = setTimeout(() => reject(Error("bounded RPC wait")), 30000);
      pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })); });
  };
  try {
    const request = await client(); await assert.rejects(request("workspace.extensions.list", {}), /unauthorized/);
    const init = await request("initialize", { token: handle.token }); assert.ok(init.capabilities.includes("workspace.extensions.v1"));
    const a = await request("workspace.create", { label: "A", expectedRevision: init.workspace.revision });
    let directory = await request("workspace.list"); await request("workspace.select", { workspaceId: a.workspaceId, expectedRevision: directory.revision });
    const scope = { workspaceId: a.workspaceId, expectedGeneration: a.resourceGeneration }, main = a.agents.find(row => row.kind === "main");
    assert.equal((await request("workspace.extensions.list", scope)).revision, 0);
    assert.equal((await request("workspace.extensions.describe", { ...scope, sourceId: sources[0].sourceId })).sources.length, 1);
    await assert.rejects(request("workspace.extensions.list", { ...scope, expectedGeneration: randomUUID() }), /generation/);
    await assert.rejects(request("workspace.extensions.propose", { ...scope, change: { ...change(sources[0]), env: { SECRET: "no" } }, expectedRevision: 0 }), /Invalid/);
    const proposal = await request("workspace.extensions.propose", { ...scope, change: change(sources[0]), expectedRevision: 0 });
    assert.equal((await request("workspace.extensions.list", scope)).sources[0].enabled, false);
    await assert.rejects(request("workspace.extensions.approve", { ...scope, proposalId: proposal.proposalId, approved: "yes", expectedRevision: 0 }), /approval/);
    const other = await client(); await other("initialize", { token: handle.token }); directory = await request("workspace.list");
    await other("workspace.select", { workspaceId: a.workspaceId, expectedRevision: directory.revision });
    await assert.rejects(other("workspace.extensions.approve", { ...scope, proposalId: proposal.proposalId, approved: true, expectedRevision: 0 }), /unavailable/);
    const enabled = await request("workspace.extensions.approve", { ...scope, proposalId: proposal.proposalId, approved: true, expectedRevision: 0 }); assert.equal(enabled.revision, 1);
    await assert.rejects(request("workspace.extensions.approve", { ...scope, proposalId: proposal.proposalId, approved: true, expectedRevision: 0 }), /unavailable/);
    const rejected = await request("workspace.extensions.propose", { ...scope, change: change(sources[0], false), expectedRevision: 1 });
    const unchanged = await request("workspace.extensions.approve", { ...scope, proposalId: rejected.proposalId, approved: false, expectedRevision: 1 });
    assert.equal(unchanged.revision, 1); assert.equal(unchanged.sources[0].enabled, true);
    const agentChange = { ...assign(sources[0]), agentId: main.agentId, agentEpoch: main.agentEpoch };
    await assert.rejects(request("workspace.agents.extensions.list", { ...scope, agentId: main.agentId, agentEpoch: main.agentEpoch + 1 }), /changed/);
    let grant = await request("workspace.extensions.propose", { ...scope, change: agentChange, expectedRevision: 1 });
    const assigned = await request("workspace.extensions.approve", { ...scope, proposalId: grant.proposalId, approved: true, expectedRevision: 1 });
    assert.deepEqual(assigned.sources[0].effectiveTools, ["read"]);
    await assert.rejects(request("workspace.extensions.propose", { ...scope, change: agentChange, expectedRevision: 1 }), /changed/);
    const stale = await request("workspace.extensions.propose", { ...scope, change: change(sources[0], false), expectedRevision: 2 });
    directory = await request("workspace.list"); const b = await request("workspace.create", { label: "B", expectedRevision: directory.revision }); directory = await request("workspace.list");
    await request("workspace.settings.select", { workspaceId: b.workspaceId, expectedRevision: directory.revision });
    await assert.rejects(request("workspace.extensions.approve", { ...scope, proposalId: stale.proposalId, approved: true, expectedRevision: 2 }), /view|unavailable/);
    assert.equal((await request("workspace.extensions.list", { workspaceId: b.workspaceId, expectedGeneration: b.resourceGeneration })).sources[0].enabled, false);
    assert.equal(modelCalls, 0);
  } finally { for (const item of pending.values()) clearTimeout(item.timer); sockets.forEach(socket => socket.terminate()); await handle.close(); }
});
