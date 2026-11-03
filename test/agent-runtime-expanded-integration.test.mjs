import { execFileSync } from "node:child_process";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";
import { createTaskExecution } from "../dist/session/task.js";
import test, { after } from "node:test";
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
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, closeWorkspaceRunPermit, assertWorkspaceRunAdmission, workspaceRunNativeEvidence } from "../dist/workspace/execution.js";
import { sharedExpandedRuntimeProtection } from "../dist/agent-runtime/expanded-policy-adapter.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { runConfiguredAgent } from "../dist/agent-runtime/dispatch.js";

const fixtureRoots = [];
after(() => fixtureRoots.forEach(value => fs.rmSync(value, { recursive: true, force: true })));
function root(_t) {
  const value = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-runtime-b-integration-")));
  fixtureRoots.push(value); return value;
}
function fakeCli(command, id, account, argv, mode, tier) {
  fs.mkdirSync(dirname(command), { recursive: true });
  fs.writeFileSync(command, `#!${process.execPath}
const fs=require("node:fs"), readline=require("node:readline");
const id=${JSON.stringify(id)}, mode=${JSON.stringify(mode)}, full=${JSON.stringify(tier === "full-protected")}, args=process.argv.slice(2);
if(args[0]==="--version"){console.log(id+" 1.2.3");process.exit(0);}
if(args[0]==="--help"){console.log("--effort <level> (low, medium, high, xhigh, max)");process.exit(0);}
if(args[0]==="models"){console.log("fixture-model - Synthetic model");process.exit(0);}
if(process.env.HOME!==${JSON.stringify(account)}||args.includes("login")||args.includes("--reauth"))process.exit(9);
fs.writeFileSync(${JSON.stringify(argv)},JSON.stringify({args,home:process.env.HOME}));
if(mode==="background"){
 const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)",${JSON.stringify(argv)}],{stdio:"ignore"});
 fs.writeFileSync(${JSON.stringify(argv + ".child")},String(child.pid));child.unref();
}
const output=frame=>process.stdout.write(JSON.stringify(frame)+"\\n");
async function callMcp(remote){
 if(!remote.url.startsWith("http://127.0.0.1:"))throw Error("non-fixture destination");
 const auth=Array.isArray(remote.headers)?Object.fromEntries(remote.headers.map(h=>[h.name,h.value])):remote.headers;
 const call=async(method,params,session)=>{
   const response=await fetch(remote.url,{method:"POST",headers:{...auth,"Content-Type":"application/json",Accept:"application/json, text/event-stream",...(session?{"Mcp-Session-Id":session}:{})},
     body:JSON.stringify({jsonrpc:"2.0",id:method==="initialize"?1:2,method,params})});
   if(!response.ok)throw Error("MCP refused");
   const text=await response.text(),body=text.startsWith("event:")?JSON.parse(text.split("\\n").find(line=>line.startsWith("data: ")).slice(6)):JSON.parse(text);
   return {body,session:response.headers.get("mcp-session-id")||session};
 };
 const initialized=await call("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"synthetic-b",version:"1"}});
 await fetch(remote.url,{method:"POST",headers:{...auth,"Content-Type":"application/json","Mcp-Session-Id":initialized.session},body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})});
 const listed=await call("tools/list",{},initialized.session);
 if(!listed.body.result.tools.some(row=>row.name==="agent_list"))throw Error("agent_list missing");
 const result=await call("tools/call",{name:"agent_list",arguments:{}},initialized.session);
 return "Team: "+result.body.result.content[0].text;
}
if(id==="grok"){
 if(args.includes("--always-approve")!==full||!args.includes("stdio"))process.exit(10);
 let remote,promptId;
 const finish=async()=>{
   if(mode==="native-write")try{fs.writeFileSync("native-result.txt","Synthetic native result");}catch{output({jsonrpc:"2.0",id:promptId,error:{code:-32000,message:"native write denied"}});return;}
   const text=await callMcp(remote);
   output({jsonrpc:"2.0",method:"session/update",params:{sessionId:"fixture-session",update:{sessionUpdate:"tool_call",title:mode==="native-write"?"write_file":"read_file",kind:mode==="native-write"?"edit":"read",status:"completed",rawInput:{secret:"PRIVATE_NATIVE_ARGS"}}}});
   output({jsonrpc:"2.0",method:"session/update",params:{sessionId:"fixture-session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}});
   output({jsonrpc:"2.0",id:promptId,result:{stopReason:"end_turn"}});
 };
 const lines=readline.createInterface({input:process.stdin});
 lines.on("line",async line=>{try{
  const request=JSON.parse(line);if(request.jsonrpc!=="2.0")process.exit(11);
  if(request.method==="initialize"){output({jsonrpc:"2.0",id:request.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:mode!=="no-mcp"}}}});}
  else if(request.method==="session/new"){remote=request.params.mcpServers[0];if(request.params.cwd!==process.cwd())process.exit(12);output({jsonrpc:"2.0",id:request.id,result:{sessionId:"fixture-session"}});}
  else if(request.method==="session/prompt"){promptId=request.id;if(mode==="cancel")return;if(!full){await finish();return;}output({jsonrpc:"2.0",id:99,method:"session/request_permission",params:{sessionId:mode==="foreign-permission"?"foreign":"fixture-session",toolCall:{title:mode==="native-schedule"?"CronCreate":"read_file"},options:[{kind:"allow_once",optionId:"once"}]}});}
  else if(request.id===99){
    if(request.result?.outcome?.outcome!=="selected"){output({jsonrpc:"2.0",id:promptId,error:{code:-32000,message:"permission cancelled PRIVATE_ACCOUNT"}});return;}
    await finish();
  }
 }catch{output({jsonrpc:"2.0",id:999,error:{code:-32000,message:"fixture failed"}});}});
}else{
 (async()=>{
  if(id==="copilot"&&(args.includes("--allow-all-tools")!==full||args.includes("--allow-all-paths")!==full))process.exit(10);
  if(id==="cursor"&&args.includes("--force")!==full)process.exit(10);
  if(mode==="native-write")fs.writeFileSync("native-result.txt","Synthetic native result");
  const configPath=id==="copilot"?args.find(arg=>arg.startsWith("--additional-mcp-config=@")).slice("--additional-mcp-config=@".length):require("node:path").join(process.cwd(),".cursor/mcp.json");
  const remote=JSON.parse(fs.readFileSync(configPath,"utf8")).mcpServers.hara;
  const text=await callMcp(remote);
  if(mode==="terminal-error"){output({type:"session.error",data:{message:"401 PRIVATE_ACCOUNT"}});process.exit(0);}
  if(id==="copilot"){output({type:"tool.execution_complete",data:{toolName:mode==="native-write"?"write_file":"read_file",success:true}});output({type:"assistant.message",data:{content:text}});output({type:"session.idle"});}
  else{output({type:"tool_call",subtype:"completed",tool_call:{[mode==="native-write"?"writeToolCall":"readToolCall"]:{args:{path:mode==="native-write"?"native-result.txt":"README.md"}}}});output({type:"assistant",message:{content:[{type:"text",text}]}});output({type:"result",subtype:"success",is_error:false,result:text});}
 })().catch(()=>process.exit(13));
}
`, { mode: 0o755 });
}
async function fixture(t, id, kind = "main", mode = "ok", tier = "full-protected") {
  const data = root(t), account = root(t), project = root(t), home = join(data, "state"), temp = root(t);
  fs.mkdirSync(home); const command = join(account, ".local/bin", id === "cursor" ? "cursor-agent" : id),
    argv = join(account, "." + id, id === "cursor" ? "chats" : "logs", "argv.json");
  fs.mkdirSync(dirname(argv), { recursive: true });
  fakeCli(command, id, account, argv, mode, tier);
  const originalCursor = '{ "mcpServers": { "kept": { "url": "http://127.0.0.1:2/mcp" } } }\n';
  if (id === "cursor") { fs.mkdirSync(join(project, ".cursor"), { mode: 0o700 }); fs.writeFileSync(join(project, ".cursor/mcp.json"), originalCursor); }
  const catalog = new LocalWorkspaceCatalog(home), row = catalog.create("Synthetic B", 1);
  const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize();
  const installer = new WorkspaceRuntimeInstaller(storage, { accountHome: () => account, discovery: { home: account,
    probeHome: temp, path: dirname(process.execPath) + ":/usr/bin:/bin", systemBins: [],
    run: async (_command, args) => args[0] === "-lic" ? null : id + " 1.2.3" } });
  t.after(() => installer.close());
  const resources = new WorkspaceResources(home, row.scope, { runtimeInstaller: installer }); resources.initialize();
  const main = resources.agents.initializeMain();
  await installer.discover(); const detected = installer.list().options.find(row => row.runtimeId === id);
  assert.equal(detected.state, "detected"); assert.throws(() => installer.registerLocal(id, detected.fingerprint, "isolated"), /unsafe/);
  installer.registerLocal(id, detected.fingerprint, "host");
  // Only these fake binaries may use the direct metadata contract seam.
  const models = new WorkspaceRuntimeModels(storage, installer, async input => {
    assert.equal(input.command, command); assert.equal(input.env.HOME, account);
    return runExternalCommandCapture({ command: input.command, env: input.env }, input.runtimeId === "cursor" ? ["models"] : ["--help"],
      { cwd: account, timeoutMs: 5000 });
  }), inventory = await models.list(id);
  assert.equal(inventory.source, id === "cursor" ? "live" : "documented");
  await models.select(id, inventory.models[0].id, 0, null);
  const agent = kind === "main" ? main : resources.agents.create({ username: "tester", profile: { displayName: "Tester" } }, resources.agents.list().revision);
  let selected = resources.agents.setRuntime(agent.agentId, id, agent.configRevision, agent.agentEpoch);
  if (selected.permissionTier !== tier) selected = resources.agents.setPermissionTier(selected.agentId, tier, selected.configRevision, selected.agentEpoch);
  const task = resources.agents.bindTask(createTaskExecution("List colleagues", randomUUID()), selected.agentId, selected.configRevision, selected.agentEpoch);
  const connections = new WorkspaceSecureConnections(storage, new MemoryCredentialVault());
  connections.add({ label: "Synthetic", provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "fixture", defaultModel: "fixture" }, 0);
  const binding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: row.scope, agent: task.workspaceAgentBinding,
    agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding), connection: connections.capture(), runtimeContract: "hara-governed-runtime-v1",
    project: captureWorkspaceProjectIdentity(project), sessionId: randomUUID(), runId: randomUUID(),
    lineage: { rootRunId: null, parentRunId: null, depth: 0 }, createdAt: new Date().toISOString(),
    host: { hostId: catalog.read().hostId, hostEpoch: 1, grantId: row.grantId, grantRevision: 1, actorId: row.actorId, policyRevision: 1 },
    budget: { maxRounds: 12, maxToolCalls: 32, maxTokens: 32000, timeoutMs: 30000 } });
  task.workspaceRunBinding = binding;
  const controller = new AbortController(), lease = WorkspaceSessionLease.acquire(storage, binding.sessionId); let calls = 0, wrapped = 0, closed = 0, collected = 0, owned = 0, drained = 0;
  const observations = [], liveEvidence = [];
  const permit = createWorkspaceRunPermit({ binding, catalog, resources, storage, connections, lease, cwd: project, signal: controller.signal,
    provider: { id: "openai", model: binding.connection.model, async turn() { throw Error("provider fallback forbidden"); } },
    toolNames: ["agent_list"], usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }, updateUsage() {} });
  t.after(async () => { controller.abort(); await closeWorkspaceRunPermit(permit); });
  const options = bindWorkspaceRunOptions(permit, { ctx: { cwd: project, sessionId: binding.sessionId, sandbox: "off" },
    signal: controller.signal, approval: "auto-edit", approvalChannel: true, confirm: async () => false, hooks: false,
    systemOverride: "Use agent_list and reply concisely", taskIntake: { task, current: () => task },
    extraTools: [{ name: "agent_list", description: "List colleagues", kind: "read", input_schema: { type: "object", properties: {} },
      async run() { calls++; liveEvidence.push(workspaceRunNativeEvidence(permit)); return "Tester"; } }] });
  // Explicit fake-CLI test seam, not a production sandbox or an assertion that Seatbelt passed.
  const testProtector = async input => {
    assert.equal(input.command, command); assert.equal(input.env.HOME, account);
    return { fullProtected: tier === "full-protected", temporaryDirectory: temp,
      assertCurrent: () => assertWorkspaceRunAdmission(permit, options, id),
      wrap(command, args, env) { wrapped++; return { command, args: [...args], env, async onProcess() {}, async drainProcess() {} }; },
      observeNativeTool(event) { observations.push(event); },
      collectEvidence() { collected++; if (id === "cursor") assert.ok(JSON.parse(fs.readFileSync(join(project, ".cursor/mcp.json"), "utf8")).mcpServers.hara); },
      async close() { closed++; },
    };
  };
  const tracedProtection = async input => {
    const protection = await sharedExpandedRuntimeProtection(input);
    return { ...protection,
      wrap(...args) {
        wrapped++; const launch = protection.wrap(...args);
        assert.equal(typeof launch.onProcess, "function"); assert.equal(typeof launch.drainProcess, "function");
        return { ...launch,
          async onProcess(...processArgs) { owned++; await launch.onProcess(...processArgs); },
          async drainProcess() { drained++; await launch.drainProcess(); },
        };
      },
      async collectEvidence() { collected++; await protection.collectEvidence(); },
      async close() { closed++; await protection.close(); },
    };
  };
  const history = [{ role: "user", content: "List colleagues" }];
  const run = protect => storage.run(() => runConfiguredAgent(history, options, new AgentRuntimeRegistry(undefined, installer, models, protect ?? tracedProtection)));
  return { id, run, testProtector, history, argv, project, originalCursor, binding, liveEvidence,
    evidence: () => workspaceRunNativeEvidence(permit), models, installer, observations, controller,
    state: () => ({ calls, wrapped, closed, collected, owned, drained }) };
}
for (const id of ["copilot", "cursor", "grok"]) for (const kind of ["main", "colleague"])
  test(id + " " + kind + " reaches the governed Hara MCP bridge with only a fake host login", async t => {
    const f = await fixture(t, id, kind), result = await f.run(f.testProtector);
    assert.equal(result.status, "completed", result.error);
    assert.equal(f.state().calls, 1); assert.equal(f.state().wrapped, 1); assert.equal(f.state().closed, 1); assert.equal(f.state().collected, 1);
    assert.match(f.history.at(-1).text, /Team: Tester/);
    assert.ok(f.observations.length > 0); assert.equal(JSON.stringify(f.observations).includes("PRIVATE_NATIVE_ARGS"), false);
    const version = f.installer.list().options.find(row => row.runtimeId === id).versionStatus;
    assert.equal(version.lastSuccessfulVersion, "1.2.3"); assert.equal(version.compatibility, "previously_succeeded");
  });
