import { observeCodexAttempts } from "./helpers/codex-attempt-probe.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { writeManagedMcpCli } from "./helpers/managed-mcp-clis.mjs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { prepareWorkspaceMcpReview, restoreWorkspaceMcpReview, assertWorkspaceMcpReviewCurrent, workspaceMcpReviewPlan } from "../dist/workspace/extension-review.js";
import { ManagedMcpStdioTransport, managedMcpEnvironment } from "../dist/workspace/extension-process.js";
import { createWorkspaceExtensionApproval, approveWorkspaceExtension } from "../dist/workspace/extension-binding.js";
import { WorkspaceMcpManager, workspaceMcpToolName } from "../dist/workspace/extension-manager.js";
import { WorkspaceExtensions } from "../dist/workspace/extensions.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { createWorkspaceMcpEndpoint } from "../dist/agent-runtime/registered-cli-mcp.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";

const managedTest = (name, body) => test(name, { skip: process.platform !== "darwin" && "Protected stdio requires macOS Seatbelt" }, body);
const ownedRoots = [];
after(() => ownedRoots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = text => ({ text, toolUses: [], stop: "end", usage: { input: 10, output: 4 } });
const call = (name, input = {}) => ({ text: "", toolUses: [{ id: randomUUID(), name, input }], stop: "tool_use", usage: { input: 10, output: 4 } });
const intake = { intent: "investigate", goal: "Read the fixed synthetic MCP data", constraints: ["Only the reviewed synthetic server"], acceptance: ["Observe the synthetic result"], steps: ["Read the fixture"] };
async function listen(t) {
  let connections = 0; const server = createServer(socket => { connections++; socket.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, count: () => connections, close: () => new Promise(resolve => server.close(resolve)) };
}
async function fixture(t, patch = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-mcp-manager-")));
  ownedRoots.push(root);
  const proxy = await listen(t), direct = await listen(t), packageRoot = join(root, "package"), account = join(root, "account");
  fs.mkdirSync(packageRoot, { mode: 0o700 }); fs.mkdirSync(join(account, ".codex"), { recursive: true, mode: 0o700 });
  const credentialCanary = join(account, ".codex/auth.json"); fs.writeFileSync(credentialCanary, '{"fixture":"synthetic-only"}', { mode: 0o600 });
  const schema = { type: "object", properties: { key: { type: "string", enum: ["one", "two", "boundaries", "notify", "delay", "crash", "secret", "huge"] } }, required: ["key"], additionalProperties: false };
  const tools = [{ toolId: "read", remoteName: "fixture_read", description: "Read fixed synthetic MCP data", inputSchema: schema, effect: "read" },
    { toolId: "change", remoteName: "fixture_change", description: "Write only synthetic isolated MCP state", inputSchema: schema, effect: "exec" }];
  const foreignWorkspaceCanary = join(root, "foreign-workspace.txt"); fs.writeFileSync(foreignWorkspaceCanary, "synthetic-other-workspace", { mode: 0o600 });
  const catalog = { foreignWorkspaceCanary, tools: tools.map(tool => ({ name: tool.remoteName, description: tool.description, inputSchema: tool.inputSchema })), credentialCanary, proxyPort: proxy.port, directPort: direct.port, ...patch };
  fs.copyFileSync(new URL("./fixtures/workspace-managed-mcp.mjs", import.meta.url), join(packageRoot, "server.mjs"));
  fs.writeFileSync(join(packageRoot, "catalog.json"), JSON.stringify(catalog));
  const source = { sourceId: "workspace:" + randomUUID(), kind: "workspace", name: "Synthetic MCP", transport: "stdio", executableSummary: "stdio · node", description: "Only task-owned synthetic data", sourceRevision: "a".repeat(64), tools: [] };
  const record = prepareWorkspaceMcpReview({ source, command: fs.realpathSync(process.execPath), args: [join(packageRoot, "server.mjs")], packageRoot, tools });
  const reviewed = restoreWorkspaceMcpReview(record);
  return { root, proxy, direct, packageRoot, account, record, reviewed, source, tools };
}
function ownedRoot(root) { for (const name of ["home", "config", "cache", "state", "tmp"]) fs.mkdirSync(join(root, name), { recursive: true, mode: 0o700 }); return root; }
async function until(check, description = "fixture state") {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(30); }
  throw Error("Bounded wait did not reach " + description);
}
function allCalls(host, workspaceId) {
  const root = host.context(workspaceId).storage.run(() => join(workspaceStateHome(), ".hara/extension-processes"));
  const rows = [];
  const walk = path => { if (!fs.existsSync(path)) return; for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name); if (entry.isDirectory()) walk(target); else if (entry.name === "calls.jsonl") rows.push(...fs.readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  } }; walk(root); return rows;
}

