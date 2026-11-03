import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRuntimeExecutionPolicy } from '../dist/agent-runtime/execution-policy.js';
// Only ordinary synthetic files under this task's fake HOME; no Keychain API or real CLI/login.
const rows={copilot:['.copilot/config.json','.copilot/session-state'],cursor:['.cursor/cli-config.json','.cursor/chats'],grok:['.grok/auth.json','.grok/sessions']};
for(const [runtimeId,[own,state]] of Object.entries(rows))for(const tier of ['controlled','full-protected'])test(runtimeId+' '+tier+' shared Seatbelt credential boundary',{skip:process.platform!=='darwin'},async()=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),'expanded-seatbelt-'))),account=join(root,'fake-home'),work=join(root,'work');let policy;
 try{
  for(const p of [work,join(account,state),join(account,'.codex'),join(account,'.hara')])fs.mkdirSync(p,{recursive:true});
  for(const p of [own,'.codex/auth.json','.hara/serve-v2.json'])fs.writeFileSync(join(account,p),'SYNTHETIC_FILE');
  policy=createRuntimeExecutionPolicy({runtimeId,tier,accountHome:account,workRoot:work,loginSource:'host'});
  const p={own:join(account,own),foreign:join(account,'.codex/auth.json'),hara:join(account,'.hara/serve-v2.json'),state:join(account,state,'session'),work:join(work,'out'),outside:join(root,'denied')};
  const code=`const fs=require('fs'),p=${JSON.stringify(p)},out={};for(const [k,f]of Object.entries({ownRead:()=>fs.readFileSync(p.own),ownWrite:()=>fs.writeFileSync(p.own,'x'),foreignRead:()=>fs.readFileSync(p.foreign),haraRead:()=>fs.readFileSync(p.hara),haraWrite:()=>fs.writeFileSync(p.hara,'x'),state:()=>fs.writeFileSync(p.state,'x'),work:()=>fs.writeFileSync(p.work,'x'),outside:()=>fs.writeFileSync(p.outside,'x')})){try{f();out[k]=true}catch{out[k]=false}}console.log(JSON.stringify(out));`;
  const launch=policy.wrap({command:process.execPath,args:['-e',code],env:{...process.env,HOME:account}});
  const child=spawnSync(launch.command,launch.args,{env:launch.env,encoding:'utf8',timeout:10000,maxBuffer:65536});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{ownRead:true,ownWrite:false,foreignRead:false,haraRead:false,haraWrite:false,state:true,work:tier==='full-protected',outside:false});
 }finally{await policy?.close();fs.rmSync(root,{recursive:true,force:true});}
});
