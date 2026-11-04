import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {cliMcpFixture,until} from "./helpers/workspace-cli-mcp.mjs";
const done=v=>["completed","blocked","paused","cancelled"].includes(v.conversation.state);
const cold=v=>v.conversation.runtimeStages.at(-1).events.some(e=>e.kind==="cold_start");
async function exchange(f,text){await f.send(text);return until(f.read,done);}
const starts=f=>f.native().filter(r=>["thread/start","thread/resume"].includes(r.method));

test("initialized launcher child stays warm across fresh permits with one native PID/thread and no repeated cold_start",async t=>{
 const f=await cliMcpFixture(t,"list",{launcher:true});
 const first=await exchange(f,"List colleagues WARM-FIRST?");assert.equal(first.conversation.state,"completed",first.conversation.blockReason);
 const native=f.meta().pid,launcher=Number(fs.readFileSync(f.command+".launcher.pid","utf8"));
 assert.notEqual(native,launcher,"fixture must represent a real launcher/native process pair");assert.equal(cold(first),true);
 for(const text of ["List colleagues WARM-SECOND?","List colleagues WARM-THIRD?"]){
  const next=await exchange(f,text);assert.equal(next.conversation.state,"completed",next.conversation.blockReason);
  assert.equal(f.meta().pid,native);assert.equal(Number(fs.readFileSync(f.command+".launcher.pid","utf8")),launcher);
  assert.equal(next.conversation.sessionId,first.conversation.sessionId);assert.equal(cold(next),false);
 }
 const requests=starts(f),turns=f.native().filter(r=>r.method==="turn/start");
 assert.deepEqual(requests.map(r=>r.method),["thread/start","thread/resume","thread/resume"]);
 assert.equal(requests[1].params.threadId,requests[2].params.threadId);assert.equal(new Set(requests.map(r=>r.pid)).size,1);
 assert.equal(turns.length,3);assert.doesNotMatch(turns[1].params.input[0].text,/WARM-FIRST/);assert.doesNotMatch(turns[2].params.input[0].text,/WARM-FIRST|WARM-SECOND/);
});

test("launcher resident still recycles on frozen tier change and failed native process without replay",async t=>{
 const f=await cliMcpFixture(t,"list",{launcher:true});
 assert.equal((await exchange(f,"List current colleagues?")).conversation.state,"completed");const first=f.meta();
 const v=await f.read(),a=v.agents.find(r=>r.agentId===f.main.agentId);
 await f.request("workspace.agents.setPermissionTier",{...f.scope,agentId:a.agentId,permissionTier:"controlled",configRevision:a.configRevision,agentEpoch:a.agentEpoch});
 assert.equal((await exchange(f,"List colleagues with controlled tier?")).conversation.state,"completed");const controlled=f.meta();
 assert.notEqual(controlled.pid,first.pid);assert.equal(starts(f).at(-1).params.threadId,starts(f)[1].params.threadId);
 f.mode({mode:"crash",launcher:true});assert.equal((await exchange(f,"List colleagues with a failed process?")).conversation.state,"blocked");
 const before=f.native().filter(r=>r.method==="turn/start").length;assert.equal(before,3);
 f.mode({mode:"list",launcher:true});assert.equal((await exchange(f,"List colleagues after explicit recovery?")).conversation.state,"completed");
 assert.notEqual(f.meta().pid,controlled.pid);assert.notEqual(f.meta().tokenFingerprint,controlled.tokenFingerprint);
 assert.equal(f.native().filter(r=>r.method==="turn/start").length,4);assert.equal(starts(f).filter(r=>r.method==="thread/start").length,1);
});

test("unknown thread status cannot promote initialized descendants or dispatch a native turn",async t=>{
 const f=await cliMcpFixture(t,"list",{launcher:true,threadStatus:"unknown-native-state"});
 const view=await exchange(f,"List current colleagues?");assert.equal(view.conversation.state,"blocked");
 assert.equal(f.native().filter(r=>r.method==="turn/start").length,0);assert.equal(starts(f).length,1);
});
