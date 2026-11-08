// All workspace-mcp-owner-review cases. Thin test files register disjoint partitions so each stays well under the unchanged
// 120s per-file deadline on hosted Intel (target <= 60s per file). A case that is not listed in exactly one
// partition fails registration, so no case can be silently dropped.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRuntimeExecutionPolicy } from "../../dist/agent-runtime/execution-policy.js";
import { runExternalCommandCapture } from "../../dist/external-sessions/process.js";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../../dist/serve/local-workspace.js";
import { createServer } from "node:net";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { workspaceStateHome } from "../../dist/workspace/resource-context.js";
import { workspaceMcpToolName } from "../../dist/workspace/extension-manager.js";
import { WorkspaceMcpReviewLibrary } from "../../dist/workspace/extension-review-store.js";
import { projectHostMcpConfig } from "../../dist/workspace/extension-catalog.js";
const TEST_FILE_URL = new URL("../workspace-mcp-owner-review.test.mjs", import.meta.url).href;
export const PARTITIONS = Object.freeze({
  "workspace-mcp-owner-review.test.mjs": Object.freeze([
    "review revocation and identical-code reapproval cannot revive old two-level grants",
    "upstream catalog-change notification persists invalidation and cannot be cleared by reload",
  ]),
  "workspace-mcp-owner-review-fences.test.mjs": Object.freeze([
    "fixed code, config, proxy and library CAS fences reject stale owner records",
    "foreign clients, colleague sessions, A-B-A views and cancelled catalog inspections have no approval authority",
    "cancelling a real in-flight catalog read drains it without exposing an approvable result",
  ]),
  "workspace-mcp-owner-review-flow.test.mjs": Object.freeze([
    "actual discovery → code confirmation → tool catalog → CAS review → two grants → one-call card → stdio",
    "changed package automatically loses callable status and requires a new owner review",
    "authenticated owner RPC rejects launcher fields, wrong generation, nonowner and another client record",
    "HTTP/SSE/OAuth/environment sources and floating or shell launchers explain refusal without any startup",
    "a full native child cannot read, rewrite, replace or delete the owner review library",
    "owner library preserves malformed, future or backup-only files as read-only and CAS creates no library during read",
    "MCP-only launch projection never materializes credential/header values or unrelated configuration",
  ]),
});
const ASSIGNED = new Map(Object.entries(PARTITIONS).flatMap(([file, cases]) => cases.map(name => [name, file])));
if (ASSIGNED.size !== Object.values(PARTITIONS).flat().length) throw new Error("a case is listed in more than one partition");
export async function registerCases(file) {
  if (!Object.hasOwn(PARTITIONS, file)) throw new Error(`unknown partition ${file}`);
  const test = (name, ...rest) => {
    if (!ASSIGNED.has(name)) throw new Error(`case is not assigned to a partition: ${name}`);
    return ASSIGNED.get(name) === file ? nodeTest(name, ...rest) : undefined;
  };
const managed = (name, fn) => test(name, { skip: process.platform !== "darwin" && "Requires protected macOS stdio" }, fn);
const reply = text => ({ text, toolUses: [], stop: "end", usage: { input: 5, output: 2 } });
const call = (name, input) => ({ ...reply(""), toolUses: [{ id: randomUUID(), name, input }], stop: "tool_use" });
async function until(check) { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 35)); } throw Error("Bounded fixture wait expired"); }
function entries(root, filename) {
  const rows = []; if (!fs.existsSync(root)) return rows;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isDirectory()) rows.push(...entries(path, filename)); else if (item.name === filename) rows.push(...fs.readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); }
  return rows;
}
async function fixture(t, { extraServers = {}, catalogPatch = {}, callKey = "one" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-owner-review-")));
  const account = join(root, "account"), packageRoot = join(account, "fixed-package");
  fs.mkdirSync(join(account, ".hara"), { recursive: true, mode: 0o700 }); fs.mkdirSync(packageRoot, { mode: 0o700 });
  fs.copyFileSync(new URL("./fixtures/workspace-managed-mcp.mjs", TEST_FILE_URL), join(packageRoot, "server.mjs"));
  if (catalogPatch.listDelayMs) {
    const script = join(packageRoot, "server.mjs");
    fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace('  if (request.method === "tools/list")', '  if (request.method === "tools/list" && definition.listDelayMs) await new Promise(resolve => setTimeout(resolve, definition.listDelayMs));\n  if (request.method === "tools/list")'));
  }
  const tools = [{ name: "fixture_change", description: "Write synthetic isolated fixture state", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false }, annotations: { readOnlyHint: true } }];
  fs.writeFileSync(join(packageRoot, "catalog.json"), JSON.stringify({ tools, ...catalogPatch }));
  const config = join(account, ".hara/config.json"), servers = { fixture: { command: process.execPath, args: [join(packageRoot, "server.mjs")], packageRoot }, ...extraServers };
  const writeConfig = () => fs.writeFileSync(config, JSON.stringify({ mcpServers: servers, providers: { credential: "synthetic-private-skipped" } }), { mode: 0o600 }); writeConfig();
  fs.mkdirSync(join(root, "host"), { mode: 0o700 });
  const proxy = createServer(socket => socket.end());
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  let toolName, trace = [], turn = 0;
  const host = new LocalWorkspaceHost(join(root, "host"), { mcpReviewHome: account, providerFactory: (_connection, binding) => ({ id: "openai", model: binding.model, async turn(args) {
    trace.push(args);
    if (++turn === 1) return call("task_intake", { intent: "change", goal: "Write the synthetic fixture through its reviewed MCP tool", constraints: ["Only synthetic isolated state"], acceptance: ["Observe the upstream result"], steps: ["Call the fixture"] });
    if (turn === 2) return call(toolName, { key: callKey });
    return reply("The synthetic upstream result was observed.");
  } }) });
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = host.createWorkspace("Owner review fixture", host.list().revision), id = workspace.workspaceId;
  host.configureSynthetic(id, 0); host.select("owner", id, host.list().revision); host.setExtensionClientCapability("owner", true); host.setExtensionOwnerReviewCapability("owner", true);
  const context = host.context(id), before = context.resources.agents.get(workspace.selectedAgentId);
  const main = context.resources.agents.setPermissionTier(before.agentId, "controlled", before.configRevision, before.agentEpoch);
  context.runtimes.proxy.save(`http://127.0.0.1:${proxy.address().port}`, 0);
  const stateHome = context.storage.run(() => workspaceStateHome());
  const rows = () => host.mcpOwnerReviews("owner", id), fixtureRow = () => rows().sources.find(row => row.name === "fixture");
  const describe = row => host.describeMcpOwnerReview("owner", id, (row ?? fixtureRow()).recordId);
  const inspect = detail => host.inspectMcpOwnerReview("owner", id, detail.recordId, true);
  const approve = detail => host.approveMcpOwnerReview("owner", id, detail.recordId, true);
  const prepare = async () => { const detail = await inspect(describe()); assert.equal(detail.phase, "tools", JSON.stringify(detail)); return detail; };
  const grants = async () => {
    let view = host.workspaceExtensions(id), source = view.sources.find(row => row.name === "fixture");
    const input = { target: "workspace", sourceId: source.sourceId, sourceRevision: source.sourceRevision, enabled: true, allowedTools: source.tools.map(tool => tool.toolId) };
    const apply = change => { const proposal = host.proposeExtensions("owner", id, change, view.revision); view = host.approveExtensions("owner", id, proposal.proposalId, true, view.revision); };
    apply(input); apply({ ...input, target: "agent", agentId: main.agentId, agentEpoch: main.agentEpoch });
    toolName = workspaceMcpToolName(source.sourceId, source.tools[0].toolId); return source;
  };
  return { root, account, packageRoot, config, servers, writeConfig, host, id, main, stateHome, rows, fixtureRow, describe, inspect, approve, prepare, grants,
    allCalls: () => entries(stateHome, "calls.jsonl"), spawns: () => entries(stateHome, "lifecycle.jsonl"), read: () => host.snapshot(id, main.agentId, "owner"), trace };
}