test("Host review binds actual binary/package/schema digests; metadata alone, secrets and changed files cannot become executable", async t => {
  const f = await fixture(t);
  assertWorkspaceMcpReviewCurrent(f.reviewed);
  if (process.platform !== "win32") {
    const pipe = join(f.packageRoot, "synthetic-pipe"); execFileSync("/usr/bin/mkfifo", [pipe], { env: { PATH: "/usr/bin:/bin" } });
    assert.throws(() => prepareWorkspaceMcpReview({ source: f.source, command: fs.realpathSync(process.execPath), args: [], packageRoot: f.packageRoot, tools: f.tools }), /unreviewed/);
    fs.unlinkSync(pipe);
  }
  assert.throws(() => prepareWorkspaceMcpReview({ source: f.source, command: join(f.account, ".codex/auth.json"), args: [], packageRoot: f.packageRoot, tools: f.tools }), /unreviewed/);
  const secretRoot = join(f.root, ".aws"); fs.mkdirSync(secretRoot); fs.writeFileSync(join(secretRoot, "config"), "synthetic-only");
  assert.throws(() => prepareWorkspaceMcpReview({ source: f.source, command: fs.realpathSync(process.execPath), args: [], packageRoot: secretRoot, tools: f.tools }), /unreviewed/);
  assert.throws(() => restoreWorkspaceMcpReview({ ...f.record, binaryDigest: "0".repeat(64) }), /stale/);
  assert.throws(() => workspaceMcpReviewPlan({ descriptor: f.reviewed.descriptor }), /unreviewed/);
  assert.throws(() => restoreWorkspaceMcpReview({ ...f.record, env: { TOKEN: "synthetic-secret" } }), /unreviewed/);
  assert.throws(() => restoreWorkspaceMcpReview({ ...f.record, args: ["--api-key=synthetic-secret"] }), /unreviewed/);
  fs.appendFileSync(join(f.packageRoot, "server.mjs"), "\n// changed after review\n");
  assert.throws(() => assertWorkspaceMcpReviewCurrent(f.reviewed), /stale/);
  assert.throws(() => restoreWorkspaceMcpReview(f.record), /stale/);
});

