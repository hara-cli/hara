import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { MessageTimingRecorder, parseMessageTimingReport, parseMessageTimingInput } from "../dist/workspace/message-timing.js";
import { WorkspaceMessageTimingStore } from "../dist/workspace/message-timing-store.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { WorkspaceResourceStorage, currentWorkspaceResourceBinding } from "../dist/workspace/resource-context.js";
const identity = () => ({workspaceId:"ws_"+randomUUID(),resourceGeneration:randomUUID(),agentId:"ag_"+randomUUID(),sessionId:randomUUID(),runId:randomUUID(),attemptId:randomUUID(),historyStart:0});
const dir = () => fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-message-timing-")));
test("monotonic observations stay first-only; unknown native and paint points stay null",()=>{
 let now=1000;const r=new MessageTimingRecorder({receivedAt:1000,client:{hostAtMs:995,errorMs:2},now:()=>now}),id=identity();
 now=1010;r.mark("T2");now=1015;r.mark("T2");r.mark("T3",900);now=1020;r.finish();r.mark("T4");
 assert.deepEqual(r.snapshot(id).points,{T0:-5,T1:0,T2:10,T3:null,T4:null,T5:null,T6:null,T7:null,T8:null,T9:20});
 now=1025;assert.equal(r.paint({hostAtMs:1017,errorMs:2}),true);assert.equal(r.paint({hostAtMs:1018,errorMs:2}),false);assert.equal(r.snapshot(id).points.T7,17);
});
test("closed metadata rejects raw content, foreign identity and malformed timing without coercion",()=>{
 const r=new MessageTimingRecorder({receivedAt:1000,now:()=>1000}),report=r.snapshot(identity());
 for(const value of [{...report,prompt:"private"},{...report,workspaceId:"wrong"},{...report,points:{...report.points,T4:-1}},{...report,points:{...report.points,T7:1}},{...report,historyStart:4001}])assert.equal(parseMessageTimingReport(value),null);
 for(const input of [{hostAtMs:1,errorMs:1001},{hostAtMs:"1",errorMs:0},{hostAtMs:1,errorMs:0,token:"x"}])assert.equal(parseMessageTimingInput(input),null);
 assert.equal(new MessageTimingRecorder({receivedAt:1000,client:{hostAtMs:1001,errorMs:0},now:()=>1000}).snapshot(identity()).points.T0,null);
 assert.equal(new MessageTimingRecorder({receivedAt:1000,client:{hostAtMs:1001,errorMs:2},now:()=>1000}).snapshot(identity()).points.T0,1);
 assert.equal(r.paint({hostAtMs:1000,errorMs:0}),false);
});
test("late paint must match clock error and a bounded real-time window",()=>{
 let now=1010;const r=new MessageTimingRecorder({receivedAt:1000,client:{hostAtMs:998,errorMs:1},now:()=>now});
 assert.equal(r.paint({hostAtMs:1010,errorMs:2}),false);assert.equal(r.paint({hostAtMs:1012,errorMs:1}),false);
 now=40020;assert.equal(r.paint({hostAtMs:1010,errorMs:1}),false);
});
test("separate timing store keeps terminal points immutable, accepts one late paint, and fails on revocation",()=>{
 const root=dir();let revoked=false;
 const scope={schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}};
 const storage=new WorkspaceResourceStorage(root,scope,()=>{if(revoked)throw new Error("revoked");});storage.initialize();
 const id={...identity(),workspaceId:scope.workspaceId,resourceGeneration:storage.run(()=>currentWorkspaceResourceBinding().generation)};
 const store=new WorkspaceMessageTimingStore(storage,id.sessionId,id.agentId);let now=1000;const r=new MessageTimingRecorder({receivedAt:1000,client:{hostAtMs:998,errorMs:1},now:()=>now});
 try{now=1010;r.mark("T2");r.finish();store.save(r.snapshot(id));now=1012;assert.ok(r.paint({hostAtMs:1008,errorMs:1}));store.save(r.snapshot(id));
  assert.equal(store.list()[0].points.T7,8);assert.throws(()=>store.save({...r.snapshot(id),points:{...r.snapshot(id).points,T4:5}}),/rewritten/);
  assert.throws(()=>store.save({...r.snapshot(id),runId:randomUUID()}),/rewritten/);revoked=true;assert.throws(()=>store.list(),/revoked/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test("Host timing correlates only the original selected client; diagnostics persist without a native turn",async()=>{
 const root=dir(),host=new LocalWorkspaceHost(root),w=host.createWorkspace("Fixture",host.list().revision);host.configureSynthetic(w.workspaceId,0);
 host.select("owner",w.workspaceId,host.list().revision);host.selectAgent("owner",w.workspaceId,w.selectedAgentId);
 const receivedAt=performance.now(),client={hostAtMs:receivedAt-1,errorMs:0};
 try{const run=host.start("owner",w.workspaceId,w.selectedAgentId,"hello",randomUUID(),false,undefined,undefined,undefined,undefined,undefined,undefined,{receivedAt,client});await host.wait(run.runId);
  const r=host.snapshot(w.workspaceId).conversation.messageTimings.at(-1);assert.equal(r.runId,run.runId);assert.ok(r.points.T2>=0);assert.ok(r.points.T9>=r.points.T2);assert.equal(r.points.T4,null);
  const args=[w.workspaceId,w.selectedAgentId,r.sessionId,r.runId,r.attemptId,{hostAtMs:performance.now(),errorMs:0}];
  assert.equal(host.recordMessagePaint("foreign",...args).recorded,false);assert.equal(host.recordMessagePaint("owner",...args).recorded,true);
  assert.equal(host.recordMessagePaint("owner",...args).recorded,false);await host.close();
  const restored=new LocalWorkspaceHost(root);try{assert.notEqual(restored.snapshot(w.workspaceId).conversation.messageTimings.at(-1).points.T7,null);}finally{await restored.close();}
 }finally{await host.close();fs.rmSync(root,{recursive:true,force:true});}
});
async function connect(handle){const socket=new WebSocket(`ws://127.0.0.1:${handle.port}`),pending=new Map();let id=0;
 socket.on("message",raw=>{const data=JSON.parse(raw),wait=pending.get(data.id);if(wait){pending.delete(data.id);clearTimeout(wait.timer);data.error?wait.reject(new Error(data.error.message)):wait.resolve(data.result);}});await once(socket,"open");
 return{request(method,params={}){return new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(new Error("RPC deadline")),10000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:"2.0",id:n,method,params}));});},async close(){socket.close();await once(socket,"close");}};}
