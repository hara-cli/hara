import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";
import { createRuntimeExecutionPolicy, runtimeExecutionPolicyKey } from "../dist/agent-runtime/execution-policy.js";

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"runtime-policy-"))),home=join(root,"account"),work=join(root,"work");
  for(const p of [work,join(home,".hara"),join(home,".codex/sessions"),join(home,".claude/projects"),join(home,"Library/Keychains"),join(root,"outside")])fs.mkdirSync(p,{recursive:true});
  fs.writeFileSync(join(home,".codex/auth.json"),"FAKE_CODEX_LOGIN");fs.writeFileSync(join(home,".claude/.credentials.json"),"FAKE_CLAUDE_LOGIN");
  fs.writeFileSync(join(home,".hara/serve-v2.json"),"FAKE_HARA_RPC");fs.writeFileSync(join(home,"Library/Keychains/login.keychain-db"),"PLAIN_FIXTURE_NOT_A_KEYCHAIN");
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return{root,home,work,policy(tier="full-protected",runtimeId="codex") {const p=createRuntimeExecutionPolicy({runtimeId,tier,accountHome:home,workRoot:work});t.after(()=>p.close());return p;}};
}
async function execute(p,code,env={}) {
 const launch=p.wrap({command:process.execPath,args:["-e",code],env:{...process.env,...env}});
 const out=await runExternalCommandCapture(launch,launch.args,{timeoutMs:10000,waitForClose:true,retainStdoutOnFailure:true});
 return {status:out.code,stdout:out.stdout,stderr:out.errorCode??""};
}

test("real Seatbelt permits only the full tier's working directory and own runtime state, with credential/Hara masks",{skip:process.platform!=="darwin"},async t=>{
  const f=fixture(t),p=f.policy();
  const script=`const f=require('fs'),p=${JSON.stringify(f)},o={};for(const [k,fn] of Object.entries({work:()=>f.writeFileSync(p.work+'/ok.txt','ok'),state:()=>f.writeFileSync(p.home+'/.codex/sessions/ok','ok'),haraWrite:()=>f.writeFileSync(p.home+'/.hara/no','no'),haraRead:()=>f.readFileSync(p.home+'/.hara/serve-v2.json'),foreignRead:()=>f.readFileSync(p.home+'/.claude/.credentials.json'),ownRead:()=>f.readFileSync(p.home+'/.codex/auth.json'),ownWrite:()=>f.writeFileSync(p.home+'/.codex/auth.json','no'),keychainWrite:()=>f.writeFileSync(p.home+'/Library/Keychains/login.keychain-db','no'),outside:()=>f.writeFileSync(p.root+'/outside/no','no'),link:()=>f.linkSync(p.home+'/.claude/.credentials.json',p.work+'/alias')})){try{fn();o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`;
  const out=await execute(p,script,{HOME:f.home,CODEX_HOME:join(f.home,".codex")});assert.equal(out.status,0,out.stderr);
  assert.deepEqual(JSON.parse(out.stdout),{work:true,state:true,haraWrite:false,haraRead:false,foreignRead:false,ownRead:true,ownWrite:false,keychainWrite:false,outside:false,link:false});
  assert.ok(p.profile.includes('global-name "com.apple.securityd"')); // no service call or real Keychain read
});
test("controlled tier is externally read-only even with native sandbox disabled, and native nesting is unsuitable",{skip:process.platform!=="darwin"},async t=>{
  const f=fixture(t),p=f.policy("controlled");
  let out=await execute(p,`try{require('fs').writeFileSync(${JSON.stringify(join(f.work,"no.txt"))},'no');process.exit(4)}catch{console.log('write-denied')}`,{HOME:f.home});
  assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/write-denied/);
  out=await execute(p,`const r=require('child_process').spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/usr/bin/true'],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stderr:r.stderr}));`,{HOME:f.home});
  assert.equal(out.status,0,out.stderr);const nested=JSON.parse(out.stdout);assert.notEqual(nested.status,0);assert.match(nested.stderr,/sandbox_apply|Operation not permitted/);
});
test("a directory symlink cannot grant writes outside the working root and linked roots are rejected",{skip:process.platform!=="darwin"},async t=>{
  const f=fixture(t);fs.symlinkSync(join(f.root,"outside"),join(f.work,"escape"));const p=f.policy();
  const out=await execute(p,`try{require('fs').writeFileSync(${JSON.stringify(join(f.work,"escape/no"))},'no');process.exit(4)}catch{console.log('denied')}`,{HOME:f.home});
  assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/denied/);
  fs.symlinkSync(f.work,join(f.root,"alias"));assert.throws(()=>runtimeExecutionPolicyKey({runtimeId:"codex",tier:"full-protected",workRoot:join(f.root,"alias"),accountHome:f.home}),/symbolic link/);
});
test("native diff evidence needs actual complete changes; a native event or prose alone is insufficient",t=>{
  const f=fixture(t),p=f.policy();assert.equal(p.collectWorkspaceEvidence(),null);
  p.observeNativeEvent({type:"file",status:"completed",path:"invented.txt",operation:"write"});assert.equal(p.collectWorkspaceEvidence(),null);
  fs.writeFileSync(join(f.work,"actual.txt"),"actual");const e=p.collectWorkspaceEvidence();assert.equal(e.verified,true);assert.equal(e.changes.length,1);assert.equal(e.changes[0].path,"actual.txt");
  assert.equal(p.collectWorkspaceEvidence().id,e.id);p.beginAttempt("next-attempt");assert.equal(p.collectWorkspaceEvidence(),null);
  p.observeNativeEvent({type:"command",status:"started",command:"git push with-sensitive-arguments"});assert.equal(p.risks.length,1);assert.equal(p.risks[0].state,"observed");assert.doesNotMatch(JSON.stringify(p.risks),/sensitive-arguments/);
});

