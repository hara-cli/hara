import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { startServe } from "../dist/serve/server.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";

const temporary=[];
after(()=>{for(const path of temporary)fs.rmSync(path,{recursive:true,force:true});});
function dir(){const path=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-local-server-")));temporary.push(path);return path;}
async function connect(handle,origin){
 const socket=new WebSocket(`ws://127.0.0.1:${handle.port}`,origin?{origin}:{}),pending=new Map();let counter=0;
 socket.on("error",()=>{});socket.on("message",raw=>{const value=JSON.parse(raw.toString()),wait=pending.get(value.id);if(wait){pending.delete(value.id);clearTimeout(wait.timer);value.error?wait.reject(Object.assign(new Error(value.error.message),{code:value.error.code})):wait.resolve(value.result);}});
 await once(socket,"open");
 return{socket,request(method,params={}){return new Promise((resolve,reject)=>{const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(new Error("bounded RPC timeout"));},30_000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:"2.0",id,method,params}));});},
  async close(){if(socket.readyState===WebSocket.CLOSED)return;const closed=once(socket,"close");socket.close();await closed;}};
}
async function until(check){for(let attempt=0;attempt<150;attempt++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw new Error("bounded RPC state wait expired");}
test("formal startServe local branch boots without provider/global config and enforces token/origin/protocol scope",async()=>{
 const root=dir(),handle=await startServe({host:"127.0.0.1",port:0,cwd:root},{version:"synthetic-dev",localWorkspace:{root}});
 const client=await connect(handle);try{
  await assert.rejects(client.request("workspace.list"),/unauthorized/);
  await assert.rejects(client.request("initialize",{token:"x".repeat(64)}),/unauthorized/);
  await assert.rejects(client.request("initialize",{token:"中".repeat(64)}),/unauthorized/);
  const init=await client.request("initialize",{token:handle.token});assert.deepEqual(init.capabilities,["workspace.local-dev.v2","workspace.user-interaction.v1","workspace.interaction.v2","workspace.local-channels.v1"]);assert.equal(init.workspace.workspaces.length,0);
  await assert.rejects(client.request("session.create",{}),/Workspace must be explicit|legacy/);
  const created=await client.request("workspace.create",{label:"Personal",expectedRevision:init.workspace.revision});
  await client.request("workspace.connection.synthetic",{workspaceId:created.workspaceId,expectedGeneration:created.resourceGeneration,expectedRevision:0});
  const listed=await client.request("workspace.list");await client.request("workspace.select",{workspaceId:created.workspaceId,expectedRevision:listed.revision});
  await assert.rejects(client.request("workspace.session.send",{workspaceId:created.workspaceId,expectedGeneration:randomUUID(),agentId:created.selectedAgentId,message:"hello",requestId:randomUUID()}),/generation/);
  await assert.rejects(client.request("workspace.session.send",{workspaceId:created.workspaceId,expectedGeneration:created.resourceGeneration,agentId:created.selectedAgentId,message:"hello",requestId:randomUUID(),workspaceRunBinding:{authorized:true}}),/unsupported/);
  await assert.rejects(client.request("workspace.session.send",{workspaceId:created.workspaceId,expectedGeneration:created.resourceGeneration,agentId:created.selectedAgentId+"\n",message:"hello",requestId:randomUUID()}),/invalid/);
  await assert.rejects(client.request("workspace.session.send",{workspaceId:created.workspaceId,expectedGeneration:created.resourceGeneration,agentId:created.selectedAgentId,message:"hello\x1bworld",requestId:randomUUID()}),/invalid/);
  const run=await client.request("workspace.session.send",{workspaceId:created.workspaceId,expectedGeneration:created.resourceGeneration,agentId:created.selectedAgentId,message:"hello\n你好\r\n第二行\t內容",requestId:randomUUID()});assert.equal(typeof run.runId,"string");
  const snapshot=await until(async()=>{const view=await client.request("workspace.snapshot",{workspaceId:created.workspaceId,agentId:null});return view.conversation.state==="completed"?view:null;});
  assert.equal(snapshot.conversation.usage.modelCalls,1);assert.equal(snapshot.syntheticOnly,true);
  assert.equal(snapshot.conversation.history[0].content,"hello\n你好\r\n第二行\t內容");
  const blocked=new WebSocket(`ws://127.0.0.1:${handle.port}`,{origin:"https://evil.example.invalid"});blocked.on("error",()=>{});
  const [error]=await once(blocked,"error");assert.match(error.message,/403/);blocked.terminate();
 }finally{await client.close();await handle.close();}
});
test("RPC creation approval is tied to original controller and Workspace, not a bare approval id",async()=>{
 const root=dir(),handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},{root,version:"synthetic"});
 const a=await connect(handle),b=await connect(handle);try{
  const init=await a.request("initialize",{token:handle.token});await b.request("initialize",{token:handle.token});
  const workspace=await a.request("workspace.create",{label:"A",expectedRevision:init.workspace.revision});
  await a.request("workspace.connection.synthetic",{workspaceId:workspace.workspaceId,expectedGeneration:workspace.resourceGeneration,expectedRevision:0});
  const list=await a.request("workspace.list");await a.request("workspace.select",{workspaceId:workspace.workspaceId,expectedRevision:list.revision});
  await a.request("workspace.session.send",{workspaceId:workspace.workspaceId,expectedGeneration:workspace.resourceGeneration,agentId:workspace.selectedAgentId,message:"建立 Pi 同事 Coder",requestId:randomUUID()});
  const card=await until(async()=>(await a.request("workspace.snapshot",{workspaceId:workspace.workspaceId,agentId:null})).approvals[0]);
  const other=await a.request("workspace.create",{label:"B",expectedRevision:(await a.request("workspace.list")).revision});
  await assert.rejects(b.request("workspace.approval.respond",{workspaceId:workspace.workspaceId,expectedGeneration:workspace.resourceGeneration,approvalId:card.id,approved:true}),/approval/);
  await assert.rejects(a.request("workspace.approval.respond",{workspaceId:other.workspaceId,expectedGeneration:other.resourceGeneration,approvalId:card.id,approved:true}),/approval/);
  await a.request("workspace.approval.respond",{workspaceId:workspace.workspaceId,expectedGeneration:workspace.resourceGeneration,approvalId:card.id,approved:true});
  const done=await until(async()=>{const view=await a.request("workspace.snapshot",{workspaceId:workspace.workspaceId,agentId:null});return view.conversation.state==="completed"?view:null;});
  assert.equal(done.agents.length,2);assert.equal((await a.request("workspace.snapshot",{workspaceId:other.workspaceId,agentId:null})).agents.length,1);
 }finally{await a.close();await b.close();await handle.close();}
});
test("RPC acknowledges a slow mock task, records its source, and receipt lookup never resends or calls a Provider",async()=>{
 const root=dir();let release,entered,calls=0;const ready=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 const handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},{root,version:"synthetic",providerFactory(_connection,binding){return{id:"openai",model:binding.model,async turn(){calls++;entered();await pending;return{text:"mock",toolUses:[],stop:"end",usage:{input:1,output:1}};}};}});
 const c=await connect(handle);try{
  const init=await c.request("initialize",{token:handle.token}),w=await c.request("workspace.create",{label:"Slow mock",expectedRevision:init.workspace.revision});
  await c.request("workspace.connection.synthetic",{workspaceId:w.workspaceId,expectedGeneration:w.resourceGeneration,expectedRevision:0});
  const requestId=randomUUID(),params={workspaceId:w.workspaceId,expectedGeneration:w.resourceGeneration,agentId:w.selectedAgentId,message:"hello",requestId,source:"ui"};
  const ack=await c.request("workspace.session.send",params);assert.equal(typeof ack.runId,"string");await ready;
  const receiptParams={workspaceId:w.workspaceId,expectedGeneration:w.resourceGeneration,agentId:w.selectedAgentId,requestId};
  const receipt=await c.request("workspace.session.receipt",receiptParams);assert.equal(receipt.state,"accepted");assert.equal(receipt.runId,ack.runId);assert.equal(receipt.source,"ui");assert.equal(receipt.sourceAssurance,"client_declared");
  assert.equal((await c.request("workspace.snapshot",{workspaceId:w.workspaceId,agentId:w.selectedAgentId})).conversation.state,"running");
  for(let i=0;i<3;i++)await c.request("workspace.session.receipt",receiptParams);assert.equal(calls,1);
  await assert.rejects(c.request("workspace.session.send",{...params,requestId:randomUUID(),source:"delegation"}),/source/);
  await assert.rejects(c.request("workspace.session.receipt",{...receiptParams,expectedGeneration:randomUUID()}),/generation/);
  release();await until(async()=>{const view=await c.request("workspace.snapshot",{workspaceId:w.workspaceId,agentId:w.selectedAgentId});return view.conversation.state==="completed";});assert.equal(calls,1);
 }finally{release();await c.close();await handle.close();}
});


