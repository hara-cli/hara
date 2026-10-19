import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { LegacyConnectionCatalog } from "../dist/workspace/legacy-connections.js";
import { WorkspaceLegacyConnectionImport } from "../dist/workspace/legacy-connection-import.js";
const fakeChat="fake-chat-credential",fakeA="fake-a-credential",fakeDecision="fake-decision-credential";
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-legacy-connections-domain-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=join(root,"source"),home=join(root,"home");fs.mkdirSync(join(source,".hara"),{recursive:true,mode:0o700});fs.mkdirSync(home,{mode:0o700});
 const config={provider:"openai",apiKey:fakeChat,baseURL:"https://chat.example.invalid/v1",model:"chat",decisionApiKey:fakeDecision,decisionBaseURL:"https://judge.example.invalid/v1",decisionModel:"judge"};
 const profiles={active:"a",profiles:[{id:"a",provider:"openai",baseURL:"https://a.example.invalid/v1",apiKey:fakeA,model:"a-model"},{id:"keyless",provider:"anthropic",model:"b-model"}]};
 for(const [file,value]of[["config.json",config],["profiles.json",profiles]]){fs.writeFileSync(join(source,".hara",file),JSON.stringify(value),{mode:0o400});fs.chmodSync(join(source,".hara",file),0o400);}
 const scope={schemaVersion:1,workspaceId:"ws_10000000-0000-4000-8000-000000000001",authority:{kind:"local",localAuthorityId:"20000000-0000-4000-8000-000000000001"}},storage=new WorkspaceResourceStorage(home,scope);storage.initialize();const vault=new MemoryCredentialVault(),catalog=new LegacyConnectionCatalog(source,vault);const open=()=>new WorkspaceLegacyConnectionImport(storage,catalog,vault,"a".repeat(64));
 return{root,source,home,scope,storage,vault,catalog,open,stateRoot:()=>storage.run(()=>join(workspaceStateHome(),".hara"))};
}
test("automatic owner import batches fake keys in vault, preserves active selection and keyless metadata",async t=>{
 const f=fixture(t);let batches=0;const setMany=f.vault.setMany.bind(f.vault);f.vault.setMany=rows=>{batches++;setMany(rows);};const domain=f.open(),r=await domain.apply();
 assert.equal(r.objects,4);assert.equal(batches,1);assert.equal(await domain.verify(r),true);const map=domain.connectionMap(),state=domain.connections.list();
 assert.equal(map.length,4);assert.equal(state.connections.length,4);assert.equal(state.activeConnectionId,map.find(r=>r.legacyId==="a").connectionId);
 const missing=state.connections.find(r=>r.id===map.find(r=>r.legacyId==="keyless").connectionId);assert.equal(missing.credentialRequired,true);assert.equal(missing.keySaved,false);
 for(const file of fs.readdirSync(f.stateRoot()).filter(name=>name.endsWith(".json"))){const text=fs.readFileSync(join(f.stateRoot(),file),"utf8");for(const value of[fakeChat,fakeA,fakeDecision])assert.equal(text.includes(value),false);}
 assert.equal(fs.statSync(join(f.source,".hara/config.json")).mode&0o777,0o400);
});
test("readonly 0644 provider sources import into private 0600 Workspace metadata without source edits",async t=>{
 const f=fixture(t),paths=["config.json","profiles.json"].map(name=>join(f.source,".hara",name));
 for(const path of paths)fs.chmodSync(path,0o644);const before=paths.map(path=>fs.readFileSync(path));
 const domain=f.open(),receipt=await domain.apply();assert.equal(receipt.objects,4);assert.equal(await domain.verify(receipt),true);
 assert.equal(domain.connections.list().connections.length,4);
 for(let i=0;i<paths.length;i++){assert.equal(fs.statSync(paths[i]).mode&0o777,0o644);assert.deepEqual(fs.readFileSync(paths[i]),before[i]);}
 for(const name of fs.readdirSync(f.stateRoot()).filter(name=>name.endsWith(".json"))){const file=join(f.stateRoot(),name);
  assert.equal(fs.statSync(file).mode&0o777,0o600);const value=fs.readFileSync(file,"utf8");for(const key of[fakeChat,fakeA,fakeDecision])assert.equal(value.includes(key),false);}
});
test("provider sources writable by group or others are never accepted as inherited credentials",t=>{
 for(const mode of[0o664,0o620,0o602,0o666]){const f=fixture(t),file=join(f.source,".hara/config.json"),before=fs.readFileSync(file);fs.chmodSync(file,mode);
  assert.equal(f.catalog.inheritanceSeeds().some(row=>row.source===file),false);assert.equal(fs.statSync(file).mode&0o777,mode);assert.deepEqual(fs.readFileSync(file),before);}
});
test("reopen and repeated apply preserve connection IDs and credential generations without another write",async t=>{
 const f=fixture(t),a=f.open(),r=await a.apply(),map=a.connectionMap();const state=a.connections.list();const again=f.open();assert.deepEqual(await again.apply(),r);assert.deepEqual(again.connectionMap(),map);assert.deepEqual(again.connections.list(),state);assert.equal(await again.verify(r),true);
});
test("rollback revokes only owned refs, keeps an existing connection and supports re-upgrade",async t=>{
 const f=fixture(t),domain=f.open(),existing=domain.connections.add({label:"Existing",provider:"openai",baseURL:"https://existing.example.invalid/v1",defaultModel:"existing",apiKey:"fake-existing-key"},0);
 const old=domain.connections.capture(existing.id),oldKey=domain.connections.resolve(old).apiKey;await domain.apply();const owned=domain.connections.inheritanceMetadata().filter(row=>row.id!==existing.id).map(r=>r.keyRef);
 await f.open().rollback();const restored=f.open();assert.equal(restored.connections.list().connections.length,1);assert.equal(restored.connections.resolve(old).apiKey,oldKey);assert.ok(owned.every(ref=>f.vault.get(ref)===undefined));
 await restored.apply();assert.equal(restored.connections.list().connections.length,5);assert.equal(restored.connections.list().defaultConnectionId,existing.id);
});
test("a denied vault batch can be cancelled without another vault write or locking the old store",async t=>{
 const f=fixture(t);let writes=0;f.vault.setMany=()=>{writes++;throw Error("synthetic OS permission denied");};const domain=f.open();await assert.rejects(domain.apply(),/Credential authorization pending/);assert.equal(writes,1);assert.equal(domain.connections.list().migrationPending,true);
 await f.open().rollback();assert.equal(f.open().connections.list().connections.length,0);assert.equal(writes,1);
});
test("cleanup after metadata rollback remains resumable across a fake OS cleanup failure",async t=>{
 const f=fixture(t),domain=f.open();await domain.apply();const remove=f.vault.remove.bind(f.vault);let denied=true;f.vault.remove=ref=>{if(denied)throw Error("synthetic cleanup pending");remove(ref);};
 await assert.rejects(domain.rollback(),/cleanup pending/);assert.equal(f.open().connections.list().connections.length,0);denied=false;await f.open().rollback();
 assert.equal(f.open().connections.list().connections.length,0);
});
test("a user edit after import blocks rollback before metadata or credentials are removed",async t=>{
 const f=fixture(t),domain=f.open();await domain.apply();const a=domain.connections.list().connections.find(r=>r.keySaved);domain.connections.edit(a.id,{...a,label:"User edited",apiKey:""},domain.connections.list().revision);const before=domain.connections.list();
 await assert.rejects(domain.rollback(),/newer file edit/);assert.deepEqual(domain.connections.list(),before);assert.equal(domain.connections.resolve(domain.connections.capture(a.id)).apiKey.length>0,true);
});
test("decision extends an already pending preview without duplicating or replacing its chat connections",async t=>{
 const f=fixture(t),domain=f.open();domain.connections.stageLegacyImport(f.catalog.personalSeeds());const before=domain.connections.inheritanceMetadata();
 await domain.apply();const after=domain.connections.inheritanceMetadata();assert.equal(after.length,4);for(const row of before)assert.equal(after.find(next=>next.id===row.id).keyRef,row.keyRef);
});
test("preexisting user-rotated imported credentials are preserved rather than replaced from the old source",async t=>{
 const f=fixture(t),domain=f.open(),seed=f.catalog.personalSeeds().find(r=>r.legacyId===undefined); // Public previews intentionally omit private legacy IDs.
 const resolved=f.catalog.resolve(seed.id),existing=domain.connections.importConnection({...resolved.input,apiKey:"fake-user-rotated"},0,resolved.importId);
 const r=await domain.apply();assert.equal(await domain.verify(r),true);assert.equal(domain.connections.resolve(domain.connections.capture(existing.id)).apiKey,"fake-user-rotated");
});
