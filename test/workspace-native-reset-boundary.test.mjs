import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
const done=v=>["completed","blocked","paused","cancelled"].includes(v.conversation.state);
async function exchange(f,text){await f.send(text);return until(f.read,done);}
test("manual new native session persists a history boundary and never seeds old48 messages after reopen",async t=>{
 const f=await cliMcpFixture(t,"reply",{contextInput:21000});assert.equal((await exchange(f,"你好")).conversation.state,"completed");
 const file=fs.readdirSync(f.root,{recursive:true}).find(name=>/(?:^|\/)conversation-[a-f0-9-]+\.json$/.test(name));assert(file);
 const path=join(f.root,file),state=JSON.parse(fs.readFileSync(path,"utf8"));
 state.history.push(...Array.from({length:48},(_,i)=>({role:"user",content:"BEFORE-MANUAL-RESET-"+i})));state.revision+=1;fs.writeFileSync(path,JSON.stringify(state));
 const before=await f.read(),oldTurns=f.native().filter(row=>row.method==="turn/start"),requestId=randomUUID();
 const fields={...f.scope,agentId:f.main.agentId,expectedRevision:before.conversation.revision,expectedNativeRevision:before.conversation.nativeSession.revision,requestId,approved:true};
 await f.request("workspace.session.new",fields);await f.restart();
 assert.equal((await f.request("workspace.session.new",fields)).duplicate,true);
 f.mode({mode:"reply",contextInput:21000});const fresh=await exchange(f,"你好");assert.equal(fresh.conversation.state,"completed");
 assert.equal(fresh.conversation.contextCompactions.length,0);assert.deepEqual(fresh.conversation.history.slice(0,state.history.length),before.conversation.history);
 const first=f.native().filter(row=>row.method==="turn/start").at(-1);assert.notEqual(first.params.threadId,oldTurns[0].params.threadId);assert.doesNotMatch(first.params.input[0].text,/hara-context-summary|BEFORE-MANUAL-RESET/);
 const second=await exchange(f,"你好");assert.equal(second.conversation.state,"completed");assert.equal(f.native().filter(row=>row.method==="thread/compact/start").length,0);
});
