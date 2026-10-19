import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceLegacyCoordinator, LEGACY_DOMAINS, LEGACY_AGENT_SCHEDULE_DOMAINS } from "../dist/workspace/legacy-coordinator.js";
const binding={sourceFingerprint:"a".repeat(64),planHash:"b".repeat(64),backupHash:"c".repeat(64)};
function fixture(t){const home=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-inheritance-journal-")));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const catalog=new LocalWorkspaceCatalog(home),row=catalog.create("Personal",1),storage=new WorkspaceResourceStorage(home,row.scope);storage.initialize();let source={...binding};const values=new Map(),counts=new Map();const adapters=LEGACY_DOMAINS.map(id=>({id,async apply(){if(!values.has(id)){values.set(id,id);counts.set(id,(counts.get(id)??0)+1);}return{hash:"d".repeat(64),objects:1};},async verify(){return values.get(id)===id;},async preflightRollback(){if(values.has(id)&&values.get(id)!==id)throw Error("newer edit preserved");},async rollback(){values.delete(id);}}));const make=()=>new WorkspaceLegacyCoordinator(storage,catalog,()=>source,adapters);return{home,catalog,row,storage,values,counts,adapters,make,setSource(value){source=value;}};}
test("personal home marker persists across rename/foreground switches and cannot be revoked",t=>{const f=fixture(t),a=f.catalog.resolvePersonalWorkspace(),b=f.catalog.create("Personal",f.catalog.read().revision);f.catalog.select(b.scope.workspaceId,f.catalog.read().revision);assert.equal(new LocalWorkspaceCatalog(f.home).resolvePersonalWorkspace().scope.workspaceId,a.scope.workspaceId);assert.throws(()=>f.catalog.revoke(a.scope.workspaceId,f.catalog.read().revision),/cannot be revoked/);assert.equal(f.catalog.resolve(b.scope.workspaceId).personal,undefined);});
test("missing/revoked bootstrap never silently imports into the next active Workspace",t=>{const f=fixture(t);f.catalog.create("Other",f.catalog.read().revision);f.catalog.revoke(f.row.scope.workspaceId,f.catalog.read().revision);assert.throws(()=>f.catalog.resolvePersonalWorkspace(),/missing or revoked/);assert.throws(()=>f.make().prepare(),/unique personal/);});
test("a foreign Workspace cannot claim the legacy personal target",t=>{const f=fixture(t),b=f.catalog.create("Other",f.catalog.read().revision),storage=new WorkspaceResourceStorage(f.home,b.scope);storage.initialize();const c=new WorkspaceLegacyCoordinator(storage,f.catalog,()=>binding,f.adapters);assert.throws(()=>c.prepare(),/unique personal/);assert.equal(c.read().phase,"empty");});
test("restart resumes receipt states and repeat apply/verify never duplicates a domain",async t=>{const f=fixture(t);assert.equal(f.make().prepare().phase,"dry_run");assert.equal((await f.make().apply()).phase,"applied");assert.equal((await f.make().verify()).phase,"verified");await f.make().apply();assert.equal(f.counts.size,8);assert.ok([...f.counts.values()].every(n=>n===1));});
test("partial domain effects survive a crash intent and retry uses importer idempotence",async t=>{const f=fixture(t),original=f.adapters[2].apply;let once=true;f.adapters[2].apply=async()=>{const r=await original();if(once){once=false;throw Error("fixture-only crash");}return r;};await assert.rejects(f.make().apply(),/roles import incomplete/);assert.equal(f.make().read().domains.find(r=>r.id==="roles").state,"applying");await f.make().apply();assert.equal(f.counts.get("roles"),1);assert.equal((await f.make().verify()).phase,"verified");});
test("changed source/backup/reviewed plan stops before another mutation",async t=>{for(const field of Object.keys(binding)){const f=fixture(t),c=f.make();c.prepare();const before=c.read();f.setSource({...binding,[field]:"e".repeat(64)});await assert.rejects(c.apply(),/source or reviewed plan changed/);assert.deepEqual(c.read(),before);assert.equal(f.values.size,0);}});
test("upgrade → rollback → re-upgrade uses same home and no duplicate imported objects",async t=>{const f=fixture(t),personal=f.catalog.resolvePersonalWorkspace().scope.workspaceId;await f.make().apply();await f.make().verify();assert.equal((await f.make().rollback()).phase,"rolled_back");assert.equal(f.values.size,0);await f.make().apply();assert.equal((await f.make().verify()).round,2);assert.equal(f.values.size,8);assert.equal(f.catalog.resolvePersonalWorkspace().scope.workspaceId,personal);});
test("all rollback conflicts are checked before any deletion",async t=>{const f=fixture(t);await f.make().apply();f.values.set("connections","new user edit");const before=new Map(f.values);await assert.rejects(f.make().rollback(),/newer edit/);assert.deepEqual(f.values,before);assert.equal(f.make().read().phase,"applied");});
test("a failed functional verifier cannot turn a classified/imported copy into a handoff",async t=>{const f=fixture(t);await f.make().apply();f.adapters[0].verify=async()=>false;await assert.rejects(f.make().verify(),/connections verification failed/);assert.notEqual(f.make().read().phase,"verified");});
test("independent coordinator instances cannot apply and rollback concurrently",async t=>{const f=fixture(t),old=f.adapters[0].apply;let entered,release;const ready=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);f.adapters[0].apply=async()=>{entered();await held;return old();};const first=f.make().apply();await ready;await assert.rejects(f.make().apply(),/busy or owner death/);await assert.rejects(f.make().rollback(),/busy or owner death/);release();await first;assert.equal(f.counts.get("connections"),1);});

