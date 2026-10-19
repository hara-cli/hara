import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceResources } from "../dist/workspace/resources.js";
import { WorkspaceFeatures } from "../dist/workspace/features.js";
import { WorkspaceScheduler } from "../dist/workspace/scheduler.js";
import { WorkspaceLegacyResources,planLegacyResources } from "../dist/workspace/legacy-resources.js";
import { buildLegacyInheritancePlan } from "../dist/workspace/legacy-plan.js";
import { legacyScheduleRows,legacySchedulesDomain } from "../dist/workspace/legacy-schedules.js";
function fixture(t){const home=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-legacy-schedules-")));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const scope={schemaVersion:1,workspaceId:"ws_10000000-0000-4000-8000-000000000001",authority:{kind:"local",localAuthorityId:"20000000-0000-4000-8000-000000000001"}},storage=new WorkspaceResourceStorage(home,scope);storage.initialize();const resources=new WorkspaceResources(home,scope);resources.initialize();const main=resources.agents.initializeMain();const features=new WorkspaceFeatures(storage,home,scope.workspaceId),folders=new WorkspaceLegacyResources(storage);return{home,scope,storage,main,features,folders};}
const job=(id,extra={})=>({id,name:id,task:"printf fixture",mode:"command",cwd:"/legacy/project",createdAt:0,enabled:true,schedule:{kind:"cron",expr:"* * * * *"},...extra});
async function stage(f,jobs){const input={sourceFingerprint:"a".repeat(64),now:120000,jobs,roles:[],sessions:[],flows:[],profiles:{},config:{}};const plan=buildLegacyInheritancePlan(input);await f.folders.domain(input.sourceFingerprint,planLegacyResources({jobs,projects:[],legacyWorkspacePath:"/legacy/workspace"})).apply();const rows=legacyScheduleRows({jobs,plan:plan.tasks,sourceFingerprint:input.sourceFingerprint,workspaceId:f.scope.workspaceId,mainAgentId:f.main.agentId,resources:f.folders});return{rows,plan,input,domain:()=>legacySchedulesDomain(f.storage,f.features,input.sourceFingerprint,rows)};}
test("mixed command/print staging preserves mode, timezone, errors and structured delivery without starting work",async t=>{const f=fixture(t),jobs=[job("command",{tz:"",alertAfter:5,consecutiveErrors:4,deliver:"feishu:fixture"}),job("print",{mode:"print",task:"Fixture analysis",tz:"Asia/Taipei"})],s=await stage(f,jobs);await s.domain().apply();assert.equal(f.features.schedules().length,2);const a=f.features.schedules()[0];assert.equal(a.definition.mode,"command");assert.equal(a.definition.tz,"Asia/Shanghai");assert.equal(a.definition.consecutiveErrors,4);assert.equal(a.definition.alertAfter,5);assert.equal(a.definition.deliver,"feishu:fixture");let calls=0;const scheduler=new WorkspaceScheduler(f.storage,f.features,{available:()=>true,async execute(){calls++;assert.fail("staged work must not run");}});await scheduler.tick(f.main.agentId,120000);assert.equal(calls,0);assert(scheduler.list().schedules.every(row=>row.awaitingHandoff));});
test("expired once is retained disabled; unsafe source retains metadata without its command/body",async t=>{const f=fixture(t),jobs=[job("expired",{schedule:{kind:"once",runAt:100,display:"old once"}}),job("unsafe",{enabled:false,task:"command --api-key fake-never-copy"})],s=await stage(f,jobs);await s.domain().apply();const [expired,unsafe]=f.features.schedules();assert.equal(expired.enabled,false);assert.equal(unsafe.enabled,false);assert.equal(unsafe.definition.legacy.quarantined,true);assert.equal(JSON.stringify(unsafe).includes("fake-never-copy"),false);assert.equal(unsafe.definition.task,"");});
test("all row IDs and flags survive repeat/reopen/rollback/re-upgrade without duplicate jobs",async t=>{const f=fixture(t),s=await stage(f,Array.from({length:99},(_,i)=>job("job-"+i,{enabled:i<66}))),r=await s.domain().apply();assert.equal(f.features.schedules().filter(row=>row.enabled).length,66);assert.deepEqual(await s.domain().apply(),r);const reopen=new WorkspaceFeatures(f.storage,f.home,f.scope.workspaceId);assert.equal(reopen.schedules().length,99);await s.domain().rollback();assert.equal(reopen.schedules().length,0);await s.domain().apply();assert.equal(reopen.schedules().length,99);});
test("a newer toggle prevents rollback from silently restoring earlier enabled flags",async t=>{const f=fixture(t),s=await stage(f,[job("one")]);await s.domain().apply();f.features.setScheduleEnabled("one",false,f.features.list().revision);await assert.rejects(s.domain().rollback(),/newer file edit/);assert.equal(f.features.schedules()[0].enabled,false);});
test("changed dry-run source and absent cwd bindings fail before a schedule is written",async t=>{const f=fixture(t),s=await stage(f,[job("one")]);const args={...s.input,plan:s.plan.tasks,workspaceId:f.scope.workspaceId,mainAgentId:f.main.agentId,resources:f.folders};assert.throws(()=>legacyScheduleRows({...args,jobs:[job("one",{task:"changed"})]}),/changed/);const empty=new WorkspaceResourceStorage(f.home,{...f.scope,workspaceId:"ws_10000000-0000-4000-8000-000000000002"});empty.initialize();assert.throws(()=>legacyScheduleRows({...args,resources:new WorkspaceLegacyResources(empty)}),/not registered/);assert.equal(f.features.schedules().length,0);});
test("a modified review cannot re-enable a disabled source or silently change its timezone",async t=>{const f=fixture(t),s=await stage(f,[job("off",{enabled:false})]),args={...s.input,plan:s.plan.tasks,workspaceId:f.scope.workspaceId,mainAgentId:f.main.agentId,resources:f.folders};for(const patch of[{importEnabled:true},{originalEnabled:true},{timezone:"Asia/Tokyo"}])assert.throws(()=>legacyScheduleRows({...args,plan:s.plan.tasks.map(row=>({...row,...patch}))}),/changed/);});
test("an unknown old delivery noise policy is quarantined rather than defaulted to always-send",async t=>{const f=fixture(t),s=await stage(f,[job("unknown-policy",{deliver:"feishu:fixture",deliverMode:"unsupported"})]);assert.equal(s.rows[0].definition.legacy.quarantined,true);assert.equal(s.rows[0].enabled,false);assert.equal(s.rows[0].definition.deliver,undefined);});
test("a repeated migration ID cannot conceal a changed definition or partially append a batch",async t=>{
  const f=fixture(t),s=await stage(f,[job("one"),job("two")]);
  f.features.importLegacy([s.rows[0]]);const before=f.features.schedules();
  for(const change of [{definition:{...s.rows[0].definition,task:"changed fixture"}},
    {name:"changed name"},{id:"another-id"},{source:"different-source"},
    {schedule:{kind:"cron",expr:"0 * * * *"}}]){
    assert.throws(()=>f.features.importLegacy([s.rows[1],{...s.rows[0],...change}]),/source changed|edited/);
    assert.deepEqual(f.features.schedules(),before);
  }
});
test("duplicate migration identities are rejected even when every row was already imported",async t=>{
  const f=fixture(t),s=await stage(f,[job("one"),job("two")]);f.features.importLegacy(s.rows);const before=f.features.schedules();
  assert.throws(()=>f.features.importLegacy([s.rows[0],s.rows[0]]),/Duplicate/);
  assert.throws(()=>f.features.importLegacy([s.rows[0],{...s.rows[1],migrationId:s.rows[0].migrationId}]),/Duplicate/);
  assert.deepEqual(f.features.schedules(),before);
});
test("an unchanged source replay preserves a user's newer enabled choice",async t=>{
  const f=fixture(t),s=await stage(f,[job("one")]);f.features.importLegacy(s.rows);
  f.features.setScheduleEnabled("one",false,f.features.list().revision);
  assert.equal(f.features.importLegacy(s.rows),0);assert.equal(f.features.schedules()[0].enabled,false);
});
