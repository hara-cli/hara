import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { SYNTHETIC_CONNECTION } from "../dist/workspace/synthetic-provider.js";
import { WorkspaceLegacyBusiness } from "../dist/workspace/legacy-business.js";
import { allText, fixture, hash } from "./helpers/legacy-startup-fixture.mjs";
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
test("denied Vault stays pending without plaintext backup, paid request or partial Agent import",async t=>{
  const vault={get(){throw Error("fixture denied");},set(){assert.fail("not reached");},remove(){assert.fail("not reached");}},f=fixture(t,{vault}),host=f.open();
  try{const value=await host.initialize();assert.equal(value.state,"pending");const id=host.list().workspaces[0].workspaceId;
    assert.equal(host.snapshot(id).agents.length,1);assert.equal(host.snapshot(id).connections.connections.length,0);assert.equal(allText(f.root).includes(SYNTHETIC_CONNECTION.apiKey),false);
    assert.equal(host.workspaceFeatures(id).scheduler.migratedEnabled,false);
  }finally{await host.close();}
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