managed("actual discovery → code confirmation → tool catalog → CAS review → two grants → one-call card → stdio", async t => {
  const f = await fixture(t), row = f.fixtureRow(); assert.equal(row.status, "candidate");
  assert.equal(fs.existsSync(join(f.account, ".hara/mcp-reviewed-v1.json")), false);
  const code = f.describe(row); assert.equal(code.phase, "code"); assert.match(code.binaryDigest, /^[a-f0-9]{64}$/); assert.match(code.packageDigest, /^[a-f0-9]{64}$/);
  assert.equal(code.packagePath, "~/fixed-package"); assert.ok(!JSON.stringify(code).includes(f.account)); assert.equal(code.network, "proxy_only"); assert.equal(code.credentials, "none");
  assert.equal(f.spawns().length, 0); assert.throws(() => f.host.approveMcpOwnerReview("owner", f.id, code.recordId, true), /review_changed/);
  const tools = await f.inspect(code); assert.equal(tools.phase, "tools", JSON.stringify(tools)); assert.equal(f.spawns().length, 1); assert.equal(f.allCalls().length, 0);
  assert.equal(tools.tools[0].name, "fixture_change"); assert.equal(tools.tools[0].effect, "exec", "readOnlyHint never grants read authority");
  assert.equal(tools.binaryDigest, code.binaryDigest); assert.equal(tools.packageDigest, code.packageDigest);
  const saved = f.approve(tools); assert.equal(saved.phase, "approved"); assert.equal(saved.revision, 1);
  const libraryFile = join(f.account, ".hara/mcp-reviewed-v1.json"), library = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
  assert.equal(fs.statSync(libraryFile).mode & 0o777, 0o600); assert.equal(library.records.length, 1); assert.equal(library.records[0].binaryDigest, code.binaryDigest);
  assert.equal(f.host.workspaceExtensions(f.id).sources[0].callable, false);
  const source = await f.grants(); assert.equal(f.host.agentExtensions(f.id, f.main.agentId, f.main.agentEpoch).sources[0].callable, true);
  const started = f.host.start("owner", f.id, f.main.agentId, "Write the synthetic fixture using the reviewed MCP tool.", randomUUID());
  const card = await until(() => f.read().approvals.find(item => item.kind === "extension_call")); assert.equal(f.allCalls().length, 0); assert.equal(card.draft.action, "exec");
  assert.throws(() => f.host.answerApproval("another-owner-view", f.id, card.id, true), /approval/);
  f.host.answerApproval("owner", f.id, card.id, true); await f.host.wait(started.runId);
  assert.equal(f.allCalls().length, 1); assert.equal(f.allCalls()[0].name, "fixture_change");
  const result = f.trace.flatMap(args => args.history.flatMap(message => message.role === "tool" ? message.results : [])).find(item => item.name === workspaceMcpToolName(source.sourceId, source.tools[0].toolId));
  assert.ok(result && !result.isError, JSON.stringify(f.read().conversation)); assert.match(result.content, /"verified":false/);
  assert.ok(f.trace.every(args => args.tools.every(tool => !/owner.review|review\.(approve|inspect|revoke)/u.test(tool.name))));
  assert.ok(f.spawns().every(row => !row.inheritedBridge && !row.inheritedProvider));
});

