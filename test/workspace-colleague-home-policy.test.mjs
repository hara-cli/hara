import { beginWorkspaceHostWrite } from "../dist/agent-runtime/workspace-native-policy.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {LocalWorkspaceCatalog} from "../dist/workspace/local-catalog.js";
import {WorkspaceResources} from "../dist/workspace/resources.js";
import {WorkspaceResourceStorage,workspaceStateHome} from "../dist/workspace/resource-context.js";
import {WorkspaceConnectionStoreV2} from "../dist/workspace/connections.js";
import {WorkspaceColleagueHomes} from "../dist/workspace/colleague-homes.js";
import {createTaskExecution} from "../dist/session/task.js";
import {captureWorkspaceProjectIdentity,freezeWorkspaceRunBinding,workspaceAgentBindingHash} from "../dist/workspace/run-binding.js";
import {WorkspaceSessionLease} from "../dist/workspace/session-lease.js";
import {createWorkspaceRunPermit,closeWorkspaceRunPermit,workspaceRunManagedProjectRoots} from "../dist/workspace/execution.js";
import {createRuntimeExecutionPolicy} from "../dist/agent-runtime/execution-policy.js";
import {beginWorkspaceNativePolicy,endWorkspaceNativePolicy} from "../dist/agent-runtime/workspace-native-policy.js";
import {runExternalCommandCapture} from "../dist/external-sessions/process.js";

