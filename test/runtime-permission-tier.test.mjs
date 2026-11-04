import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {WorkspaceResources} from "../dist/workspace/resources.js";
import {workspaceResourceScopeKey} from "../dist/workspace/resource-context.js";
import {isWorkspaceAgentTaskBinding} from "../dist/workspace/agent-binding.js";
import {createTaskExecution,applyTaskBrief} from "../dist/session/task.js";
import {CompletionEvidenceLedger,completionEvidenceScope} from "../dist/agent/completion-evidence.js";
import {WorkspaceChangeTrace} from "../dist/agent/governance-c-lite.js";
import {createRuntimeExecutionPolicy} from "../dist/agent-runtime/execution-policy.js";
import {codexHostToolOverrides} from "../dist/agent-runtime/codex-host-config.js";
import {registeredCliArgs} from "../dist/agent-runtime/registered-cli.js";
const scope={schemaVersion:1,workspaceId:"ws_10000000-0000-4000-8000-000000000001",authority:{kind:"local",localAuthorityId:"20000000-0000-4000-8000-000000000001"}};
const root=t=>{const p=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"permission-tier-")));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const bind=(r,a)=>r.agents.bindTask(createTaskExecution("Edit the fixture file","turn"),a.agentId,a.configRevision,a.agentEpoch).workspaceAgentBinding;
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v);
test("new tasks freeze the default full tier; switching preserves old task and persona/runtime edits preserve the new tier",t=>{
 const r=new WorkspaceResources(root(t),scope);r.initialize();let a=r.agents.initializeMain();assert.equal(a.permissionTier,"full-protected");
 const old=bind(r,a);assert.equal(old.permissionTier,"full-protected");
 a=r.agents.setPermissionTier(a.agentId,"controlled",a.configRevision,a.agentEpoch);const next=bind(r,a);assert.equal(next.permissionTier,"controlled");
 assert.equal(r.agents.resolveTask(old).permissionTier,"full-protected");assert.equal(r.agents.resolveTask(next).permissionTier,"controlled");
 assert.throws(()=>r.agents.setPermissionTier(a.agentId,"full-protected",1,a.agentEpoch),/changed/);
 a=r.agents.setRuntime(a.agentId,"hara",a.configRevision,a.agentEpoch);assert.equal(a.permissionTier,"controlled");
 assert.throws(()=>r.agents.resolveTask({...next,permissionTier:"full-protected"}),/Frozen/);
 const {permissionTier,...legacy}=old;assert.equal(isWorkspaceAgentTaskBinding(legacy),true);assert.equal(r.agents.resolveTask(legacy).permissionTier,"full-protected");
 assert.equal(isWorkspaceAgentTaskBinding({...legacy,permissionTier:"unrestricted"}),false);
});
test("legacy configuration hashes remain readable; new task freezing does not alter a legacy binding",t=>{
 const home=root(t),r=new WorkspaceResources(home,scope);r.initialize();const a=r.agents.initializeMain(),old=bind(r,a);
 const file=join(home,".hara/workspace-data/v1",workspaceResourceScopeKey(scope),"state/.hara/workspace-agents.json");
 const raw=JSON.parse(fs.readFileSync(file));for(const c of raw.agents[0].configurations){delete c.permissionTier;delete c.hash;c.hash=createHash('sha256').update('hara-workspace-agent-config-v1\0').update(canonical(c)).digest('hex');}
 fs.writeFileSync(file,JSON.stringify(raw),{mode:0o600});
 const restarted=new WorkspaceResources(home,scope);restarted.initialize();assert.equal(restarted.agents.get(a.agentId).permissionTier,"full-protected");
 const fresh=bind(restarted,restarted.agents.get(a.agentId));assert.equal(fresh.permissionTier,"full-protected");
 const {permissionTier,...legacy}=fresh;assert.equal(restarted.agents.resolveTask(legacy).permissionTier,undefined);assert.equal(Object.hasOwn(legacy,'permissionTier'),false);
});
function changeTask(){return applyTaskBrief(createTaskExecution("Edit the fixture file","turn"),{intent:"change",goal:"Edit fixture",constraints:[],acceptance:["file updated"],steps:["edit"]}).task;}
const check=(ids,native=[])=>({completion:{state:"verified",checks:[{acceptance_index:0,evidence:"Observed fixture file change",tool_call_ids:ids,native_evidence_ids:native}]}});
test("N1 rejects read-only change checks and accepts a current successful write effect",()=>{
 const task=changeTask(),ledger=new CompletionEvidenceLedger(),scope=completionEvidenceScope(task);
 ledger.finish(ledger.begin(scope,"r","workspace_read","read"),"read ok",false);assert.equal(ledger.bind(task,check(["r"])).ok,false);
 ledger.finish(ledger.begin(scope,"w","workspace_write","edit"),"write ok",false);assert.equal(ledger.bind(task,check(["r","w"])).ok,true);
});
test("native file proof supports C-lite and explicit checks; prose, no diff, stale scope and failed tools cannot",t=>{
 const dir=root(t),work=join(dir,"work"),home=join(dir,"account");fs.mkdirSync(work);fs.mkdirSync(home);
 const p=createRuntimeExecutionPolicy({runtimeId:"codex",tier:"full-protected",accountHome:home,workRoot:work});t.after(()=>p.close());p.beginAttempt("attempt-1");
 const task=changeTask(),scope=completionEvidenceScope(task),ledger=new CompletionEvidenceLedger(),trace=new WorkspaceChangeTrace();
 p.observeNativeEvent({type:"file",status:"completed",path:"file.txt",operation:"write"});assert.equal(p.collectWorkspaceEvidence(),null);assert.equal(trace.evidence(),null);
 fs.writeFileSync(join(work,"file.txt"),"actual");const proof=p.collectWorkspaceEvidence();ledger.observeNative(scope,proof);
 assert.equal(ledger.bind(task,check([],[proof.id])).ok,true);assert.match(trace.evidence(proof)[0],/native-workspace-diff/);
 assert.equal(ledger.bind({...task,turnId:"other-turn"},check([],[proof.id])).ok,false);assert.equal(ledger.bind(task,check([],["invented"])).ok,false);
 ledger.observeNative(scope,null);assert.equal(ledger.bind(task,check([],[proof.id])).ok,false);
 trace.observe({id:"failed",name:"workspace_write",content:"Error: denied",isError:true},true);assert.equal(trace.evidence(proof),null);
});
test("native configuration disables global integrations and schedulers without changing host login",t=>{
 const home=root(t);fs.mkdirSync(join(home,".codex"));const cfg=join(home,".codex/config.toml");fs.writeFileSync(cfg,'[mcp_servers.personal]\ncommand="do-not-run"\n[hooks]\n');
 const before=fs.readFileSync(cfg),args=codexHostToolOverrides(home);assert.ok(args.includes('mcp_servers."personal"={enabled=false,command="hara-disabled-global-mcp"}'));assert.ok(args.includes('features.hooks=false'));assert.ok(args.includes('features.plugins=false'));assert.ok(args.includes('features.in_app_local_automation=false'));assert.deepEqual(fs.readFileSync(cfg),before);
 fs.writeFileSync(cfg,'[mcp_servers.hara_workspace_000000000000000000000000]\ncommand="do-not-run"');assert.throws(()=>codexHostToolOverrides(home,undefined,undefined,"hara_workspace_000000000000000000000000"),/private Hara namespace/);
 fs.writeFileSync(cfg,'mcp_servers={personal={command="do-not-run"}}');assert.throws(()=>codexHostToolOverrides(home),/Inline/);
 for(const permissionTier of ["full-protected","controlled"]){const a=registeredCliArgs({id:"claude",permissionTier,prompt:"fixture",cwd:home,model:null,effort:null,skipGitRepoCheck:false});assert.ok(a.includes("Cron*"));assert.ok(a.includes("project,local"));assert.ok(a.some(v=>v.includes('"disableAllHooks":true')));assert.ok(a.some(v=>v.includes('"enabled":false')));}
});