managed("review revocation and identical-code reapproval cannot revive old two-level grants", async t => {
  const f = await fixture(t); const first = f.approve(await f.prepare()); const source = await f.grants();
  const revoked = f.host.revokeMcpOwnerReview("owner", f.id, first.recordId, true); assert.equal(revoked.phase, "revoked"); assert.equal(revoked.revision, 2);
  assert.equal(f.host.workspaceExtensions(f.id).sources[0].callable, false); assert.equal(f.fixtureRow().status, "candidate");
  const second = f.approve(await f.prepare()); assert.equal(second.revision, 3);
  const current = f.host.workspaceExtensions(f.id).sources[0]; assert.notEqual(current.sourceRevision, source.sourceRevision); assert.equal(current.callable, false); assert.equal(current.status, "needs-review");
  const backup = JSON.parse(fs.readFileSync(join(f.account, ".hara/mcp-reviewed-v1-backup.json"), "utf8")); assert.equal(backup.revision, 3);
});

managed("fixed code, config, proxy and library CAS fences reject stale owner records", async t => {
  const f = await fixture(t), ready = await f.prepare();
  fs.appendFileSync(join(f.packageRoot, "server.mjs"), "\n// tampered after catalog inspection\n");
  assert.throws(() => f.approve(ready), /review_changed/); assert.equal(fs.existsSync(join(f.account, ".hara/mcp-reviewed-v1.json")), false);
  const next = await f.prepare(); f.servers.fixture.args.push("changed-launch"); f.writeConfig(); assert.throws(() => f.approve(next), /review_changed/);
  const changed = await f.prepare(), libraryFile = join(f.account, ".hara/mcp-reviewed-v1.json"); fs.writeFileSync(libraryFile, '{"schemaVersion":1,"revision":7,"records":[],"invalidated":{}}\n', { mode: 0o600 });
  assert.throws(() => f.approve(changed), /review_changed/); assert.equal(JSON.parse(fs.readFileSync(libraryFile)).revision, 7);
  const proxyReady = await f.prepare(); f.host.context(f.id).runtimes.proxy.save(null, 1); assert.throws(() => f.approve(proxyReady), /view_changed|proxy_unavailable/);
});

