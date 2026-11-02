import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../../dist/workspace/synthetic-provider.js";

import { fakeCodexMain } from "./fake-codex-app-server.mjs";

export function writeFakeCodex(command, settings = { mode: "list" }) {
  fs.mkdirSync(dirname(command), { recursive: true });
  fs.writeFileSync(command, "#!" + process.execPath + "\n(" + fakeCodexMain.toString() + ")();\n", { mode: 0o755 });
  fs.writeFileSync(command + ".mode.json", JSON.stringify(settings));
}

export async function cliMcpFixture(t, mode = "list") {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-cli-mcp-")));
  const account = join(root, "account"), command = join(account, ".local/bin/codex");
  fs.mkdirSync(dirname(command), { recursive: true });
  writeFakeCodex(command, { mode });
  fs.writeFileSync(command + ".mode.json", JSON.stringify({ mode }));
  fs.mkdirSync(join(root, "workspace"), { mode: 0o700 });
  const serveOptions = { root: join(root, "workspace"), mode: "workspace",
    version: "fixture", credentialVault: new MemoryCredentialVault(),
    runtimeInstallerOptions: { accountHome: () => account, discovery: { home: account, path: "/usr/bin:/bin", systemBins: [],
      run: async (_command, args) => args[0] === "-lic" ? null : "codex 1.2.3" } } };
  let handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, serveOptions);
  let socket = new WebSocket("ws://127.0.0.1:" + handle.port); await once(socket, "open");
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
    native: () => fs.readFileSync(command + ".rpc.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line)),
    async restart() {
      socket.terminate(); await handle.close();
      handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0 }, serveOptions);
      socket = new WebSocket("ws://127.0.0.1:" + handle.port); await once(socket, "open");
      await request("initialize", { token: handle.token });
      const current = await request("workspace.list"); await request("workspace.select", { workspaceId: scope.workspaceId, expectedRevision: current.revision });
    },
    send: message => request("workspace.session.send", { ...scope, agentId: main.agentId, message, requestId: randomUUID(), source: "ui" }),
    mode(value) { fs.writeFileSync(command + ".mode.json", JSON.stringify({ mode: value })); } };
}
export async function until(operation, accept, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await operation(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error("bounded MCP fixture condition was not observed");
}
