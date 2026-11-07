import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createRuntimeExecutionPolicy} from '../dist/agent-runtime/execution-policy.js';
import {codexHostToolOverrides} from '../dist/agent-runtime/codex-host-config.js';
import {JsonlRpcClient,runExternalCommandCapture} from '../dist/external-sessions/process.js';
function tree(t){const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'codex-native-startup-'))),home=join(root,'account.with-dot'),work=join(root,'work');for(const dir of [join(home,'.codex'),join(home,'.hara'),join(home,'.claude'),work])fs.mkdirSync(dir,{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,home,work};}

test('Codex SQLite state whitelist matches dotted physical homes and denies configs, credentials, foreign stores and unrelated DBs',{skip:process.platform!=='darwin'},async t=>{
 const {home,work}=tree(t);fs.writeFileSync(join(home,'.codex/auth.json'),'SYNTHETIC_OWN_AUTH');fs.writeFileSync(join(home,'.claude/.credentials.json'),'SYNTHETIC_FOREIGN_AUTH');
 for(const tier of ['controlled','full-protected']){
  const policy=createRuntimeExecutionPolicy({runtimeId:'codex',tier,accountHome:home,workRoot:work,loginSource:'host'});
  try{
   const allowed=['state_5','logs_2','memories_1','queue_1','goals_1'].flatMap(name=>['','-wal','-shm','-journal'].map(suffix=>join(home,'.codex',name+'.sqlite'+suffix))).concat(join(home,'.codex/installation_id'));
   const denied=['.codex/auth.json','.codex/config.toml','.codex/other_1.sqlite','.codex/state_5.sqlite-secret','.claude/.credentials.json','.hara/write-denied'].map(file=>join(home,file));
   const script=`const fs=require('node:fs');const write=p=>{try{fs.writeFileSync(p,'fixture');return true;}catch{return false;}};console.log(JSON.stringify({allowed:${JSON.stringify(allowed)}.map(write),denied:${JSON.stringify(denied)}.map(write),foreign:(()=>{try{fs.readFileSync(${JSON.stringify(join(home,'.claude/.credentials.json'))});return true;}catch{return false;}})(),own:fs.readFileSync(${JSON.stringify(join(home,'.codex/auth.json'))},'utf8')}));`;
   const launch=policy.wrap({command:process.execPath,env:{HOME:home,PATH:dirname(process.execPath)+':/usr/bin:/bin'},args:['-e',script]});
   const result=await runExternalCommandCapture(launch,launch.args,{waitForClose:true});assert.equal(result.ok,true);
   const proof=JSON.parse(result.stdout);assert.ok(proof.allowed.every(Boolean));assert.ok(proof.denied.every(value=>!value));assert.equal(proof.foreign,false);assert.equal(proof.own,'SYNTHETIC_OWN_AUTH');
  }finally{await policy.close();}
 }
});

test('Codex model cache is the only extra writable basename and global system skills stay protected',{skip:process.platform!=='darwin'},async t=>{
 const {home,work}=tree(t),codex=join(home,'.codex'),cache=join(codex,'models_cache.json');
 fs.mkdirSync(join(codex,'skills/.system'),{recursive:true});
 for(const file of ['auth.json','config.toml','skills/.system/keep.fixture'])fs.writeFileSync(join(codex,file),'UNCHANGED');
 for(const tier of ['controlled','full-protected']){
  const policy=createRuntimeExecutionPolicy({runtimeId:'codex',tier,accountHome:home,workRoot:work,loginSource:'host'});
  try{
   const denied=['models_cache.json.tmp','models_cache.json.123','.models_cache.json.tmp','.tmpABC','models_cache.other.json','config.toml','auth.json','skills/.system/keep.fixture','skills/.system/new.fixture','../.hara/models_cache.json'].map(file=>join(codex,file));
   const script=`const fs=require('node:fs'),cache=${JSON.stringify(cache)};const attempt=fn=>{try{fn();return true;}catch{return false;}};fs.writeFileSync(cache,JSON.stringify({models:['fresh']}));const first=JSON.parse(fs.readFileSync(cache)).models[0];fs.writeFileSync(cache,JSON.stringify({models:['refreshed']}));console.log(JSON.stringify({first,second:JSON.parse(fs.readFileSync(cache)).models[0],denied:${JSON.stringify(denied)}.map(file=>attempt(()=>fs.writeFileSync(file,'bad'))),removeSystemSkill:attempt(()=>fs.unlinkSync(${JSON.stringify(join(codex,'skills/.system/keep.fixture'))}))}));`;
   const launch=policy.wrap({command:process.execPath,env:{HOME:home,PATH:dirname(process.execPath)+':/usr/bin:/bin'},args:['-e',script]});
   const result=await runExternalCommandCapture(launch,launch.args,{waitForClose:true});assert.equal(result.ok,true);
   const proof=JSON.parse(result.stdout);assert.equal(proof.first,'fresh');assert.equal(proof.second,'refreshed');assert.ok(proof.denied.every(value=>!value));assert.equal(proof.removeSystemSkill,false);
   fs.unlinkSync(cache);fs.symlinkSync(join(codex,'config.toml'),cache);
   const alias=policy.wrap({command:process.execPath,env:{HOME:home,PATH:dirname(process.execPath)+':/usr/bin:/bin'},args:['-e',`try{require('node:fs').writeFileSync(${JSON.stringify(cache)},'bad');process.exitCode=2;}catch{}`]});
   assert.equal((await runExternalCommandCapture(alias,alias.args,{waitForClose:true})).ok,true);fs.unlinkSync(cache);
   for(const file of ['auth.json','config.toml','skills/.system/keep.fixture'])assert.equal(fs.readFileSync(join(codex,file),'utf8'),'UNCHANGED');
  }finally{await policy.close();}
 }
 const protectedPolicy=createRuntimeExecutionPolicy({runtimeId:'codex',tier:'full-protected',accountHome:home,workRoot:work,protectedStateRoots:[cache]});
 try{
  const launch=protectedPolicy.wrap({command:process.execPath,env:{HOME:home,PATH:dirname(process.execPath)+':/usr/bin:/bin'},args:['-e',`try{require('node:fs').writeFileSync(${JSON.stringify(cache)},'bad');process.exitCode=2;}catch{}`]});
  assert.equal((await runExternalCommandCapture(launch,launch.args,{waitForClose:true})).ok,true);
 }finally{await protectedPolicy.close();}
});

