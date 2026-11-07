import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceRuntimeModels } from "../dist/workspace/runtime-models.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceSecureConnections } from "../dist/workspace/secure-connections.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { captureWorkspaceProjectIdentity, freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, closeWorkspaceRunPermit } from "../dist/workspace/execution.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { runConfiguredAgent } from "../dist/agent-runtime/dispatch.js";
import { createTaskExecution } from "../dist/session/task.js";
import { DEFAULT_TIER, FULL_TIER_SKIP, SEATBELT } from "./helpers/platform-tier.mjs";

const roots = [];
function root() { const path = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-opencode-general-"))); roots.push(path); return path; }
after(() => roots.forEach(path => fs.rmSync(path, { recursive: true, force: true })));

function fakeOpenCode(path, output) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const script = `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { process.stdout.write("opencode 1.2.3\\n"); process.exit(0); }
if (process.argv[2] === "models") { process.stdout.write("fixture/model\\n"); process.exit(0); }
if (process.argv[2] !== "run") process.exit(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
if (config.permission["*"] !== "deny" || config.tools.bash !== ${JSON.stringify(output.full)} || config.tools.write !== ${JSON.stringify(output.full)} ||
    !config.mcp?.hara?.headers?.Authorization || process.env.HOME !== ${JSON.stringify(output.home)}) process.exit(3);
fs.writeFileSync(${JSON.stringify(output.argv)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME,
  config: { permission: config.permission, tools: config.tools, mcpUrl: config.mcp.hara.url } }));
const send = async (method, params, session) => {
  const response = await fetch(config.mcp.hara.url, { method: "POST", headers: {
    Authorization: config.mcp.hara.headers.Authorization, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: method === "initialize" ? 1 : 2, method, params }) });
  if (!response.ok) throw Error("MCP " + response.status);
  const raw = await response.text();
  const body = raw.startsWith("event:") ? JSON.parse(raw.split("\\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(raw);
  return { body, session: response.headers.get("mcp-session-id") || session };
};
(async () => {
  process.stdout.write(JSON.stringify({ type: "step_start" }) + "\\n");
  const init = await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  const ready = await fetch(config.mcp.hara.url, { method: "POST", headers: {
    Authorization: config.mcp.hara.headers.Authorization, "Content-Type": "application/json", "Mcp-Session-Id": init.session },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) });
  if (ready.status !== 202) throw Error("MCP notification " + ready.status);
  const listed = await send("tools/list", {}, init.session);
  if (!listed.body.result.tools.some(tool => tool.name === "agent_list")) throw Error("agent_list missing");
  const called = await send("tools/call", { name: "agent_list", arguments: {} }, init.session);
  const reply = called.body.result.content[0].text;
  process.stdout.write(JSON.stringify({ type: "text", part: { text: "Team: " + reply } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }) + "\\n");
})().catch(error => { fs.writeFileSync(${JSON.stringify(output.argv)} + ".error", String(error?.stack ?? error));
  process.stdout.write(JSON.stringify({ type: "error", error: { message: "fixture MCP failed" } }) + "\\n"); });
`;
  fs.writeFileSync(path, script, { mode: 0o755 });
}

