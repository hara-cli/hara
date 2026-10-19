import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { LegacyConnectionCatalog } from "../dist/workspace/legacy-connections.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
const roots=[];
const directory=(config=true)=>{const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-source-")));roots.push(root);if(config)fs.mkdirSync(join(root,".hara"),{mode:0o700});return root;};
const write=(home,file,value)=>fs.writeFileSync(join(home,".hara",file),JSON.stringify(value),{mode:0o600});
after(()=>roots.forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
test("Personal config and named providers both prefill, preserving a config-backed active Personal row",()=>{
 const source=directory(), vault=new MemoryCredentialVault();
 write(source,"config.json",{provider:"anthropic",apiKey:"fake-personal",model:"fixture-personal"});
 write(source,"profiles.json",{active:"personal",profiles:[{id:"personal",kind:"byok",label:"Personal"},{id:"ark",kind:"byok",provider:"volcengine-coding-plan",apiKey:"fake-ark",model:"ark-code-latest"},{id:"gateway",kind:"gateway",deviceToken:"fake-never-import"}]});
 const rows=new LegacyConnectionCatalog(source,vault).personalSeeds();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.isDefault).label,"Personal");
 assert.equal(rows[0].baseURL,"https://api.anthropic.com");assert.equal(rows[1].baseURL,"https://ark.cn-beijing.volces.com/api/coding/v3");
 assert.equal(JSON.stringify(rows).includes("fake-"),false);
});
test("keyless legacy copy lists every provider without vault reads, writes, automatic retries or a permanently locked space",async()=>{
 const source=directory(), data=directory(), root=directory(false);
 write(source,"profiles.json",{active:"second",profiles:[{id:"one",provider:"openai",model:"fixture-one"},{id:"second",provider:"anthropic",model:"fixture-two"}]});
 const original=fs.readFileSync(join(source,".hara/profiles.json"));fs.chmodSync(join(source,".hara/profiles.json"),0o400);
 const vault=new MemoryCredentialVault();let reads=0,writes=0;const get=vault.get.bind(vault),set=vault.set.bind(vault);vault.get=ref=>{reads++;return get(ref);};vault.set=(ref,key)=>{writes++;return set(ref,key);};
 const host=new LocalWorkspaceHost(root,{mode:"workspace",hostHome:data,legacySourceHome:source,credentialVault:vault});
 try {const a=host.createWorkspace("Personal",host.list().revision);assert.equal(a.connections.connections.length,2);assert.equal(a.connections.readOnly,false);assert.equal(a.connections.migrationPending,false);
   assert.equal(a.connections.defaultConnectionId,null);const selected=a.connections.connections.find(row=>row.id===a.connections.activeConnectionId);assert.equal(selected.defaultModel,"fixture-two");
   assert(selected.credentialRequired);assert(a.connections.connections.every(row=>!row.keySaved));assert.equal(reads,0);assert.equal(writes,0);
   assert.throws(()=>host.start("fixture",a.workspaceId,a.agents[0].agentId,"hello","missing-key-request"));assert.equal(reads,0);
   host.editConnection(a.workspaceId,selected.id,{...selected,apiKey:"fake-user-supplied"},a.connections.revision);
   assert.equal(writes,1);assert.equal(host.snapshot(a.workspaceId).connections.defaultConnectionId,selected.id);
   const b=host.createWorkspace("B",host.list().revision);assert.equal(b.connections.connections.length,0);assert(fs.readFileSync(join(source,".hara/profiles.json")).equals(original));
   assert.equal(fs.statSync(join(source,".hara/profiles.json")).mode&0o777,0o400,"read-only source permissions are never repaired by a preview/import reader");
 } finally {await host.close();}
});
test("config overlays retain their own credentials but never borrow a key across providers",()=>{
 const source=directory();write(source,"config.json",{provider:"anthropic",apiKey:"fake-personal",model:"personal",overlays:{other:{provider:"openai",model:"other"},named:{provider:"openai",apiKey:"fake-named",model:"named"}}});
 const catalog=new LegacyConnectionCatalog(source,new MemoryCredentialVault()),rows=catalog.personalSeeds();assert.equal(rows.length,3);
 const other=rows.find(row=>row.label==="other");assert.equal(other.keySaved,false);assert.equal(other.baseURL,"https://api.openai.com/v1");assert.throws(()=>catalog.resolve(other.id));
 const named=rows.find(row=>row.label==="named");assert.equal(catalog.resolve(named.id).input.apiKey,"fake-named");
});
test("same endpoint and model do not collapse two independent accounts",()=>{
 const source=directory();write(source,"config.json",{provider:"openai",baseURL:"https://example.invalid/v1",model:"same",apiKey:"fake-personal"});
 write(source,"profiles.json",{active:"named",profiles:[{id:"named",provider:"openai",baseURL:"https://example.invalid/v1",model:"same",apiKey:"fake-other"}]});
 assert.equal(new LegacyConnectionCatalog(source,new MemoryCredentialVault()).personalSeeds().length,2);
});
test("Node and the packaged Bun engine agree on source IDs despite fractional filesystem timestamps",{skip:spawnSync("bun",["--version"]).status!==0},()=>{
 const source=directory(),file=join(source,".hara/profiles.json");write(source,"profiles.json",{active:"one",profiles:[{id:"one",provider:"openai",model:"same",apiKey:"fake-only"}]});
 fs.utimesSync(file,1770000000.123456,1770000000.123456);
 const expected=new LegacyConnectionCatalog(source,new MemoryCredentialVault()).personalSeeds().map(row=>row.id);
 const module=pathToFileURL(join(process.cwd(),"dist/workspace/legacy-connections.js")).href;
 const result=spawnSync("bun",["-e",`import {LegacyConnectionCatalog} from ${JSON.stringify(module)};console.log(JSON.stringify(new LegacyConnectionCatalog(process.argv[1],{get(){throw new Error("No credential reads");}}).personalSeeds().map(row=>row.id)));`,source],{encoding:"utf8",env:{PATH:process.env.PATH,HOME:source},timeout:5000});
 assert.equal(result.status,0,"Bun source-ID probe must succeed");assert.deepEqual(JSON.parse(result.stdout),expected);
});
test("a frozen backup retains original source identity without reading or chmodding the original location",()=>{
 const original=directory(),copy=directory();const value={active:"one",profiles:[{id:"one",provider:"openai",model:"same",apiKey:"fake-only"}]};
 write(original,"profiles.json",value);write(copy,"profiles.json",value);fs.chmodSync(join(copy,".hara/profiles.json"),0o400);
 const vault=new MemoryCredentialVault();assert.deepEqual(new LegacyConnectionCatalog(copy,vault,original).personalSeeds().map(r=>r.id),new LegacyConnectionCatalog(original,vault).personalSeeds().map(r=>r.id));
 assert.equal(fs.statSync(join(copy,".hara/profiles.json")).mode&0o777,0o400);
});
test("decision is an explicit owner-only connection source, never the active chat or a borrowed provider key",()=>{
 const source=directory(),vault=new MemoryCredentialVault();write(source,"config.json",{provider:"openai",model:"chat",apiKey:"fake-chat",decisionBaseURL:"https://decision.example.invalid/v1",decisionModel:"judge",decisionApiKey:"fake-judge"});
 const catalog=new LegacyConnectionCatalog(source,vault);assert.equal(catalog.personalSeeds().length,1);
 const rows=catalog.inheritanceSeeds(),decision=rows.find(r=>r.purpose==="decision");assert.equal(rows.length,2);assert.equal(decision.isDefault,false);assert.equal(decision.legacyId,"__decision__");
 assert.equal(JSON.stringify(rows).includes("fake-"),false);assert.throws(()=>catalog.resolve(decision.id),/changed or is unavailable/);
 assert.equal(catalog.resolve(decision.id,undefined,true,true).input.apiKey,"fake-judge");
});
