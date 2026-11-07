// Synthetic upstream only. No real account, user config, network API or model.
import { appendFileSync, writeFileSync, readFileSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
const definition = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "catalog.json"), "utf8"));
appendFileSync(join(process.cwd(), "lifecycle.jsonl"), JSON.stringify({ event: "spawn", inheritedBridge: Boolean(process.env.HARA_WORKSPACE_MCP_TOKEN), inheritedProvider: Boolean(process.env.SYNTHETIC_PROVIDER_SECRET) }) + "\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const socket = (port, timeout = 200) => new Promise(resolve => {
  const client = createConnection({ host: "127.0.0.1", port }); let settled = false;
  const done = value => { if (settled) return; settled = true; clearTimeout(timer); client.destroy(); resolve(value); };
  const timer = setTimeout(() => done(false), timeout); client.once("connect", () => done(true)); client.once("error", () => done(false));
});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) { const end = buffer.indexOf("\n"); if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
    const request = JSON.parse(line); void handle(request).catch(() => send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "synthetic failure" } }));
  }
});
async function handle(request) {
  if (request.id === undefined) return;
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "synthetic-workspace-mcp", version: "1.0.0" } } });
  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools: definition.tools } });
  if (request.method !== "tools/call") return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unsupported" } });
  appendFileSync(join(process.cwd(), "calls.jsonl"), JSON.stringify({ name: request.params.name, key: request.params.arguments?.key }) + "\n");
  const key = request.params.arguments?.key;
  if (key === "delay") {
    if (definition.waitForRelease) { for (let tick = 0; tick < 1500 && !existsSync(join(process.cwd(), "release")); tick++) await new Promise(resolve => setTimeout(resolve, 20)); }
    else await new Promise(resolve => setTimeout(resolve, definition.delayMs ?? 200));
  }
  if (key === "crash") return process.exit(7);
  if (key === "notify") send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  if (key === "secret") return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "\u001b[31mapi_key=sk-synthetic-manager-key-12345678901234567890" }], structuredContent: { password: "synthetic-password-only", answer: "safe" } } });
  if (key === "huge") return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "x".repeat(600 * 1024) }] } });
  let extra = {};
  if (key === "boundaries") {
    let credentialReadable = false;
    try { readFileSync(definition.credentialCanary, "utf8"); credentialReadable = true; } catch {}
    let foreignWorkspaceReadable = false, foreignAliasReadable = false, hardlinkReadable = false;
    try { readFileSync(definition.foreignWorkspaceCanary, "utf8"); foreignWorkspaceReadable = true; } catch {}
    try { readFileSync("/System/Volumes/Data" + definition.foreignWorkspaceCanary, "utf8"); foreignAliasReadable = true; } catch {}
    try { const alias = join(process.cwd(), "foreign-alias"); linkSync(definition.foreignWorkspaceCanary, alias); readFileSync(alias); hardlinkReadable = true; unlinkSync(alias); } catch {}
    extra = { credentialReadable, foreignWorkspaceReadable, foreignAliasReadable, hardlinkReadable, proxyConnected: await socket(definition.proxyPort), directConnected: await socket(definition.directPort),
      inheritedBridge: Boolean(process.env.HARA_WORKSPACE_MCP_TOKEN), inheritedProvider: Boolean(process.env.SYNTHETIC_PROVIDER_SECRET) };
  }
  if (request.params.name === "fixture_change") writeFileSync(join(process.cwd(), "effect.txt"), String(key));
  send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ fixture: true, key, ...extra }) }] } });
}