managedTest("real protected stdio reuses one owned server, excludes credentials and enforces proxy-only egress", async t => {
  const parentEnv = { HARA_WORKSPACE_MCP_TOKEN: process.env.HARA_WORKSPACE_MCP_TOKEN, SYNTHETIC_PROVIDER_SECRET: process.env.SYNTHETIC_PROVIDER_SECRET };
  process.env.HARA_WORKSPACE_MCP_TOKEN = "synthetic-parent-bridge-only"; process.env.SYNTHETIC_PROVIDER_SECRET = "synthetic-parent-provider-only";
  t.after(() => { for (const [key, value] of Object.entries(parentEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const f = await fixture(t), root = ownedRoot(join(f.root, "child")), stopped = new AbortController();
  const env = managedMcpEnvironment(root, process.execPath, `http://127.0.0.1:${f.proxy.port}`);
  assert.equal(env.HARA_WORKSPACE_MCP_TOKEN, undefined); assert.equal(env.SYNTHETIC_PROVIDER_SECRET, undefined);
  const transport = new ManagedMcpStdioTransport({ source: f.reviewed, root, accountHome: f.account, stateHome: join(f.root, "private-state"), proxy: `http://127.0.0.1:${f.proxy.port}`, signal: stopped.signal });
  const client = new Client({ name: "synthetic-host", version: "1" }, { capabilities: {} });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport, { timeout: 5000 }); const listed = await client.listTools(); assert.equal(listed.tools.length, 2);
  const first = await client.callTool({ name: "fixture_read", arguments: { key: "one" } }); assert.equal(JSON.parse(first.content[0].text).key, "one");
  const second = await client.callTool({ name: "fixture_read", arguments: { key: "boundaries" } }); const result = JSON.parse(second.content[0].text);
  assert.equal(result.credentialReadable, false); assert.equal(result.foreignWorkspaceReadable, false); assert.equal(result.foreignAliasReadable, false); assert.equal(result.hardlinkReadable, false); assert.equal(result.proxyConnected, true); assert.equal(result.directConnected, false); assert.equal(f.direct.count(), 0);
  assert.equal(result.inheritedBridge, false); assert.equal(result.inheritedProvider, false);
  assert.equal(fs.readFileSync(join(root, "lifecycle.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.equal(fs.readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").length, 2);
  await client.close(); await transport.close(); assert.equal(transport.drainReport.remaining, 0);
});

async function hostFixture(t, f, { tier = "controlled", key = "one", afterIntake, runtime = "pi" } = {}) {
  fs.mkdirSync(join(f.root, "host"), { mode: 0o700 });
  const command = runtime === "pi" ? null : join(f.account, runtime === "codex" ? ".codex/tmp/bin/codex" : ".claude/projects/bin/claude");
  if (command) writeManagedMcpCli(command, runtime, workspaceMcpToolName(f.source.sourceId, "read"));
  const host = new LocalWorkspaceHost(join(f.root, "host"), { ...(command ? { runtimeInstallerOptions: { accountHome: () => f.account,
    discovery: { home: f.account, path: dirname(command) + ":" + dirname(process.execPath) + ":/usr/bin:/bin", systemBins: [], run: async (_command, args) => args[0] === "-lic" ? null : `${runtime} 1.2.3` } } } : {}), extensionCatalog: () => { if (f.catalogFailure) throw Error("synthetic catalog failure"); return [f.source]; }, reviewedMcpSources: () => [f.reviewed],
    providerFactory: (_connection, binding) => { let step = 0; return { id: "openai", model: binding.model, async turn(args) {
      if (runtime !== "pi") throw Error("Unexpected native provider fallback");
      if (f.catalogFailure && f.greetingOnly) return reply("Hello from the governed core.");
      const named = name => args.tools.find(tool => tool.name === name || tool.name === "mcp__hara__" + name)?.name ?? name;
      (f.nativeTrace ??= []).push({ step: step + 1, results: args.history.flatMap(row => row.role === "tool" ? row.results.map(result => ({ name: result.name, isError: result.isError, content: result.content.slice(0, 1200) })) : []).slice(-3) });
      if (++step === 1) return call(named("task_intake"), intake);
      if (step === 2) { await afterIntake?.(); return call(named(workspaceMcpToolName(f.source.sourceId, "read")), { key }); }
      if (step === 3) {
        const result = args.history.flatMap(row => row.role === "tool" ? row.results : []).findLast(row => row.name.replace(/^mcp__hara__/, "") === workspaceMcpToolName(f.source.sourceId, "read"));
        if (!result || result.isError) return reply("Synthetic MCP result was not observed.");
        const observed = JSON.parse(result.content.split("\n\n<system-reminder>")[0]);
        return call(named("task_checkpoint"), { completion: { state: "verified", evidence: ["Observed the synthetic server result only"], checks: [{ acceptance_index: 0, evidence: "Observed the synthetic server result, without claiming external business verification", tool_call_ids: [observed.receipt.toolCallId] }], final_answer: "Synthetic MCP result observed." } });
      }
      return reply("Synthetic MCP result observed.");
    } }; } });
  t.after(() => host.close());
  const ws = host.createWorkspace("MCP manager", host.list().revision), id = ws.workspaceId;
  host.setExtensionClientCapability("client", true);
  host.configureSynthetic(id, 0); host.select("client", id, host.list().revision);
  const context = host.context(id), original = context.resources.agents.get(ws.selectedAgentId);
  let main = original;
  if (runtime !== "pi") {
    await host.detectRuntimes(id); const detected = context.runtimes.list().options.find(row => row.runtimeId === runtime);
    host.registerLocalRuntime(id, runtime, detected.fingerprint, "host");
    await host.selectRuntimeModel(id, runtime, runtime === "codex" ? "fixture-model" : "sonnet", 0);
    main = context.resources.agents.setRuntime(original.agentId, runtime, original.configRevision, original.agentEpoch);
  } else if (tier === "controlled") main = context.resources.agents.setPermissionTier(original.agentId, tier, original.configRevision, original.agentEpoch);
  context.runtimes.proxy.save(`http://127.0.0.1:${f.proxy.port}`, 0);
  let view = host.workspaceExtensions(id); const source = view.sources.find(row => row.sourceId === f.source.sourceId);
  async function change(input, revision) {
    const proposal = host.proposeExtensions("client", id, input, revision); return host.approveExtensions("client", id, proposal.proposalId, true, revision);
  }
  const input = { target: "workspace", sourceId: source.sourceId, sourceRevision: source.sourceRevision, enabled: true, allowedTools: ["read"] };
  view = await change(input, view.revision);
  await change({ ...input, target: "agent", agentId: main.agentId, agentEpoch: main.agentEpoch }, view.revision);
  return { host, id, main, command, change, input, read: () => host.snapshot(id, main.agentId, "client") };
}

for (const tier of ["controlled", "full-protected"]) managedTest(`actual governed Pi ${tier} tool conversion reaches real stdio after a current one-call card`, async t => {
  const f = await fixture(t), h = await hostFixture(t, f, { tier }), started = h.host.start("client", h.id, h.main.agentId, "Read the synthetic fixture through the reviewed plugin.", randomUUID());
  const card = await until(() => h.read().approvals.find(row => row.kind === "extension_call"), "external call card");
  assert.equal(allCalls(h.host, h.id).length, 0); assert.equal(card.draft.sourceName, "Synthetic MCP");
  assert.throws(() => h.host.answerApproval("foreign-client", h.id, card.id, true), /approval/);
  h.host.answerApproval("client", h.id, card.id, true); await h.host.wait(started.runId);
  const view = h.read(); assert.equal(allCalls(h.host, h.id).length, 1); assert.equal(view.conversation.state, "completed", JSON.stringify({blockReason:view.conversation.blockReason,taskState:view.conversation.taskState,completion:view.conversation.completion,nativeTrace:f.nativeTrace}));
  const tool = view.conversation.history.flatMap(row => row.role === "tool" ? row.results : []).find(row => row.name === workspaceMcpToolName(f.source.sourceId, "read"));
  assert.ok(tool && !tool.isError); const result = JSON.parse(tool.content.split("\n\n<system-reminder>")[0]); assert.equal(result.verified, false); assert.equal(result.outcome, "server_reported_success");
  const diagnostics = h.host.agentExtensions(h.id, h.main.agentId, h.main.agentEpoch).sources[0]; assert.equal(diagnostics.callable, true); assert.equal(diagnostics.lastCall.outcome, "server_reported_success");
  assert.equal(JSON.stringify(diagnostics).includes("inputDigest"), false); assert.equal(JSON.stringify(diagnostics).includes(f.account), false);
});

for (const runtime of ["codex", "claude"]) managedTest(`registered ${runtime} adapter calls the same real stdio through its attempt token and governor`, async t => {
  const revoked = runtime === "codex" ? observeCodexAttempts(t) : undefined;
  const f = await fixture(t), h = await hostFixture(t, f, { runtime, tier: "full-protected" });
  const started = h.host.start("client", h.id, h.main.agentId, "Read the synthetic plugin data.", randomUUID());
  const card = await until(() => {
    const snapshot = h.read(), card = snapshot.approvals.find(row => row.kind === "extension_call");
    if (!card && ["blocked", "cancelled", "completed"].includes(snapshot.conversation.state)) throw Error("Native fixture ended before the external card");
    return card;
  }, runtime + " external card").catch(error => {
    const snapshot = h.read(), file = h.command + ".meta.json";
    const meta = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    throw Error(error.message + " " + JSON.stringify({ state: snapshot.conversation.state, taskState: snapshot.conversation.taskState,
      blockReason: snapshot.conversation.blockReason, toolsListed: Boolean(meta.tools), mcpMethod: meta.mcpMethod, mcpStatus: meta.mcpStatus, refusedMcp: meta.refusedMcp, intake: meta.intake, plugin: meta.plugin,
      nativeMethods: fs.existsSync(h.command + ".rpc.jsonl") ? fs.readFileSync(h.command + ".rpc.jsonl", "utf8").trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line).method) : [],
      nativeStateWritten: fs.existsSync(h.command + ".native.json"), metaWritten: fs.existsSync(file),
      stages: snapshot.conversation.runtimeStages?.at(-1) }));
  });
  assert.equal(allCalls(h.host, h.id).length, 0); h.host.answerApproval("client", h.id, card.id, true); await h.host.wait(started.runId);
  const snapshot = h.read(), meta = JSON.parse(fs.readFileSync(h.command + ".meta.json", "utf8"));
  assert.equal(snapshot.conversation.state, "completed", JSON.stringify({ error: snapshot.conversation.error, taskState: snapshot.conversation.taskState })); assert.equal(allCalls(h.host, h.id).length, 1);
  assert.equal(meta.tokenPresent, true); assert.equal(meta.tokenInArgv, false); assert.ok(meta.tools.includes(workspaceMcpToolName(f.source.sourceId, "read")));
  assert.ok(snapshot.conversation.history.flatMap(row => row.role === "tool" ? row.results : []).some(result => result.name === workspaceMcpToolName(f.source.sourceId, "read") && !result.isError));
  if (revoked) {
    await revoked(meta, { resident: true });
    assert.equal(allCalls(h.host, h.id).length, 1, "revoked capability cannot dispatch another upstream call");
  } else await until(async () => { try { await fetch(meta.url); return false; } catch { return true; } }, "closed per-attempt Claude endpoint");
});

managedTest("revoking a Workspace switch while its external confirmation is pending dispatches zero stdio calls", async t => {
  const f = await fixture(t), h = await hostFixture(t, f), started = h.host.start("client", h.id, h.main.agentId, "Read the synthetic plugin.", randomUUID());
  const card = await until(() => h.read().approvals.find(row => row.kind === "extension_call"));
  await h.change({ ...h.input, enabled: false }, h.host.workspaceExtensions(h.id).revision);
  h.host.answerApproval("client", h.id, card.id, true); await h.host.wait(started.runId);
  assert.equal(allCalls(h.host, h.id).length, 0); assert.equal(h.host.workspaceExtensions(h.id).sources[0].callable, false);
});

test("per-attempt loopback capabilities reject another token, expired tokens and revoked attempts", async t => {
  let calls = 0; const stopped = new AbortController();
  const endpoint = await createWorkspaceMcpEndpoint({ signal: stopped.signal, expiresAt: Date.now() + 100, assertCurrent() {}, tools: () => [], call: async () => { calls++; throw Error("not called"); } });
  t.after(() => endpoint.close());
  const foreign = await createWorkspaceMcpEndpoint({ signal: new AbortController().signal, assertCurrent() {}, tools: () => [], call: async () => { calls++; throw Error("not called"); } });
  t.after(() => foreign.close());
  const token = endpoint.env.HARA_WORKSPACE_MCP_TOKEN;
  assert.notEqual(token, foreign.env.HARA_WORKSPACE_MCP_TOKEN);
  assert.equal((await fetch(endpoint.url, { method: "POST", headers: { Authorization: "Bearer " + foreign.env.HARA_WORKSPACE_MCP_TOKEN } })).status, 401);
  await sleep(120); assert.equal((await fetch(endpoint.url, { method: "POST", headers: { Authorization: "Bearer " + token } })).status, 403);
  stopped.abort(); await endpoint.close(); await assert.rejects(fetch(endpoint.url)); assert.equal(calls, 0); assert.equal(endpoint.env.HARA_WORKSPACE_MCP_TOKEN, undefined);
});

// Fine-grained manager boundary tests complement (never replace) the real Host/governor paths above.
function managerFixture(t, f, { reviewed = true } = {}) {
  const storage = new WorkspaceResourceStorage(f.root, { schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() } }); storage.initialize();
  const manager = new WorkspaceMcpManager(storage, { accountHome: f.account, proxy: () => ({ revision: 1, proxyUrl: `http://127.0.0.1:${f.proxy.port}`, readOnly: false }) });
  t.after(() => manager.close());
  const catalog = manager.catalog([reviewed ? f.source : f.reviewed.descriptor], reviewed ? [f.reviewed] : []), extensions = new WorkspaceExtensions(storage, catalog);
  const source = catalog[0], agentId = "ag_" + randomUUID();
  const workspaceChange = { target: "workspace", sourceId: source.sourceId, sourceRevision: source.sourceRevision, enabled: true, allowedTools: ["read", "change"] };
  const assignment = { ...workspaceChange, target: "agent", agentId, agentEpoch: 1 };
  const enable = () => { let revision = extensions.list().revision; extensions.apply(workspaceChange, revision++); extensions.apply(assignment, revision); };
  const attempt = (patch = {}) => manager.createAttempt({ snapshot: extensions.snapshot(agentId, 1), extensions, runId: randomUUID(), deadline: Date.now() + 30_000, signal: new AbortController().signal, assertCurrent() {}, ...patch });
  const roots = () => storage.run(() => join(workspaceStateHome(), ".hara/extension-processes"));
  const entries = filename => { const rows = []; const walk = root => { if (!fs.existsSync(root)) return; for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const target = join(root, entry.name); if (entry.isDirectory()) walk(target); else if (entry.name === filename) rows.push(...fs.readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); } }; walk(roots()); return rows; };
  const release = () => { const walk = root => { if (!fs.existsSync(root)) return; for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const target = join(root, entry.name); if (entry.isDirectory()) walk(target); else if (entry.name === "calls.jsonl") fs.writeFileSync(join(root, "release"), "synthetic-test-release"); } }; walk(roots()); };
  return { storage, manager, extensions, source, assignment, enable, attempt, release, calls: () => entries("calls.jsonl"), spawns: () => entries("lifecycle.jsonl") };
}
function granted(attempt, runId, args, toolId = "read", callId = randomUUID()) {
  const tool = attempt.tools.find(row => row.name.endsWith(workspaceMcpToolName("", toolId).split("_").at(-1)));
  const offer = createWorkspaceExtensionApproval(tool, callId, args); approveWorkspaceExtension(offer, runId);
  return { tool, offer, callId, run: (value = args) => tool.run(value, { toolCallId: callId }) };
}

