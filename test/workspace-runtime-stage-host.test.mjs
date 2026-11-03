import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID,createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { scriptedWorkspaceProvider } from "./fixtures/scripted-workspace-provider.mjs";
function dir(){return fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-stage-host-")));}
function setup(options){const root=dir(),host=new LocalWorkspaceHost(root,options),w=host.createWorkspace("Fixture",host.list().revision);host.configureSynthetic(w.workspaceId,0);return{root,host,w};}
test("real governed Host persists stage identity and exports only metadata without rerunning a model",async()=>{
 const f=setup({providerFactory(_connection,binding){let called=false;return scriptedWorkspaceProvider({id:"openai",model:binding.model,async turn(){
  if(!called){called=true;return{text:"",toolUses:[{id:randomUUID(),name:"agent_list",input:{}}],stop:"tool_use"};}
  return{text:"Listed the current colleagues.",toolUses:[],stop:"end"};
 }});}});try{
  const run=f.host.start("client",f.w.workspaceId,f.w.selectedAgentId,"List colleagues PRIVATE_USER_PROMPT",randomUUID());await f.host.wait(run.runId);
  const c=f.host.snapshot(f.w.workspaceId).conversation,r=c.runtimeStages.at(-1);assert.ok(r);assert.equal(r.runId,run.runId);assert.equal(r.sessionId,c.sessionId);
  assert.equal(r.state,"completed");assert.equal(r.events.at(-1).kind,"complete");assert.ok(r.events.some(e=>e.kind==="model_roundtrip"&&e.phase==="end"));
  assert.ok(r.events.some(e=>e.kind==="tool_call"&&e.phase==="end"));
  const receipt=f.host.exportRuntimeDiagnostic(f.w.workspaceId,f.w.selectedAgentId,r.sessionId,r.runId,r.attemptId),content=fs.readFileSync(receipt.path,"utf8");
  assert.equal(receipt.sha256,createHash("sha256").update(content).digest("hex"));assert.equal(receipt.bytes,Buffer.byteLength(content));
  assert.equal(content.includes("PRIVATE_USER_PROMPT"),false);assert.equal(content.includes("hello workspace"),false);assert.equal(content.includes(f.root),false);
  if(process.platform!=="win32")assert.equal(fs.statSync(receipt.path).mode&0o777,0o600);
  assert.throws(()=>f.host.exportRuntimeDiagnostic(f.w.workspaceId,f.w.selectedAgentId,randomUUID(),r.runId,r.attemptId),/another conversation/);
  assert.throws(()=>f.host.exportRuntimeDiagnostic(f.w.workspaceId,f.w.selectedAgentId,r.sessionId,randomUUID(),r.attemptId),/unavailable/);
  assert.deepEqual(f.host.snapshot(f.w.workspaceId).conversation.usage,c.usage);
  await f.host.close();const restored=new LocalWorkspaceHost(f.root);try{assert.deepEqual(restored.snapshot(f.w.workspaceId).conversation.runtimeStages,c.runtimeStages);}finally{await restored.close();}
 }finally{await f.host.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test("cancelling an actual pending model wait records cancellation and no late successful boundary",async()=>{
 let entered;const ready=new Promise(r=>entered=r);const f=setup({providerFactory(_connection,binding){return{id:"openai",model:binding.model,async turn(args){
  args.onText?.("PRIVATE_STREAM");entered();await new Promise((resolve,reject)=>{if(args.signal?.aborted)reject(new Error("aborted"));else args.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});});
  return{text:"late",toolUses:[],stop:"end"};}};}});
 try{const run=f.host.start("client",f.w.workspaceId,f.w.selectedAgentId,"hello",randomUUID());await ready;f.host.cancel(f.w.workspaceId,f.w.selectedAgentId,run.runId);await f.host.wait(run.runId);
  const r=f.host.snapshot(f.w.workspaceId).conversation.runtimeStages.at(-1);assert.equal(r.state,"cancelled");assert.equal(r.events.at(-1).outcome,"cancelled");
  assert.ok(r.events.some(e=>e.kind==="first_token"));assert.ok(r.events.some(e=>e.kind==="model_roundtrip"&&e.outcome==="cancelled"));assert.equal(JSON.stringify(r).includes("PRIVATE_STREAM"),false);
 }finally{await f.host.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
async function connect(handle){const socket=new WebSocket(`ws://127.0.0.1:${handle.port}`),pending=new Map();let id=0;
 socket.on("message",raw=>{const data=JSON.parse(raw),wait=pending.get(data.id);if(wait){pending.delete(data.id);clearTimeout(wait.timer);data.error?wait.reject(new Error(data.error.message)):wait.resolve(data.result);}});await once(socket,"open");
 return{request(method,params={}){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(new Error("RPC deadline")),10000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:"2.0",id:n,method,params}));});},async close(){socket.close();await once(socket,"close");}};}
test("diagnostic export RPC requires authentication, current generation and exact stored attempt; accepts no body/path",async()=>{
 const root=dir(),handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},{root,version:"fixture"}),client=await connect(handle);
 try{await assert.rejects(client.request("workspace.runtime.diagnostics.export",{}),/unauthorized/);
  const init=await client.request("initialize",{token:handle.token});assert.ok(init.capabilities.includes("workspace.runtime-stage-events.v1"));
  const w=await client.request("workspace.create",{label:"Fixture",expectedRevision:init.workspace.revision}),scope={workspaceId:w.workspaceId,expectedGeneration:w.resourceGeneration};
  await client.request("workspace.connection.synthetic",{...scope,expectedRevision:0});await client.request("workspace.session.send",{...scope,agentId:w.selectedAgentId,message:"hello",requestId:randomUUID(),source:"ui"});
  let c;for(let i=0;i<300;i++){c=(await client.request("workspace.snapshot",{workspaceId:w.workspaceId,agentId:w.selectedAgentId})).conversation;if(c.runtimeStages?.at(-1)?.state!=="running"&&c.runtimeStages?.length)break;await new Promise(r=>setTimeout(r,20));}
  const r=c.runtimeStages.at(-1);assert.notEqual(r.state,"running");const params={...scope,agentId:w.selectedAgentId,sessionId:r.sessionId,runId:r.runId,attemptId:r.attemptId};
  await assert.rejects(client.request("workspace.runtime.diagnostics.export",{...params,expectedGeneration:randomUUID()}),/generation/);
  await assert.rejects(client.request("workspace.runtime.diagnostics.export",{...params,destinationPath:"/tmp/forged",content:"PRIVATE"}),/unsupported/);
  await assert.rejects(client.request("workspace.runtime.diagnostics.export",{...params,attemptId:randomUUID()}),/unavailable/);
  const receipt=await client.request("workspace.runtime.diagnostics.export",params);assert.ok(fs.existsSync(receipt.path));assert.equal(fs.readFileSync(receipt.path,"utf8").includes("PRIVATE"),false);
 }finally{await client.close();await handle.close();fs.rmSync(root,{recursive:true,force:true});}
});