test("Claude keeps its own fake login reads and descendants inherit Hara/foreign-credential write protection",{skip:process.platform!=="darwin"},async t=>{
 const f=fixture(t),p=f.policy("full-protected","claude");
 const code=`const f=require('fs'),o={};for(const [key,fn]of Object.entries({own:()=>f.readFileSync(${JSON.stringify(join(f.home,".claude/.credentials.json"))}),foreign:()=>f.readFileSync(${JSON.stringify(join(f.home,".codex/auth.json"))}),state:()=>f.writeFileSync(${JSON.stringify(join(f.home,".claude/projects/session"))},'ok')})){try{fn();o[key]=true}catch{o[key]=false}}console.log(JSON.stringify(o));`;
 const out=await execute(p,`const r=require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(code)}],{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);`,{HOME:f.home});
 assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{own:true,foreign:false,state:true});
});
test("OpenCode cannot load global or project plugin code while its own fake auth remains readable",{skip:process.platform!=="darwin"},async t=>{
 const f=fixture(t);for(const dir of [join(f.home,".config/opencode/plugins"),join(f.home,".local/share/opencode"),join(f.work,".opencode/plugins")])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(join(f.home,".local/share/opencode/auth.json"),"FAKE_OPENCODE_LOGIN");fs.writeFileSync(join(f.home,".config/opencode/plugins/test.js"),"throw new Error('must not load')");fs.writeFileSync(join(f.work,".opencode/plugins/test.js"),"throw new Error('must not load')");
 const p=f.policy("full-protected","opencode"),out=await execute(p,`const f=require('fs'),o={};for(const[k,path]of Object.entries(${JSON.stringify({auth:join(f.home,".local/share/opencode/auth.json"),global:join(f.home,".config/opencode/plugins/test.js"),project:join(f.work,".opencode/plugins/test.js")})})){try{f.readFileSync(path);o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`,{HOME:f.home});
 assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{auth:true,global:false,project:false});
});

test("foreign Kimi OAuth directories and the incompatible Kimi Code data root remain unreadable", {skip:process.platform!=="darwin"}, async t=>{
  const f=fixture(t), names=[".kimi/credentials/kimi-code.json",".kimi/credentials/custom.json",".kimi-code/config.toml",".kimi-code/credentials/kimi-code.json"];
  for(const name of names){fs.mkdirSync(join(f.home,name.slice(0,name.lastIndexOf("/"))),{recursive:true});fs.writeFileSync(join(f.home,name),"FAKE_LOGIN_ONLY");}
  for(const runtimeId of ["codex","claude","gemini"]){
    const p=f.policy("full-protected",runtimeId);
    const out=await execute(p,`const fs=require('fs'),paths=${JSON.stringify(names.map(name=>join(f.home,name)))};console.log(JSON.stringify(paths.map(path=>{try{fs.readFileSync(path);return true}catch{return false}})));`,{HOME:f.home});
    assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),names.map(()=>false));
  }
});

