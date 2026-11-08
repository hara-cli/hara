import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {LocalWorkspaceHost} from '../dist/workspace/local-host.js';
import {startLocalWorkspaceServe} from '../dist/serve/local-workspace.js';
import {localeDescriptor,withClientLocale} from '../dist/i18n/locale.js';
import {composeSystem} from '../dist/agent/loop.js';
import {scriptedWorkspaceProvider} from './fixtures/scripted-workspace-provider.mjs';
test('locale is turn-only; switching language preserves S3 static/session prefix bytes',()=>{
 const parts=tag=>withClientLocale(localeDescriptor(tag),()=>composeSystem('/fixture/project').parts);
 const a=parts('en'),b=parts('zh-Hans');assert.deepEqual(a.filter(p=>p.stability!=='turn'),b.filter(p=>p.stability!=='turn'));assert(a.some(p=>p.stability==='turn'&&p.content.includes('Interface language: en.')));assert(b.some(p=>p.stability==='turn'&&p.content.includes('Interface language: zh-Hans.')));
});
test('real loopback RPC accepts en/Hans/legacy clients, rejects metadata/extra fields without mutation and isolates fake-provider runs',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'hara-i18n-rpc-')));let handle;const sockets=[],pending=new Map();t.after(async()=>{for(const p of pending.values())clearTimeout(p.timer);for(const s of sockets)s.terminate();await handle?.close();fs.rmSync(root,{recursive:true,force:true});});
 const seed=new LocalWorkspaceHost(root),view=seed.createWorkspace('我的空間',seed.list().revision);seed.configureSynthetic(view.workspaceId,0);const agents=seed.context(view.workspaceId).resources.agents;const a=agents.create({username:'alpha',profile:{displayName:'Alpha'}},agents.list().revision),b=agents.create({username:'beta',profile:{displayName:'Beta'}},agents.list().revision);await seed.close();
 const calls=[];handle=await startLocalWorkspaceServe({host:'127.0.0.1',port:0,cwd:root},{root,version:'i18n-fixture',providerFactory(_connection,binding,ctx){return scriptedWorkspaceProvider({id:'openai',model:binding.model,async turn(args){await new Promise(r=>setImmediate(r));calls.push({agent:ctx.agent.agentId,request:args});return{text:'Hello.',toolUses:[],stop:'end',usage:{input:1,output:1}};}});}});
 let serial=0;
 const connect=async(tag)=>{const socket=new WebSocket('ws://127.0.0.1:'+handle.port);sockets.push(socket);socket.on('message',data=>{const row=JSON.parse(data),p=pending.get(row.id);if(!p)return;pending.delete(row.id);clearTimeout(p.timer);p.resolve(row);});await once(socket,'open');const raw=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>reject(Error('fixture RPC timeout')),10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});const rpc=async(method,params={})=>{const reply=await raw(method,{...params,...(tag?{clientLocale:localeDescriptor(tag)}:{})});assert(!reply.error,JSON.stringify(reply.error));return reply.result;};const init=await rpc('initialize',{token:handle.token});assert(init.capabilities.includes('workspace.i18n.v1'));await rpc('workspace.select',{workspaceId:view.workspaceId,expectedRevision:init.workspace.revision});return{raw,rpc};};
 const en=await connect('en'),zh=await connect('zh-Hans'),legacy=await connect();const scope={workspaceId:view.workspaceId,expectedGeneration:(await en.rpc('workspace.snapshot',{workspaceId:view.workspaceId,agentId:a.agentId})).resourceGeneration};
 assert.equal((await legacy.rpc('workspace.list')).workspaces[0].labelSource,'default');assert.equal((await zh.rpc('workspace.list')).workspaces[0].label,'我的空間');
 const before=JSON.stringify(await en.rpc('workspace.list'));
 for(const bad of [{tag:'zh-Hans',fallback:['zh-Hant','en']},{tag:'en',fallback:[],inject:'secret'},'zh-Hans']){const row=await en.raw('workspace.create',{label:'must not create',expectedRevision:1,clientLocale:bad});assert.equal(row.error.data.code,'locale_invalid');}
 const extra=await en.raw('workspace.list',{clientLocale:localeDescriptor('en'),extra:true});assert.equal(extra.error.data.code,'fields_unsupported');assert.equal(JSON.stringify(await en.rpc('workspace.list')),before);
 const invalid=await zh.raw('workspace.session.send',{...scope,agentId:a.agentId,message:'',requestId:randomUUID(),clientLocale:localeDescriptor('zh-Hans')});assert.equal(invalid.error.data.code,'message_invalid');assert.deepEqual(invalid.error.data.params,{});assert.equal(calls.length,0);
 await en.rpc('workspace.agent.select',{...scope,agentId:a.agentId});await zh.rpc('workspace.agent.select',{...scope,agentId:b.agentId});
 await Promise.all([en.rpc('workspace.session.send',{...scope,agentId:a.agentId,message:'👍',requestId:randomUUID(),source:'ui'}),zh.rpc('workspace.session.send',{...scope,agentId:b.agentId,message:'👍',requestId:randomUUID(),source:'ui'})]);
 const end=Date.now()+45000;while(Date.now()<end){const values=await Promise.all([en.rpc('workspace.snapshot',{workspaceId:view.workspaceId,agentId:a.agentId}),zh.rpc('workspace.snapshot',{workspaceId:view.workspaceId,agentId:b.agentId})]);if(values.every(v=>!['running','draining'].includes(v.conversation.state)))break;await new Promise(r=>setTimeout(r,20));}
 assert(calls.some(c=>c.agent===a.agentId));assert(calls.some(c=>c.agent===b.agentId));for(const call of calls){const expected=call.agent===a.agentId?'en':'zh-Hans';assert(JSON.stringify(call.request).includes('Interface language: '+expected+'.'));}
});