test("a missing common protector cannot start a full CLI process", async t => {
  const f = await fixture(t, "copilot"), result = await f.run(async () => { throw new Error("runtime_permission_denied"); });
  assert.equal(result.status, "error"); assert.equal(fs.existsSync(f.argv), false); assert.equal(f.state().calls, 0);
  assert.match(result.error, /runtime_permission_denied/);
});
for (const [id, mode] of [["copilot", "terminal-error"], ["grok", "foreign-permission"], ["grok", "no-mcp"], ["grok", "native-schedule"]])
  test(id + " " + mode + " cannot record a successful version or leak a raw account error", async t => {
    const f = await fixture(t, id, "main", mode), result = await f.run(f.testProtector);
    assert.equal(result.status, "error"); assert.equal(result.error.includes("PRIVATE_ACCOUNT"), false);
    assert.equal(f.state().closed, 1);
    assert.equal(f.installer.list().options.find(row => row.runtimeId === id).versionStatus.lastSuccessfulVersion, null);
  });

for (const id of ["copilot", "cursor", "grok"]) for (const tier of ["full-protected", "controlled"])
  test(id + " " + tier + " uses public ownership, drain and the governed MCP bridge", { skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, id, "main", "ok", tier), outcome = await f.run();
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(f.binding.agent.permissionTier, tier);
    assert.equal(f.state().calls, 1); assert.equal(f.state().wrapped, 1);
    assert.equal(f.state().owned, 1); assert.ok(f.state().drained >= 1);
    assert.equal(f.state().collected, 1); assert.equal(f.state().closed, 1);
    assert.equal(f.evidence(), null); assert.deepEqual(f.liveEvidence, [null]);
    if (id === "cursor") assert.equal(fs.readFileSync(join(f.project, ".cursor/mcp.json"), "utf8"), f.originalCursor);
    assert.equal(f.installer.list().options.find(row => row.runtimeId === id).versionStatus.lastSuccessfulVersion, "1.2.3");
  });