function fixture(t,tier="full-protected"){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-home-policy-"))),account=join(root,"account"),host=join(account,".hara/workspaces-v1"),home=join(host,"home"),policies=[],permits=[];
 t.after(async()=>{for(const p of policies)await p.close();for(const p of permits)await closeWorkspaceRunPermit(p);fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(home,{recursive:true,mode:0o700});const catalog=new LocalWorkspaceCatalog(home),row=catalog.create("Fixture",1);
 const resources=new WorkspaceResources(home,row.scope);resources.initialize();resources.agents.initializeMain();
 const storage=new WorkspaceResourceStorage(home,row.scope);storage.initialize();const connections=new WorkspaceConnectionStoreV2(storage);
 connections.add({label:"Fake",provider:"openai",baseURL:"http://127.0.0.1:1/v1",apiKey:"synthetic-not-a-real-key",defaultModel:"fixture"},0);
 const legacy=join(host,"project",row.scope.workspaceId);fs.mkdirSync(legacy,{recursive:true});const homes=new WorkspaceColleagueHomes(storage,legacy);
 function make(){
  let a=resources.agents.create({username:"fixture-"+resources.agents.list().revision,profile:{displayName:"Fixture"},runtimeId:"pi"},resources.agents.list().revision);
  if(a.permissionTier!==tier)a=resources.agents.setPermissionTier(a.agentId,tier,a.configRevision,a.agentEpoch);
  const primary=homes.ensure(a.agentId).project.root,sessionId=randomUUID(),controller=new AbortController(),lease=WorkspaceSessionLease.acquire(storage,sessionId);
  const task=resources.agents.bindTask(createTaskExecution("Synthetic file task",randomUUID()),a.agentId,a.configRevision,a.agentEpoch),hostIdentity=catalog.read();
  const binding=freezeWorkspaceRunBinding({schemaVersion:1,scope:row.scope,agent:task.workspaceAgentBinding,agentBindingHash:workspaceAgentBindingHash(task.workspaceAgentBinding),connection:connections.capture(),runtimeContract:"hara-governed-runtime-v1",project:captureWorkspaceProjectIdentity(primary),sessionId,runId:randomUUID(),lineage:{rootRunId:null,parentRunId:null,depth:0},createdAt:new Date().toISOString(),host:{hostId:hostIdentity.hostId,hostEpoch:hostIdentity.hostEpoch,grantId:row.grantId,grantRevision:row.grantRevision,actorId:row.actorId,policyRevision:row.policyRevision},budget:{mode:"interactive",maxRounds:100,maxToolCalls:32,maxTokens:128000,timeoutMs:120000}});
  const input={binding,catalog,resources,storage,connections,lease,cwd:primary,managedProjectRoot:legacy,signal:controller.signal,provider:{id:"openai",model:binding.connection.model,async turn(){throw Error("No model is allowed in policy tests");}},toolNames:[],usage:{modelCalls:0,toolCalls:0,inputTokens:0,outputTokens:0},updateUsage(){}};
  const permit=createWorkspaceRunPermit(input);permits.push(permit);
  const runtime=join(root,"pi-runtime-"+a.agentId);fs.mkdirSync(runtime,{mode:0o700});fs.writeFileSync(join(runtime,"auth.json"),"{}",{mode:0o600});
  const policyInput={runtimeId:"pi",tier,workRoot:primary,accountHome:account,runtimeHome:runtime,loginSource:"isolated",managedProjectPermit:permit,protectedStateRoots:[storage.run(()=>workspaceStateHome())]};
  return{a,primary,permit,input,policyInput,policy(){const p=createRuntimeExecutionPolicy(policyInput);policies.push(p);return p;}};
 }
 return{root,account,legacy,storage,make};
}
async function execute(policy,code,account){
 const launch=policy.wrap({command:process.execPath,args:["-e",code],env:{PATH:"/usr/bin:/bin",HOME:account}});
 return runExternalCommandCapture(launch,launch.args,{timeoutMs:10000,waitForClose:true,retainStdoutOnFailure:true});
}
test("opaque managed proof admits only the Agent's derived cwd and pins the parent identity",async t=>{
 const f=fixture(t),a=f.make(),b=f.make();assert.deepEqual(workspaceRunManagedProjectRoots(a.permit),{workRoot:a.primary,legacyRoot:f.legacy,homeRoot:a.primary});
 assert.throws(()=>createWorkspaceRunPermit({...a.input,cwd:b.primary,binding:{...a.input.binding,project:captureWorkspaceProjectIdentity(b.primary)}}),/managed Workspace project proof/);
 assert.throws(()=>createRuntimeExecutionPolicy({...a.policyInput,managedProjectPermit:structuredClone(a.permit)}),/trusted Host permit/);
 assert.throws(()=>createRuntimeExecutionPolicy({...a.policyInput,managedProjectPermit:undefined}),/protected Hara state/);
 const moved=f.legacy+"-retained";fs.renameSync(f.legacy,moved);fs.mkdirSync(f.legacy);
 assert.throws(()=>workspaceRunManagedProjectRoots(a.permit),/identity changed/);fs.rmdirSync(f.legacy);fs.renameSync(moved,f.legacy);
});
test("actual Seatbelt retains legacy writes but denies sibling homes, instruction aliases and settings",{skip:process.platform!=="darwin"},async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),p=a.policy();assert.equal(p.workRoot,a.primary);assert.equal(p.evidenceRoot,f.legacy);
 const paths={own:join(a.primary,"ok.txt"),legacy:join(f.legacy,"legacy.txt"),sibling:join(b.primary,"no.txt"),instructions:join(a.primary,"AGENTS.md"),caseAlias:join(a.primary,"agents.md"),claude:join(a.primary,"CLAUDE.md"),local:join(a.primary,"CLAUDE.local.md"),parentRules:join(f.legacy,"AGENTS.md"),state:join(f.account,".hara/no.txt")};
 const code=`const fs=require('fs'),paths=${JSON.stringify(paths)},results={};for(const[k,path]of Object.entries(paths)){try{fs.writeFileSync(path,'fixture');results[k]=true}catch{results[k]=false}}for(const[k,path]of Object.entries(${JSON.stringify({settings:join(a.primary,".claude"),codex:join(a.primary,".codex"),parentSettings:join(f.legacy,".claude")})})){try{fs.mkdirSync(path);results[k]=true}catch{results[k]=false}}try{fs.renameSync(${JSON.stringify(a.primary)},${JSON.stringify(join(p.tempRoot,"renamed-root"))});results.renameRoot=true}catch{results.renameRoot=false}console.log(JSON.stringify(results));`;
 const result=await execute(p,code,f.account);assert.equal(result.code,0,result.errorFirstLine);
 assert.deepEqual(JSON.parse(result.stdout),{own:true,legacy:true,sibling:false,instructions:false,caseAlias:false,claude:false,local:false,parentRules:false,state:false,settings:false,codex:false,parentSettings:false,renameRoot:false});
 p.observeNativeEvent({type:"command",status:"completed",command:"touch ok.txt"});const proof=p.collectWorkspaceEvidence();assert(proof);assert.deepEqual(proof.changes.map(row=>row.path).sort(),["colleagues/"+a.a.agentId+"/ok.txt","legacy.txt"].sort());
 p.observeNativeEvent({type:"file",status:"completed",path:join(f.legacy,"legacy.txt"),operation:"delete"});assert.equal(p.risks.length,0);
});
test("controlled tier denies both cwd and legacy writes even when they share a valid managed proof",{skip:process.platform!=="darwin"},async t=>{
 const f=fixture(t,"controlled"),a=f.make(),p=a.policy();
 const result=await execute(p,`const fs=require('fs'),o={};for(const[k,path]of Object.entries(${JSON.stringify({own:join(a.primary,"no.txt"),legacy:join(f.legacy,"no.txt")})})){try{fs.writeFileSync(path,'no');o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`,f.account);
 assert.equal(result.code,0,result.errorFirstLine);assert.deepEqual(JSON.parse(result.stdout),{own:false,legacy:false});assert.equal(p.collectWorkspaceEvidence(),null);
});
test("different cwd writers sharing the legacy root invalidate each other's native evidence",async t=>{
 const f=fixture(t),a=f.make(),b=f.make(),one=a.policy(),two=b.policy();
 beginWorkspaceNativePolicy(a.permit,one);beginWorkspaceNativePolicy(b.permit,two);
 fs.writeFileSync(join(a.primary,"one.txt"),"One");fs.writeFileSync(join(b.primary,"two.txt"),"Two");
 one.observeNativeEvent({type:"command",status:"completed",command:"touch one.txt"});two.observeNativeEvent({type:"command",status:"completed",command:"touch two.txt"});
 assert.equal(one.collectWorkspaceEvidence(),null);assert.equal(two.collectWorkspaceEvidence(),null);
 await endWorkspaceNativePolicy(a.permit,one);await endWorkspaceNativePolicy(b.permit,two);
});

test("only actual Host write lifetimes invalidate overlapping native evidence, including a native attempt that starts during the write",async t=>{
 const f=fixture(t),a=f.make(),one=a.policy();beginWorkspaceNativePolicy(a.permit,one);
 const finish=beginWorkspaceHostWrite(f.legacy),b=f.make(),two=b.policy();beginWorkspaceNativePolicy(b.permit,two);
 for(const[row,policy]of[[a,one],[b,two]]){fs.writeFileSync(join(row.primary,"native.txt"),"fixture");policy.observeNativeEvent({type:"command",status:"completed",command:"touch native.txt"});assert.equal(policy.collectWorkspaceEvidence(),null);}
 finish();finish();await endWorkspaceNativePolicy(a.permit,one);await endWorkspaceNativePolicy(b.permit,two);
 const c=f.make(),three=c.policy();beginWorkspaceNativePolicy(c.permit,three);fs.writeFileSync(join(c.primary,"native.txt"),"later");three.observeNativeEvent({type:"command",status:"completed",command:"touch native.txt"});assert(three.collectWorkspaceEvidence(),"closed Host writer must not poison a later attempt");await endWorkspaceNativePolicy(c.permit,three);
});