test("clock and paint RPC require authentication, closed fields and the current generation",async()=>{
 const root=dir(),handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},{root,version:"fixture"}),client=await connect(handle);
 try{await assert.rejects(client.request("workspace.message-timing.clock"),/unauthorized/);const init=await client.request("initialize",{token:handle.token});assert.ok(init.capabilities.includes("workspace.message-timing.v1"));
  const clock=await client.request("workspace.message-timing.clock");assert.ok(clock.hostAtMs>=0);await assert.rejects(client.request("workspace.message-timing.clock",{raw:"x"}),/unsupported/);
  const w=await client.request("workspace.create",{label:"Fixture",expectedRevision:init.workspace.revision}),params={workspaceId:w.workspaceId,expectedGeneration:randomUUID(),agentId:w.selectedAgentId,sessionId:randomUUID(),runId:randomUUID(),attemptId:randomUUID(),timing:{hostAtMs:clock.hostAtMs,errorMs:0}};
  await assert.rejects(client.request("workspace.session.paint",params),/generation/);params.expectedGeneration=w.resourceGeneration;
  await assert.rejects(client.request("workspace.session.paint",{...params,timing:{...params.timing,content:"private"}}),/Invalid/);
  assert.deepEqual(await client.request("workspace.session.paint",params),{recorded:false});
 }finally{await client.close();await handle.close();fs.rmSync(root,{recursive:true,force:true});}
});
