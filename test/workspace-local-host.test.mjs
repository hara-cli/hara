import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { WorkspaceTreeBudget } from "../dist/workspace/tree-budget.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";

const temporary=[];
after(()=>{for(const path of temporary)fs.rmSync(path,{recursive:true,force:true});});
function dir(){const path=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-local-host-")));temporary.push(path);return path;}
function setup(options){
 const root=dir(),host=new LocalWorkspaceHost(root,options),workspace=host.createWorkspace("Personal",host.list().revision),workspaceId=workspace.workspaceId;
 host.configureSynthetic(workspaceId,0);host.select("client",workspaceId,host.list().revision);
 return{root,host,workspaceId,main:workspace.selectedAgentId};
}
async function until(check){const deadline=Date.now()+10000;while(Date.now()<deadline){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw new Error("bounded Workspace fixture did not reach expected state");}
test("no-key boot, main chat, explicit creation card, colleague task and same-root restart are a real Host flow",async()=>{
 const a=setup();try{
  const hello=a.host.start("client",a.workspaceId,a.main,"hello",randomUUID());await a.host.wait(hello.runId);
  let snapshot=a.host.snapshot(a.workspaceId,a.main,"client");assert.equal(snapshot.conversation.state,"completed");
  assert.ok(snapshot.conversation.history.some(row=>row.role==="assistant"&&row.text.includes("Hara")));
  const create=a.host.start("client",a.workspaceId,a.main,"建立 Pi 同事 Coder",randomUUID());
  const card=await until(()=>a.host.snapshot(a.workspaceId,a.main,"client").approvals[0]);
  assert.equal(a.host.snapshot(a.workspaceId).agents.length,1,"proposal is not an Agent");
  assert.throws(()=>a.host.answerApproval("other-client",a.workspaceId,card.id,true),/approval/);
  a.host.answerApproval("client",a.workspaceId,card.id,true);await a.host.wait(create.runId);
  snapshot=a.host.snapshot(a.workspaceId,a.main,"client");assert.equal(snapshot.agents.length,2);assert.equal(snapshot.conversation.taskState,"completed");
  assert.throws(()=>a.host.answerApproval("client",a.workspaceId,card.id,true),/approval/);
  const colleague=snapshot.agents.find(agent=>agent.kind==="colleague");assert.equal(colleague.runtime.id,"pi");
  const delegated=a.host.start("client",a.workspaceId,a.main,"委派 Coder 生成 hello.md 並驗證",randomUUID());await a.host.wait(delegated.runId);
  snapshot=a.host.snapshot(a.workspaceId,a.main,"client");
  assert.equal(snapshot.conversation.taskState,"completed");assert.equal(snapshot.conversation.completion.state,"verified");
  assert.equal(fs.readFileSync(join(a.root,"project",a.workspaceId,"hello.md"),"utf8"),"hello workspace\n");
  const child=a.host.snapshot(a.workspaceId,colleague.agentId);assert.equal(child.conversation.taskState,"completed");
  assert.equal(child.conversation.completion.state,"verified");assert.ok(child.conversation.history.some(message=>message.role==="tool"));
  assert.equal(JSON.stringify(snapshot).includes(SYNTHETIC_CONNECTION.apiKey),false);assert.equal(JSON.stringify(snapshot).includes("configHash"),false);
  const before=JSON.stringify(snapshot.conversation);await a.host.close();
  let factories=0;const restored=new LocalWorkspaceHost(a.root,{providerFactory(){factories++;throw new Error("read must not create provider");}});
  try{assert.equal(JSON.stringify(restored.snapshot(a.workspaceId,a.main,"client").conversation),before);assert.equal(factories,0);assert.equal(restored.snapshot(a.workspaceId).agents.length,2);}finally{await restored.close();}
 }finally{await a.host.close();}
});
test("different Workspaces cannot share same-relative-path project artifacts or reuse each other's verification",async()=>{
 const a=setup();try{
  const b=a.host.createWorkspace("Other",a.host.list().revision);a.host.configureSynthetic(b.workspaceId,0);
  const first=a.host.start("client",a.workspaceId,a.main,"生成 hello.md 並驗證",randomUUID());await a.host.wait(first.runId);
  const fileA=join(a.root,"project",a.workspaceId,"hello.md"),fileB=join(a.root,"project",b.workspaceId,"hello.md");
  assert.equal(fs.existsSync(fileA),true,"A must write only its own project root");assert.equal(fs.existsSync(fileB),false);
  const before=a.host.snapshot(a.workspaceId).conversation,inode=fs.statSync(fileA).ino;
  const second=a.host.start("other",b.workspaceId,b.selectedAgentId,"生成 hello.md 並驗證",randomUUID());await a.host.wait(second.runId);
  assert.equal(fs.readFileSync(fileB,"utf8"),"hello workspace\n");assert.equal(fs.statSync(fileA).ino,inode);
  assert.notEqual(fs.statSync(fileB).ino,inode);assert.deepEqual(a.host.snapshot(a.workspaceId).conversation,before);
  const bRead=a.host.snapshot(b.workspaceId).conversation.history.flatMap(row=>row.role==="tool"?row.results:[]).find(row=>row.name==="workspace_read");
  assert.equal(JSON.parse(bRead.content).exists,false,"B must not observe A's file even with an identical connection value");
  assert.equal(fs.existsSync(join(a.root,"project","hello.md")),false,"the shared fixture container is not an executable project");
 }finally{await a.host.close();}
});
test("old shared-project run remains readable but cannot resume or construct a Provider",async()=>{
 let entered,release;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 const a=setup({providerFactory(_connection,binding){return{id:"openai",model:binding.model,async turn(){entered();await pending;return{text:"late",toolUses:[],stop:"end",usage:{input:1,output:1}};}};}});
 try{
  const run=a.host.start("client",a.workspaceId,a.main,"hello",randomUUID());await ready;a.host.cancel(a.workspaceId,a.main,run.runId);release();await a.host.wait(run.runId);
  const row=a.host.catalog.resolve(a.workspaceId),storage=new WorkspaceResourceStorage(a.host.home,row.scope);storage.initialize();
  const path=storage.run(()=>join(workspaceStateHome(),".hara",`conversation-${a.main.slice(3)}.json`));
  await a.host.close();const raw=JSON.parse(fs.readFileSync(path,"utf8")),base=fs.statSync(join(a.root,"project"));
  // Seed an earlier candidate's valid on-disk snapshot, not an authorized live mutation.
  raw.task.workspaceRunBinding.project={root:join(a.root,"project"),dev:base.dev,ino:base.ino};fs.writeFileSync(path,JSON.stringify(raw)+"\n",{mode:0o600});
  let constructed=0;const restored=new LocalWorkspaceHost(a.root,{providerFactory(){constructed++;throw new Error("must not construct");}});
  try{const history=restored.snapshot(a.workspaceId).conversation.history;
   assert.throws(()=>restored.start("client",a.workspaceId,a.main,"/continue",randomUUID(),true),/project root changed/);
   assert.equal(constructed,0);assert.deepEqual(restored.snapshot(a.workspaceId).conversation.history,history);
  }finally{await restored.close();}
 }finally{release();await a.host.close();}
});
test("a replaced project container cannot redirect a newly opened Workspace through an alias",async()=>{
 const a=setup(),outside=dir(),container=join(a.root,"project"),original=join(a.root,"project-retained");
 try{
  const before=a.host.snapshot(a.workspaceId).conversation;fs.renameSync(container,original);fs.symlinkSync(outside,container,"dir");
  assert.throws(()=>a.host.createWorkspace("Aliased",a.host.list().revision),/not a real directory|symlink|directory changed/);
  assert.deepEqual(fs.readdirSync(outside),[],"no workspace/tool state may be written through a project-container alias");
  assert.deepEqual(a.host.snapshot(a.workspaceId).conversation,before);
 }finally{if(fs.lstatSync(container).isSymbolicLink()){fs.unlinkSync(container);fs.renameSync(original,container);}await a.host.close();}
});
test("durable request IDs deduplicate messages after completion and restart, without another model call",async()=>{
 const a=setup(),id=randomUUID();try{
  const first=a.host.start("client",a.workspaceId,a.main,"hello",id);await a.host.wait(first.runId);
  const before=a.host.snapshot(a.workspaceId).conversation;
  assert.equal(a.host.start("client",a.workspaceId,a.main,"hello",id).duplicate,true);
  assert.throws(()=>a.host.start("client",a.workspaceId,a.main,"different",id),/another request/);
  assert.deepEqual(a.host.snapshot(a.workspaceId).conversation,before);await a.host.close();
  const restored=new LocalWorkspaceHost(a.root);try{assert.equal(restored.start("client",a.workspaceId,a.main,"hello",id).duplicate,true);assert.deepEqual(restored.snapshot(a.workspaceId).conversation,before);}finally{await restored.close();}
 }finally{await a.host.close();}
});
test("switching Workspace invalidates the old approval, never creates a colleague in either new view",async()=>{
 const a=setup();try{
  const create=a.host.start("client",a.workspaceId,a.main,"建立 Pi 同事 Coder",randomUUID());
  const card=await until(()=>a.host.snapshot(a.workspaceId,a.main,"client").approvals[0]);
  const b=a.host.createWorkspace("Other",a.host.list().revision);a.host.select("client",b.workspaceId,a.host.list().revision);
  assert.throws(()=>a.host.answerApproval("client",a.workspaceId,card.id,true),/approval/);await a.host.wait(create.runId);
  assert.equal(a.host.snapshot(a.workspaceId).agents.length,1);assert.equal(a.host.snapshot(b.workspaceId).agents.length,1);
  assert.equal(a.host.snapshot(b.workspaceId).connections.connections.length,0);
  assert.equal(a.host.snapshot(a.workspaceId).conversation.state,"cancelled");
 }finally{await a.host.close();}
});
test("only the declared synthetic connection executes; an unapproved model/Key produces zero requests",async()=>{
 const root=dir(),host=new LocalWorkspaceHost(root);try{
  const workspace=host.createWorkspace("Private",host.list().revision);
  host.configureConnection(workspace.workspaceId,{label:"Unapproved",provider:"openai",baseURL:"https://no-network.example.invalid/v1",apiKey:"synthetic-unapproved-key",defaultModel:"unapproved-model"},0);
  assert.throws(()=>host.start("client",workspace.workspaceId,workspace.selectedAgentId,"hello",randomUUID()),/真實模型/);
  assert.equal(host.snapshot(workspace.workspaceId).conversation.usage.modelCalls,0);assert.equal(host.snapshot(workspace.workspaceId).conversation.history.length,0);
 }finally{await host.close();}
});
test("cancellation reports draining and retains the active lease until a non-cooperative physical provider settles",async()=>{
 let entered,release;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 const a=setup({providerFactory(_connection,binding){return{id:"openai",model:binding.model,async turn(){entered();await pending;return{text:"late",toolUses:[],stop:"end",usage:{input:1,output:1}};}};}});
 try{const started=a.host.start("client",a.workspaceId,a.main,"hello",randomUUID());await ready;
  a.host.cancel(a.workspaceId,a.main,started.runId);assert.equal(a.host.snapshot(a.workspaceId).conversation.state,"draining");
  assert.throws(()=>a.host.start("client",a.workspaceId,a.main,"second",randomUUID()),/draining/);
  release();await a.host.wait(started.runId);assert.equal(a.host.snapshot(a.workspaceId).conversation.state,"cancelled");
  assert.equal(a.host.snapshot(a.workspaceId).conversation.history.some(message=>message.role==="assistant"&&message.text==="late"),false);
 }finally{release();await a.host.close();}
});
test("shared tree reservations persist across reopen and refuse excess work before it starts",()=>{
 const a=setup();const row=a.host.catalog.resolve(a.workspaceId),storage=new WorkspaceResourceStorage(a.host.home,row.scope);storage.initialize();
 const id=randomUUID(),limits={maxRounds:2,maxToolCalls:3,maxTokens:100,timeoutMs:1000},budget=new WorkspaceTreeBudget(storage,id,limits);
 budget.consume({modelCalls:1,toolCalls:0,inputTokens:0,outputTokens:0});budget.consume({modelCalls:1,toolCalls:1,inputTokens:10,outputTokens:2});
 const restored=new WorkspaceTreeBudget(storage,id,limits);assert.equal(restored.read().usage.modelCalls,2);
 assert.throws(()=>restored.consume({modelCalls:1,toolCalls:0,inputTokens:0,outputTokens:0}),/budget exhausted/);
 assert.equal(restored.read().usage.modelCalls,2);return a.host.close();
});
test("actual CLI routes before legacy startup and does not create caller Home state",async()=>{
 const root=dir(),callerHome=dir(),execute=promisify(execFile),cli=resolve("dist/cli.js");
 const {stdout}=await execute(process.execPath,[cli,"workspace-dev","init","--root",root],{cwd:dir(),env:{PATH:process.env.PATH,HOME:callerHome,USERPROFILE:callerHome}});
 const result=JSON.parse(stdout);assert.equal(result.syntheticOnly,true);assert.equal(result.workspaces.length,0);assert.deepEqual(fs.readdirSync(callerHome),[]);
});
test("actual CLI sends multiline bodies unchanged through its isolated governed entry",async()=>{
 const a=setup(),callerHome=dir(),execute=promisify(execFile),cli=resolve("dist/cli.js");await a.host.close();
 const message="hello\n你好\r\n第二行\t內容";
 const {stdout}=await execute(process.execPath,[cli,"workspace-dev","run","--root",a.root,"--workspace",a.workspaceId,"--agent",a.main,"--message",message],
  {cwd:dir(),env:{PATH:process.env.PATH,HOME:callerHome,USERPROFILE:callerHome}});
 const result=JSON.parse(stdout);assert.equal(result.conversation.state,"completed");assert.equal(result.conversation.history[0].content,message);
 assert.deepEqual(fs.readdirSync(callerHome),[]);
});
