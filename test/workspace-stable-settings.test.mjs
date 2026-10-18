import {test,after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
import {WorkspaceResourceStorage,workspaceStateHome} from "../dist/workspace/resource-context.js";
import {WorkspaceConnectionStoreV2} from "../dist/workspace/scoped-connections.js";
import {WorkspaceSecureConnections} from "../dist/workspace/secure-connections.js";
import {MemoryCredentialVault,MacKeychainCredentialVault,WORKSPACE_CREDENTIAL_SERVICE} from "../dist/workspace/credential-vault.js";
import {WorkspacePreferences,readLegacyTheme} from "../dist/workspace/preferences.js";
import {LegacyConnectionCatalog} from "../dist/workspace/legacy-connections.js";
import {WorkspaceFeatures,migrateLegacyScheduleFixture} from "../dist/workspace/features.js";
const roots=[];function dir(){const p=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-stable-test-")));roots.push(p);return p;}after(()=>roots.forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
function resource(home=dir()){const value=new WorkspaceResourceStorage(home,{schemaVersion:1,workspaceId:`ws_${randomUUID()}`,authority:{kind:"local",localAuthorityId:randomUUID()}});value.initialize();return value;}
const fakeKey="fixture-private-model-key", input=(label="Mock")=>({label,provider:"openai",baseURL:"https://example.invalid/v1",defaultModel:"fixture-model",apiKey:fakeKey});
const file=(s,name="workspace-connections-v2.json")=>s.run(()=>join(workspaceStateHome(),".hara",name));
test("multi-connection add/select/edit-blank/delete fallbacks use scoped Keychain refs, never plaintext JSON/DTO",()=>{
 const storage=resource(),vault=new MemoryCredentialVault(),store=new WorkspaceSecureConnections(storage,vault);
 const a=store.add(input("A"),0),b=store.add(input("B"),1);assert.equal(store.list().defaultConnectionId,a.id);const old=store.capture();
 store.select(b.id,2);assert.equal(store.capture().connectionId,b.id);assert.doesNotThrow(()=>store.resolve(old));
 store.edit(b.id,{...input("B edited"),apiKey:""},3);assert.equal(store.resolve(store.capture()).apiKey,fakeKey);
 const before=JSON.parse(fs.readFileSync(file(storage))),ref=before.connections.find(r=>r.id===b.id).keyRef;
 store.revoke(b.id,store.list().revision);assert.equal(store.list().defaultConnectionId,a.id);assert.equal(vault.get(ref),undefined);
 store.revoke(a.id,store.list().revision);assert.equal(store.list().defaultConnectionId,null);assert.throws(()=>store.resolve(old));
 for(const p of [file(storage),file(storage,"workspace-connections-v2-backup.json")])assert(!fs.readFileSync(p,"utf8").includes(fakeKey));
 assert(!JSON.stringify(store.list()).includes(fakeKey));assert(!JSON.stringify(store.list()).includes("keyRef"));
});
test("same-space v1→v2→v3 migration backs up recoverable keyRef metadata and is idempotent",()=>{
 const storage=resource(),legacy=new WorkspaceConnectionStoreV2(storage),row=legacy.add(input(),0);const raw=JSON.parse(fs.readFileSync(file(storage)));raw.schemaVersion=1;fs.writeFileSync(file(storage),JSON.stringify(raw));
 const vault=new MemoryCredentialVault(),store=new WorkspaceSecureConnections(storage,vault);assert.equal(store.list().connections[0].id,row.id);
 const migrated=fs.readFileSync(file(storage),"utf8"),backup=fs.readFileSync(file(storage,"workspace-connections-v2-backup.json"),"utf8");assert(!migrated.includes(fakeKey));assert(!backup.includes(fakeKey));
 assert.equal(JSON.parse(migrated).schemaVersion,3);assert.equal(store.resolve(store.capture()).apiKey,fakeKey);store.list();assert.equal(fs.readFileSync(file(storage),"utf8"),migrated);
});
test("unknown higher connection schema is read-only and cannot overwrite its original bytes",()=>{
 const storage=resource(),store=new WorkspaceSecureConnections(storage,new MemoryCredentialVault());store.add(input(),0);
 const raw=JSON.parse(fs.readFileSync(file(storage)));raw.schemaVersion=99;raw.futureField="keep";const text=JSON.stringify(raw);fs.writeFileSync(file(storage),text);
 assert.equal(store.list().readOnly,true);assert.throws(()=>store.select(store.list().connections[0].id,1));assert.equal(fs.readFileSync(file(storage),"utf8"),text);
});
test("corrupt connection file recovers last committed backup read-only, with a usable credential",()=>{
 const storage=resource(),store=new WorkspaceSecureConnections(storage,new MemoryCredentialVault());store.add(input(),0);fs.writeFileSync(file(storage),"{");
 assert.equal(store.list().recovered,true);assert.equal(store.resolve(store.capture()).apiKey,fakeKey);assert.throws(()=>store.add(input(),1));assert.equal(fs.readFileSync(file(storage),"utf8"),"{");
});
test("legacy import is confirmation-ready metadata only, repeated import idempotent, broken sources ignored",()=>{
 const home=dir();fs.mkdirSync(join(home,".hara"),{mode:0o700});fs.writeFileSync(join(home,".hara/config.json"),JSON.stringify({...input("Old"),model:"fixture-model"}),{mode:0o600});
 const vault=new MemoryCredentialVault(),catalog=new LegacyConnectionCatalog(home,vault),preview=catalog.list();assert.equal(preview.length,1);assert(!JSON.stringify(preview).includes(fakeKey));
 const storage=resource(),store=new WorkspaceSecureConnections(storage,vault),resolved=catalog.resolve(preview[0].id);store.importConnection(resolved.input,0,resolved.importId);store.importConnection(resolved.input,1,resolved.importId);
 assert.equal(store.list().connections.length,1);fs.writeFileSync(join(home,".hara/config.json"),"broken");assert.deepEqual(catalog.list(),[]);assert.throws(()=>catalog.resolve(preview[0].id));
});
test("Keychain secret is stdin-only, fixed service, and diagnostics never surface credential values",()=>{
 const calls=[];const execute=(command,args,opts)=>{calls.push({args,input:opts.input});return args[0]==="find-generic-password"?{status:0,stdout:fakeKey+"\n"}:{status:0,stdout:"",stderr:fakeKey};};
 const vault=new MacKeychainCredentialVault(dir(),execute);vault.set("scope:connection:generation",fakeKey);assert.equal(vault.get("scope:connection:generation"),fakeKey);vault.remove("scope:connection:generation");
 assert(calls.every(c=>!c.args.join(" ").includes(fakeKey)));assert(calls.some(c=>c.input?.includes(WORKSPACE_CREDENTIAL_SERVICE)));
 const bad=new MacKeychainCredentialVault(dir(),()=>({status:1,stderr:fakeKey}));assert.throws(()=>bad.get("safe"),error=>!error.message.includes(fakeKey));
 const thrown=new MacKeychainCredentialVault(dir(),()=>{throw new Error(fakeKey);});assert.throws(()=>thrown.set("safe",fakeKey),error=>!error.message.includes(fakeKey));
});
test("denied old-Key cleanup is persisted, revoked immediately and explicitly retryable after restart",()=>{
 const storage=resource(),memory=new MemoryCredentialVault();let deny=true;
 const vault={get:ref=>memory.get(ref),set:(ref,key)=>memory.set(ref,key),remove(ref){if(deny)throw new Error("fixture Keychain denied");memory.remove(ref);}};
 const store=new WorkspaceSecureConnections(storage,vault),row=store.add(input(),0),binding=store.capture();
 assert.throws(()=>store.edit(row.id,{...input(),apiKey:""},1),/denied/);assert.throws(()=>store.resolve(binding),/generation unavailable/);
 const resumed=new WorkspaceSecureConnections(storage,vault);assert.equal(resumed.list().connections[0].cleanupPending,true);
 deny=false;resumed.cleanupCredentials(row.id,resumed.list().revision);assert.equal(resumed.list().connections[0].cleanupPending,false);assert.equal(resumed.resolve(resumed.capture()).apiKey,fakeKey);
 deny=true;assert.throws(()=>resumed.revoke(row.id,resumed.list().revision),/denied/);assert.throws(()=>resumed.capture());assert.equal(resumed.list().connections[0].cleanupPending,true);
 deny=false;resumed.cleanupCredentials(row.id,resumed.list().revision);assert.equal(resumed.list().connections[0].cleanupPending,false);
});
test("post-commit backup failure never deletes a new credential referenced by durable metadata",()=>{
 const storage=resource(),vault=new MemoryCredentialVault(),store=new WorkspaceSecureConnections(storage,vault),backup=file(storage,"workspace-connections-v2-backup.json"),original=fs.linkSync;let backups=0;
 fs.linkSync=function(from,to){if(to===backup&&++backups===2)throw new Error("fixture backup commit denied");return original.apply(this,arguments);};syncBuiltinESMExports();
 try {assert.throws(()=>store.add(input(),0),/denied/);}finally{fs.linkSync=original;syncBuiltinESMExports();}
 assert.equal(store.list().connections.length,1);assert.equal(store.resolve(store.capture()).apiKey,fakeKey);
 // Rotate under the same uncertain post-commit boundary; neither the new key nor the pending old
 // cleanup may be lost. A later explicit action can clean the retired generation.
 backups=0;fs.linkSync=function(from,to){if(to===backup&&++backups===2)throw new Error("fixture backup commit denied");return original.apply(this,arguments);};syncBuiltinESMExports();
 try {assert.throws(()=>store.edit(store.list().connections[0].id,{...input(),apiKey:""},store.list().revision),/denied/);}finally{fs.linkSync=original;syncBuiltinESMExports();}
 assert.equal(store.resolve(store.capture()).apiKey,fakeKey);assert.equal(store.list().connections[0].cleanupPending,true);
});
test("legacy source preview rejects aliases, public/hard-linked config and excludes the current workspace source",()=>{
 const home=dir(),path=join(home,".hara/config.json");fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,JSON.stringify(input()),{mode:0o600});const catalog=new LegacyConnectionCatalog(home,new MemoryCredentialVault());
 assert.equal(catalog.list(path).length,0);fs.chmodSync(path,0o644);assert.equal(catalog.list().length,0);fs.chmodSync(path,0o600);
 fs.linkSync(path,join(home,"retained-hardlink.json"));assert.equal(catalog.list().length,0);
});
test("bundle-id-independent theme settings survive upgrade, ordered schema migration and backup recovery",()=>{
 const home=dir(),old=new WorkspacePreferences(home,undefined,()=>"dark");old.save(old.read().theme,0);
 const newer=new WorkspacePreferences(home,undefined,()=>"light");assert.equal(newer.read().theme,"dark");
 const path=join(home,".hara/ui-preferences-v1.json"),raw=JSON.parse(fs.readFileSync(path));raw.schemaVersion=1;delete raw.migratedFrom;fs.writeFileSync(path,JSON.stringify(raw));
 assert.equal(newer.read().schemaVersion,2);const text=fs.readFileSync(path,"utf8");newer.read();assert.equal(fs.readFileSync(path,"utf8"),text);
 newer.save("light",newer.read().revision);fs.writeFileSync(path,"broken");assert.equal(newer.read().theme,"light");assert.equal(newer.read().recovered,true);assert.throws(()=>newer.save("dark",2));
});
test("old bundle WebKit appearance is read-only and preserves UTF-16 localStorage preference",()=>{
 const home=dir(),path=join(home,"Library/WebKit/com.nanhara.hara/WebsiteData/LocalStorage/old.localstorage");fs.mkdirSync(dirname(path),{recursive:true});
 const result=spawnSync("/usr/bin/sqlite3",[path,`CREATE TABLE ItemTable(key TEXT,value BLOB); INSERT INTO ItemTable VALUES('hara.theme',X'${Buffer.from("dark","utf16le").toString("hex")}');`]);assert.equal(result.status,0);
 const before=fs.readFileSync(path);assert.equal(readLegacyTheme(home),"dark");assert.deepEqual(fs.readFileSync(path),before);
});
test("fixture schedule migration keeps enable/schedule/explicit workspace, backs up and deduplicates",()=>{
 const root=dir(),a=resource(),b=resource(),pa=dir(),pb=dir(),aid=a.scope.workspaceId,bid=b.scope.workspaceId;
 const featuresA=new WorkspaceFeatures(a,pa,aid),featuresB=new WorkspaceFeatures(b,pb,bid);
 const source=join(root,"jobs.json"),jobs=[{id:"one",name:"Personal",enabled:false,schedule:{kind:"cron",expr:"0 9 * * *"},task:"fixture"},{id:"two",name:"Other",enabled:true,workspaceId:bid,schedule:{kind:"every",everyMs:60000,display:"every minute"},task:"fixture"}];
 fs.writeFileSync(source,JSON.stringify(jobs),{mode:0o600});const text=fs.readFileSync(source),args={fixtureRoot:root,source,personalWorkspaceId:aid,targets:new Map([[aid,featuresA],[bid,featuresB]])};
 assert.equal(migrateLegacyScheduleFixture(args).imported,2);assert.equal(migrateLegacyScheduleFixture(args).imported,0);assert.deepEqual(fs.readFileSync(source+".before-workspace-migration"),text);
 assert.equal(featuresA.list().schedules[0].enabled,false);assert.deepEqual(featuresA.list().schedules[0].schedule,jobs[0].schedule);assert.equal(featuresB.list().schedules[0].workspaceId,bid);
 fs.writeFileSync(source,"broken");assert.equal(migrateLegacyScheduleFixture(args).state,"invalid_source");
});
test("skills and schedule controls stay inside their resource binding",()=>{
 const a=resource(),b=resource(),project=dir(),other=dir(),aid=a.scope.workspaceId;
 fs.mkdirSync(join(project,".hara/skills/mock"),{recursive:true});fs.writeFileSync(join(project,".hara/skills/mock/SKILL.md"),"---\nname: mock\ndescription: Local fixture skill\n---\nUse local fixtures only.\n");
 const one=new WorkspaceFeatures(a,project,aid),two=new WorkspaceFeatures(b,other,b.scope.workspaceId);assert.equal(one.list().skills.length,1);assert.equal(two.list().skills.length,0);
 assert.equal(one.list().skills[0].enabled,false);one.setSkillEnabled("mock",true,0);assert.equal(one.list().skills[0].enabled,true);
 one.setSkillEnabled("mock",false,1);assert.equal(one.list().skills[0].enabled,false);assert.throws(()=>two.setSkillEnabled("mock",true,0));
});