test("off switches, unreviewed metadata, unsupported clients and foreign Workspace snapshots never start a server", async t => {
  const f = await fixture(t), m = managerFixture(t, f);
  const empty = m.attempt(); assert.equal(empty.tools.length, 0); await empty.close();
  m.enable(); const snapshot = m.extensions.snapshot(m.assignment.agentId, 1), other = managerFixture(t, f);
  assert.throws(() => other.attempt({ snapshot, extensions: m.extensions }), /cancelled/);
  const unreviewed = managerFixture(t, f, { reviewed: false }); unreviewed.enable(); const denied = unreviewed.attempt(); assert.equal(denied.tools.length, 0); await denied.close();
  const h = await hostFixture(t, f); h.host.setExtensionClientCapability("client", false);
  const run = h.host.start("client", h.id, h.main.agentId, "Read synthetic data", randomUUID()); await h.host.wait(run.runId);
  assert.equal(allCalls(h.host, h.id).length, 0); assert.equal(h.read().approvals.length, 0);
  assert.equal(m.spawns().length, 0); assert.equal(unreviewed.spawns().length, 0);
});

managedTest("single-call approval binds exact input, denies reuse, and unchanged sources reuse one child", async t => {
  const f = await fixture(t), m = managerFixture(t, f); m.enable(); const runId = randomUUID(), attempt = m.attempt({ runId });
  const readTool = attempt.tools.find(tool => tool.name.endsWith(workspaceMcpToolName("", "read").split("_").at(-1)));
  assert.throws(() => createWorkspaceExtensionApproval(readTool, randomUUID(), { key: "x".repeat(33 * 1024) }), /input_invalid/);
  const long = createWorkspaceExtensionApproval(readTool, randomUUID(), { key: "x".repeat(1500) }); assert.ok(long.target.length > 1500, "the card must never hide the tail of the approved input");
  const first = granted(attempt, runId, { key: "one" });
  await assert.rejects(first.run({ key: "two" }), /approval_required/); assert.equal(m.spawns().length, 0);
  const observed = JSON.parse(await first.run()); assert.equal(observed.verified, false); assert.equal(m.calls().length, 1);
  await assert.rejects(first.run(), /approval_required/); assert.throws(() => approveWorkspaceExtension(first.offer, runId), /approval_required/);
  await granted(attempt, runId, { key: "two" }).run(); assert.equal(m.calls().length, 2); assert.equal(m.spawns().length, 1); await attempt.close();
});

