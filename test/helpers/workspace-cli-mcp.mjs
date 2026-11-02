import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../../dist/workspace/synthetic-provider.js";

async function fakeCli() {
  const fs = await import("node:fs"), readline = await import("node:readline");
  const args = process.argv.slice(2), command = process.argv[1];
  if (args[0] === "--version") { console.log("codex 1.2.3"); return; }
  if (args[0] === "app-server") {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      if (message.id !== undefined) console.log(JSON.stringify({ id: message.id, result: message.method === "model/list"
        ? { data: [{ id: "fixture-model", displayName: "Fixture", isDefault: true }] } : {} }));
    } return;
  }
  if (args[0] === "debug") { console.log(JSON.stringify({ models: [{ slug: "fixture-model" }] })); return; }
  if (args[0] !== "exec") { process.exitCode = 2; return; }
  const mode = JSON.parse(fs.readFileSync(command + ".mode.json", "utf8")).mode;
  const raw = args.find(value => value.startsWith("mcp_servers.hara.url="));
  if (!raw) throw new Error("fixture missing MCP URL");
  const url = JSON.parse(raw.slice(raw.indexOf("=") + 1)), token = process.env.HARA_WORKSPACE_MCP_TOKEN;
  const meta = { pid: process.pid, url, mode, tokenPresent: Boolean(token), tokenInArgv: args.some(value => token && value.includes(token)),
    readOnly: args.includes("read-only"), onRequest: args.includes('approval_policy="on-request"'),
    haraOnlyTrust: args.includes('mcp_servers.hara.default_tools_approval_mode="auto"') };
  const save = () => { fs.writeFileSync(command + ".meta.next", JSON.stringify(meta)); fs.renameSync(command + ".meta.next", command + ".meta.json"); };
  save();
  let serial = 0, session;
  async function request(method, params, credential = token) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", Authorization: "Bearer " + credential,
      ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++serial }), method, params }) });
    session = response.headers.get("mcp-session-id") ?? session;
    if (response.status === 202) return {};
    const body = await response.json();
    if (!response.ok || body.error) throw new Error("fixture MCP request refused");
    return body.result;
  }
  async function call(name, input) {
    const result = await request("tools/call", { name, arguments: input });
    return { isError: Boolean(result.isError), text: result.content?.[0]?.text ?? "" };
  }
  await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-codex", version: "1" } });
  await request("notifications/initialized", {});
  meta.tools = (await request("tools/list", {})).tools.map(tool => tool.name); save();
  if (mode === "crash") { process.exitCode = 7; return; }
  if (mode === "create") {
    meta.intake = await call("task_intake", { intent: "change", goal: "Create one test colleague after confirmation",
      constraints: ["Only this Workspace"], acceptance: ["The colleague is active after human confirmation"],
      steps: ["Check colleagues", "Wait for the human card", "Verify creation"] }); save();
  }
  const listed = await call("agent_list", {}); meta.listed = listed; save();
  if (mode === "create") {
    const created = await call("agent_create", { username: "fixture-colleague", displayName: "Fixture Colleague",
      title: "Test", instructions: "Only the assigned Workspace task." });
    meta.created = created; save();
    const value = JSON.parse(created.text);
    if (value.created) {
      meta.second = await call("agent_create", { username: "second", displayName: "Second", title: "Test", instructions: "Stay scoped." }); save();
      await call("task_checkpoint", { completion: { state: "verified",
        checks: [{ acceptance_index: 0, evidence: "Human confirmed and the tool observed the active colleague", tool_call_ids: [value.receipt.toolCallId] }],
        final_answer: "The test colleague was created after confirmation." } });
    }
  }
  const text = mode === "leak" ? token : "Scoped CLI reply";
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }));
}

export async function cliMcpFixture(t, mode = "list") {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-cli-mcp-")));
  const account = join(root, "account"), command = join(account, ".local/bin/codex");
  fs.mkdirSync(dirname(command), { recursive: true });
  fs.writeFileSync(command, "#!" + process.execPath + "\n(" + fakeCli.toString() + ")();\n", { mode: 0o755 });
  fs.writeFileSync(command + ".mode.json", JSON.stringify({ mode }));
  fs.mkdirSync(join(root, "workspace"), { mode: 0o700 });
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, { root: join(root, "workspace"), mode: "workspace",
    version: "fixture", credentialVault: new MemoryCredentialVault(),
    runtimeInstallerOptions: { accountHome: () => account, discovery: { home: account, path: "/usr/bin:/bin", systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } } });
  const socket = new WebSocket("ws://127.0.0.1:" + handle.port); await once(socket, "open");
  let serial = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timeout = setTimeout(() => { socket.off("message", receive); reject(new Error("bounded fixture RPC wait")); }, 10000);
    function receive(raw) {
      const response = JSON.parse(String(raw)); if (response.id !== id) return;
      clearTimeout(timeout); socket.off("message", receive);
      if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
    }
    socket.on("message", receive); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  t.after(async () => { socket.terminate(); await handle.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const init = await request("initialize", { token: handle.token });
  const workspace = await request("workspace.create", { label: "MCP fixture", expectedRevision: init.workspace.revision });
  const scope = { workspaceId: workspace.workspaceId, expectedGeneration: workspace.resourceGeneration };
  await request("workspace.connection.add", { ...scope, input: { ...SYNTHETIC_CONNECTION }, expectedRevision: 0 });
  const catalog = await request("workspace.list"); await request("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: catalog.revision });
  let snapshot = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
  const main = snapshot.agents.find(row => row.kind === "main");
  const detected = await request("workspace.runtime.detect", scope), codex = detected.options.find(row => row.runtimeId === "codex");
  await request("workspace.runtime.registerLocal", { ...scope, runtimeId: "codex", fingerprint: codex.fingerprint, approved: true, loginSource: "host" });
  await request("workspace.runtime.selectModel", { ...scope, runtimeId: "codex", modelId: "fixture-model", expectedRevision: 0 });
  await request("workspace.agents.setRuntime", { ...scope, agentId: main.agentId, runtimeId: "codex", configRevision: main.configRevision, agentEpoch: main.agentEpoch });
  const read = () => request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: main.agentId });
  const meta = () => fs.existsSync(command + ".meta.json") ? JSON.parse(fs.readFileSync(command + ".meta.json")) : null;
  return { root, command, scope, main, request, read, meta,
    send: message => request("workspace.session.send", { ...scope, agentId: main.agentId, message, requestId: randomUUID(), source: "ui" }),
    mode(value) { fs.writeFileSync(command + ".mode.json", JSON.stringify({ mode: value })); } };
}
export async function until(operation, accept, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await operation(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error("bounded MCP fixture condition was not observed");
}