managed("changed package automatically loses callable status and requires a new owner review", async t => {
  const f = await fixture(t); f.approve(await f.prepare()); await f.grants(); assert.equal(f.fixtureRow().status, "reviewed");
  fs.appendFileSync(join(f.packageRoot, "server.mjs"), "\n// new package digest\n");
  assert.equal(f.fixtureRow().status, "stale"); assert.equal(f.host.workspaceExtensions(f.id).sources[0].callable, false);
  const newDetail = f.describe(); assert.equal(newDetail.canApprove, false); assert.equal(newDetail.canInspect, true); assert.equal(f.allCalls().length, 0);
});

managed("foreign clients, colleague sessions, A-B-A views and cancelled catalog inspections have no approval authority", async t => {
  const f = await fixture(t), ready = await f.prepare(), { host, id } = f;
  assert.deepEqual(host.mcpOwnerReviews("unknown", id).sources, []); assert.throws(() => host.approveMcpOwnerReview("unknown", id, ready.recordId, true), /owner_required/);
  host.setExtensionOwnerReviewCapability("other", true); host.select("other", id, host.list().revision); assert.throws(() => host.approveMcpOwnerReview("other", id, ready.recordId, true), /view_changed/);
  assert.throws(() => host.approveMcpOwnerReview("owner", id, ready.recordId, false), /owner_required/);
  const other = host.createWorkspace("Second fixture", host.list().revision); host.select("owner", other.workspaceId, host.list().revision); host.select("owner", id, host.list().revision);
  assert.throws(() => f.approve(ready), /view_changed/);
  const cancelled = f.describe(); host.cancelMcpOwnerReview("owner", id, cancelled.recordId); assert.throws(() => f.approve(cancelled), /view_changed/);
  const agents = host.context(id).resources.agents;
  const colleague = agents.create({ username: "review-colleague", profile: { displayName: "Synthetic colleague" }, description: "Synthetic fixture", instructions: "Synthetic fixture only" }, agents.list().revision);
  host.selectAgent("owner", id, colleague.agentId); assert.equal(f.rows().allowed, false);
  assert.throws(() => host.approveMcpOwnerReview("owner", id, ready.recordId, true), /owner_required/);
  host.setExtensionOwnerReviewCapability("owner", false); assert.equal(f.rows().allowed, false);
});

managed("HTTP/SSE/OAuth/environment sources and floating or shell launchers explain refusal without any startup", async t => {
  const f = await fixture(t, { extraServers: {
    http: { type: "http", url: "https://synthetic.invalid/mcp?token=never-decode" }, sse: { type: "sse", url: "https://synthetic.invalid/sse" },
    oauth: { command: process.execPath, oauth: { token: "synthetic-private" } }, env: { command: process.execPath, env: { PRIVATE: "synthetic-private" } },
    floating: { command: "npx", args: ["floating-package"] }, shell: { command: "/bin/sh", args: ["-c", "exit 0"] }
  } });
  for (const row of f.rows().sources.filter(item => item.name !== "fixture")) {
    const detail = f.describe(row); assert.equal(detail.phase, "failed"); assert.equal(detail.canApprove, false);
    assert.equal(detail.reason, ["http", "sse"].includes(row.name) ? "unsupported_transport" : ["env", "oauth"].includes(row.name) ? "credentials_unsupported" : "unsupported_command");
    assert.doesNotMatch(JSON.stringify(detail), /never-decode|synthetic-private/); assert.throws(() => f.approve(detail));
  }
  assert.equal(f.spawns().length, 0);
});

