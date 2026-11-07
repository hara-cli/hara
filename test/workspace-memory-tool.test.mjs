import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID,createHash } from "node:crypto";
import { workspaceMemorySearchTool } from "../dist/workspace/memory-tool.js";
import { legacyPolicyAllowsTool } from "../dist/workspace/legacy-role-policy.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceResourceStorage,workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceLegacyMemoryImport } from "../dist/workspace/legacy-memory.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { piWorkspaceToolName } from "../dist/agent-runtime/pi-native-tools.js";
test("memory search projects bounded sanitized text, never source paths or extra result fields",async()=>{let checks=0;const tool=workspaceMemorySearchTool(async()=>Array.from({length:5},()=>({title:"Memo",snippet:'"'.repeat(20000),path:"/must-not-return",permission:"must-not-return"})),()=>checks++);const result=await tool.run({query:"memo"},{});assert(result.length<7800);assert.equal(checks,2);assert.equal(result.includes("must-not-return"),false);assert.equal(JSON.parse(result).historicalContextOnly,true);});
test("memory query and revocation gates run before any lookup and again after await",async()=>{let calls=0;const tool=workspaceMemorySearchTool(async()=>{calls++;return[];},()=>{throw Error("revoked");});await assert.rejects(tool.run({query:"hello"},{}),/revoked/);assert.equal(calls,0);await assert.rejects(tool.run({query:"hello",path:"/"},{}),/Invalid/);let checks=0;await assert.rejects(workspaceMemorySearchTool(async()=>[],()=>{if(++checks===2)throw Error("revoked after lookup");}).run({query:"hello"},{}),/after lookup/);});
test("an explicit old allow-list does not gain memory tools unless it already allowed memory_search",()=>{assert.equal(legacyPolicyAllowsTool({allow:["read_file"],deny:[],owns:[],readOnly:true},"workspace_memory_search","read"),false);assert.equal(legacyPolicyAllowsTool({allow:["memory_search"],deny:[],owns:[],readOnly:true},"workspace_memory_search","read"),true);});
test("actual Pi Host receives only matching inherited memory; greetings and another Workspace do not",async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-memory-host-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const turns=[];
 const host=new LocalWorkspaceHost(root,{mode:"workspace",credentialVault:new MemoryCredentialVault(),providerFactory:()=>({id:"openai",model:"fake",async turn(args){turns.push(args);return{text:"Hello",toolUses:[],stop:"end",usage:{input:1,output:1}};}})});
 try{const a=host.createWorkspace("A",host.list().revision),b=host.createWorkspace("B",host.list().revision),content="Always confirm the reporting period. "+"Context. ".repeat(1000),source={sourceRef:"legacy",sourceHash:createHash("sha256").update(content).digest("hex"),content};
  const storage=new WorkspaceResourceStorage(host.home,host.catalog.resolve(a.workspaceId).scope);storage.initialize();await new WorkspaceLegacyMemoryImport(storage,"a".repeat(64),[source]).apply();
  for(const view of[a,b]){
   host.configureConnection(view.workspaceId,{label:"Fake",provider:"openai",baseURL:"https://example.invalid/v1",defaultModel:"fake",apiKey:"fixture-only-key"},0);
   for(const objective of["Hello","What is known about the reporting period?"]){
    const run=host.start("fixture",view.workspaceId,view.selectedAgentId,objective,randomUUID());await host.wait(run.runId);
   }
  }
  assert.equal(turns.length,4);
  assert.equal(turns[0].system.includes("confirm the reporting period"),false,"a greeting omits unrelated inherited notes");
  assert.match(turns[1].system,/confirm the reporting period/,"the matching current question receives its note");
  assert.equal(turns[2].system.includes("confirm the reporting period"),false);
  assert.equal(turns[3].system.includes("confirm the reporting period"),false,"another Workspace cannot receive the matched note");
  assert(turns[1].tools.some(tool=>tool.name===piWorkspaceToolName("workspace_memory_search")));
  // The existing governed environment intentionally includes the authorized fixture project cwd.
  // The new memory projection must not expose its distinct private state namespace/file paths.
  const privateMemoryRoot=storage.run(()=>join(workspaceStateHome(),".hara/memory"));
  for(const turn of turns)assert.equal(turn.system.includes(privateMemoryRoot),false);
  assert(turns[1].system.length-turns[3].system.length<2400);
 }finally{await host.close();}
});
