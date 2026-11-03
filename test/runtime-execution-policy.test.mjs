import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRuntimeExecutionPolicy, runtimeExecutionPolicyKey } from "../dist/agent-runtime/execution-policy.js";

function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"runtime-policy-"))),home=join(root,"account"),work=join(root,"work");
  for(const p of [work,join(home,".hara"),join(home,".codex/sessions"),join(home,".claude/projects"),join(home,"Library/Keychains"),join(root,"outside")])fs.mkdirSync(p,{recursive:true});
  fs.writeFileSync(join(home,".codex/auth.json"),"FAKE_CODEX_LOGIN");fs.writeFileSync(join(home,".claude/.credentials.json"),"FAKE_CLAUDE_LOGIN");
  fs.writeFileSync(join(home,".hara/serve-v2.json"),"FAKE_HARA_RPC");fs.writeFileSync(join(home,"Library/Keychains/login.keychain-db"),"PLAIN_FIXTURE_NOT_A_KEYCHAIN");
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return{root,home,work,policy(tier="full-protected",runtimeId="codex") {const p=createRuntimeExecutionPolicy({runtimeId,tier,accountHome:home,workRoot:work});t.after(()=>p.close());return p;}};
}
function execute(p,code,env={}) {const launch=p.wrap({command:process.execPath,args:["-e",code],env:{...process.env,...env}});return spawnSync(launch.command,launch.args,{env:launch.env,encoding:"utf8",timeout:5000});}

test("real Seatbelt permits only the full tier's working directory and own runtime state, with credential/Hara masks",{skip:process.platform!=="darwin"},t=>{
  const f=fixture(t),p=f.policy();
  const script=`const f=require('fs'),p=${JSON.stringify(f)},o={};for(const [k,fn] of Object.entries({work:()=>f.writeFileSync(p.work+'/ok.txt','ok'),state:()=>f.writeFileSync(p.home+'/.codex/sessions/ok','ok'),haraWrite:()=>f.writeFileSync(p.home+'/.hara/no','no'),haraRead:()=>f.readFileSync(p.home+'/.hara/serve-v2.json'),foreignRead:()=>f.readFileSync(p.home+'/.claude/.credentials.json'),ownRead:()=>f.readFileSync(p.home+'/.codex/auth.json'),ownWrite:()=>f.writeFileSync(p.home+'/.codex/auth.json','no'),keychainWrite:()=>f.writeFileSync(p.home+'/Library/Keychains/login.keychain-db','no'),outside:()=>f.writeFileSync(p.root+'/outside/no','no'),link:()=>f.linkSync(p.home+'/.claude/.credentials.json',p.work+'/alias')})){try{fn();o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`;
  const out=execute(p,script,{HOME:f.home,CODEX_HOME:join(f.home,".codex")});assert.equal(out.status,0,out.stderr);
  assert.deepEqual(JSON.parse(out.stdout),{work:true,state:true,haraWrite:false,haraRead:false,foreignRead:false,ownRead:true,ownWrite:false,keychainWrite:false,outside:false,link:false});
  assert.ok(p.profile.includes('global-name "com.apple.securityd"')); // no service call or real Keychain read
});
test("controlled tier is externally read-only even with native sandbox disabled, and native nesting is unsuitable",{skip:process.platform!=="darwin"},t=>{
  const f=fixture(t),p=f.policy("controlled");
  let out=execute(p,`try{require('fs').writeFileSync(${JSON.stringify(join(f.work,"no.txt"))},'no');process.exit(4)}catch{console.log('write-denied')}`,{HOME:f.home});
  assert.equal(out.status,0,out.stderr);assert.match(out.stdout,/write-denied/);
  out=execute(p,`const r=require('child_process').spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/usr/bin/true'],{encoding:'utf8'});console.log(JSON.stringify({status:r.status,stderr:r.stderr}));`,{HOME:f.home});
  assert.equal(out.status,0,out.stderr);const nested=JSON.parse(out.stdout);assert.notEqual(nested.status,0);assert.match(nested.stderr,/sandbox_apply|Operation not permitted/);
});
test("a directory symlink cannot grant writes outside the working root and linked roots are rejected",{skip:process.platform!=="darwin"},t=>{
  const f=fixture(t);fs.symlinkSync(join(f.root,"outside"),join(f.work,"escape"));const p=f.policy();
  const out=execute(p,`try{require('fs').writeFileSync(${JSON.stringify(join(f.work,"escape/no"))},'no');process.exit(4)}catch{console.log('denied')}`,{HOME:f.home});
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