managedTest("agent revoke, stale reviewed code and invalid schemas reject before upstream dispatch", async t => {
  const f = await fixture(t), m = managerFixture(t, f); m.enable(); const runId = randomUUID(), attempt = m.attempt({ runId });
  const first = granted(attempt, runId, { key: "one" });
  m.extensions.apply({ ...m.assignment, enabled: false }, m.extensions.list().revision);
  await assert.rejects(first.run(), /changed/); assert.equal(m.spawns().length, 0); await attempt.close();
  m.extensions.apply(m.assignment, m.extensions.list().revision); const nextId = randomUUID(), next = m.attempt({ runId: nextId });
  const invalid = granted(next, nextId, { key: "outside-schema" }); await assert.rejects(invalid.run(), /input_invalid/); assert.equal(m.spawns().length, 0);
  const stale = granted(next, nextId, { key: "two" }); fs.appendFileSync(join(f.packageRoot, "server.mjs"), "\n// stale-reviewed-code\n");
  await assert.rejects(stale.run(), /stale/); assert.equal(m.spawns().length, 0); await next.close();
});

managedTest("changed upstream inventory and tools/list_changed freeze the reviewed schema instead of expanding it", async t => {
  const f = await fixture(t, { tools: [{ name: "fixture_read", description: "Changed description", inputSchema: { type: "object" } }] }), m = managerFixture(t, f); m.enable();
  let runId = randomUUID(), attempt = m.attempt({ runId });
  await assert.rejects(granted(attempt, runId, { key: "one" }).run(), /schema_stale/); assert.equal(m.calls().length, 0); await attempt.close();
  const duplicate = await fixture(t); const catalogFile = join(duplicate.packageRoot, "catalog.json"), inventory = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  inventory.tools = [inventory.tools[0], inventory.tools[0]]; fs.writeFileSync(catalogFile, JSON.stringify(inventory));
  duplicate.record = prepareWorkspaceMcpReview({ source: duplicate.source, command: fs.realpathSync(process.execPath), args: [join(duplicate.packageRoot, "server.mjs")], packageRoot: duplicate.packageRoot, tools: duplicate.tools });
  duplicate.reviewed = restoreWorkspaceMcpReview(duplicate.record); const d = managerFixture(t, duplicate); d.enable(); runId = randomUUID(); attempt = d.attempt({ runId });
  await assert.rejects(granted(attempt, runId, { key: "one" }).run(), /schema_stale/); assert.equal(d.calls().length, 0); await attempt.close();
  const unchanged = await fixture(t), n = managerFixture(t, unchanged); n.enable(); runId = randomUUID(); attempt = n.attempt({ runId });
  await granted(attempt, runId, { key: "notify" }).run(); await sleep(20);
  await assert.rejects(granted(attempt, runId, { key: "two" }).run(), /schema_stale/); assert.equal(n.calls().length, 1); assert.equal(n.spawns().length, 1); await attempt.close();
});