for (const id of ["copilot", "cursor", "grok"]) for (const tier of ["full-protected", "controlled"])
  test(id + " " + tier + " native write produces only Host-verified workspace evidence", { skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, id, "main", "native-write", tier), outcome = await f.run();
    if (tier === "controlled") {
      assert.equal(outcome.status, "error"); assert.equal(fs.existsSync(join(f.project, "native-result.txt")), false);
      assert.equal(f.evidence(), null); assert.equal(f.state().calls, 0);
      assert.equal(f.installer.list().options.find(row => row.runtimeId === id).versionStatus.lastSuccessfulVersion, null);
    } else {
      assert.equal(outcome.status, "completed", outcome.error);
      assert.equal(fs.readFileSync(join(f.project, "native-result.txt"), "utf8"), "Synthetic native result");
      const evidence = f.evidence(); assert.equal(evidence.source, "native-workspace-diff");
      assert.equal(evidence.attemptKey, f.binding.runId); assert.ok(evidence.nativeEventCount > 0);
      assert.deepEqual(evidence.changes.map(row => [row.path, row.change]), [["native-result.txt", "created"]]);
    }
    if (id === "cursor") assert.equal(fs.readFileSync(join(f.project, ".cursor/mcp.json"), "utf8"), f.originalCursor);
    assert.equal(f.state().owned, 1); assert.ok(f.state().drained >= 1); assert.equal(f.state().closed, 1);
  });