test("owner library preserves malformed, future or backup-only files as read-only and CAS creates no library during read", t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-review-library-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new WorkspaceMcpReviewLibrary(root, () => {}); assert.equal(library.read().readOnly, false); assert.equal(fs.existsSync(join(root, ".hara")), false);
  fs.mkdirSync(join(root, ".hara"), { mode: 0o700 }); const file = join(root, ".hara/mcp-reviewed-v1.json");
  for (const text of ['{broken', '{"schemaVersion":99,"records":[]}']) {
    fs.writeFileSync(file, text, { mode: 0o600 }); assert.equal(library.read().readOnly, true); assert.deepEqual(library.valid([]), []); assert.throws(() => library.revoke("workspace:fixture", 0, () => {}), /library_read_only/); assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  fs.renameSync(file, join(root, ".hara/mcp-reviewed-v1-backup.json")); assert.equal(library.read().readOnly, true); assert.equal(fs.existsSync(file), false);
});

test("MCP-only launch projection never materializes credential/header values or unrelated configuration", () => {
  const projected = projectHostMcpConfig('{"accounts":{"token":"SKIPPED-ACCOUNT"},"mcpServers":{"fixture":{"command":"node","args":["/fixed/server.mjs","--one"],"env":{"secret":"SKIPPED-ENV"},"headers":{"Authorization":"SKIPPED-HEADER"}}}}', true);
  assert.deepEqual(projected.fixture.args, ["/fixed/server.mjs", "--one"]); assert.equal(projected.fixture.requiresCredentials, true); assert.doesNotMatch(JSON.stringify(projected), /SKIPPED/);
  assert.equal(projectHostMcpConfig('{"mcpServers":{"remote":{"url":"SKIPPED-URL"}}}', true).remote.transport, "streamable-http");
});

managed("upstream catalog-change notification persists invalidation and cannot be cleared by reload", async t => {
  const f = await fixture(t, { callKey: "notify" }); f.approve(await f.prepare()); const source = await f.grants();
  const started = f.host.start("owner", f.id, f.main.agentId, "Write the synthetic fixture using the reviewed MCP tool.", randomUUID());
  const card = await until(() => f.read().approvals.find(row => row.kind === "extension_call")); f.host.answerApproval("owner", f.id, card.id, true); await f.host.wait(started.runId);
  assert.equal(f.allCalls().length, 1); assert.equal(f.fixtureRow().status, "stale"); assert.equal(f.host.workspaceExtensions(f.id).sources[0].callable, false);
  const file = join(f.account, ".hara/mcp-reviewed-v1.json"), state = JSON.parse(fs.readFileSync(file)); assert.equal(state.revision, 2); assert.match(state.invalidated[source.sourceId], /^[a-f0-9]{64}$/);
  const freshLibrary = new WorkspaceMcpReviewLibrary(f.account, () => {}); assert.deepEqual(freshLibrary.valid([state.records[0].source]), []);
});

managed("cancelling a real in-flight catalog read drains it without exposing an approvable result", async t => {
  const f = await fixture(t, { catalogPatch: { listDelayMs: 1000 } }), code = f.describe(), promise = f.inspect(code);
  await until(() => f.spawns().length === 1); f.host.cancelMcpOwnerReview("owner", f.id, code.recordId);
  const result = await promise; assert.equal(result.canApprove, false); assert.equal(f.allCalls().length, 0); assert.throws(() => f.approve(result), /view_changed/);
  assert.equal(fs.existsSync(join(f.account, ".hara/mcp-reviewed-v1.json")), false);
});

