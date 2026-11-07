import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { createJsonCliExecutionPolicy } from "../../dist/agent-runtime/json-cli-policy.js";
import { SYNTHETIC_CONNECTION } from "../../dist/workspace/synthetic-provider.js";
import { DEFAULT_TIER } from "./platform-tier.mjs";

export async function jsonCliFixture(t, id, { mode = "list", protectedFactory = true, productionPolicy = false, bind = true, recordReceipt = true, tier = DEFAULT_TIER, helpFailure = false, defaultLayout = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), `hara-${id}-fixture-`))), account = join(root, "account"); fs.mkdirSync(join(account, ".local/bin"), { recursive: true, mode: 0o700 });
  let host;
  t.after(async () => {
    try { await host?.close(); }
    finally {
      // Fixture-only fallback: the generated shell has this unique owner tag. Never kill by a
      // model/native PID claim in production, and never signal a process with an unverified tag.
      const receipt = join(account, id === "gemini" ? ".gemini/tmp" : ".kimi-code/logs", ".native-fixture-receipt.json");
      try {
        const meta = JSON.parse(fs.readFileSync(receipt, "utf8"));
        if (Number.isSafeInteger(meta.toolPid)) {
          const args = execFileSync("/bin/ps", ["-p", String(meta.toolPid), "-o", "args="], { encoding: "utf8" });
          if (args.includes("hara-owned-fixture-" + root.split("/").at(-1))) process.kill(-meta.toolPid, "SIGKILL");
        }
      } catch { /* Already drained or no background fixture was created. */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  fs.mkdirSync(join(root, "data"), { mode: 0o700 });
  fs.mkdirSync(join(root, "probe"), { mode: 0o700 });
  fs.mkdirSync(join(account, ".gemini/tmp"), { recursive: true, mode: 0o700 });
  const fakeConfigPath = join(account, ".kimi-code/config.toml"), extensionMarker = join(account, ".kimi-code/logs/personal-extension-marker");
  if (id === "kimi") {
    fs.mkdirSync(join(account, ".kimi-code/logs"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fakeConfigPath, '# FAKE_USER_EXTENSION_FIXTURE\n[[hooks]]\nevent = "SessionStart"\ncommand = "fixture-only-not-executed"\n', { mode: 0o600 });
  }
  const configDigest = id === "kimi" ? createHash("sha256").update(fs.readFileSync(fakeConfigPath)).digest("hex") : null;
  const command = join(account, ".local/bin", id), policyCalls = [];
  if (id === "kimi") {
    const pkg = join(account, "tools/kimi-code"); fs.mkdirSync(join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@moonshot-ai/kimi-code", version: "1.2.3", bin: { kimi: "dist/main.cjs" } }), { mode: 0o600 });
    fs.symlinkSync(join(pkg, "dist/main.cjs"), command);
  }
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), runtime = ${JSON.stringify(id)}, backgroundTag = ${JSON.stringify("hara-owned-fixture-" + root.split("/").at(-1))};
if (args.includes('--version')) { console.log(runtime + ' 1.2.3'); process.exit(0); }
if (args.includes('--help')) { if (${JSON.stringify(helpFailure)}) { process.stderr.write('Error: help startup failed /Users/private/config.toml\\nPRIVATE_SECOND_LINE\\n'); process.exit(1); } console.log('--print --yolo --auto --output-format --mcp-config-file --prompt --work-dir --allowed-mcp-server-names --extensions --model --approval-mode --plan\\n  acp    Native ACP server'); process.exit(0); }
const mode = fs.readFileSync(path.join(process.cwd(), '.fixture-mode'), 'utf8');
if (mode === 'startup-stderr') { process.stderr.write('Error: native startup failed token=' + process.env.HARA_WORKSPACE_MCP_TOKEN + ' /Users/private/config.toml https://private.example/ private@example.com\\nPRIVATE_SECOND_LINE\\n'); process.exit(1); }
async function executeFixture(config, protocol) {
const server = config.mcpServers.hara, url = server.httpUrl || server.url;
const token = process.env.HARA_WORKSPACE_MCP_TOKEN;
const metadata = { runtime, pid: process.pid, home: process.env.HOME, cwd: process.cwd(), model: protocol?.model || (args.includes('--model') ? args[args.indexOf('--model') + 1] : null),
  yolo: protocol ? protocol.mode === 'auto' : args.includes('--yolo'), plan: protocol ? protocol.mode === 'plan' : args.includes('--plan'), tokenPresent: !!token, tokenInArgv: args.some(value => token && value.includes(token)), wrapped: process.env.HARA_SYNTHETIC_POLICY_WRAP === 'yes',
  mcpNames: Object.keys(config.mcpServers), url, proxy: !!process.env.HTTP_PROXY, noProxy: process.env.NO_PROXY || '' };
if (runtime === 'gemini') {
 if (config.hooksConfig?.enabled !== false || config.skills?.enabled !== false || config.tools?.discoveryCommand !== '' || config.tools?.callCommand !== '' || config.tools?.sandbox !== false
   || !config.tools.core.includes('run_shell_command') || config.tools.core.some(name => /background|cron|schedule|agent/i.test(name)) || args[args.indexOf('--extensions') + 1] !== 'none') throw Error('fixture isolation config absent');
 metadata.isolatedExtensions = true;
} else {
 if(process.env.KIMI_DISABLE_CRON !== "1" || process.env.KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT !== "false") throw Error("runtime scheduling boundary missing");
 // Native fixture reads its own fake config; Hara never copies it. No hook command is executed.
 const personal = fs.readFileSync(path.join(process.env.HOME, '.kimi-code/config.toml'), 'utf8');
 if (!personal.includes('FAKE_USER_EXTENSION_FIXTURE')) throw Error('fixture host extensions missing');
 fs.writeFileSync(path.join(process.env.HOME, '.kimi-code/logs/personal-extension-marker'), 'fixture-loaded');
 metadata.inheritedExtensions = true;
}
const save = () => { if (${JSON.stringify(recordReceipt)}) fs.writeFileSync(path.join(process.env.HOME, runtime === 'gemini' ? '.gemini/tmp' : '.kimi-code/logs', '.native-fixture-receipt.json'), JSON.stringify(metadata)); };
const emit = value => {
 if (!protocol) { console.log(JSON.stringify(value)); return; }
 if (value.error) { protocol.failure = value.error; return; }
 const update = body => console.log(JSON.stringify({jsonrpc:'2.0', method:'session/update', params:{sessionId:mode==='foreign-session'?'foreign-session':'fixture-session', update:body}}));
 if (value.role === 'tool') update({sessionUpdate:'tool_call_update',toolCallId:value.tool_call_id,status:value.is_error?'failed':'completed',rawInput:protocol.extraRaw});
 else if (Array.isArray(value.tool_calls)) for(const call of value.tool_calls) update({sessionUpdate:'tool_call',toolCallId:call.id,title:call.function.name,rawInput:JSON.parse(call.function.arguments),status:'in_progress'});
 else if (value.role === 'assistant') for(const part of value.content || []) if(part.type==='text') update({sessionUpdate:'agent_message_chunk',content:part});
};
const nativeUse = (id, name, parameters) => runtime === 'gemini'
 ? emit({ type: 'tool_use', tool_name: name, tool_id: id, parameters })
 : emit({ role: 'assistant', content: [], tool_calls: [{ id, function: { name, arguments: JSON.stringify(parameters) } }] });
const nativeResult = (id, failed = false) => runtime === 'gemini'
 ? emit({ type: 'tool_result', tool_id: id, status: failed ? 'error' : 'success' })
 : emit({ role: 'tool', tool_call_id: id, is_error: failed, content: 'fixture result' });
const finalText = text => {
 if (runtime === 'gemini') { emit({ type: 'message', role: 'assistant', content: text, delta: true }); emit({ type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 10 } }); }
 else emit({ role: 'assistant', content: [{ type: 'text', text }] });
};
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
   const error = { message: '401 authentication failed: account=fixture-private', code: 'authentication_failed' };
   if (runtime === 'gemini') { emit({ type: 'error', error }); emit({ type: 'result', status: 'error' }); } else emit({ error });
   return;
 }
 if (mode === 'native-pending') { nativeUse('pending-id','Write',{}); finalText('claimed done'); return; }
 if (mode === 'risk-update') { nativeUse('update-id','Bash',{}); protocol.extraRaw={command:'git push PRIVATE_ARGUMENT'}; nativeResult('update-id'); delete protocol.extraRaw; }
 if (mode === 'native-write' || mode === 'native-claim') {
   nativeUse('fixture-write', runtime === 'gemini' ? 'write_file' : 'WriteFile', { file_path: 'native-result.txt' });
   if (mode === 'native-write') { try { fs.writeFileSync(path.join(process.cwd(), 'native-result.txt'), 'native fixture result'); } catch { metadata.writeDenied = true; } }
   nativeResult('fixture-write', metadata.writeDenied === true); save(); finalText('The file change is ready.'); return;
 }
 if (mode === 'risk') { nativeUse('fixture-risk', runtime === 'gemini' ? 'run_shell_command' : 'Shell', { command: 'git push PRIVATE_ARGUMENT' }); nativeResult('fixture-risk'); }
 if (mode === 'background') {
   nativeUse('fixture-background', runtime === 'gemini' ? 'run_shell_command' : 'Shell', { command: 'fixture background sleep' });
   await new Promise(resolve => {
     const tool = require('node:child_process').spawn('/bin/sh', ['-c', "trap '' TERM; /bin/sleep 300 & echo $!; wait", backgroundTag], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
     metadata.toolPid = tool.pid;
     tool.stdout.once('data', chunk => { metadata.backgroundPid = Number(chunk.toString().trim()); tool.stdout.destroy(); tool.unref(); save(); resolve(); });
   });
   await new Promise(resolve => setTimeout(resolve, 1500)); nativeResult('fixture-background');
 }
 const listed = await rpc('tools/call', { name: 'agent_list', arguments: {} }, 3);
 metadata.listed = listed.result; save();
 if (runtime === 'gemini') {
   emit({ type: 'tool_use', tool_name: 'mcp_hara_agent_list', tool_id: 'fixture-list', parameters: {} }); emit({ type: 'tool_result', tool_id: 'fixture-list', status: 'success' });
   emit({ type: 'message', role: 'assistant', content: 'Gemini fixture complete', delta: true }); emit({ type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 10 } });
 } else { emit({ role: 'assistant', content: [{ type: 'text', text: 'Kimi fixture complete' }] }); }
}
if (runtime === 'gemini') executeFixture(JSON.parse(fs.readFileSync(path.join(process.cwd(), '.gemini/settings.json'), 'utf8'))).catch(() => { process.stderr.write('fixture MCP failed\\n'); process.exitCode = 1; });
else {
 const protocol = {mode:'default',model:null}, rl = require('node:readline').createInterface({input:process.stdin}); let config;
 rl.on('line', async line => {
  const request=JSON.parse(line), answer=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  if(request.method==='initialize') answer({protocolVersion:1,agentInfo:{name:'Kimi Code CLI',version:'1.2.3'},agentCapabilities:{mcpCapabilities:{http:true}}});
  else if(request.method==='session/new') { const server=request.params.mcpServers[0];config={mcpServers:{hara:{url:server.url}}}; answer({sessionId:'fixture-session',modes:{availableModes:[{id:'auto'},{id:'plan'}],currentModeId:'default'}}); }
  else if(request.method==='session/set_mode') {protocol.mode=request.params.modeId;answer({});}
  else if(request.method==='session/set_config_option') {protocol.model=request.params.value;answer({configOptions:[]});}
  else if(request.method==='session/prompt') {try {await executeFixture(config,protocol);if(protocol.failure) console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,...protocol.failure}}));else answer({stopReason:'end_turn'});}catch {process.stderr.write('fixture MCP failed\\n');process.exit(1);}}
 });
}

