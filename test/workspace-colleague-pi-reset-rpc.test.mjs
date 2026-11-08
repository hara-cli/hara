import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {fixture} from "./helpers/workspace-colleague-rpc.mjs";
test("Pi RPC reset preserves old UI history and excludes old seed context after reopen",async t=>{
 const f=await fixture(t);await f.select(f.b.agentId);await f.send("Hello",f.b.agentId);await f.settle(f.b.agentId);
 const file=fs.readdirSync(f.root,{recursive:true}).map(name=>join(f.root,name)).find(path=>/conversation-[a-f0-9-]+\.json$/.test(path)&&JSON.parse(fs.readFileSync(path,"utf8")).agentId===f.b.agentId);assert(file);const state=JSON.parse(fs.readFileSync(file,"utf8"));state.history.push(...Array.from({length:48},(_,i)=>({role:"user",content:"BEFORE-PI-RESET-"+i})));state.revision++;fs.writeFileSync(file,JSON.stringify(state));
 const previous=await f.read(f.b.agentId),requestId=randomUUID(),fields={...f.scope,agentId:f.b.agentId,expectedRevision:previous.conversation.revision,expectedNativeRevision:previous.conversation.nativeSession.revision,requestId,approved:true};
 assert.equal(previous.conversation.nativeSession.runtimeId,"pi");await f.rpc("workspace.session.new",fields);await f.restart();await f.select(f.b.agentId);assert.equal((await f.rpc("workspace.session.new",fields)).duplicate,true);
 const start=f.turns.length;await f.send("Hello",f.b.agentId);const view=await f.settle(f.b.agentId);assert.equal(view.conversation.history.length>previous.conversation.history.length,true);assert.equal(view.conversation.contextCompactions.length,0);assert(f.turns.length>start);
 for(const turn of f.turns.slice(start))assert.doesNotMatch(JSON.stringify({system:turn.system,history:turn.history}),/BEFORE-PI-RESET|hara-context-summary/);
});
