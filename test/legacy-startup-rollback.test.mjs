import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { SYNTHETIC_CONNECTION, createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { allText, fixture, hash } from "./helpers/legacy-startup-fixture.mjs";
test("owner rollback restores pre-inheritance state and later automatic boots do not re-import cancelled inheritance",async t=>{
  const f=fixture(t),host=f.open();let id;try{await host.initialize();id=host.list().workspaces[0].workspaceId;await host.rollbackLegacyInheritance();
    assert.equal(host.snapshot(id).agents.length,1);assert.equal(host.workspaceFeatures(id).schedules.length,0);assert.equal(host.workspaceFeatures(id).skills.length,0);assert.equal(host.snapshot(id).connections.connections.length,0);
  }finally{await host.close();}
  const b=f.open();try{assert.equal((await b.initialize()).state,"rolled_back");assert.equal(b.snapshot(id).agents.length,1);assert.equal(b.workspaceFeatures(id).schedules.length,0);}finally{await b.close();}
});
test("rollback preflights newer task edits before deleting any imported colleague",async t=>{
  const f=fixture(t),host=f.open();try{await host.initialize();const id=host.list().workspaces[0].workspaceId,value=host.workspaceFeatures(id),before=host.snapshot(id).agents.map(row=>row.agentId);
    host.updateFeature(id,"schedule","legacy-0",false,value.revision);await assert.rejects(host.rollbackLegacyInheritance(),/newer file edit|changed/);
    assert.deepEqual(host.snapshot(id).agents.map(row=>row.agentId),before);assert.equal(host.workspaceFeatures(id).schedules.length,3);
  }finally{await host.close();}
});
test("a tampered encrypted backup cannot restart import or gain another Workspace's credentials",async t=>{
  const f=fixture(t),host=f.open();let file;
  try{await host.initialize();const record=host.catalog.resolvePersonalWorkspace(),storage=new WorkspaceResourceStorage(host.home,record.scope);storage.initialize();
    file=storage.run(()=>join(workspaceStateHome(),".hara/workspace-legacy-source-backup-v1.json"));
  }finally{await host.close();}
  const raw=JSON.parse(fs.readFileSync(file));raw.tag="0".repeat(32);fs.writeFileSync(file,JSON.stringify(raw)+"\n");const before=fs.readFileSync(file),b=f.open();
  try{assert.equal((await b.initialize()).state,"pending");assert.deepEqual(fs.readFileSync(file),before);assert.equal(b.list().workspaces.length,1);}finally{await b.close();}
});
test("readonly 0644 legacy sources inherit into an existing personal Workspace without chmod, plaintext keys or duplication",async t=>{
  const f=fixture(t,{roles:17,jobs:99});
  const inventory=root=>fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const path=join(root,entry.name);return entry.isDirectory()?inventory(path):[{path,mode:fs.statSync(path).mode&0o777,hash:hash(fs.readFileSync(path))}];
  });
  for(const row of inventory(f.sourceHome))fs.chmodSync(row.path,0o644);
  const before=inventory(f.sourceHome);
  const seed=new LocalWorkspaceHost(f.root,{mode:"workspace",hostHome:f.root,credentialVault:f.vault,providerFactory:createWorkspaceSyntheticProvider});
  let personalId;try{await seed.initialize();personalId=seed.createWorkspace("My existing personal Workspace",seed.list().revision).workspaceId;}finally{await seed.close();}
  let agentIds;
  const host=f.open();try{
    const state=await host.initialize();assert.equal(state.state,"verified");assert.equal(state.roles,17);assert.equal(state.schedules,99);
    assert.equal(host.list().workspaces.length,1);assert.equal(host.catalog.resolvePersonalWorkspace().scope.workspaceId,personalId);
    const snapshot=host.snapshot(personalId),features=host.workspaceFeatures(personalId);agentIds=snapshot.agents.map(row=>row.agentId);
    assert.equal(snapshot.agents.length,18);assert.equal(features.schedules.length,99);assert.equal(snapshot.connections.connections.length,1);
    assert.equal(features.scheduler.migratedEnabled,false);assert.equal(allText(f.root).includes(SYNTHETIC_CONNECTION.apiKey),false);
    assert.match(allText(f.root),/Use concise Chinese summaries/);
    assert(inventory(f.root).every(row=>row.mode===0o600),"all copied Workspace files must remain private 0600");
    assert.deepEqual(inventory(f.sourceHome),before);
  }finally{await host.close();}
  const reopened=f.open();try{assert.equal((await reopened.initialize()).state,"verified");assert.equal(reopened.list().workspaces.length,1);
    assert.deepEqual(reopened.snapshot(personalId).agents.map(row=>row.agentId),agentIds);assert.equal(reopened.workspaceFeatures(personalId).schedules.length,99);
    assert.equal(reopened.snapshot(personalId).connections.connections.length,1);assert.deepEqual(inventory(f.sourceHome),before);
  }finally{await reopened.close();}
});
test("source symlinks, hardlinks and group/other-writable roles remain rejected without source chmod or partial import",async t=>{
  for(const mode of["link","hardlink",0o664,0o620,0o602,0o666]){const f=fixture(t),path=join(f.sourceHome,".hara/roles/legacy00.md");
    if(mode==="link"){const original=path+".original";fs.renameSync(path,original);fs.symlinkSync(original,path);}
    else if(mode==="hardlink")fs.linkSync(path,path+".other");else fs.chmodSync(path,mode);
    const before=fs.lstatSync(path);
    const host=f.open();try{assert.equal((await host.initialize()).state,"pending");assert.equal(host.snapshot(host.list().workspaces[0].workspaceId).agents.length,1);
      assert.equal(host.snapshot(host.list().workspaces[0].workspaceId).connections.connections.length,0);
      assert.equal(fs.lstatSync(path).mode,before.mode);assert.equal(fs.lstatSync(path).nlink,before.nlink);
    }finally{await host.close();}
  }
});
test("writable legacy config and memory cannot bypass the readonly-source migration boundary",async t=>{
  for(const relative of[".hara/config.json",".hara/profiles.json",".hara/cron/jobs.json",".hara/memory/global/MEMORY.md"]){
    const f=fixture(t);if(relative.endsWith("profiles.json"))f.write(relative,"{}");const path=join(f.sourceHome,relative);fs.chmodSync(path,0o664);
    const before=fs.readFileSync(path),host=f.open();try{assert.equal((await host.initialize()).state,"pending");const id=host.list().workspaces[0].workspaceId;
      assert.equal(host.snapshot(id).agents.length,1);assert.equal(host.snapshot(id).connections.connections.length,0);assert.equal(host.workspaceFeatures(id).schedules.length,0);
      assert.equal(fs.statSync(path).mode&0o777,0o664);assert.deepEqual(fs.readFileSync(path),before);
    }finally{await host.close();}
  }
});