`, { mode: 0o700 });
  const dataRoot = defaultLayout ? join(account, ".hara/workspaces-v1") : join(root, "data");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  host = new LocalWorkspaceHost(dataRoot, { mode: "workspace", hostHome: account, discoveryHome: account, legacySourceHome: account, credentialVault: new MemoryCredentialVault(),
    runtimeInstallerOptions: { accountHome: () => account, discovery: { home: account, probeHome: join(root, "probe"), path: dirname(process.execPath), systemBins: [], run: async (_command, args) => args[0] === "--version" ? `${id} 1.2.3` : null } },
    ...(productionPolicy ? {} : protectedFactory ? { jsonCliPolicyFactory: async input => {
      policyCalls.push({ kind: "create", runtimeId: input.runtimeId, workRoot: input.permit.binding.project.root });
      const result = await createJsonCliExecutionPolicy(input), policy = result.policy;
      for (const name of ["beginAttempt", "observeNativeEvent", "collectWorkspaceEvidence", "drainAttempt", "close"]) {
        const original = policy[name].bind(policy);
        policy[name] = (...args) => { policyCalls.push({ kind: ({ beginAttempt: "begin", observeNativeEvent: "event", collectWorkspaceEvidence: "collect", drainAttempt: "drain", close: "close" })[name], ...(name === "beginAttempt" ? { attemptKey: args[0] } : {}) }); return original(...args); };
      }
      const wrap = policy.wrap.bind(policy);
      policy.wrap = spec => {
        policyCalls.push({ kind: "wrap" }); const launch = wrap(spec);
        const own = launch.onProcess, drain = launch.drainProcess;
        return { ...launch, env: { ...launch.env, HARA_SYNTHETIC_POLICY_WRAP: "yes" },
          async onProcess(child, group) { policyCalls.push({ kind: "on-process" }); await own(child, group); },
          async drainProcess() { policyCalls.push({ kind: "drain-process" }); await drain(); } };
      };
      return result;
    } } : { jsonCliPolicyFactory: async () => { throw Error("runtime_protection_unavailable"); } }),
    providerFactory: (_connection, binding) => ({ id: "openai", model: binding.model, async turn() { throw Error("unexpected external model call"); } }),
  });
  if (defaultLayout) await host.initialize();
  const workspace = host.createWorkspace("Native CLI fixture", host.list().revision), workspaceId = workspace.workspaceId;
  host.configureConnection(workspaceId, { ...SYNTHETIC_CONNECTION }, 0); host.select("fixture", workspaceId, host.list().revision);
  await host.detectRuntimes(workspaceId);
  const row = host.snapshot(workspaceId).runtimes.options.find(row => row.runtimeId === id);
  host.registerLocalRuntime(workspaceId, id, row.fingerprint, "host");
  const main = host.snapshot(workspaceId).agents[0]; if (bind) host.setAgentRuntime(workspaceId, main.agentId, id, main.configRevision, main.agentEpoch);
  const selected = host.snapshot(workspaceId).agents.find(row => row.agentId === main.agentId);
  if (selected.permissionTier !== tier) host.setAgentPermissionTier(workspaceId, main.agentId, tier, selected.configRevision, selected.agentEpoch);
  const project = join(dataRoot, "project", workspaceId); fs.writeFileSync(join(project, ".fixture-mode"), mode);
  const metaPath = join(account, id === "gemini" ? ".gemini/tmp" : ".kimi-code/logs", ".native-fixture-receipt.json");
  return { root, account, host, workspaceId, main: main.agentId, project, policyCalls, metaPath, fakeConfigPath, configDigest, extensionMarker,
    send: (message = "List the colleagues of this Workspace.") => host.start("fixture", workspaceId, main.agentId, message, randomUUID()),
    read: () => host.snapshot(workspaceId, main.agentId, "fixture"), meta: () => JSON.parse(fs.readFileSync(metaPath, "utf8")) };
}