managedTest("proxy outage has no direct fallback and cannot launch an upstream process", async t => {
  const f = await fixture(t), m = managerFixture(t, f); m.enable(); await f.proxy.close();
  const runId = randomUUID(), attempt = m.attempt({ runId }); await assert.rejects(granted(attempt, runId, { key: "one" }).run(), /proxy_unavailable/);
  assert.equal(m.spawns().length, 0); assert.equal(f.direct.count(), 0); await attempt.close();
});

managedTest("upstream crash has durable unknown outcome and the next attempt cannot replay it", async t => {
  const f = await fixture(t), m = managerFixture(t, f); m.enable(); let runId = randomUUID(), attempt = m.attempt({ runId });
  await assert.rejects(granted(attempt, runId, { key: "crash" }, "change").run(), /outcome_unknown/); await attempt.close();
  assert.equal(m.calls().length, 1); assert.equal(m.manager.view(m.extensions.list()).sources[0].lastCall.outcome, "outcome_unknown");
  // Reconstruct the manager from protected persisted state, rather than trusting the previous object.
  const restored = new WorkspaceMcpManager(m.storage, { accountHome: f.account, proxy: () => ({ revision: 1, proxyUrl: `http://127.0.0.1:${f.proxy.port}`, readOnly: false }) });
  restored.catalog([f.source], [f.reviewed]); t.after(() => restored.close()); runId = randomUUID();
  attempt = restored.createAttempt({ snapshot: m.extensions.snapshot(m.assignment.agentId, 1), extensions: m.extensions, runId, deadline: Date.now() + 30_000, signal: new AbortController().signal, assertCurrent() {} });
  await assert.rejects(granted(attempt, runId, { key: "crash" }, "change").run(), /outcome_unknown/); assert.equal(m.calls().length, 1); assert.equal(m.spawns().length, 1); await attempt.close();
});

