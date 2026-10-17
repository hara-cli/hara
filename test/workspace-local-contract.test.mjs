import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceConnectionStoreV2 } from "../dist/workspace/connections.js";
import { freezeWorkspaceRunBinding, isWorkspaceRunBinding, workspaceAgentBindingHash } from "../dist/workspace/run-binding.js";
import { createTaskExecution } from "../dist/session/task.js";

const temporary = [];
after(() => { for (const path of temporary) fs.rmSync(path, { recursive: true, force: true }); });
function host() { const home=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-local-contract-")));temporary.push(home);return home; }
function setup() {
  const home=host(), catalog=new LocalWorkspaceCatalog(home), row=catalog.create("Personal",1);
  const storage=new WorkspaceResourceStorage(home,row.scope);storage.initialize();
  const connections=new WorkspaceConnectionStoreV2(storage), resources=new WorkspaceResources(home,row.scope);resources.initialize();
  return {home,catalog,row,storage,connections,resources};
}
const connection = () => ({label:"Synthetic",provider:"openai",baseURL:"http://127.0.0.1:1/v1",apiKey:"synthetic-not-a-real-key",defaultModel:"synthetic-model"});
test("explicit local Workspace owner/catalog is persistent and requires no Account, Key or legacy profile", () => {
  const a=setup(), old=a.catalog.read();
  assert.deepEqual(new LocalWorkspaceCatalog(a.home).read(),old);
  assert.equal(fs.existsSync(join(a.home,".hara","profiles.json")),false);
  assert.equal(fs.existsSync(join(a.home,".hara","config.json")),false);
  const other=a.catalog.create("Another",old.revision);
  assert.notEqual(other.scope.workspaceId,a.row.scope.workspaceId);
  assert.notEqual(other.actorId,a.row.actorId);
  assert.throws(()=>a.catalog.select(other.scope.workspaceId,old.revision),/changed/);
  a.catalog.select(other.scope.workspaceId,a.catalog.read().revision);
  assert.equal(a.catalog.resolve(a.row.scope.workspaceId).grantRevision,1,"selection is not revocation");
  a.catalog.revoke(other.scope.workspaceId,a.catalog.read().revision);
  assert.throws(()=>a.catalog.resolve(other.scope.workspaceId),/revoked/);
});
test("connections live in one scoped private snapshot with no public Key/endpoint projection",()=>{
  const a=setup(), result=a.connections.add(connection(),0), listed=a.connections.list();
  assert.equal(listed.revision,1);assert.equal(listed.defaultConnectionId,result.id);
  assert.equal(JSON.stringify(listed).includes(connection().apiKey),false);
  assert.equal(JSON.stringify(listed).includes(connection().baseURL),false);
  const captured=a.connections.capture();
  assert.equal(a.connections.resolve(captured).apiKey,connection().apiKey);
  assert.equal(new WorkspaceConnectionStoreV2(a.storage).capture().credentialGeneration,captured.credentialGeneration);
  const privateFile=a.storage.run(()=>{
    const key=a.storage.scopeKey;return join(a.home,".hara","workspace-data","v1",key,"state",".hara","workspace-connections-v2.json");
  });
  if(process.platform!=="win32") assert.equal(fs.statSync(privateFile).mode&0o777,0o600);
  assert.throws(()=>a.connections.add(connection(),0),/changed/);
  assert.equal(a.connections.list().connections.length,1);
});
test("same labels/Key values in separate Workspace or authority never share a connection binding",()=>{
  const a=setup(), b=setup();a.connections.add(connection(),0);b.connections.add(connection(),0);
  assert.notEqual(a.connections.capture().connectionId,b.connections.capture().connectionId);
  assert.throws(()=>b.connections.resolve(a.connections.capture()),/no fallback/);
  assert.throws(()=>a.connections.add({...connection(),baseURL:"http://remote.invalid"},1),/connection/);
  assert.throws(()=>a.connections.add({...connection(),extra:true},1),/connection/);
});
test("rotation, revoke/re-add, and default selection cannot retarget an old run",()=>{
  const a=setup();const first=a.connections.add(connection(),0), frozen=a.connections.capture();
  const second=a.connections.add({...connection(),defaultModel:"different"},1);a.connections.select(second.id,2);
  assert.equal(a.connections.resolve(frozen).defaultModel,"synthetic-model");
  a.connections.replace(first.id,connection(),3);assert.throws(()=>a.connections.resolve(frozen),/no fallback/);
  const rotated=a.connections.capture(first.id);assert.notEqual(rotated.credentialGeneration,frozen.credentialGeneration);
  a.connections.revoke(first.id,4);a.connections.add(connection(),5);assert.throws(()=>a.connections.resolve(rotated),/no fallback/);
});
test("RunBinding is strict, frozen and preserves all provenance; unsupported runtime/cloud cannot execute",()=>{
  const a=setup();a.connections.add(connection(),0);const main=a.resources.agents.initializeMain();
  const task=a.resources.agents.bindTask(createTaskExecution("synthetic","turn"),main.agentId,main.configRevision,main.agentEpoch);
  const binding=freezeWorkspaceRunBinding({schemaVersion:1,scope:a.row.scope,agent:task.workspaceAgentBinding,
    agentBindingHash:workspaceAgentBindingHash(task.workspaceAgentBinding),connection:a.connections.capture(),runtimeContract:"hara-governed-pi-v1",
    project:{root:a.home,dev:fs.statSync(a.home).dev,ino:fs.statSync(a.home).ino},sessionId:"conversation",runId:randomUUID(),createdAt:new Date().toISOString(),
    host:{hostId:a.catalog.read().hostId,hostEpoch:1,grantId:a.row.grantId,grantRevision:1,actorId:a.row.actorId,policyRevision:1},
    budget:{maxRounds:16,maxToolCalls:32,maxTokens:32000,timeoutMs:60000}});
  assert.equal(isWorkspaceRunBinding(binding),true);assert.equal(Object.isFrozen(binding.agent.resourceBinding),true);
  for (const corrupt of [{...binding,extra:true},{...binding,schemaVersion:99},{...binding,agentBindingHash:"0".repeat(64)},
    {...binding,agent:{...binding.agent,runtimeId:"codex"}},{...binding,scope:{...binding.scope,workspaceId:`ws_${randomUUID()}`}},
    {...binding,budget:{...binding.budget,maxRounds:1000000}}]) assert.equal(isWorkspaceRunBinding(corrupt),false);
  const forged=structuredClone(binding);forged.agent.resourceBinding.generation=randomUUID();
  assert.equal(isWorkspaceRunBinding(forged),false);
});
