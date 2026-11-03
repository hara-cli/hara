import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION } from "../../dist/workspace/synthetic-provider.js";

export async function jsonCliFixture(t, id, { mode = "list", protectedFactory = true, productionPolicy = false, bind = true, recordReceipt = true, tier = "full-protected" } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), `hara-${id}-fixture-`))), account = join(root, "account"); fs.mkdirSync(join(account, ".local/bin"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, "data"), { mode: 0o700 });
  fs.mkdirSync(join(root, "probe"), { mode: 0o700 });
  const fakeConfigPath = join(account, ".kimi/config.toml"), extensionMarker = join(account, ".kimi/logs/personal-extension-marker");
  if (id === "kimi") {
    fs.mkdirSync(join(account, ".kimi/logs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fakeConfigPath, '# FAKE_USER_EXTENSION_FIXTURE\n[[hooks]]\nevent = "SessionStart"\ncommand = "fixture-only-not-executed"\n', { mode: 0o600 });
  }
  const configDigest = id === "kimi" ? createHash("sha256").update(fs.readFileSync(fakeConfigPath)).digest("hex") : null;
  const command = join(account, ".local/bin", id), policyCalls = [];
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), runtime = ${JSON.stringify(id)};
if (args.includes('--version')) { console.log(runtime + ' 1.2.3'); process.exit(0); }
if (args.includes('--help')) { console.log('--print --yolo --output-format --mcp-config-file --prompt --work-dir --allowed-mcp-server-names --extensions --model --approval-mode --plan'); process.exit(0); }
const mode = fs.readFileSync(path.join(process.cwd(), '.fixture-mode'), 'utf8');
const config = JSON.parse(fs.readFileSync(runtime === 'gemini' ? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH : args[args.indexOf('--mcp-config-file') + 1], 'utf8'));
const server = config.mcpServers.hara, url = server.httpUrl || server.url;
const token = process.env.HARA_WORKSPACE_MCP_TOKEN;
const metadata = { runtime, home: process.env.HOME, cwd: process.cwd(), model: args.includes('--model') ? args[args.indexOf('--model') + 1] : null,
  yolo: args.includes('--yolo'), plan: args.includes('--plan'), tokenPresent: !!token, tokenInArgv: args.some(value => token && value.includes(token)), wrapped: process.env.HARA_SYNTHETIC_POLICY_WRAP === 'yes',
  mcpNames: Object.keys(config.mcpServers), url, proxy: !!process.env.HTTP_PROXY, noProxy: process.env.NO_PROXY || '' };
if (runtime === 'gemini') {
 if (config.hooksConfig?.enabled !== false || config.skills?.enabled !== false || config.tools?.discoveryCommand !== '' || config.tools?.callCommand !== '' || config.tools?.sandbox !== false
   || config.tools.core.some(name => /shell|background|cron|schedule|agent/i.test(name)) || args[args.indexOf('--extensions') + 1] !== 'none') throw Error('fixture isolation config absent');
 metadata.isolatedExtensions = true;
} else {
 // Native fixture reads its own fake config; Hara never copies it. No hook command is executed.
 const personal = fs.readFileSync(path.join(process.env.HOME, '.kimi/config.toml'), 'utf8');
 if (!personal.includes('FAKE_USER_EXTENSION_FIXTURE')) throw Error('fixture host extensions missing');
 fs.writeFileSync(path.join(process.env.HOME, '.kimi/logs/personal-extension-marker'), 'fixture-loaded');
 metadata.inheritedExtensions = true;
}
const save = () => { if (${JSON.stringify(recordReceipt)}) fs.writeFileSync(path.join(process.cwd(), '.native-fixture-receipt.json'), JSON.stringify(metadata)); };
const emit = value => console.log(JSON.stringify(value));
(async () => {
 let session;
 async function rpc(method, params, id) {
   const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
     authorization: 'Bearer ' + token, ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
   if (!response.ok) throw Error('fixture MCP request refused');
   session = response.headers.get('mcp-session-id') || session;
   return id ? await response.json() : null;
 }
 if (runtime === 'gemini') emit({ type: 'init', session_id: 'fixture-only' });
 await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }, 1);
 await rpc('notifications/initialized', {});
 const tools = await rpc('tools/list', {}, 2); metadata.tools = tools.result.tools.map(row => row.name); save();
 if (mode === 'cancel') { await new Promise(resolve => setTimeout(resolve, 60000)); return; }
 if (mode === 'error') {
   const error = { message: '401 authentication failed: fixture-private', code: 'authentication_failed' };
   if (runtime === 'gemini') { emit({ type: 'error', error }); emit({ type: 'result', status: 'error' }); } else emit({ error });
   return;
 }
 const listed = await rpc('tools/call', { name: 'agent_list', arguments: {} }, 3);
 metadata.listed = listed.result; save();
 if (runtime === 'gemini') {
   emit({ type: 'tool_use', tool_name: 'mcp_hara_agent_list', tool_id: 'fixture-list', parameters: {} }); emit({ type: 'tool_result', tool_id: 'fixture-list', status: 'success' });
   emit({ type: 'message', role: 'assistant', content: 'Gemini fixture complete', delta: true }); emit({ type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 10 } });
 } else { emit({ role: 'assistant', content: [{ type: 'text', text: 'Kimi fixture complete' }] }); }
})().catch(() => { process.stderr.write('fixture MCP failed\\n'); process.exitCode = 1; });
`, { mode: 0o700 });
  const host = new LocalWorkspaceHost(join(root, "data"), { mode: "workspace", hostHome: account, discoveryHome: account, credentialVault: new MemoryCredentialVault(),
    runtimeInstallerOptions: { accountHome: () => account, discovery: { home: account, probeHome: join(root, "probe"), path: dirname(process.execPath), systemBins: [], run: async (_command, args) => args[0] === "--version" ? `${id} 1.2.3` : null } },
    ...(productionPolicy ? {} : protectedFactory ? { jsonCliPolicyFactory: async input => {
      policyCalls.push({ kind: "create", runtimeId: input.runtimeId, workRoot: input.permit.binding.project.root });
      return { tier, policy: {
        beginAttempt(attemptKey) { policyCalls.push({ kind: "begin", attemptKey }); },
        wrap(spec) { policyCalls.push({ kind: "wrap" }); return { ...spec, env: { ...spec.env, HARA_SYNTHETIC_POLICY_WRAP: "yes" } }; },
        observeNativeEvent(event) { policyCalls.push({ kind: "event", event }); },
        collectWorkspaceEvidence() { policyCalls.push({ kind: "collect" }); return null; },
        async close() { policyCalls.push({ kind: "close" }); },
      } };
    } } : { jsonCliPolicyFactory: async () => { throw Error("runtime_protection_unavailable"); } }),
    providerFactory: (_connection, binding) => ({ id: "openai", model: binding.model, async turn() { throw Error("unexpected external model call"); } }),
  });
  t.after(async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = host.createWorkspace("Native CLI fixture", host.list().revision), workspaceId = workspace.workspaceId;
  host.configureConnection(workspaceId, { ...SYNTHETIC_CONNECTION }, 0); host.select("fixture", workspaceId, host.list().revision);
  await host.detectRuntimes(workspaceId);
  const row = host.snapshot(workspaceId).runtimes.options.find(row => row.runtimeId === id);
  host.registerLocalRuntime(workspaceId, id, row.fingerprint, "host");
  const main = host.snapshot(workspaceId).agents[0]; if (bind) host.setAgentRuntime(workspaceId, main.agentId, id, main.configRevision, main.agentEpoch);
  const project = join(root, "data/project", workspaceId); fs.writeFileSync(join(project, ".fixture-mode"), mode);
  const metaPath = join(project, ".native-fixture-receipt.json");
  return { root, account, host, workspaceId, main: main.agentId, project, policyCalls, metaPath, fakeConfigPath, configDigest, extensionMarker,
    send: () => host.start("fixture", workspaceId, main.agentId, "List the colleagues of this Workspace.", randomUUID()),
    read: () => host.snapshot(workspaceId, main.agentId, "fixture"), meta: () => JSON.parse(fs.readFileSync(metaPath, "utf8")) };
}
