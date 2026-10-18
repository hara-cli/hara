import test,{after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {WorkspaceResourceStorage} from "../dist/workspace/resource-context.js";
import {WorkspaceFeatures} from "../dist/workspace/features.js";
import {workspaceSkillTool} from "../dist/workspace/skills.js";
import {LocalWorkspaceHost} from "../dist/workspace/local-host.js";
import {MemoryCredentialVault} from "../dist/workspace/credential-vault.js";
const roots=[];const dir=()=>{const p=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-skill-lock-")));roots.push(p);return p;};after(()=>roots.forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
const instructions=extra=>`---\nname: fixture\ndescription: Inspect workspace fixture files\n---\nRead local fixture files. ${extra}\n`;
const source=(home,content=instructions("one"))=>{const path=join(home,".hara/skills/fixture/SKILL.md");fs.mkdirSync(join(home,".hara/skills/fixture"),{recursive:true,mode:0o700});fs.writeFileSync(path,content,{mode:0o600});return path;};
function scoped(home){const storage=new WorkspaceResourceStorage(dir(),{schemaVersion:1,workspaceId:`ws_${randomUUID()}`,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();return new WorkspaceFeatures(storage,dir(),storage.scope.workspaceId,home);}
test("global versions are shared source only; workspace pins and private edits stay independent",()=>{
 const home=dir(),path=source(home),a=scoped(home),b=scoped(home),version=a.list().skills[0].version;
 assert.equal(a.list().skills[0].enabled,false);a.setSkillEnabled("fixture",true,0,version);b.setSkillEnabled("fixture",true,0,version);
 assert.equal(fs.readdirSync(join(home,".hara/skill-library/v1/fixture")).length,1);
 fs.writeFileSync(path,instructions("two"));const update=a.list().skills[0];assert.notEqual(update.availableVersion,version);assert.equal(update.version,version);
 a.setSkillEnabled("fixture",true,1,update.availableVersion);assert.notEqual(a.list().skills[0].version,version);assert.equal(b.list().skills[0].version,version);
 a.forkSkill("fixture",instructions("private"),2);assert.equal(a.list().skills[0].source,"private");assert.match(a.skillContent("fixture").content,/private/);
 assert.match(b.skillContent("fixture").content,/one/);assert.match(fs.readFileSync(path,"utf8"),/two/);assert.equal(fs.readdirSync(join(home,".hara/skill-library/v1/fixture")).length,2);
 fs.renameSync(join(home,".hara/skills"),join(home,".hara/skills-retained"));const c=scoped(home);assert.equal(c.list().skills.length,1,"preserved global library survives source removal");
});
test("runtime reads only captured enabled locks; disable/version changes revoke reads and never expose host paths",async()=>{
 const home=dir();source(home);const a=scoped(home),b=scoped(home);a.setSkillEnabled("fixture",true,0);
 const tool=workspaceSkillTool(a.enabledSkills(),(id,version)=>a.assertSkill(id,version));const result=await tool.run({id:"fixture"},{cwd:"/fixture"});assert(result.length<8000);assert(!result.includes(home));assert.match(result,/Read local fixture/);
 await assert.rejects(workspaceSkillTool(b.enabledSkills(),()=>{}).run({id:"fixture"},{cwd:"/fixture"}),/unavailable/);
 a.setSkillEnabled("fixture",false,1);await assert.rejects(tool.run({id:"fixture"},{cwd:"/fixture"}),/lock changed/);
});
test("symlinks, secrets, invalid versions and unsafe resources cannot be published; tool floors are enforced",async()=>{
 const home=dir(),path=source(home,instructions("one") .replace("---\n\n","---\n")),features=scoped(home);
 fs.writeFileSync(join(home,".hara/skills/fixture/secret.txt"),"api_key=sk-test-fixtureabcdefghijklmnopqrstuv");assert.equal(features.list().skills.length,0);fs.unlinkSync(join(home,".hara/skills/fixture/secret.txt"));
 fs.symlinkSync(path,join(home,".hara/skills/fixture/linked.txt"));assert.equal(features.list().skills.length,0);fs.unlinkSync(join(home,".hara/skills/fixture/linked.txt"));
 const text=instructions("one").replace("description:","allowed-tools: [workspace_read]\ndescription:");fs.writeFileSync(path,text);features.setSkillEnabled("fixture",true,0);
 const tool=workspaceSkillTool(features.enabledSkills(),(id,version)=>features.assertSkill(id,version));await assert.rejects(tool.run({id:"fixture"},{cwd:"/fixture"}),/policy/);
 const floors=[];await tool.run({id:"fixture"},{cwd:"/fixture",restrictToolsForSkill:(id,allowed)=>{floors.push({id,allowed});return {ok:true};}});assert.deepEqual(floors,[{id:"fixture",allowed:["workspace_read"]}]);
 await assert.rejects(tool.run({id:"fixture",file:"../config.json"},{cwd:"/fixture"}),/unavailable/);
 assert.throws(()=>features.setSkillEnabled("fixture",true,1,"a".repeat(64)),/version unavailable/);
});
test("formal Pi host exposes enabled workspace skill/tool but no global credential, env or executable runtime",async()=>{
 const home=dir(),root=dir();source(home);const turns=[];
 const host=new LocalWorkspaceHost(root,{mode:"workspace",hostHome:home,credentialVault:new MemoryCredentialVault(),providerFactory:()=>({id:"openai",model:"fake",async turn(args){turns.push(args);return {text:"Hello from the fake provider",toolUses:[],stopReason:"end_turn",inputTokens:1,outputTokens:1};}})});
 try {
  const view=host.createWorkspace("Fixture",host.list().revision),id=view.workspaceId;host.configureConnection(id,{label:"Fake",provider:"openai",baseURL:"https://example.invalid/v1",defaultModel:"fake",apiKey:"fixture-private-key"},0);
  const skills=host.workspaceFeatures(id);host.updateFeature(id,"skill","fixture",true,skills.revision,skills.skills[0].version);
  const receipt=host.start("fixture-client",id,view.selectedAgentId,"Hello",randomUUID());await host.wait(receipt.runId);
  assert.equal(turns.length,1,JSON.stringify(host.snapshot(id).conversation));assert.match(turns[0].system,/Enabled version-locked Workspace skills/);assert.match(turns[0].system,/"id":"fixture"/);
  assert(turns[0].tools.some(tool=>tool.name==="workspace_skill"));assert(!JSON.stringify({system:turns[0].system,tools:turns[0].tools}).includes(home));assert(!turns[0].tools.some(tool=>["bash","skill","exec"].includes(tool.name)));
 }finally{await host.close();}
});
test("escaped skill text and resource names remain under the 8k tool result ceiling",async()=>{
 const home=dir(),path=source(home,instructions('"'.repeat(20000)));for(let n=0;n<30;n++)fs.writeFileSync(join(home,".hara/skills/fixture",`${"r".repeat(180)}-${n}.md`),"Resource");
 const a=scoped(home);a.setSkillEnabled("fixture",true,0);const result=await workspaceSkillTool(a.enabledSkills(),()=>{}).run({id:"fixture"},{cwd:"/fixture"});assert(result.length<=7800);assert(JSON.parse(result).nextOffset>0);assert.equal(fs.existsSync(path),true);
});