test("custom provider keeps host HOME but strips its OAuth/provider environment and uses a separate config",async()=>{
 const {claudeCustomProviderEnv}=await import("../dist/agent-runtime/custom-provider-env.js");
 const host={HOME:"/fixture/account",ANTHROPIC_API_KEY:"HOST_FAKE",ANTHROPIC_AUTH_TOKEN:"HOST_FAKE",CLAUDE_CODE_OAUTH_TOKEN:"HOST_FAKE",CLAUDE_CODE_OAUTH_REFRESH_TOKEN:"HOST_FAKE",HTTPS_PROXY:"http://127.0.0.1:9999"};
 const env=claudeCustomProviderEnv(host,"/fixture/custom-provider",{baseURL:"https://provider.invalid",apiKey:"EXPLICIT_FAKE"});
 assert.equal(env.HOME,host.HOME);assert.equal(env.CLAUDE_CONFIG_DIR,"/fixture/custom-provider");assert.equal(env.ANTHROPIC_API_KEY,"EXPLICIT_FAKE");assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,undefined);assert.equal(env.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(env.HTTPS_PROXY,host.HTTPS_PROXY);assert.equal(host.CLAUDE_CODE_OAUTH_TOKEN,"HOST_FAKE");
 assert.throws(()=>claudeCustomProviderEnv(host,"/fixture/account/.claude",{baseURL:"https://provider.invalid",apiKey:"EXPLICIT_FAKE"}),/separate/);
});

