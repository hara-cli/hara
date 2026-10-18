import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
