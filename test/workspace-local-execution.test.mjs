import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import "../dist/tools/all.js";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { freezeWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { WorkspaceSessionLease } from "../dist/workspace/session-lease.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, beginWorkspaceGovernedRun, closeWorkspaceRunPermit, executeWorkspaceTool, prepareWorkspaceRunHistory } from "../dist/workspace/execution.js";
import { WorkspaceExecutionAudit } from "../dist/workspace/execution-audit.js";
import { createTaskExecution, finishTaskExecution } from "../dist/session/task.js";
import { runConfiguredAgent, bindNewAgentTask } from "../dist/agent-runtime/dispatch.js";
import { runAgent } from "../dist/agent/loop.js";
import { runPiAgent } from "../dist/agent-runtime/pi.js";

const temporary=[];
after(()=>{for(const path of temporary)fs.rmSync(path,{recursive:true,force:true});});
function dir(){const path=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-local-execution-")));temporary.push(path);return path;}
const reply=text=>({text,toolUses:[],stop:"end",usage:{input:7,output:3}});
function fixture(turn,extraTools=[],modelHistory){
 const home=dir(),project=dir(),catalog=new LocalWorkspaceCatalog(home),row=catalog.create("Personal",1);
 const resources=new WorkspaceResources(home,row.scope);resources.initialize();const main=resources.agents.initializeMain();
 const storage=new WorkspaceResourceStorage(home,row.scope);storage.initialize();
 const connections=new WorkspaceConnectionStoreV2(storage);connections.add({label:"Fake",provider:"openai",baseURL:"http://127.0.0.1:1/v1",apiKey:"synthetic-not-a-real-key",defaultModel:"fixed-synthetic"},0);
 let task=resources.agents.bindTask(createTaskExecution("synthetic task","fixture-turn"),main.agentId,main.configRevision,main.agentEpoch);
 const sessionId=main.agentId.slice(3),binding=freezeWorkspaceRunBinding({schemaVersion:1,scope:row.scope,agent:task.workspaceAgentBinding,
  agentBindingHash:workspaceAgentBindingHash(task.workspaceAgentBinding),connection:connections.capture(),runtimeContract:"hara-governed-pi-v1",
  project:{root:project,dev:fs.statSync(project).dev,ino:fs.statSync(project).ino},sessionId,runId:randomUUID(),lineage:{rootRunId:null,parentRunId:null,depth:0},createdAt:new Date().toISOString(),
  host:{hostId:catalog.read().hostId,hostEpoch:1,grantId:row.grantId,grantRevision:1,actorId:row.actorId,policyRevision:1},
  budget:{maxRounds:12,maxToolCalls:32,maxTokens:32000,timeoutMs:60000}});
 task.workspaceRunBinding=binding;const lease=WorkspaceSessionLease.acquire(storage,sessionId),controller=new AbortController();
 let requests=0,usage={modelCalls:0,toolCalls:0,inputTokens:0,outputTokens:0};
 const permit=createWorkspaceRunPermit({binding,catalog,resources,storage,connections,lease,cwd:project,signal:controller.signal,
  provider:{id:"openai",model:binding.connection.model,async turn(args){requests++;return turn(args,requests);}},
  toolNames:["task_intake","task_checkpoint","todo_write",...extraTools.map(tool=>tool.name)],usage,modelHistory,
  updateUsage(value){usage={...value};}});
 const input={ctx:{cwd:project,sessionId,todoScope:`local-${sessionId}`,sandbox:"off"},signal:controller.signal,
  approval:"auto-edit",approvalChannel:true,confirm:async()=>false,hooks:false,quiet:true,extraTools,
  systemOverride:"You are the scoped Hara. Use only the supplied task and tools.",
  taskIntake:{task,current:()=>task,onUpdate(next){task=next;},onCheckpoint(next){task=next;},onRoundUsage(next){task=next;}}};
 const options=bindWorkspaceRunOptions(permit,input);
 return{home,project,catalog,row,resources,connections,storage,lease,controller,permit,options,input,binding,
  get task(){return task;},set task(next){task=next;},get requests(){return requests;},get usage(){return usage;},close:()=>closeWorkspaceRunPermit(permit)};
}
test("actual Pi execution reaches the frozen scoped provider once, without legacy keys or a second planner",async()=>{
 const a=fixture(async(args)=>{assert.equal(args.tools.some(t=>t.name==="bash"||t.name==="computer"||t.name==="skill"),false);return reply("Hello from scoped Pi");});
 const history=[{role:"user",content:"hello"}];try{
  assert.equal(bindNewAgentTask(a.options.taskIntake.task,"unused","unused",undefined,a.options),a.options.taskIntake.task);
  const result=await runConfiguredAgent(history,a.options);
  assert.equal(result.status,"completed",result.error);assert.equal(a.requests,1);assert.equal(history.at(-1).text,"Hello from scoped Pi");
  assert.equal(a.usage.modelCalls,1);assert.equal(a.usage.inputTokens,7);
  assert.equal(fs.existsSync(join(a.home,".hara","profiles.json")),false);
 }finally{await a.close();}
});
test("attempt context is pinned to the actual durable transcript and refuses a replaced or rewritten prefix",async()=>{
 const history=[{role:"user",content:"retained older task"},{role:"assistant",text:"old result",toolUses:[]},{role:"user",content:"current task"}];
 const a=fixture(async()=>reply("must not run"),[],{history,start:2});
 try{
  assert.throws(()=>prepareWorkspaceRunHistory(a.permit,history),/governed entry/);
  beginWorkspaceGovernedRun(a.permit,a.options,"pi");
  assert.deepEqual(prepareWorkspaceRunHistory(a.permit,history),history.slice(2));
  assert.throws(()=>prepareWorkspaceRunHistory(a.permit,structuredClone(history)),/prefix changed/);
  history[0].content="rewritten old task";
  assert.throws(()=>prepareWorkspaceRunHistory(a.permit,history),/prefix changed/);assert.equal(a.requests,0);
 }finally{await a.close();}
});
test("forged JSON handles, direct legacy kernel, changed provider and stripped provenance start zero models",async()=>{
 const a=fixture(async()=>reply("must not run"));try{
  for(const options of [{...a.options,workspaceRun:structuredClone(a.permit)},
   {...a.options,provider:{id:"openai",model:"fixed-synthetic",turn:async()=>{throw new Error("bad");}}},
   {...a.options,taskIntake:undefined},{...a.options,workspaceRun:{},taskIntake:undefined}]){
    assert.equal((await runConfiguredAgent([{role:"user",content:"hello"}],options)).status,"error");
  }
  assert.equal((await runAgent([{role:"user",content:"hello"}],a.options)).status,"error");
  assert.equal(a.requests,0);
 }finally{await a.close();}
});
test("connection rotation, grant revocation and Agent lifecycle epoch changes invalidate the original permit",async()=>{
 for(const revoke of [a=>a.connections.revoke(a.binding.connection.connectionId,1),a=>a.catalog.revoke(a.row.scope.workspaceId,a.catalog.read().revision)]){
  const a=fixture(async()=>reply("must not run"));try{revoke(a);assert.equal((await runConfiguredAgent([],a.options)).status,"error");assert.equal(a.requests,0);}finally{await a.close();}
 }
});
test("initial/current task provenance cannot be changed by steering an active scoped run",async()=>{
 const a=fixture(async()=>reply("no"));try{
  a.task={...a.task,turnId:"forged-turn"};assert.equal((await runConfiguredAgent([],a.options)).status,"error");assert.equal(a.requests,0);
 }finally{await a.close();}
});
test("shared governor still requires intake, observed work and final receipt for a scoped Pi edit",async()=>{
 let project,writes=0;
 const write={name:"fixture_write",kind:"edit",description:"Write the fixed authorized fixture",input_schema:{type:"object",properties:{}},
  async run(_input,ctx){writes++;fs.writeFileSync(join(project,"hello.md"),"hello workspace\n");ctx.verifiedChange?.(createHash("sha256").update("hello workspace\n").digest("hex"));return "wrote hello.md";}};
 const verify={name:"fixture_verify",kind:"read",description:"Verify exact fixture bytes",input_schema:{type:"object",properties:{}},
  async run(){assert.equal(fs.readFileSync(join(project,"hello.md"),"utf8"),"hello workspace\n");return "verified exact hello.md bytes";}};
 const steps=[
  {text:"",stop:"tool_use",toolUses:[{id:"brief",name:"task_intake",input:{intent:"change",goal:"write hello.md",constraints:["only the approved project"],acceptance:["hello.md exact bytes verified"],steps:["write","verify"]}}]},
  {text:"",stop:"tool_use",toolUses:[{id:"write",name:write.name,input:{}}]},
  {text:"",stop:"tool_use",toolUses:[{id:"verify",name:verify.name,input:{}}]},
  {text:"",stop:"tool_use",toolUses:[{id:"complete",name:"task_checkpoint",input:{completion:{state:"verified",checks:[{acceptance_index:0,evidence:"exact bytes were read",tool_call_ids:["verify"]}],final_answer:"hello.md is ready and verified."}}}]},
 ];
 const a=fixture(async(_args,n)=>{assert.ok(n<=4);return steps[n-1];},[write,verify]);project=a.project;
 try{const history=[{role:"user",content:"Create hello.md in the approved project and verify it."}],result=await runConfiguredAgent(history,a.options);
  assert.equal(result.status,"completed");assert.equal(writes,1);assert.equal(a.requests,4);
  assert.equal(finishTaskExecution(a.task,result).status,"completed");assert.equal(history.at(-1).text,"hello.md is ready and verified.");
 }finally{await a.close();}
});
test("cancellation cannot free a lease while a real pending model promise ignores AbortSignal",async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
 const a=fixture(async()=>{enter();await waiting;return reply("late");});
 const run=runConfiguredAgent([{role:"user",content:"hello"}],a.options);await entered;a.controller.abort();
 let closed=false;const close=a.close().then(()=>closed=true);
 const audit=new WorkspaceExecutionAudit(a.storage,a.binding.runId,a.binding.agent.agentId);
 await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);assert.equal(audit.read().operations[0].outcome,"running");
 assert.throws(()=>WorkspaceSessionLease.acquire(a.storage,a.binding.sessionId),/busy/);
 release();await run;await close;assert.equal(closed,true);assert.equal(audit.read().operations[0].outcome,"cancelled");
 const next=WorkspaceSessionLease.acquire(a.storage,a.binding.sessionId);next.release();
});
test("physical model timing includes retry metadata and provider errors, without retaining raw provider data",async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
 const marker="SYNTHETIC_PRIVATE_ERROR_MUST_NOT_BE_RETAINED";
 const a=fixture(async args=>{
  args.onRetry({provider:marker,model:marker,attempt:1,nextAttempt:2,kind:"overloaded",delayMs:7,elapsedMs:12,status:503});
  enter();await waiting;return{text:"",toolUses:[],stop:"error",errorMsg:marker,errorMetadata:{status:503},usage:{input:9,output:2}};
 });
 try{
  const audit=new WorkspaceExecutionAudit(a.storage,a.binding.runId,a.binding.agent.agentId);
  const run=runConfiguredAgent([{role:"user",content:"hello"}],a.options);await entered;
  const pending=audit.read().operations[0];assert.equal(pending.kind,"model");assert.equal(pending.outcome,"running");assert.equal(pending.endedAt,null);assert.equal(pending.retryCount,1);
  release();assert.equal((await run).status,"error");
  const row=audit.read().operations[0];assert.equal(row.outcome,"error");assert.equal(row.error,"provider_error");assert.equal(row.status,503);
  assert.ok(row.endedAt>=row.startedAt);assert.ok(row.durationMs>=0);assert.equal(row.retries[0].delayMs,7);
  assert.equal(JSON.stringify(audit.read()).includes(marker),false);assert.equal(a.usage.inputTokens,9);assert.equal(a.usage.outputTokens,2);
 }finally{release();await a.close();}
});
test("each physical tool has a start/end and its own attempt number, including returned and thrown errors",async()=>{
 const tool={name:"fixture_read",description:"Synthetic read",kind:"read",input_schema:{type:"object"},async run(){return"unused";}};
 const a=fixture(async()=>reply("unused"),[tool]),marker="SYNTHETIC_PRIVATE_TOOL_BODY";
 try{
  beginWorkspaceGovernedRun(a.permit,a.options,"pi");const audit=new WorkspaceExecutionAudit(a.storage,a.binding.runId,a.binding.agent.agentId);
  let release;const wait=new Promise(r=>release=r);
  const first=executeWorkspaceTool(a.permit,tool.name,async()=>{await wait;return marker;});
  assert.equal(audit.read().operations[0].outcome,"running");release();assert.equal(await first,marker);
  assert.equal(await executeWorkspaceTool(a.permit,tool.name,async()=>`Error: ${marker}`),`Error: ${marker}`);
  await assert.rejects(executeWorkspaceTool(a.permit,tool.name,async()=>{throw new Error(marker);}),new RegExp(marker));
  assert.equal(await executeWorkspaceTool(a.permit,tool.name,async()=>marker,()=>true),marker);
  const rows=audit.read().operations;
  assert.deepEqual(rows.map(row=>[row.kind,row.call,row.outcome,row.error,row.retryCount]),[["tool",1,"completed",null,0],["tool",2,"error","tool_error",0],["tool",3,"error","thrown",0],["tool",4,"error","tool_error",0]]);
  assert.ok(rows.every(row=>row.endedAt>=row.startedAt&&row.durationMs>=0));assert.equal(JSON.stringify(audit.read()).includes(marker),false);
 }finally{await a.close();}
});
test("an existing frozen 32k run still stops at its original ceiling and records the failed call",async()=>{
 const a=fixture(async()=>({...reply("over budget"),usage:{input:32000,output:1}}));
 try{
  assert.equal((await runConfiguredAgent([{role:"user",content:"hello"}],a.options)).status,"error");
  assert.equal(a.binding.budget.maxTokens,32000);assert.equal(a.requests,1);assert.equal(a.usage.inputTokens+a.usage.outputTokens,32001);
  const row=new WorkspaceExecutionAudit(a.storage,a.binding.runId,a.binding.agent.agentId).read().operations[0];
  assert.equal(row.outcome,"error");assert.equal(row.error,"budget_exhausted");
 }finally{await a.close();}
});
test("a syntactically valid permit cannot be attached to ambient hooks, fallback or plugin execution",async()=>{
 const a=fixture(async()=>reply("no"));try{
  assert.throws(()=>bindWorkspaceRunOptions(a.permit,{...a.input,hooks:true}),/already attached/);
  assert.equal((await runPiAgent([],{...a.options,hooks:true})).status,"error");
  assert.equal((await runPiAgent([],{...a.options,fallback:{provider:a.options.provider}})).status,"error");
  assert.equal(a.requests,0);
 }finally{await a.close();}
});
test("one private permit is consumed once, even when a second runner shares its live lease",async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);
 const a=fixture(async()=>{enter();await waiting;return reply("one run");});
 try{const first=runConfiguredAgent([{role:"user",content:"hello"}],a.options);await entered;
  const second=await runConfiguredAgent([{role:"user",content:"duplicate"}],a.options);
  assert.equal(second.status,"error");assert.match(second.error,/already consumed/);assert.equal(a.requests,1);
  release();assert.equal((await first).status,"completed");
 }finally{release();await a.close();}
});
test("credential revocation during a provider stream mutes late text and never releases a tool batch",async()=>{
 let a,signalAborted=false;
 a=fixture(async args=>{args.onText("before");a.connections.revoke(a.binding.connection.connectionId,1);args.onText("late secret sentinel");signalAborted=args.signal.aborted;return reply("late reply");});
 const history=[{role:"user",content:"hello"}];
 try{const result=await runConfiguredAgent(history,a.options);
  assert.equal(result.status,"error");assert.equal(a.requests,1);assert.equal(signalAborted,true);
  assert.equal(JSON.stringify(history).includes("late secret sentinel"),false);assert.equal(JSON.stringify(history).includes("late reply"),false);
 }finally{await a.close();}
});
