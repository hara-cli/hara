import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";
import { detectInstalledRuntimes } from "../dist/workspace/runtime-detect.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
function fixture(t, current) {
 const home=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"kimi-generation-")));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const old=join(home,".local/bin/kimi");fs.mkdirSync(dirname(old),{recursive:true});fs.writeFileSync(old,"#!/bin/sh\nexit 0\n",{mode:0o700});
 let manifest;
 if(current){const root=join(home,".nvm/versions/node/v22.23.1/lib/node_modules/@moonshot-ai/kimi-code"),entry=join(root,"dist/main.mjs"),command=join(home,".nvm/versions/node/v22.23.1/bin/kimi");fs.mkdirSync(dirname(entry),{recursive:true});fs.mkdirSync(dirname(command),{recursive:true});fs.writeFileSync(entry,"#!/bin/sh\nexit 0\n",{mode:0o700});manifest=join(root,"package.json");fs.writeFileSync(manifest,JSON.stringify({name:"@moonshot-ai/kimi-code",version:"2.4.1",bin:{kimi:"dist/main.mjs"}}));fs.symlinkSync(entry,command);}
 const discovery={home,path:"/usr/bin:/bin",systemBins:[],run:async(command,args)=>args[0]==="--version"?command===old?"kimi, version 1.52.0":"2.4.1":null};
 fs.mkdirSync(join(home,"data"));
 const storage=new WorkspaceResourceStorage(join(home,"data"),{schemaVersion:1,workspaceId:`ws_${randomUUID()}`,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();
 const installer=new WorkspaceRuntimeInstaller(storage,{accountHome:()=>home,discovery});t.after(()=>installer.close());return {home,manifest,installer,discovery};
}
test("Kimi discovery continues past an old Python shim and requires explicit new registration",async t=>{
 const f=fixture(t,true);await f.installer.discover();const row=f.installer.list().options.find(x=>x.runtimeId==="kimi");assert.equal(row.version,"2.4.1");assert.match(row.path,/nvm/);assert.equal(row.registered,false);assert.deepEqual(f.installer.availability("kimi"),{state:"detected",generalAgentDriverAvailable:false});f.installer.registerLocal("kimi",row.fingerprint);assert.equal(f.installer.resolveBound("kimi").env.HOME,f.home);assert.deepEqual(f.installer.availability("kimi"),{state:"local_registered",generalAgentDriverAvailable:true});const registry=new AgentRuntimeRegistry(undefined,f.installer);registry.assertAvailable("kimi");
 fs.unlinkSync(f.manifest);assert.deepEqual(f.installer.availability("kimi"),{state:"legacy_unsupported",generalAgentDriverAvailable:false});assert.throws(()=>registry.assertAvailable("kimi"),/not available/);assert.equal(f.installer.list().options.find(x=>x.runtimeId==="kimi").registered,false);assert.throws(()=>f.installer.resolveBound("kimi"),/no longer maintained/);
});
test("Kimi legacy detection explains replacement and cannot be registered or bound",async t=>{
 const f=fixture(t,false),found=(await detectInstalledRuntimes(f.discovery)).find(x=>x.runtimeId==="kimi");await f.installer.discover();const row=f.installer.list().options.find(x=>x.runtimeId==="kimi");assert.equal(row.state,"legacy_unsupported");assert.deepEqual(f.installer.availability("kimi"),{state:row.state,generalAgentDriverAvailable:row.generalAgentDriverAvailable});assert.equal(row.installed,false);assert.equal(row.generalAgentDriverAvailable,false);assert.match(row.compatibilityMessage,/旧版已停止维护，请换新版/);assert.throws(()=>f.installer.registerLocal("kimi",found.fingerprint),/no longer maintained/);assert.throws(()=>f.installer.resolveBound("kimi"));
});