test("Grok cancellation closes the public wrapped fake ACP process and never records a success", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "grok", "main", "cancel"), pending = f.run();
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(f.argv) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(f.argv), true); f.controller.abort();
  const outcome = await pending;
  assert.notEqual(outcome.status, "completed"); assert.equal(f.state().closed, 1); assert.equal(f.state().calls, 0);
  assert.equal(f.installer.list().options.find(row => row.runtimeId === "grok").versionStatus.lastSuccessfulVersion, null);
});

for (const id of ["copilot", "cursor", "grok"]) test(id + " public attempt clears an inherited background child on normal completion", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, id, "main", "background");
  const inspect = pid => { try { return execFileSync("/bin/ps", ["-o", "state=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
  let pid;
  t.after(() => { if (pid) { const state = inspect(pid); if (state.includes(f.argv) && !state.startsWith("Z")) try { process.kill(pid, "SIGKILL"); } catch {} } });
  const outcome = await f.run();
  pid = Number(fs.readFileSync(f.argv + ".child", "utf8")); assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.equal(outcome.status, "completed", outcome.error);
  const deadline = Date.now() + 5000; let state;
  do { state = inspect(pid); if (!state || state.startsWith("Z")) break; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
  assert.ok(!state || state.startsWith("Z"), "owned background child must no longer run");
});
