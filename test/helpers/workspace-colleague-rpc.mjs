import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {randomUUID} from "node:crypto";
import {WebSocket} from "ws";
import {LocalWorkspaceHost} from "../../dist/workspace/local-host.js";
import {startLocalWorkspaceServe} from "../../dist/serve/local-workspace.js";
import {MemoryCredentialVault} from "../../dist/workspace/credential-vault.js";
import {scriptedWorkspaceProvider} from "../fixtures/scripted-workspace-provider.mjs";
import {RuntimeExecutionPolicy} from "../../dist/agent-runtime/execution-policy.js";
export const terminal=value=>!["running","draining"].includes(value.conversation.state);
export async function fixture(t,runtime="pi"){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-colleague-rpc-")));const marker=new LocalWorkspaceHost(root);await marker.close();let runtimeOptions={},command;
 if(runtime==="claude"){
  const account=join(root,"account"),bin=join(account,".claude","projects","fixture-bin");command=join(bin,"claude");fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(command,"#!"+process.execPath+"\nconst fs=require('node:fs'),{randomUUID}=require('node:crypto');if(process.argv[2]==='--version'){console.log('claude 1.2.3');process.exit(0);}fs.appendFileSync(process.argv[1]+'.launches',JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Hello from a fresh fixture session',session_id:randomUUID()}));\n",{mode:0o755});
  runtimeOptions={runtimeInstallerOptions:{accountHome:()=>account,discovery:{home:account,path:bin+":/usr/bin:/bin",systemBins:[],run:async(_command,args)=>args[0]==="-lic"?null:"claude 1.2.3"}}};
 }
 const seed=new LocalWorkspaceHost(root,runtimeOptions),workspace=seed.createWorkspace("Folders",seed.list().revision);seed.configureSynthetic(workspace.workspaceId,0);
 const context=seed.context(workspace.workspaceId);
 if(runtime==="claude"){await context.runtimes.discover();const detected=context.runtimes.list().options.find(row=>row.runtimeId==="claude");context.runtimes.registerLocal("claude",detected.fingerprint,"host");await context.runtimeModels.select("claude","sonnet",0);}
 const agents=context.resources.agents,a=agents.create({username:"alpha",profile:{displayName:"Alpha"},runtimeId:runtime},agents.list().revision),b=agents.create({username:"beta",profile:{displayName:"Beta"},runtimeId:"pi"},agents.list().revision);await seed.close();
 let action=null,handle,socket,serial=0;const turns=[],pending=new Map();
 const serveOptions={root,...runtimeOptions,version:"colleague-fixture",credentialVault:new MemoryCredentialVault(),providerFactory(_c,binding,context){let calls=0;return scriptedWorkspaceProvider({id:"openai",model:binding.model,async turn(args){turns.push({agentId:context.agent.agentId,...args});return calls++===0&&action?{text:"",toolUses:[{id:randomUUID(),...action}],stop:"tool_use",usage:{input:1,output:1}}:{text:"The requested check is complete.",toolUses:[],stop:"end",usage:{input:1,output:1}};}});}};
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error("RPC timeout "+method));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:"2.0",id,method,params}));});
 const connect=async()=>{handle=await startLocalWorkspaceServe({host:"127.0.0.1",port:0,cwd:root},serveOptions);socket=new WebSocket(`ws://127.0.0.1:${handle.port}`);socket.on("message",raw=>{const row=JSON.parse(raw),wait=pending.get(row.id);if(!wait)return;pending.delete(row.id);clearTimeout(wait.timer);row.error?wait.reject(Error(row.error.message)):wait.resolve(row.result);});await once(socket,"open");await rpc("initialize",{token:handle.token});const directory=await rpc("workspace.list");await rpc("workspace.select",{workspaceId:workspace.workspaceId,expectedRevision:directory.revision});};
 const close=async()=>{socket?.terminate();await handle?.close();};t.after(async()=>{for(const row of pending.values())clearTimeout(row.timer);await close();fs.rmSync(root,{recursive:true,force:true});});await connect();
 const read=agent=>rpc("workspace.snapshot",{workspaceId:workspace.workspaceId,agentId:agent??a.agentId}),scope={workspaceId:workspace.workspaceId,expectedGeneration:(await read()).resourceGeneration};
 const until=async fn=>{const deadline=Date.now()+45000;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,30));}throw Error("Colleague fixture did not settle");};
 const select=agent=>rpc("workspace.agent.select",{...scope,agentId:agent});
 const send=(message,agent=a.agentId)=>rpc("workspace.session.send",{...scope,agentId:agent,message,source:"ui",requestId:randomUUID()});
 const settle=(agent=a.agentId)=>until(async()=>{const value=await read(agent);return terminal(value)?value:null;});
 return{root,command,a,b,scope,rpc,read,send,settle,until,select,turns,setAction:value=>{action=value;},restart:async()=>{await close();await connect();},project:join(root,"project",workspace.workspaceId)};
}
export const results=view=>view.conversation.history.flatMap(row=>row.role==="tool"?row.results:[]);
