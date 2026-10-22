import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { DEFAULT_WORKSPACE_RUN_BUDGET } from "../dist/workspace/run-binding.js";
import { REFERENCE_CLARIFICATION_POLICY } from "../dist/agent/reference-clarification.js";
import { composeSystem } from "../dist/agent/loop.js";

function fixture(turn) {
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"hara-reference-policy-")));
  const host=new LocalWorkspaceHost(root,{providerFactory(_connection,binding){return{id:"openai",model:binding.model,turn};}});
  const workspace=host.createWorkspace("Synthetic",host.list().revision),workspaceId=workspace.workspaceId;
  host.configureSynthetic(workspaceId,0);host.select("client",workspaceId,host.list().revision);
  const scope=host.catalog.resolve(workspaceId).scope,storage=new WorkspaceResourceStorage(host.home,scope);
  storage.initialize();
  const stateHome=storage.run(()=>workspaceStateHome());
  return{root,host,workspaceId,main:workspace.selectedAgentId,scope,stateHome,async close(){await host.close();rmSync(root,{recursive:true,force:true});}};
}
const call=(name,input={})=>({text:"",toolUses:[{id:randomUUID(),name,input}],stop:"tool_use",usage:{input:20,output:5}});
test("reference clarification is a stable system rule even under a trusted custom prompt",()=>{
  const prompt=composeSystem("/synthetic/project",undefined,"Custom role",undefined,false);
  assert.ok(prompt.text.includes(REFERENCE_CLARIFICATION_POLICY));
  assert.ok(REFERENCE_CLARIFICATION_POLICY.includes("at most two combined roster/memory lookups"));
  assert.ok(REFERENCE_CLARIFICATION_POLICY.includes("ask_user (no default)"));
  assert.ok(REFERENCE_CLARIFICATION_POLICY.includes("Do not search/read Workspace files"));
});
for(const lookups of [1,2]) test(`unknown reference pauses after ${lookups} lookup(s); a question batch cannot execute a file search or another round`,async()=>{
  let requests=0;const question="你说的 Mori 是哪位同事，还是某个功能？请确认名称。";
  const a=fixture(async args=>{
    requests++;assert.ok(args.system.includes(REFERENCE_CLARIFICATION_POLICY));assert.ok(args.tools.some(tool=>tool.name==="ask_user"));
    assert.ok(requests<=lookups+1,"no model call may follow the retained question");
    if(lookups===2&&requests===1)return call("agent_list");
    if(requests===lookups)return call("workspace_memory_search",{query:"mori-synthetic-unknown"});
    const memory=args.history.flatMap(row=>row.role==="tool"?row.results:[]).find(row=>row.name==="workspace_memory_search");
    assert.deepEqual(JSON.parse(memory.content).hits,[]);
    const result=call("ask_user",{question});
    result.toolUses.push({id:randomUUID(),name:"workspace_read",input:{path:"DO-NOT-READ.txt"}});
    return result;
  });
  try{
    writeFileSync(join(a.root,"project",a.workspaceId,"DO-NOT-READ.txt"),"SYNTHETIC_FILE_MUST_NOT_BE_READ");
    const run=a.host.start("client",a.workspaceId,a.main,"Mori 同事去哪了？",randomUUID());await a.host.wait(run.runId);
    const snapshot=a.host.snapshot(a.workspaceId,a.main,"client"),conversation=snapshot.conversation;
    assert.equal(requests,lookups+1);assert.equal(conversation.taskState,"paused");assert.equal(conversation.completion.state,"awaiting_user");assert.equal(conversation.blockReason,question);
    const results=conversation.history.flatMap(row=>row.role==="tool"?row.results:[]);
    assert.equal(results.filter(row=>["agent_list","workspace_memory_search"].includes(row.name)).length,lookups);
    assert.equal(results.find(row=>row.name==="workspace_read").isError,true);
    assert.equal(JSON.stringify(conversation.history).includes("SYNTHETIC_FILE_MUST_NOT_BE_READ"),false);
    const operations=JSON.parse(readFileSync(join(a.stateHome,".hara",`execution-${run.runId}.json`),"utf8")).operations;
    assert.equal(operations.filter(row=>row.name==="ask_user").length,1);assert.equal(conversation.runUsage.toolCalls,lookups+1);
    assert.equal(operations.some(row=>row.name==="workspace_read"),false);
    await a.host.close();let restarts=0;
    const reopened=new LocalWorkspaceHost(a.root,{providerFactory(){restarts++;throw new Error("read-only reopen must not invoke a provider");}});
    try{assert.equal(reopened.snapshot(a.workspaceId,a.main).conversation.blockReason,question);assert.equal(restarts,0);}finally{await reopened.close();}
  }finally{await a.close();}
});
test("a model-provided default cannot answer its own Workspace clarification or trigger another model round",async()=>{
  let requests=0;const question="请确认你指的是哪位同事。";
  const a=fixture(async()=>{requests++;assert.equal(requests,1);return call("ask_user",{question,default:"INVENTED_ANSWER_MUST_NOT_BE_USED"});});
  try{
    const run=a.host.start("client",a.workspaceId,a.main,"那位同事是谁？",randomUUID());await a.host.wait(run.runId);
    const conversation=a.host.snapshot(a.workspaceId,a.main).conversation;
    assert.equal(requests,1);assert.equal(conversation.taskState,"paused");assert.equal(conversation.completion.state,"awaiting_user");assert.equal(conversation.blockReason,question);
    const result=conversation.history.flatMap(row=>row.role==="tool"?row.results:[]).find(row=>row.name==="ask_user");
    assert.equal(result.content.includes("INVENTED_ANSWER_MUST_NOT_BE_USED"),false);
  }finally{await a.close();}
});
test("two evidenced colleagues sharing a display name cause immediate clarification after the roster lookup",async()=>{
  let requests=0;const question="你指的是哪位 Mori 同事？请确认具体名称或职责。";
  const a=fixture(async args=>{
    if(++requests===1)return call("agent_list");
    assert.equal(requests,2);const result=args.history.flatMap(row=>row.role==="tool"?row.results:[]).find(row=>row.name==="agent_list");
    assert.equal(JSON.parse(result.content).agents.filter(row=>row.identity.displayName==="Mori").length,2);
    return call("ask_user",{question});
  });
  try{
    const resources=new WorkspaceResources(a.host.home,a.scope);resources.initialize();const agents=resources.agents;
    for(const username of ["synthetic-a","synthetic-b"])agents.create({username,profile:{displayName:"Mori",title:username},instructions:"Synthetic colleague",runtimeId:"pi"},agents.list().revision);
    const run=a.host.start("client",a.workspaceId,a.main,"Mori 同事是哪位？",randomUUID());await a.host.wait(run.runId);
    const conversation=a.host.snapshot(a.workspaceId,a.main).conversation;
    assert.equal(requests,2);assert.equal(conversation.completion.state,"awaiting_user");assert.equal(conversation.blockReason,question);
    assert.equal(conversation.history.flatMap(row=>row.role==="tool"?row.results:[]).some(row=>row.name==="workspace_memory_search"||row.name==="workspace_read"),false);
  }finally{await a.close();}
});
test("new ordinary tasks can finish five bounded model rounds above the old 32k limit, retaining exact raw usage",async()=>{
  const usage=Array.from({length:5},()=>({input:7000,output:1000}));
  let requests=0;const a=fixture(async()=>{
    const round=requests++,result=round<4?call("workspace_read",{path:`synthetic-${round}.txt`}):{text:"Synthetic notes read.",toolUses:[],stop:"end"};
    assert.ok(round<5);return{...result,usage:usage[round]};
  });
  try{
    for(let i=0;i<4;i++)writeFileSync(join(a.root,"project",a.workspaceId,`synthetic-${i}.txt`),`Synthetic note ${i}`);
    const run=a.host.start("client",a.workspaceId,a.main,"What is in the four synthetic notes?",randomUUID());await a.host.wait(run.runId);
    const conversation=a.host.snapshot(a.workspaceId,a.main).conversation;
    assert.equal(requests,5);assert.equal(conversation.taskState,"completed");assert.equal(conversation.runUsage.inputTokens+conversation.runUsage.outputTokens,40000);
    const files=readdirSync(join(a.stateHome,".hara"));
    const budget=JSON.parse(readFileSync(join(a.stateHome,".hara",files.find(file=>file.startsWith("tree-budget-"))),"utf8"));
    assert.deepEqual(budget.limits,DEFAULT_WORKSPACE_RUN_BUDGET);assert.equal(budget.limits.maxTokens,128000);
    assert.equal(budget.usage.inputTokens+budget.usage.outputTokens,40000);
    const audit=JSON.parse(readFileSync(join(a.stateHome,".hara",`execution-${run.runId}.json`),"utf8"));
    assert.equal(audit.operations.filter(row=>row.kind==="model").length,5);assert.equal(audit.operations.filter(row=>row.kind==="tool").length,4);
    assert.ok(audit.operations.every(row=>row.outcome==="completed"&&row.endedAt>=row.startedAt));
  }finally{await a.close();}
});