test("protected capture cancellation joins actual close before releasing its owner",async()=>{
 const {EventEmitter}=await import("node:events"),{PassThrough}=await import("node:stream"),{runExternalCommandCapture}=await import("../dist/external-sessions/process.js");
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{setTimeout(()=>child.emit("close",null,"SIGKILL"),20);return true;};
 const controller=new AbortController();let settled=false;
 const run=runExternalCommandCapture({command:process.execPath,spawnProcess:()=>child},[],{signal:controller.signal,waitForClose:true}).then(value=>{settled=true;return value;});
 setTimeout(()=>child.emit("close",null,"SIGKILL"),20);controller.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);const result=await run;assert.equal(result.errorCode,"interrupted");assert.equal(settled,true);
});
test("OpenCode transient settings do not replace the host login data or import ambient integrations",async()=>{
 const {openCodeRunEnv}=await import("../dist/agent-runtime/opencode-cli.js");const env=openCodeRunEnv({HOME:"/fixture/account",XDG_DATA_HOME:"/fixture/login-data",OPENCODE_CONFIG_CONTENT:"PRIVATE_FAKE_CONFIG",HTTPS_PROXY:"http://127.0.0.1:9999"},{toolNames:["workspace_read"],mcp:{type:"remote",url:"http://127.0.0.1:1/mcp"}},true,"/fixture/owned-temp/config");
 assert.equal(env.HOME,"/fixture/account");assert.equal(env.XDG_DATA_HOME,"/fixture/login-data");assert.equal(env.XDG_CONFIG_HOME,"/fixture/owned-temp/config");assert.equal(env.HTTPS_PROXY,"http://127.0.0.1:9999");const config=JSON.parse(env.OPENCODE_CONFIG_CONTENT);assert.deepEqual(Object.keys(config.mcp),["hara"]);assert.equal(config.tools.bash,true);assert.equal(config.tools.task,false);assert.deepEqual(config.plugin,[]);assert.equal(env.OPENCODE_PURE,"1");
});


test("conversation proof rejects unobserved writes, native calls and invalidated snapshots", t => {
 const dir=root(t),work=join(dir,"work"),home=join(dir,"account");fs.mkdirSync(work);fs.mkdirSync(home);
 const p=createRuntimeExecutionPolicy({runtimeId:"codex",tier:"full-protected",accountHome:home,workRoot:work});t.after(()=>p.close());
 fs.writeFileSync(join(dir,"outside.txt"),"opaque fixture");fs.symlinkSync(join(dir,"outside.txt"),join(work,"unchanged-link"));
 p.beginAttempt("conversation");assert.equal(p.canCompleteConversation(),true);
 fs.writeFileSync(join(work,"native.txt"),"unexpected");assert.equal(p.canCompleteConversation(),false);
 fs.unlinkSync(join(work,"native.txt"));p.observeNativeEvent({type:"tool",status:"completed",operation:"read"});assert.equal(p.canCompleteConversation(),false);
 p.beginAttempt("fresh-conversation");assert.equal(p.canCompleteConversation(),true);p.invalidateEvidence();assert.equal(p.canCompleteConversation(),false);
});