const minimal = f => new WorkspaceLegacyCoordinator(f.storage,f.catalog,()=>binding,
  f.adapters.filter(row=>LEGACY_AGENT_SCHEDULE_DOMAINS.includes(row.id)),{profile:"agents-and-schedules-v1"});
test("reviewed Agent/schedule profile imports every required dependency without optional fake receipts",async t=>{
  const f=fixture(t);await minimal(f).apply();const verified=await minimal(f).verify();
  assert.equal(verified.profile,"agents-and-schedules-v1");assert.equal(verified.phase,"verified");
  assert.deepEqual(verified.domains.map(row=>row.id),[...LEGACY_AGENT_SCHEDULE_DOMAINS]);
  assert.equal(f.counts.size,6);assert.equal(f.values.has("settings"),false);assert.equal(f.values.has("history"),false);
  await minimal(f).apply();assert.ok([...f.counts.values()].every(n=>n===1));
});
test("minimal profile survives a partial write and rollback/re-upgrade without touching deferred domains",async t=>{
  const f=fixture(t),original=f.adapters.find(row=>row.id==="skills").apply;let first=true;
  f.adapters.find(row=>row.id==="skills").apply=async()=>{const result=await original();if(first){first=false;throw Error("fixture crash");}return result;};
  await assert.rejects(minimal(f).apply(),/skills import incomplete/);await minimal(f).apply();await minimal(f).verify();
  assert.equal(f.counts.get("skills"),1);await minimal(f).rollback();assert.equal(f.values.size,0);
  await minimal(f).apply();assert.equal((await minimal(f).verify()).round,2);assert.equal(f.values.size,6);
});
test("an existing full or minimal journal cannot shrink/expand its required plan even after rollback",async t=>{
  for(const profile of["full-v1","agents-and-schedules-v1"]){
    const f=fixture(t),open=profile==="full-v1"?f.make:()=>minimal(f),other=profile==="full-v1"?()=>minimal(f):f.make;
    open().prepare();const before=open().read();assert.throws(()=>other().read(),/profile changed/);
    await assert.rejects(other().apply(),/profile changed/);assert.deepEqual(open().read(),before);
    await open().apply();await open().verify();await open().rollback();assert.throws(()=>other().prepare(),/profile changed/);
  }
});
test("minimal profile cannot omit cwd/skills/connections or accept optional/duplicate adapters",t=>{
  const f=fixture(t),required=f.adapters.filter(row=>LEGACY_AGENT_SCHEDULE_DOMAINS.includes(row.id));
  for(const id of LEGACY_AGENT_SCHEDULE_DOMAINS)assert.throws(()=>new WorkspaceLegacyCoordinator(f.storage,f.catalog,()=>binding,required.filter(row=>row.id!==id),{profile:"agents-and-schedules-v1"}),/required legacy domain/);
  for(const rows of[[...required,f.adapters.find(row=>row.id==="history")],[...required.slice(0,-1),required[0]]])assert.throws(()=>new WorkspaceLegacyCoordinator(f.storage,f.catalog,()=>binding,rows,{profile:"agents-and-schedules-v1"}),/required legacy domain/);
  assert.throws(()=>new WorkspaceLegacyCoordinator(f.storage,f.catalog,()=>binding,required,{profile:"unknown"}),/reviewed inheritance profile/);
});
test("old journals without a profile retain the full eight-domain contract and original bytes on read",async t=>{
  const f=fixture(t);await f.make().apply();await f.make().verify();
  const file=f.storage.run(()=>join(workspaceStateHome(),".hara","workspace-legacy-inheritance-v1.json"));
  const raw=JSON.parse(fs.readFileSync(file,"utf8"));delete raw.profile;fs.writeFileSync(file,JSON.stringify(raw)+"\n");
  const before=fs.readFileSync(file);assert.equal(f.make().read().phase,"verified");assert.equal(f.make().read().domains.length,8);
  assert.throws(()=>minimal(f).read(),/profile changed/);assert.deepEqual(fs.readFileSync(file),before);
});
test("a forged verified marker cannot omit a mandatory domain even in the narrowed profile",async t=>{
  const f=fixture(t);await minimal(f).apply();await minimal(f).verify();
  const file=f.storage.run(()=>join(workspaceStateHome(),".hara","workspace-legacy-inheritance-v1.json"));
  const raw=JSON.parse(fs.readFileSync(file,"utf8"));raw.domains=raw.domains.filter(row=>row.id!=="skills");
  fs.writeFileSync(file,JSON.stringify(raw)+"\n");const before=fs.readFileSync(file);
  await assert.rejects(minimal(f).apply(),/domains are incomplete/);assert.deepEqual(fs.readFileSync(file),before);
});
