import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID,createHash } from "node:crypto";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION,createWorkspaceSyntheticProvider } from "../dist/workspace/synthetic-provider.js";
import { WorkspaceLegacyBusiness } from "../dist/workspace/legacy-business.js";
import { WorkspaceResourceStorage,workspaceStateHome } from "../dist/workspace/resource-context.js";
const hash=v=>createHash("sha256").update(v).digest("hex");
function fixture(t,{roles=2,jobs=3,vault=new MemoryCredentialVault(),businessFactory}={}){
  const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-auto-legacy-")));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=join(base,"target"),sourceHome=join(base,"source");for(const path of[root,sourceHome])fs.mkdirSync(path,{mode:0o700});
  const write=(rel,content)=>{const path=join(sourceHome,rel);fs.mkdirSync(join(path,".."),{recursive:true,mode:0o700});fs.writeFileSync(path,content,{mode:0o600});return path;};
  write(".hara/config.json",JSON.stringify(SYNTHETIC_CONNECTION));
  for(let i=0;i<roles;i++)write(`.hara/roles/legacy${String(i).padStart(2,"0")}.md`,`---\nname: legacy${String(i).padStart(2,"0")}\ndisplayName: Legacy ${i}\ndescription: Fixture colleague\n---\nUse source evidence and verify file work.\n`);
  write(".hara/memory/global/MEMORY.md","Use concise Chinese summaries.\n");
  write(".hara/skills/source-evidence/SKILL.md","---\nname: source-evidence\ndescription: Verify source evidence\n---\nRead before acting.\n");
  const tasks=Array.from({length:jobs},(_,i)=>({id:`legacy-${i}`,name:`Legacy task ${i}`,enabled:i%3!==2,mode:i===1?"print":"command",
    cwd:join(sourceHome,"project"),task:i===1?"生成 hello.md 並驗證":"printf authored-fixture-only",createdAt:0,schedule:{kind:"every",everyMs:60000,display:"every minute"}}));
  const jobsFile=write(".hara/cron/jobs.json",JSON.stringify(tasks));
  const options={mode:"workspace",hostHome:root,legacySourceHome:sourceHome,credentialVault:vault,providerFactory:createWorkspaceSyntheticProvider,
    ...(businessFactory?{legacyBusinessFactory:businessFactory}:{})};
  return{base,root,sourceHome,tasks,jobsFile,vault,write,open:()=>new LocalWorkspaceHost(root,options)};
}
function allText(root){let text="";for(const entry of fs.readdirSync(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())text+=allText(path);else if(entry.isFile())text+=fs.readFileSync(path,"utf8");}return text;}
test("formal Host automatically inherits 17 colleagues and 99 tasks, dependencies and encrypted backup before readiness",async t=>{
  const f=fixture(t,{roles:17,jobs:99}),before=hash(fs.readFileSync(f.jobsFile)),host=f.open();
  try{
    const state=await host.initialize();assert.equal(state.state,"verified");assert.equal(state.roles,17);assert.equal(state.schedules,99);assert.equal(state.handoff,false);
    const w=host.list().workspaces[0],snapshot=host.snapshot(w.workspaceId),features=host.workspaceFeatures(w.workspaceId);
    assert.equal(snapshot.agents.length,18);assert.equal(snapshot.agents.filter(row=>row.kind==="colleague"&&row.state==="active").length,10);
    assert.equal(snapshot.agents.filter(row=>row.state==="archived").length,7);assert.equal(features.schedules.length,99);assert.equal(features.skills.length,1);
    assert.equal(snapshot.connections.connections.length,1);assert.equal(features.scheduler.migratedEnabled,false);assert.equal(features.scheduler.runs.length,0);
    const bytes=allText(f.root);assert.equal(bytes.includes(SYNTHETIC_CONNECTION.apiKey),false);assert.match(bytes,/ciphertext/);assert.match(bytes,/Use concise Chinese/);
    await host.tickSchedules(180000);assert.equal(host.workspaceFeatures(w.workspaceId).scheduler.runs.length,0);
    assert.equal(hash(fs.readFileSync(f.jobsFile)),before);
  }finally{await host.close();}
});
test("cold Host reopen uses frozen encrypted source, does not duplicate, and does not overwrite later source or target edits",async t=>{
  const f=fixture(t),a=f.open();let id,roster;
  try{await a.initialize();id=a.list().workspaces[0].workspaceId;roster=a.snapshot(id).agents.map(row=>row.agentId);
    const value=a.workspaceFeatures(id);a.updateFeature(id,"schedule","legacy-0",false,value.revision);
  }finally{await a.close();}
  f.write(".hara/roles/later.md","---\nname: later\n---\nDo not silently import a later colleague.\n");
  const b=f.open();try{assert.equal((await b.initialize()).state,"verified");assert.deepEqual(b.snapshot(id).agents.map(row=>row.agentId),roster);
    assert.equal(b.workspaceFeatures(id).schedules.find(row=>row.id==="legacy-0").enabled,false);
  }finally{await b.close();}
});
test("an inherited Pi colleague performs an actual synthetic file task and remains isolated from another Workspace",async t=>{
  const f=fixture(t),host=f.open();try{
    await host.initialize();const id=host.list().workspaces[0].workspaceId,a=host.snapshot(id).agents.find(row=>row.kind==="colleague"&&row.state==="active");
    const accepted=host.start("test",id,a.agentId,"生成 hello.md 並驗證",randomUUID());await host.wait(accepted.runId);
    assert.equal(host.snapshot(id,a.agentId).conversation.taskState,"completed");assert.equal(fs.readFileSync(join(f.root,"project",id,"hello.md"),"utf8"),"hello workspace\n");
    const other=host.createWorkspace("Other",host.list().revision);assert.equal(other.agents.length,1);assert.equal(other.connections.connections.length,0);
    assert.equal(host.workspaceFeatures(other.workspaceId).schedules.length,0);assert.equal(host.workspaceFeatures(other.workspaceId).skills.length,0);
  }finally{await host.close();}
});
test("denied Vault stays pending without plaintext backup, paid request or partial Agent import",async t=>{
  const vault={get(){throw Error("fixture denied");},set(){assert.fail("not reached");},remove(){assert.fail("not reached");}},f=fixture(t,{vault}),host=f.open();
  try{const value=await host.initialize();assert.equal(value.state,"pending");const id=host.list().workspaces[0].workspaceId;
    assert.equal(host.snapshot(id).agents.length,1);assert.equal(host.snapshot(id).connections.connections.length,0);assert.equal(allText(f.root).includes(SYNTHETIC_CONNECTION.apiKey),false);
    assert.equal(host.workspaceFeatures(id).scheduler.migratedEnabled,false);
  }finally{await host.close();}
});
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
test("readonly source symlinks and public role files are rejected without chmod or target role effects",async t=>{
  for(const mode of["link","public"]){const f=fixture(t),path=join(f.sourceHome,".hara/roles/legacy00.md");
    if(mode==="link"){const original=path+".original";fs.renameSync(path,original);fs.symlinkSync(original,path);}else fs.chmodSync(path,0o644);
    const host=f.open();try{assert.equal((await host.initialize()).state,"pending");assert.equal(host.snapshot(host.list().workspaces[0].workspaceId).agents.length,1);
      assert.equal(mode==="link"?fs.lstatSync(path).isSymbolicLink():fs.statSync(path).mode&0o777,mode==="link"?true:0o644);
    }finally{await host.close();}
  }
});
test("synthetic Lab never automatically reads an explicit old source and does not create a personal Workspace",async t=>{
  const f=fixture(t),host=new LocalWorkspaceHost(f.root,{legacySourceHome:f.sourceHome,credentialVault:f.vault});
  try{assert.equal((await host.initialize()).state,"not_needed");assert.equal(host.list().workspaces.length,0);}finally{await host.close();}
});
test("a fresh formal Host with only its own root marker never mistakes that marker for old user data",async t=>{
  const f=fixture(t),host=new LocalWorkspaceHost(f.root,{mode:"workspace",hostHome:f.root,credentialVault:f.vault});
  try{assert.equal((await host.initialize()).state,"not_needed");assert.equal(host.list().workspaces.length,0);}finally{await host.close();}
});
test("a data Home containing old files is still not consent to auto-import without an explicit source",async t=>{
  const f=fixture(t),host=new LocalWorkspaceHost(f.root,{mode:"workspace",hostHome:f.sourceHome,credentialVault:f.vault});
  try{assert.equal((await host.initialize()).state,"not_needed");assert.equal(host.list().workspaces.length,0);}finally{await host.close();}
});
test("Host scheduler routes approved fixture command occurrences into scoped business/outcome handlers only after its gate",async t=>{
  let calls=0;
  const f=fixture(t,{businessFactory:({storage,features,resources})=>new WorkspaceLegacyBusiness(storage,features,resources,{
    commands:{authorize(review){return{resourceBinding:review.resourceBinding,definitionHash:review.definitionHash,resourceId:review.resourceId,cwd:f.base,isolatedHome:f.root,searchPath:"/usr/bin:/bin",assertCurrent(){}};},
      async launch(inv){calls++;assert.equal(inv.command,"printf authored-fixture-only");inv.onOutput("stdout","fixture\n");return{code:0,terminated:true};}},notifications:{authorize(){assert.fail("no target, no transport");}}})});
  const host=f.open();try{await host.initialize();const id=host.list().workspaces[0].workspaceId;
    await host.tickSchedules(120000);assert.equal(calls,0);
    // White-box owner fixture ONLY. No RPC/automatic production cutover was added.
    host.contexts.get(id).scheduler.configure(true,true);await host.tickSchedules(120000);
    assert.equal(calls,1);const result=host.workspaceFeatures(id);assert.equal(result.scheduler.runs.find(row=>row.scheduleId==="legacy-0").state,"completed");
    assert.equal(result.legacyOutcomes.outcomes.length,2);await host.tickSchedules(120001);assert.equal(calls,1);
  }finally{await host.close();}
});