const native=process.env.HARA_CODEX_TEST_BIN;
test('real Codex metadata rejects an enabled-only MCP table but initializes with inert transports under the unchanged outer boundary',{skip:process.platform!=='darwin'||!native?'Explicit native metadata binary required; zero model requests':false},async t=>{
 const {home,work}=tree(t);const config=join(home,'.codex/config.toml');
 fs.mkdirSync(join(home,'.codex/skills/.system'),{recursive:true});fs.writeFileSync(join(home,'.codex/skills/.system/keep.fixture'),'UNCHANGED');
 fs.writeFileSync(config,'[mcp_servers.personal]\ncommand="SECRET_NEVER_EXECUTE"\n[mcp_servers.personal.env]\nTOKEN="SYNTHETIC_NEVER_IN_ARGV"\n[mcp_servers.personal-http]\nurl="https://example.invalid/private-mcp"\n[skills.bundled]\nenabled=true\n');const before=fs.readFileSync(config);
 const policy=createRuntimeExecutionPolicy({runtimeId:'codex',tier:'controlled',accountHome:home,workRoot:work,loginSource:'host'});
 try{
  const env={HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),PATH:dirname(native)+':/usr/bin:/bin'};
  const init=async args=>{let stderr='';const launch=policy.wrap({command:native,env,args:['app-server','--stdio',...args]});const client=JsonlRpcClient.start({...launch,appServerArgs:launch.args,captureErrorFirstLine:true,timeoutMs:10000,spawnProcess:(command,argv,options)=>{const child=spawn(command,argv,options);child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(0,65536);});return child;}});try{const initialized=await client.call('initialize',{clientInfo:{name:'hara',version:'1.0.2'},capabilities:{experimentalApi:true}});client.notify('initialized');await client.call('thread/start',{cwd:work,ephemeral:false,sandbox:'danger-full-access',approvalPolicy:'never',approvalsReviewer:'user',model:'gpt-6.1-sol'});return {initialized,systemSkillsUpdateAttempted:/failed to install system skills/.test(stderr)};}finally{client.close();await client.waitForClose();}};
  await assert.rejects(init(['-c','mcp_servers={}','-c','mcp_servers."personal".enabled=false']),error=>/invalid transport/.test(error.errorFirstLine));
  const overrides=codexHostToolOverrides(home);assert.doesNotMatch(JSON.stringify(overrides),/SECRET_NEVER_EXECUTE|SYNTHETIC_NEVER_IN_ARGV|example.invalid/);
  const result=await init(['-c','mcp_servers={}',...overrides]);assert.ok(result.initialized);assert.equal(result.systemSkillsUpdateAttempted,false);assert.equal(fs.readFileSync(join(home,'.codex/skills/.system/keep.fixture'),'utf8'),'UNCHANGED');assert.deepEqual(fs.readFileSync(config),before);
 }finally{await policy.close();}
});


test('host startup disables built-in apps/connectors alongside global plugins and hooks', t => {
 const {home}=tree(t), overrides=codexHostToolOverrides(home);
 for (const setting of ['features.apps=false','features.plugins=false','features.hooks=false']) {
  const index=overrides.indexOf(setting);assert.ok(index>0);assert.equal(overrides[index-1],'-c');
 }
});
