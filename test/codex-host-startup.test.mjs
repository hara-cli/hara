import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
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

const native=process.env.HARA_CODEX_TEST_BIN;
test('real Codex metadata rejects an enabled-only MCP table but initializes with inert transports under the unchanged outer boundary',{skip:process.platform!=='darwin'||!native?'Explicit native metadata binary required; zero model requests':false},async t=>{
 const {home,work}=tree(t);const config=join(home,'.codex/config.toml');
 fs.writeFileSync(config,'[mcp_servers.personal]\ncommand="SECRET_NEVER_EXECUTE"\n[mcp_servers.personal.env]\nTOKEN="SYNTHETIC_NEVER_IN_ARGV"\n[mcp_servers.personal-http]\nurl="https://example.invalid/private-mcp"\n');const before=fs.readFileSync(config);
 const policy=createRuntimeExecutionPolicy({runtimeId:'codex',tier:'controlled',accountHome:home,workRoot:work,loginSource:'host'});
 try{
  const env={HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),PATH:dirname(native)+':/usr/bin:/bin'};
  const init=async args=>{const launch=policy.wrap({command:native,env,args:['app-server','--stdio',...args]});const client=JsonlRpcClient.start({...launch,appServerArgs:launch.args,captureErrorFirstLine:true,timeoutMs:10000});try{const initialized=await client.call('initialize',{clientInfo:{name:'hara',version:'1.0.2'},capabilities:{experimentalApi:true}});client.notify('initialized');await client.call('thread/start',{cwd:work,ephemeral:false,sandbox:'danger-full-access',approvalPolicy:'never',approvalsReviewer:'user',model:'gpt-6.1-sol'});return initialized;}finally{client.close();await client.waitForClose();}};
  await assert.rejects(init(['-c','mcp_servers={}','-c','mcp_servers."personal".enabled=false']),error=>/invalid transport/.test(error.errorFirstLine));
  const overrides=codexHostToolOverrides(home);assert.doesNotMatch(JSON.stringify(overrides),/SECRET_NEVER_EXECUTE|SYNTHETIC_NEVER_IN_ARGV|example.invalid/);
  assert.ok(await init(['-c','mcp_servers={}',...overrides]));assert.deepEqual(fs.readFileSync(config),before);
 }finally{await policy.close();}
});
