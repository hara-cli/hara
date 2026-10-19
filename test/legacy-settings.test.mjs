import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { planLegacyWorkspaceSettings, WorkspaceInheritedSettings, legacySettingsDomain } from "../dist/workspace/legacy-settings.js";
const a="mc_10000000-0000-4000-8000-000000000001",b="mc_10000000-0000-4000-8000-000000000002";
const links=[{legacyId:"chat",purpose:"chat",connectionId:a,credentialGeneration:"gen_10000000-0000-4000-8000-000000000003",keyRequired:false},{legacyId:"__decision__",purpose:"decision",connectionId:b,credentialGeneration:"gen_10000000-0000-4000-8000-000000000004",keyRequired:false}];
function fixture(t){const home=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-inherited-settings-")));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const scope={schemaVersion:1,workspaceId:"ws_10000000-0000-4000-8000-000000000001",authority:{kind:"local",localAuthorityId:"20000000-0000-4000-8000-000000000001"}},storage=new WorkspaceResourceStorage(home,scope);storage.initialize();return{storage,open:()=>new WorkspaceInheritedSettings(storage)};}
test("fallback and decision map to same-Workspace connection IDs; raw credentials never enter settings",()=>{
 const key="opaque-fixture-credential-not-a-pattern",value=planLegacyWorkspaceSettings({fallbackModel:"model",fallbackConnectionIds:["chat"],decisionApiKey:key,decisionEngine:"jev",decisionMode:"off",decisionModel:"judge",computerUse:"native",computerApps:"selected",plugins:{enabled:["browser","video"]}},links,"zh");
 assert.deepEqual(value.fallbackConnectionIds,[a]);assert.equal(value.decision.connectionId,b);assert.equal(value.decision.mode,"off");assert.equal(value.locale,"zh");assert.equal(JSON.stringify(value).includes(key),false);
});
test("missing legacy connection is recorded unresolved instead of guessed from active/default/decision",()=>{const v=planLegacyWorkspaceSettings({fallbackConnectionIds:["missing","__decision__"]},links);assert.deepEqual(v.fallbackConnectionIds,[]);assert.deepEqual(v.unresolvedConnectionIds,["missing","__decision__"]);});
test("actual legacy boolean plugin map preserves both enabled and explicitly disabled plugins",t=>{
 const f=fixture(t),s=planLegacyWorkspaceSettings({plugins:{enabled:{wechat:true,browser:false,"private.Plugin_1":true}}},links);
 assert.deepEqual(s.pluginsEnabled,["private.Plugin_1","wechat"]);assert.equal(s.pluginStates.browser,false);f.open().import("a".repeat(64),s);assert.equal(f.open().read().settings.pluginStates.browser,false);
 assert.throws(()=>planLegacyWorkspaceSettings({plugins:{enabled:{browser:"true"}}},links),/plugin list/);
 assert.throws(()=>f.open().save({...s,pluginsEnabled:["browser"]},f.open().read().revision),/disagree/);
});
test("an opaque key misused as a preference is rejected rather than persisted outside the vault",()=>{const key="opaque-fixture-credential-not-a-pattern";assert.throws(()=>planLegacyWorkspaceSettings({apiKey:key,computerUse:key},links),/Credential value/);});
test("ambiguous, secret-bearing, malformed and unsupported settings cannot be silently applied",()=>{
 assert.throws(()=>planLegacyWorkspaceSettings({fallbackConnectionIds:["chat"]},[...links,{...links[0],connectionId:b}]),/Ambiguous/);
 for(const config of [{fallbackConnectionIds:"chat"},{plugins:{enabled:["../plugin"]}},{computerApps:{path:"/"}},{fallbackModel:"sk-"+"x".repeat(40)}])assert.throws(()=>planLegacyWorkspaceSettings(config,links));
 assert.throws(()=>planLegacyWorkspaceSettings({},links,"fr"),/language/);
});
test("settings import and reopen are idempotent and reject a changed source",t=>{const f=fixture(t),settings=planLegacyWorkspaceSettings({computerUse:"native"},links,"en"),first=f.open().import("a".repeat(64),settings);assert.equal(first.imported,true);assert.equal(f.open().import("a".repeat(64),settings).imported,false);assert.deepEqual(f.open().read().settings,settings);assert.throws(()=>f.open().import("b".repeat(64),settings),/source changed/);});
test("a later user setting change survives repeat import without being reset from legacy",t=>{const f=fixture(t),s=planLegacyWorkspaceSettings({},links,"zh");f.open().import("a".repeat(64),s);const before=f.open().read();f.open().save({...s,locale:"en"},before.revision);f.open().import("a".repeat(64),s);assert.equal(f.open().read().settings.locale,"en");});
test("settings created explicitly before inheritance are preserved rather than replaced",t=>{const f=fixture(t),s=planLegacyWorkspaceSettings({},links,"en");f.open().save(s,0);const imported=f.open().import("a".repeat(64),{...s,locale:"zh"});assert.equal(imported.preservedUserSettings,true);assert.equal(f.open().read().settings.locale,"en");});
test("a caller cannot smuggle credential or permission fields into the persisted typed settings",t=>{const f=fixture(t),s=planLegacyWorkspaceSettings({},links);assert.throws(()=>f.open().save({...s,apiKey:"fake-only"},0),/Invalid inherited/);assert.throws(()=>f.open().save({...s,allowTools:["bash"]},0),/Invalid inherited/);});
test("settings domain has traced apply/verify/reopen/rollback/re-upgrade receipts",async t=>{
 const f=fixture(t),s=planLegacyWorkspaceSettings({plugins:{enabled:["browser"]}},links,"en"),open=()=>legacySettingsDomain(f.storage,"a".repeat(64),()=>s);
 const r=await open().apply();assert.equal(await open().verify(r),true);assert.deepEqual(await open().apply(),r);
 await open().rollback();assert.equal(f.open().read().revision,0);const next=await open().apply();assert.notEqual(next.hash,r.hash);assert.equal(await open().verify(next),true);
});
test("settings rollback refuses newer user preferences rather than restoring an old default",async t=>{
 const f=fixture(t),s=planLegacyWorkspaceSettings({},links,"zh"),d=legacySettingsDomain(f.storage,"a".repeat(64),()=>s),r=await d.apply();
 f.open().save({...s,locale:"en"},f.open().read().revision);assert.equal(await d.verify(r),false);await assert.rejects(d.rollback(),/newer file edit/);assert.equal(f.open().read().settings.locale,"en");
});
