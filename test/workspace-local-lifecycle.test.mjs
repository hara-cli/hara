import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { createTaskExecution, isTaskExecution } from "../dist/session/task.js";

const temporary=[];
after(()=>{for(const path of temporary)fs.rmSync(path,{recursive:true,force:true});});
function dir(){const path=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-local-lifecycle-")));temporary.push(path);return path;}
function setup(assertCurrent){
 const home=dir(),catalog=new LocalWorkspaceCatalog(home),row=catalog.create("Private",1);
 const storage=new WorkspaceResourceStorage(home,row.scope,assertCurrent);storage.initialize();
 const resources=new WorkspaceResources(home,row.scope);resources.initialize();const main=resources.agents.initializeMain();
 const connections=new WorkspaceConnectionStoreV2(storage);connections.add({label:"Synthetic",provider:"openai",baseURL:"http://127.0.0.1:1/v1",apiKey:"synthetic-not-real",defaultModel:"synthetic"},0);
 const conversation=new WorkspaceConversationStore(storage,main.agentId);
 function task(){
  const t=resources.agents.bindTask(createTaskExecution("synthetic","turn"),main.agentId,main.configRevision,main.agentEpoch);
  t.workspaceRunBinding=freezeWorkspaceRunBinding({schemaVersion:1,scope:row.scope,agent:t.workspaceAgentBinding,
   agentBindingHash:workspaceAgentBindingHash(t.workspaceAgentBinding),connection:connections.capture(),runtimeContract:"hara-governed-pi-v1",
   sessionId:conversation.sessionId,runId:randomUUID(),createdAt:new Date().toISOString(),
   host:{hostId:catalog.read().hostId,hostEpoch:1,grantId:row.grantId,grantRevision:1,actorId:row.actorId,policyRevision:1},
   budget:{maxRounds:16,maxToolCalls:32,maxTokens:32000,timeoutMs:60000}});return t;
 }
 const lock=id=>join(home,".hara","workspace-data","v1",storage.scopeKey,"state",".hara","workspace-run-locks",`${id}.json`);
 return {home,catalog,row,storage,resources,main,conversation,task,lock};
}
test("same process cannot reenter a lease; draining keeps ownership and release is idempotent",()=>{
 const a=setup(),lease=WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId);
 assert.throws(()=>WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId),/busy/);
 lease.setDraining(true);assert.throws(()=>lease.release(),/draining/);
 assert.throws(()=>WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId),/busy/);
 lease.setDraining(false);lease.release();lease.release();assert.equal(fs.existsSync(a.lock(a.conversation.sessionId)),false);
 const next=WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId);next.release();
});
test("an acquired owner can clean precisely after authority revocation, without business access",()=>{
 let revoked=false;const a=setup(()=>{if(revoked)throw new Error("revoked");});
 const lease=WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId);revoked=true;
 assert.throws(()=>a.conversation.read(),/revoked/);lease.release();assert.equal(fs.existsSync(a.lock(a.conversation.sessionId)),false);
});
test("post-publication admission failure cleans only the newly published owner receipt",()=>{
 const a=setup();let enabled=false;
 const storage=new WorkspaceResourceStorage(a.home,a.row.scope,()=>{if(enabled&&fs.existsSync(a.lock(a.conversation.sessionId)))throw new Error("revoked after publication");});
 storage.initialize();enabled=true;
 assert.throws(()=>WorkspaceSessionLease.acquire(storage,a.conversation.sessionId),/revoked after publication/);
 assert.equal(fs.existsSync(a.lock(a.conversation.sessionId)),false);
});
test("foreign replacement, malformed owner and directory alias never authorize cleanup/takeover",()=>{
 const a=setup(),id=a.conversation.sessionId,lease=WorkspaceSessionLease.acquire(a.storage,id),path=a.lock(id);
 const bytes=fs.readFileSync(path);fs.renameSync(path,path+".original");fs.writeFileSync(path,bytes,{mode:0o600});
 assert.throws(()=>lease.release(),/changed/);assert.deepEqual(fs.readFileSync(path),bytes);
 fs.writeFileSync(path,"{}",{mode:0o600});assert.throws(()=>WorkspaceSessionLease.acquire(a.storage,id),/invalid/);
 assert.equal(fs.readFileSync(path,"utf8"),"{}");
});
test("conversation/task/binding/usage persist as one strict snapshot with CAS and non-resettable resume budgets",()=>{
 const a=setup(),task=a.task(),value=a.conversation.read(),at=new Date().toISOString();
 assert.equal(isTaskExecution(task),true);assert.equal(isTaskExecution({...task,workspaceAgentBinding:undefined}),false);
 value.task=task;value.attempt={attemptId:randomUUID(),fence:1,runId:task.workspaceRunBinding.runId,state:"running",startedAt:at,endedAt:null};
 value.history=[{role:"user",content:"synthetic question"}];value.usage.modelCalls=2;value.runUsage.modelCalls=2;
 let saved=a.conversation.save(0,value);assert.throws(()=>a.conversation.save(0,value),/changed/);
 assert.deepEqual(new WorkspaceConversationStore(a.storage,a.main.agentId).read(),saved);
 assert.throws(()=>a.conversation.save(saved.revision,{...saved,runUsage:{...saved.runUsage,modelCalls:0}}),/cannot reset/);
 assert.throws(()=>a.conversation.save(saved.revision,{...saved,attempt:{...saved.attempt,attemptId:randomUUID(),fence:2}}),/recovered/);
 saved=a.conversation.save(saved.revision,{...saved,attempt:{...saved.attempt,state:"interrupted",endedAt:at}});
 assert.throws(()=>a.conversation.save(saved.revision,{...saved,attempt:{...saved.attempt,attemptId:randomUUID()}}),/higher fence/);
 saved=a.conversation.save(saved.revision,{...saved,attempt:{...saved.attempt,attemptId:randomUUID(),fence:2,state:"running",endedAt:null}});
 assert.equal(saved.runUsage.modelCalls,2);
});
test("new task archives prior run atomically and does not erase provenance or old completion evidence",()=>{
 const a=setup();let value=a.conversation.read();value.task=a.task();value.task.status="completed";
 let saved=a.conversation.save(0,value);const next=a.task();
 assert.throws(()=>a.conversation.save(saved.revision,{...saved,task:next}),/archived atomically/);
 saved=a.conversation.save(saved.revision,{...saved,task:next,pastTasks:[{task:saved.task,usage:saved.runUsage,endedAt:new Date().toISOString()}]});
 assert.equal(saved.pastTasks[0].task.workspaceRunBinding.runId,value.task.workspaceRunBinding.runId);
 assert.throws(()=>a.conversation.save(saved.revision,{...saved,pastTasks:[]}),/history cannot be rewritten/);
});
test("two real processes cannot write concurrently; a proven dead isolated child is recovered without an age heuristic",async()=>{
 const a=setup(),base=pathToFileURL(resolve("dist/workspace")).href+"/";
 const code=`import {WorkspaceResourceStorage} from '${base}resource-context.js';import {WorkspaceSessionLease} from '${base}session-lease.js';
 const s=new WorkspaceResourceStorage(process.argv[1],JSON.parse(process.argv[2]));s.initialize();
 try{WorkspaceSessionLease.acquire(s,process.argv[3]);console.log('OWNED');process.stdin.resume();}catch(e){console.log('BUSY');process.exitCode=31;}`;
 const start=()=>spawn(process.execPath,["--input-type=module","--eval",code,a.home,JSON.stringify(a.row.scope),a.conversation.sessionId],
  {env:{PATH:process.env.PATH,HOME:a.home,USERPROFILE:a.home},stdio:["pipe","pipe","pipe"]});
 const first=start(),firstExit=once(first,"exit");let diagnostic="";first.stderr.on("data",x=>diagnostic+=x);try{
  const ready=once(first.stdout,"data").then(([bytes])=>bytes.toString());
  assert.match(await Promise.race([ready,firstExit.then(([code])=>{throw new Error(`lease fixture exited before ready: ${code}: ${diagnostic}`);})]),/OWNED/);
  assert.throws(()=>WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId),/busy/);
  const second=start();let output="";second.stdout.on("data",x=>output+=x);assert.equal((await once(second,"exit"))[0],31);assert.match(output,/BUSY/);
  first.kill("SIGTERM");await firstExit;
  const recovered=WorkspaceSessionLease.acquire(a.storage,a.conversation.sessionId);recovered.release();
 }finally{if(first.exitCode===null&&first.signalCode===null){first.kill("SIGTERM");await firstExit;}}
});