managedTest("cancelling an in-flight call drains its real child and keeps the outcome unknown", async t => {
  const f = await fixture(t, { delayMs: 30_000 }), m = managerFixture(t, f); m.enable();
  const runId = randomUUID(), controller = new AbortController(), attempt = m.attempt({ runId, signal: controller.signal });
  const result = granted(attempt, runId, { key: "delay" }).run(), rejected = assert.rejects(result, /outcome_unknown/);
  await until(() => m.calls().length === 1); controller.abort(); await rejected; await attempt.close();
  assert.equal(m.manager.view(m.extensions.list()).sources[0].lastCall.outcome, "outcome_unknown");
  assert.throws(() => createWorkspaceExtensionApproval(attempt.tools[0], randomUUID(), { key: "one" }), /cancelled/);
});


managedTest("text and structured secrets are redacted, while oversized results never become claimed success", async t => {
  const f = await fixture(t), m = managerFixture(t, f); m.enable(); const runId = randomUUID(), attempt = m.attempt({ runId });
  const value = JSON.parse(await granted(attempt, runId, { key: "secret" }).run());
  assert.equal(value.structuredContent.password, "***"); assert.equal(value.structuredContent.answer, "safe");
  assert.doesNotMatch(value.content, /\u001b|sk-synthetic-manager-key/);
  await assert.rejects(granted(attempt, runId, { key: "huge" }).run(), /outcome_unknown/);
  assert.equal(m.manager.view(m.extensions.list()).sources[0].lastCall.outcome, "outcome_unknown"); await attempt.close();
});