test("isolated runtimeHome inside fake Hara state is the only state exception, with credentials read-only",{skip:process.platform!=="darwin"},async t=>{
 const f=fixture(t),runtimeHome=join(f.home,".hara/host-state/runtime-homes/claude/.claude"),other=join(f.home,".hara/host-state/runtime-homes/codex/.codex");fs.mkdirSync(runtimeHome,{recursive:true});fs.mkdirSync(other,{recursive:true});fs.writeFileSync(join(runtimeHome,".credentials.json"),"OWN_FAKE");fs.writeFileSync(join(runtimeHome,"own-config.json"),"{}");fs.writeFileSync(join(other,"private.json"),"FOREIGN_FAKE");
 const p=createRuntimeExecutionPolicy({runtimeId:"claude",tier:"full-protected",accountHome:f.home,runtimeHome,workRoot:f.work,protectedStateRoots:[join(f.home,".hara/host-state")],loginSource:"isolated"});t.after(()=>p.close());
 const out=await execute(p,`const fs=require('fs'),r=${JSON.stringify({home:f.home,runtimeHome,other})},o={};for(const[k,fn]of Object.entries({ownRead:()=>fs.readFileSync(r.runtimeHome+'/own-config.json'),ownWrite:()=>fs.writeFileSync(r.runtimeHome+'/own-session.json','{}'),authRead:()=>fs.readFileSync(r.runtimeHome+'/.credentials.json'),authWrite:()=>fs.writeFileSync(r.runtimeHome+'/.credentials.json','no'),haraWrite:()=>fs.writeFileSync(r.home+'/.hara/no','no'),otherRead:()=>fs.readFileSync(r.other+'/private.json'),otherWrite:()=>fs.writeFileSync(r.other+'/no','no')})){try{fn();o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`,{HOME:join(runtimeHome,".."),CLAUDE_CONFIG_DIR:runtimeHome});
 assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{ownRead:true,ownWrite:true,authRead:true,authWrite:false,haraWrite:false,otherRead:false,otherWrite:false});
 assert.throws(()=>createRuntimeExecutionPolicy({runtimeId:"claude",tier:"full-protected",accountHome:f.home,runtimeHome:join(f.home,".hara"),workRoot:f.work,loginSource:"isolated"}),/cannot contain/);
});
test("Pi reads only its dedicated empty auth and can create the empty lock, with no Keychain exception",{skip:process.platform!=="darwin"},async t=>{
 const f=fixture(t),runtimeHome=join(f.home,".hara/host-state/runtime-homes/pi/agent");fs.mkdirSync(runtimeHome,{recursive:true});fs.mkdirSync(join(runtimeHome,"sessions"));for(const name of ["auth.json","models.json","settings.json"])fs.writeFileSync(join(runtimeHome,name),"{}");
 const p=createRuntimeExecutionPolicy({runtimeId:"pi",tier:"full-protected",accountHome:f.home,runtimeHome,workRoot:f.work,loginSource:"isolated"});t.after(()=>p.close());
 const out=await execute(p,`const fs=require('fs'),r=${JSON.stringify({home:f.home,runtimeHome,work:f.work})},o={};for(const[k,fn]of Object.entries({auth:()=>fs.readFileSync(r.runtimeHome+'/auth.json'),lock:()=>fs.mkdirSync(r.runtimeHome+'/auth.json.lock'),lockContent:()=>fs.writeFileSync(r.runtimeHome+'/auth.json.lock/no','no'),authWrite:()=>fs.writeFileSync(r.runtimeHome+'/auth.json','no'),modelsWrite:()=>fs.writeFileSync(r.runtimeHome+'/models.json','no'),settingsWrite:()=>fs.writeFileSync(r.runtimeHome+'/settings.json','no'),session:()=>fs.writeFileSync(r.runtimeHome+'/sessions/ok','ok'),keychainRead:()=>fs.readFileSync(r.home+'/Library/Keychains/login.keychain-db'),foreignRead:()=>fs.readFileSync(r.home+'/.codex/auth.json'),haraWrite:()=>fs.writeFileSync(r.home+'/.hara/no','no')})){try{fn();o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`,{HOME:join(runtimeHome,"..")});
 assert.equal(out.status,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{auth:true,lock:true,lockContent:false,authWrite:false,modelsWrite:false,settingsWrite:false,session:true,keychainRead:false,foreignRead:false,haraWrite:false});assert.ok(p.profile.includes('(deny mach-lookup'));
 fs.writeFileSync(join(runtimeHome,"auth.json"),'"FAKE_NONEMPTY_LOGIN"');assert.throws(()=>createRuntimeExecutionPolicy({runtimeId:"pi",tier:"full-protected",accountHome:f.home,runtimeHome,workRoot:f.work}),/empty object/);
});