for (const permissionTier of ["full-protected", "controlled"]) for (const kind of ["main", "colleague"]) test(`OpenCode ${kind} ${permissionTier} calls agent_list through the governed Workspace MCP bridge`, { skip: permissionTier === "full-protected" ? FULL_TIER_SKIP : false }, async () => {
  const data = root(), account = root(), home = join(data, "home"), project = root();
  fs.mkdirSync(home, { recursive: true });
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Fixture", 1);
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize();
  const command = join(account, ".local/share/opencode/fixture-bin/opencode"), argv = command + ".argv.json";
  fakeOpenCode(command, { argv, home: account, full: permissionTier === "full-protected" });
  const installer = new WorkspaceRuntimeInstaller(storage, { accountHome: () => account,
    discovery: { home: account, path: `${dirname(command)}:${dirname(process.execPath)}:/usr/bin:/bin`, systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "opencode 1.2.3" } });
  const resources = new WorkspaceResources(home, row.scope, { runtimeInstaller: installer }); resources.initialize();
  const main = resources.agents.initializeMain();
  await installer.discover();
  const detected = installer.list().options.find(option => option.runtimeId === "opencode");
  assert.equal(detected.state, "detected");
  assert.throws(() => installer.registerLocal("opencode", detected.fingerprint, "isolated"), /unsafe/);
  installer.registerLocal("opencode", detected.fingerprint, "host");
  const models = new WorkspaceRuntimeModels(storage, installer);
  await models.select("opencode", "fixture/model", 0);
  assert.equal(resources.agents.runtimeOptions().find(option => option.id === "opencode").available, true);
  const agent = kind === "main" ? main : resources.agents.create({ username: "tester", profile: { displayName: "Tester" } }, resources.agents.list().revision);
  let selected = resources.agents.setRuntime(agent.agentId, "opencode", agent.configRevision, agent.agentEpoch);
  selected = resources.agents.setPermissionTier(agent.agentId, permissionTier, selected.configRevision, selected.agentEpoch);
  const task = resources.agents.bindTask(createTaskExecution("List colleagues", randomUUID()), selected.agentId, selected.configRevision, selected.agentEpoch);
  const connections = new WorkspaceSecureConnections(storage, new MemoryCredentialVault());
  connections.add({ label: "Fixture", provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture", defaultModel: "fixture" }, 0);
  const binding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: row.scope, agent: task.workspaceAgentBinding,
    agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding), connection: connections.capture(), runtimeContract: "hara-governed-runtime-v1",
    project: captureWorkspaceProjectIdentity(project), sessionId: randomUUID(), runId: randomUUID(),
    lineage: { rootRunId: null, parentRunId: null, depth: 0 }, createdAt: new Date().toISOString(),
    host: { hostId: catalog.read().hostId, hostEpoch: 1, grantId: row.grantId, grantRevision: 1, actorId: row.actorId, policyRevision: 1 },
    budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 32000, timeoutMs: 60000 } });
  task.workspaceRunBinding = binding;
  const lease = WorkspaceSessionLease.acquire(storage, binding.sessionId), controller = new AbortController();
  let calls = 0;
  const permit = createWorkspaceRunPermit({ binding, catalog, resources, storage, connections, lease, cwd: project, signal: controller.signal,
    provider: { id: "openai", model: binding.connection.model, async turn() { throw Error("provider fallback forbidden"); } },
    toolNames: ["agent_list"], usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} });
  const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: project, sessionId: binding.sessionId, sandbox: "off" },
    signal: controller.signal, approval: "auto-edit", approvalChannel: true, confirm: async () => false, hooks: false,
    systemOverride: "Use agent_list and reply concisely", taskIntake: { task, current: () => task },
    extraTools: [{ name: "agent_list", description: "List colleagues", kind: "read", input_schema: { type: "object", properties: {} },
      async run() { calls++; return "Tester"; } }] });
  try {
    const history = [{ role: "user", content: "List colleagues" }];
    const result = await storage.run(() => runConfiguredAgent(history, options, new AgentRuntimeRegistry(undefined, installer, models)));
    assert.equal(result.status, "completed", result.error + " " + (fs.existsSync(argv + ".error") ? fs.readFileSync(argv + ".error", "utf8") : ""));
    assert.equal(calls, 1);
    const versionStatus = installer.list().options.find(row => row.runtimeId === "opencode").versionStatus;
    assert.equal(versionStatus.lastSuccessfulVersion, "1.2.3");
    assert.equal(versionStatus.compatibility, "previously_succeeded");
    assert.match(history.at(-1).text, /Team: Tester/);
    const launch = JSON.parse(fs.readFileSync(argv, "utf8"));
    assert.equal(launch.home, account);
    assert(launch.args.includes("fixture/model"));
    assert(!launch.args.includes("--variant") && !launch.args.includes("--session"));
    assert.equal(launch.config.permission.hara_agent_list, "allow");
    for (const name of ["edit", "write", "bash"]) assert.equal(launch.config.tools[name], permissionTier === "full-protected");
  } finally { controller.abort(); await closeWorkspaceRunPermit(permit); await installer.close(); }
});
