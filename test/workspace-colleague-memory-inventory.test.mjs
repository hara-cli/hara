import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceStorage, bindWorkspaceMemoryInventory, workspaceResourceDirectory } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { withWorkspaceAgentMemory, withWorkspaceSharedMemory } from "../dist/memory/agent-scope.js";
import * as memory from "../dist/memory/store.js";
function fixture(t) {
  const root=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-private-memory-inventory-"))),home=join(root,"home"),project=join(root,"project");
  fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(project,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const scope={schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}},storage=new WorkspaceResourceStorage(home,scope),resources=new WorkspaceResources(home,scope);
  storage.initialize();resources.initialize();const a="ag_"+randomUUID(),b="ag_"+randomUUID();
  return {root,home,project,scope,storage,resources,a,b,as:(id,operation)=>withWorkspaceAgentMemory(storage,id,project,operation)};
}
test("owner finds private notes through the actual search facade while other colleagues see only their own and confirmed shared notes",async t=>{
  const f=fixture(t);
  await f.as(f.a,()=>f.resources.memory.appendOnce("project","memory","orchid private Alpha",f.project));
  await f.as(f.b,()=>f.resources.memory.appendOnce("global","memory","orchid private Beta",f.project));
  await f.as(f.a,()=>withWorkspaceSharedMemory(()=>f.resources.memory.appendOnce("global","memory","orchid approved sharing",f.project)));
  const own=await f.as(f.a,()=>f.resources.memory.search("orchid",f.project,5,"mine"));
  assert.equal(own.length,1);assert.match(own[0].snippet,/private Alpha/);
  const a=await f.as(f.a,()=>f.resources.memory.search("orchid",f.project,5,"all"));
  assert.match(JSON.stringify(a),/private Alpha/);assert.match(JSON.stringify(a),/approved sharing/);assert.doesNotMatch(JSON.stringify(a),/private Beta/);
  const b=await f.as(f.b,()=>f.resources.memory.search("orchid",f.project,5,"all"));
  assert.match(JSON.stringify(b),/private Beta/);assert.match(JSON.stringify(b),/approved sharing/);assert.doesNotMatch(JSON.stringify(b),/private Alpha/);
});
test("private inventory cannot bind without its current owner or cross colleague, resource, parent and credential boundaries",async t=>{
  const f=fixture(t);let own,foreign,permit;
  f.as(f.b,()=>{foreign=memory.memoryDir("project",f.project);});
  await f.as(f.a,async()=>{own=memory.memoryDir("project",f.project);permit=bindWorkspaceMemoryInventory(own);await new Promise(resolve=>setImmediate(resolve));permit.assertDirectory(own);
    for(const target of [foreign,join(own,".."),workspaceResourceDirectory(["profiles"])])assert.throws(()=>bindWorkspaceMemoryInventory(target),/inventory/);
  });
  f.storage.run(()=>assert.throws(()=>bindWorkspaceMemoryInventory(own),/inventory/));
  f.storage.run(()=>assert.throws(()=>permit.assertDirectory(own),/colleague/));
  f.as(f.b,()=>assert.throws(()=>permit.assertDirectory(own),/colleague/));
  const other=new WorkspaceResourceStorage(f.home,{schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}});other.initialize();
  f.as(f.a,()=>other.run(()=>assert.throws(()=>permit.assertDirectory(own),/resource context/)));
});
test("a replaced private memory directory invalidates its retained inventory proof",t=>{
  const f=fixture(t);
  f.as(f.a,()=>{const own=memory.memoryDir("project",f.project),permit=bindWorkspaceMemoryInventory(own);fs.renameSync(own,own+"-retained");fs.mkdirSync(own,{mode:0o700});try{assert.throws(()=>permit.assertDirectory(own),/identity|changed/);}finally{fs.rmdirSync(own);fs.renameSync(own+"-retained",own);}permit.assertDirectory(own);});
});