managedTest("revocation during an in-flight call suppresses its late response and never converts it into success", async t => {
  const f = await fixture(t, { waitForRelease: true }), m = managerFixture(t, f); m.enable();
  const runId = randomUUID(), attempt = m.attempt({ runId }), rejected = assert.rejects(granted(attempt, runId, { key: "delay" }).run(), /outcome_unknown/);
  await until(() => m.calls().length === 1); m.extensions.apply({ ...m.assignment, enabled: false }, m.extensions.list().revision);
  m.release(); await rejected; await attempt.close();
  assert.equal(m.calls().length, 1); assert.equal(m.manager.view(m.extensions.list()).sources[0].lastCall.outcome, "outcome_unknown");
});


test("failed optional catalog removes every extension tool while the ordinary governed core remains usable", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), h = await hostFixture(t, f); f.catalogFailure = true; f.greetingOnly = true;
  const started = h.host.start("client", h.id, h.main.agentId, "hello", randomUUID()); await h.host.wait(started.runId);
  assert.equal(h.read().conversation.state, "completed"); assert.equal(h.read().conversation.usage.modelCalls, 1);
  assert.equal(h.read().approvals.length, 0); assert.equal(allCalls(h.host, h.id).length, 0);
  assert.deepEqual(h.host.context(h.id).extensions.snapshot(h.main.agentId, h.main.agentEpoch).tools, []);
});
