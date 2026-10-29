import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { detectInstalledRuntimes, boundedRuntimeCommand, LOGIN_RUNTIME_PATH_COMMAND } from "../dist/workspace/runtime-detect.js";
import { workspaceHostSources } from "../dist/workspace/local-cli.js";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
const roots=[]; const dir=()=>{const p=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-detect-test-")));roots.push(p);return p;};
after(()=>roots.forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
function binary(path, body="echo 'tool 1.2.3'") { fs.mkdirSync(dirname(path),{recursive:true});fs.writeFileSync(path,`#!/bin/sh\n${body}\n`,{mode:0o755});return path; }
function options(home, extra={}) { return {home,path:"/usr/bin:/bin",systemBins:[],timeoutMs:80,
 run:async(command,args)=>args[0]==="-lic"?null:"tool 1.2.3",...extra}; }
test("GUI minimal PATH finds nvm installs in numeric version order, with zero downloads",async()=>{
 const home=dir(); const old=binary(join(home,".nvm/versions/node/v9.20.0/bin/codex")), latest=binary(join(home,".nvm/versions/node/v22.3.1/bin/codex"));
 const result=await detectInstalledRuntimes(options(home));assert.equal(result.length,1);assert.equal(result[0].path,latest);assert.notEqual(result[0].path,old);assert.equal(result[0].version,"1.2.3");
});
test("login-shell PATH outranks nvm and its command is literal and bounded",async()=>{
 const home=dir(), login=binary(join(home,"chosen/codex"));binary(join(home,".nvm/versions/node/v99.0.0/bin/codex"));
 const result=await detectInstalledRuntimes(options(home,{run:async(cmd,args,env,timeout)=>{
   assert(timeout<=3000);assert(!/API_KEY|TOKEN/.test(Object.keys(env).join(" ")));
   if(args[0]==="-lic"){assert.equal(args[1],LOGIN_RUNTIME_PATH_COMMAND);return `noise\n__HARA_RUNTIME_PATH__${dirname(login)}\n`;}
   assert.deepEqual(args,["--version"]);return "tool 1.2.3";
 }}));assert.equal(result[0].path,login);assert.equal(result[0].source,"login-shell");
});
test("broken and timed-out binaries do not hide a usable fallback",async()=>{
 const home=dir();binary(join(home,".nvm/versions/node/v24.0.0/bin/claude"),"exit 1");binary(join(home,".nvm/versions/node/v23.0.0/bin/claude"),"sleep 3");
 const fallback=binary(join(home,".local/bin/claude"),"echo '2.0.1'");const started=Date.now();
 const result=await detectInstalledRuntimes(options(home,{run:async(command,args)=>args[0]==="-lic"||command.includes("v24.0.0")||command.includes("v23.0.0")?null:"2.0.1"}));assert.equal(result[0].path,fallback);assert(Date.now()-started<2000);
});
test("missing runtimes return no local installation; no package manager/install/network is invoked",async()=>{
 const home=dir(), calls=[];const result=await detectInstalledRuntimes(options(home,{run:async(command,args)=>{calls.push([command,args]);return null;}}));
 assert.deepEqual(result,[]);assert(calls.every(([,args])=>args[0]==="-lic"));
});
test("read-only discovery and legacy source roots never inherit the isolated writable data Home",()=>{
 const data=dir(), source=dir(), account=dir();const roots=workspaceHostSources({HOME:data,HARA_WORKSPACE_HOST_HOME:data,HARA_WORKSPACE_LEGACY_SOURCE_HOME:source},account);
 assert.equal(roots.hostHome,data);assert.equal(roots.discoveryHome,account);assert.equal(roots.legacySourceHome,source);
 assert.equal(workspaceHostSources({HARA_WORKSPACE_HOST_HOME:data},account).legacySourceHome,account);
});
test("all NVM versions plus local, Volta and Bun are searched even without a login PATH",async()=>{
 const home=dir();for(let i=1;i<=30;i++)binary(join(home,`.nvm/versions/node/v${i}.0.0/bin/irrelevant`));
 const found=binary(join(home,".nvm/versions/node/v1.0.0/bin/claude"));binary(join(home,".volta/bin/codex"));binary(join(home,".bun/bin/opencode"));
 const result=await detectInstalledRuntimes(options(home));assert.equal(result.length,3);assert.equal(result.find(x=>x.runtimeId==="claude").path,found);
});
test("binary version probes use private config roots although installation search uses the account Home",async()=>{
 const account=dir(), data=dir();binary(join(account,".local/bin/claude"));
 const result=await detectInstalledRuntimes(options(account,{probeHome:data,run:async(command,args,env)=>{
   if(args[0]==="-lic"){assert.equal(env.HOME,account);return null;}
   assert.equal(env.HOME,data);assert.equal(env.XDG_CONFIG_HOME,join(data,".config"));assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH,"true");return "2.0.1";
 }}));assert.equal(result[0].path,join(account,".local/bin/claude"));
});
test("discovery and explicitly approved local registration are separate and revalidate replaced files",async()=>{
 const home=dir(), path=binary(join(home,".local/bin/opencode")), storage=new WorkspaceResourceStorage(dir(),{schemaVersion:1,workspaceId:`ws_${randomUUID()}`,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();
 const registry=new WorkspaceRuntimeInstaller(storage,{discovery:options(home)});
 const fetchBefore=globalThis.fetch;globalThis.fetch=()=>{throw new Error("network forbidden in discovery/registration");};
 try { await registry.discover();let row=registry.list().options.find(r=>r.runtimeId==="opencode");assert.equal(row.state,"detected");assert.equal(row.registered,false);
   registry.registerLocal("opencode",row.fingerprint);row=registry.list().options.find(r=>r.runtimeId==="opencode");assert.equal(row.state,"local_registered");assert.equal(registry.resolveLocal("opencode").command,path);
   binary(path,"echo 'changed 9.9.9'");assert.equal(registry.list().options.find(r=>r.runtimeId==="opencode").state,"integrity_failed");assert.throws(()=>registry.resolveLocal("opencode"));
 } finally {globalThis.fetch=fetchBefore;await registry.close();}
});
test("actual subprocess timeout kills only its own command group; broken version exits are ignored",async()=>{
 const env={PATH:"/usr/bin:/bin",HOME:dir()};
 assert.equal(await boundedRuntimeCommand("/bin/sh",["-c","exit 1"],env,1000),null);
 const start=Date.now();assert.equal(await boundedRuntimeCommand("/bin/sh",["-c","sleep 3"],env,50),null);assert(Date.now()-start<2000);
});

test("Antigravity local binary is detected with an isolated version probe and resolves with account Home", async () => {
 const account=dir(), probe=dir(), command=binary(join(account,".local/bin/agy"));
 const storage=new WorkspaceResourceStorage(dir(),{schemaVersion:1,workspaceId:`ws_${randomUUID()}`,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();
 const discovery=options(account,{probeHome:probe,run:async(_command,args,env)=>{
   if(args[0]==="-lic") return null;
   assert.equal(env.HOME,probe); return "agy 1.4.10";
 }});
 const installer=new WorkspaceRuntimeInstaller(storage,{discovery});
 try {
   await installer.discover();
   const row=installer.list().options.find(r=>r.runtimeId==="agy");
   assert.equal(row.version,"1.4.10");assert.equal(row.state,"detected");
   installer.registerLocal("agy",row.fingerprint);
   const resolved=installer.resolveLocal("agy");
   assert.equal(resolved.command,command);assert.equal(resolved.env.HOME,account);
   assert.equal(resolved.env.USERPROFILE,account);assert.notEqual(resolved.env.HOME,probe);
   assert.match(resolved.env.PATH, /\.local\/bin/);
   await assert.rejects(installer.propose("agy","controller",()=>{}),/local registration only/);
 } finally { await installer.close(); }
});