test("two answer connections compete for one durable question; stale/cross-scope answers never restart work", async () => {
 const root=dir();let calls=0;
 const handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},{root,version:"synthetic",providerFactory(_connection,binding){return{id:"openai",model:binding.model,async turn(){
  calls++;return calls===1?{text:"",toolUses:[{id:randomUUID(),name:"ask_user",input:{question:"Which synthetic target?",options:["Alpha","Beta"]}}],stop:"tool_use",usage:{input:1,output:1}}:{text:"Answer retained",toolUses:[],stop:"end",usage:{input:1,output:1}};
 }};}});
 const a=await connect(handle),b=await connect(handle);
 try {
  const init=await a.request("initialize",{token:handle.token});await b.request("initialize",{token:handle.token});
  assert(init.capabilities.includes("workspace.user-interaction.v1"));
  const w=await a.request("workspace.create",{label:"Question",expectedRevision:init.workspace.revision});
  await a.request("workspace.connection.synthetic",{workspaceId:w.workspaceId,expectedGeneration:w.resourceGeneration,expectedRevision:0});
  const base={workspaceId:w.workspaceId,expectedGeneration:w.resourceGeneration,agentId:w.selectedAgentId};
  const first=await a.request("workspace.session.send",{...base,message:"Clarify this target",requestId:randomUUID()});
  const pending=await until(async()=>{const view=await a.request("workspace.snapshot",{workspaceId:w.workspaceId,agentId:w.selectedAgentId});return view.conversation.state==="awaiting_user"?view.conversation.pendingQuestion:null;});
  await assert.rejects(a.request("workspace.session.send",{...base,message:"Guess instead",requestId:randomUUID()}),/specific answer/);
  await assert.rejects(a.request("workspace.session.answer",{...base,questionId:randomUUID(),message:"Alpha",requestId:randomUUID()}),/specific answer|changed/);
  await assert.rejects(a.request("workspace.session.answer",{...base,expectedGeneration:randomUUID(),questionId:pending.id,message:"Alpha",requestId:randomUUID()}),/generation/);
  const requests=[{...base,questionId:pending.id,message:"Alpha",requestId:randomUUID()},{...base,questionId:pending.id,message:"Beta",requestId:randomUUID()}];
  const results=await Promise.allSettled([a.request("workspace.session.answer",requests[0]),b.request("workspace.session.answer",requests[1])]);
  assert.equal(results.filter(row=>row.status==="fulfilled").length,1);assert.equal(results.filter(row=>row.status==="rejected").length,1);
  const index=results.findIndex(row=>row.status==="fulfilled"),accepted=results[index].value;
  assert.equal(accepted.runId,first.runId);
  await until(async()=>{const view=await a.request("workspace.snapshot",{workspaceId:w.workspaceId,agentId:w.selectedAgentId});return view.conversation.state==="completed";});
  assert.equal(calls,2);
  const replay=await a.request("workspace.session.answer",requests[index]);assert.equal(replay.duplicate,true);assert.equal(calls,2);
  await assert.rejects(a.request("workspace.session.answer",{...requests[index],message:"Other answer"}),/another request/);
  const receipt=await a.request("workspace.session.receipt",{...base,requestId:requests[index].requestId});assert.equal(receipt.state,"accepted");assert.equal(receipt.runId,first.runId);
  const other=await a.request("workspace.create",{label:"Other",expectedRevision:(await a.request("workspace.list")).revision});
  await assert.rejects(a.request("workspace.session.answer",{workspaceId:other.workspaceId,expectedGeneration:other.resourceGeneration,agentId:other.selectedAgentId,questionId:pending.id,message:"Alpha",requestId:randomUUID()}),/changed|no answer/);
  assert.equal(calls,2);
 } finally {await a.close();await b.close();await handle.close();}
});