test("authenticated owner RPC rejects launcher fields, wrong generation, nonowner and another client record", async t => {
  const f = await fixture(t), serverRoot = join(f.root, "rpc"); fs.mkdirSync(serverRoot, { mode: 0o700 });
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: serverRoot }, { root: serverRoot, version: "synthetic-test", mcpReviewHome: f.account });
  const sockets = [], pending = new Map(); let nextId = 0;
  t.after(async () => { for (const socket of sockets) socket.terminate(); for (const item of pending.values()) clearTimeout(item.timer); await handle.close(); });
  const client = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`); sockets.push(socket); socket.on("error", () => {});
    socket.on("message", bytes => { const message = JSON.parse(String(bytes)), item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result); });
    await once(socket, "open");
    return (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error("bounded RPC wait")); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
  };
  const request = await client(); await assert.rejects(request("workspace.extensions.review.list"), /unauthorized/);
  let init = await request("initialize", { token: handle.token }); assert.ok(init.capabilities.includes("workspace.extensions.owner-review.v1"));
  const workspace = await request("workspace.create", { label: "Owner RPC", expectedRevision: init.workspace.revision }), scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
  let directory = await request("workspace.list"); await request("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: directory.revision });
  assert.equal((await request("workspace.extensions.review.list", scope)).allowed, false);
  await request("initialize", { token: handle.token, clientCapabilities: ["workspace.extensions.owner-review.v1"] });
  const row = (await request("workspace.extensions.review.list", scope)).sources[0], args = { ...scope, recordId: row.recordId };
  await assert.rejects(request("workspace.extensions.review.describe", { ...args, expectedGeneration: randomUUID() }), /generation/);
  for (const field of ["command", "args", "env", "sourceId", "tools", "expectedRevision"]) await assert.rejects(request("workspace.extensions.review.approve", { ...args, confirmed: true, [field]: "forbidden" }), /unsupported.*fields/);
  const code = await request("workspace.extensions.review.describe", args); assert.equal(code.canApprove, false);
  const other = await client(); await other("initialize", { token: handle.token, clientCapabilities: ["workspace.extensions.owner-review.v1"] }); directory = await request("workspace.list"); await other("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: directory.revision });
  await assert.rejects(other("workspace.extensions.review.approve", { ...args, confirmed: true }), /view_changed/);
  await request("workspace.extensions.review.cancel", args); await assert.rejects(request("workspace.extensions.review.inspect", { ...args, confirmed: true }), /view_changed/);
  assert.equal(f.allCalls().length, 0);
});

managed("a full native child cannot read, rewrite, replace or delete the owner review library", async t => {
  const f = await fixture(t), file = join(f.account, ".hara/mcp-reviewed-v1.json"), original = '{"schemaVersion":1,"revision":0,"records":[],"invalidated":{}}\n';
  fs.writeFileSync(file, original, { mode: 0o600 }); fs.mkdirSync(join(f.account, ".codex/sessions"), { recursive: true, mode: 0o700 });
  const work = f.host.context(f.id).project, policy = createRuntimeExecutionPolicy({ runtimeId: "codex", tier: "full-protected", accountHome: f.account, workRoot: work });
  try {
    const code = `const fs=require('fs'),file=${JSON.stringify(file)},work=${JSON.stringify(work)},o={};fs.writeFileSync(work+'/replacement','synthetic');for(const [key,fn] of Object.entries({read:()=>fs.readFileSync(file),write:()=>fs.writeFileSync(file,'tampered'),replace:()=>fs.renameSync(work+'/replacement',file),remove:()=>fs.unlinkSync(file)})){try{fn();o[key]=true}catch{o[key]=false}}console.log(JSON.stringify(o));`;
    const launch = policy.wrap({ command: process.execPath, args: ["-e", code], env: { PATH: "/usr/bin:/bin", HOME: f.account, CODEX_HOME: join(f.account, ".codex") } });
    const result = await runExternalCommandCapture(launch, launch.args, { timeoutMs: 10000, waitForClose: true, retainStdoutOnFailure: true });
    assert.equal(result.code, 0, result.errorCode); assert.deepEqual(JSON.parse(result.stdout), { read: false, write: false, replace: false, remove: false }); assert.equal(fs.readFileSync(file, "utf8"), original);
  } finally { await policy.close(); }
});
}
