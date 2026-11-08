import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {randomUUID} from "node:crypto";
import {WebSocket} from "ws";
import {LocalWorkspaceHost} from "../dist/workspace/local-host.js";
import {startLocalWorkspaceServe} from "../dist/serve/local-workspace.js";
import {MemoryCredentialVault} from "../dist/workspace/credential-vault.js";
import {scriptedWorkspaceProvider} from "./fixtures/scripted-workspace-provider.mjs";

async function fixture(t,{proposal="valid"}={}){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-group-create-"))),seed=new LocalWorkspaceHost(root),w=seed.createWorkspace("Group fixture",seed.list().revision);
 seed.configureSynthetic(w.workspaceId,0);const agents=seed.context(w.workspaceId).resources.agents, members=[];
 for(const name of["Alpha","Beta","Dormant"]){const agent=agents.create({username:name.toLowerCase(),profile:{displayName:name},runtimeId:"pi"},agents.list().revision);members.push(agent);}
 const dormant=members[2];await seed.setAgentArchived(w.workspaceId,dormant.agentId,true,dormant.configRevision,dormant.agentEpoch);await seed.close();
 const handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},{root,version:"group-fixture",credentialVault:new MemoryCredentialVault(),providerFactory(_connection,binding,context){
  let calls=0;return scriptedWorkspaceProvider({id:"openai",model:binding.model,async turn(){
   if(calls++===0)return{text:"",toolUses:[{id:randomUUID(),name:"group_create",input:{name:"Project planning",memberIds:proposal==="single"?[members[0].agentId]:proposal==="archived"?[members[0].agentId,dormant.agentId]:members.slice(0,2).map(row=>row.agentId)}}],stop:"tool_use",usage:{input:1,output:1}};
   return{text:"The fixture group request has been reviewed. No first message was sent.",toolUses:[],stop:"end",usage:{input:1,output:1}};
  }});
 }});
 const socket=new WebSocket(`ws://127.0.0.1:${handle.port}`),pending=new Map();let serial=0;
 socket.on("message",raw=>{const message=JSON.parse(raw),wait=pending.get(message.id);if(!wait)return;pending.delete(message.id);clearTimeout(wait.timer);message.error?wait.reject(Error(wait.method+": "+message.error.message)):wait.resolve(message.result);});await once(socket,"open");
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error("Fixture RPC timeout: "+method));},10000);pending.set(id,{resolve,reject,timer,method});socket.send(JSON.stringify({jsonrpc:"2.0",id,method,params}));});
 t.after(async()=>{socket.terminate();for(const row of pending.values())clearTimeout(row.timer);await handle.close();fs.rmSync(root,{recursive:true,force:true});});
 const init=await rpc("initialize",{token:handle.token}),snapshot=await rpc("workspace.select",{workspaceId:w.workspaceId,expectedRevision:init.workspace.revision});
 const scope={workspaceId:w.workspaceId,expectedGeneration:snapshot.resourceGeneration};let latest;const read=async()=>latest=await rpc("workspace.snapshot",{workspaceId:w.workspaceId,agentId:w.selectedAgentId});
 async function until(read){const deadline=Date.now()+30000;while(Date.now()<deadline){const value=await read();if(value)return value;if(latest&&!["running","draining"].includes(latest.conversation.state))throw Error("Group fixture ended before card: "+JSON.stringify({state:latest.conversation.state,blockReason:latest.conversation.blockReason,pendingQuestion:latest.conversation.pendingQuestion,results:latest.conversation.history.flatMap(row=>row.role==="tool"?row.results:[])}));await new Promise(resolve=>setTimeout(resolve,25));}throw Error("Group fixture did not settle");}
 const send=message=>rpc("workspace.session.send",{...scope,agentId:w.selectedAgentId,message,source:"ui",requestId:randomUUID()});
 const settled=()=>until(async()=>{const value=await read();return !["running","draining"].includes(value.conversation.state)?value:null;});
 return{rpc,scope,read,send,settled,until,members,main:w.selectedAgentId};
}

test("group creation uses a frozen scoped approval, at least two active colleagues and no first message",async t=>{
 const f=await fixture(t);await f.send("Create a group with Alpha and Beta");
 const card=await f.until(async()=>(await f.read()).approvals.find(row=>row.kind==="group_create"));
 assert.deepEqual(card.draft.memberIds,f.members.slice(0,2).map(row=>row.agentId));assert.deepEqual(card.draft.memberNames,["Alpha","Beta"]);
 assert.equal((await f.rpc("workspace.channels.list",f.scope)).channels.length,0,"proposal has no effects");
 await assert.rejects(f.rpc("workspace.approval.respond",{...f.scope,expectedGeneration:"stale",approvalId:card.id,approved:true}),/generation/);
 await assert.rejects(f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true,draft:{...card.draft,name:"Changed"}}),/frozen/);
 await f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true});const completed=await f.settled();assert.equal(completed.conversation.taskState,"completed");assert.equal(completed.conversation.completion.state,"verified");
 const groups=await f.rpc("workspace.channels.list",f.scope);assert.equal(groups.channels.length,1);
 const group=groups.channels[0];assert.equal(group.name,"Project planning");assert.equal(group.messageCount,0);assert.equal(group.autonomy.mode,"mention");
 await assert.rejects(f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true}),/approval/);
});

test("declining a group card creates nothing and an archived member invalidates a pending card",async t=>{
 const f=await fixture(t);await f.send("Create a group with Alpha and Beta");
 let card=await f.until(async()=>(await f.read()).approvals.find(row=>row.kind==="group_create"));
 await f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:false});await f.settled();
 assert.equal((await f.rpc("workspace.channels.list",f.scope)).channels.length,0);
 await f.send("Create a group with Alpha and Beta");card=await f.until(async()=>(await f.read()).approvals.find(row=>row.kind==="group_create"));
 const target=(await f.read()).agents.find(row=>row.agentId===f.members[1].agentId);
 await f.rpc("workspace.agents.setArchived",{...f.scope,agentId:target.agentId,configRevision:target.configRevision,agentEpoch:target.agentEpoch,archived:true});
 await assert.rejects(f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true}),/roster changed/);
 await f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:false});await f.settled();
 assert.equal((await f.rpc("workspace.channels.list",f.scope)).channels.length,0);
});

for(const {label,message,proposal} of[{label:"unsolicited model proposal",message:"Compare work plans.",proposal:"valid"},{label:"one member",message:"Create a group with Alpha and Beta",proposal:"single"},{label:"archived member",message:"Create a group with Alpha and Beta",proposal:"archived"}]){
 test("no group card or effect for "+label,async t=>{
  const f=await fixture(t,{proposal});await f.send(message);const done=await f.settled();
  assert.equal(done.approvals.length,0);assert.equal((await f.rpc("workspace.channels.list",f.scope)).channels.length,0);
  const result=done.conversation.history.flatMap(row=>row.role==="tool"?row.results:[]).find(row=>row.name.endsWith("group_create"));if(!result){assert.equal(proposal,"single");assert.notEqual(done.conversation.completion?.state,"verified");return;}
  if(message.startsWith("Compare")&&result.content.startsWith("{"))assert.equal(JSON.parse(result.content).refused,"human_request_required");else assert.equal(result.isError,true);
 });
}
