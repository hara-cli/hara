import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {cliMcpFixture,until} from "./helpers/workspace-cli-mcp.mjs";
const done=v=>["completed","blocked","paused","cancelled"].includes(v.conversation.state);
async function exchange(f,q){await f.send(q);return until(f.read,done);}
async function tier(f,value){const v=await f.read(),a=v.agents.find(x=>x.agentId===f.main.agentId);return f.request("workspace.agents.setPermissionTier",{...f.scope,agentId:a.agentId,permissionTier:value,configRevision:a.configRevision,agentEpoch:a.agentEpoch});}
test("S3 reuses an outer sandbox per tier and recycles it on a new frozen tier while resuming the same thread",async t=>{
 const f=await cliMcpFixture(t,"list");let v=await exchange(f,"List current colleagues?");assert.equal(v.conversation.state,"completed",v.conversation.blockReason);const a=f.meta();
 assert.equal(v.conversation.permissionTier,"full-protected");
 v=await exchange(f,"List current colleagues again?");assert.equal(v.conversation.state,"completed");assert.equal(f.meta().pid,a.pid);
 await tier(f,"controlled");v=await f.read();assert.equal(v.conversation.permissionTier,"full-protected","old task remains frozen");
 v=await exchange(f,"List current colleagues with controlled access?");assert.equal(v.conversation.state,"completed");assert.equal(v.conversation.permissionTier,"controlled");assert.notEqual(f.meta().pid,a.pid);
 const requests=f.native().filter(x=>["thread/start","thread/resume"].includes(x.method));assert.deepEqual(requests.map(x=>x.method),["thread/start","thread/resume","thread/resume"]);
 assert.equal(requests[2].params.threadId,requests[1].params.threadId);assert.equal(requests[0].params.sandbox,"danger-full-access");assert.equal(requests[2].params.sandbox,"danger-full-access");assert.equal(requests[2].params.approvalPolicy,"never");
 assert.ok(f.native().filter(x=>x.method==="turn/start").every(x=>!Object.hasOwn(x.params,"sandboxPolicy")));
});
test("actual native file change closes a simple file task and persists observed risk separately",async t=>{
 const f=await cliMcpFixture(t,"native-write");const v=await exchange(f,"Write native-result.txt");
 assert.equal(v.conversation.state,"completed",JSON.stringify(v.conversation));assert.equal(v.conversation.completion.state,"verified");assert.match(v.conversation.completion.evidence.join(" "),/native-workspace-diff/);
 f.mode("risk");const risky=await exchange(f,"Inspect publication status");assert.equal(risky.conversation.nativeRisks.length,1);assert.equal(risky.conversation.nativeRisks[0].kind,"external-publish");assert.equal(risky.conversation.nativeRisks[0].state,"observed");assert.doesNotMatch(JSON.stringify(risky.conversation.nativeRisks),/PRIVATE_ARGUMENT/);
 await f.restart();const persisted=await f.read();assert.equal(persisted.conversation.nativeRisks[0].id,risky.conversation.nativeRisks[0].id);
});
test("controlled native tools cannot write; a claimed native write without a diff cannot complete",async t=>{
 const f=await cliMcpFixture(t,"native-write");await tier(f,"controlled");let v=await exchange(f,"Write native-result.txt");
 assert.notEqual(v.conversation.state,"completed");assert.equal(f.meta().writeDenied,true);assert.notEqual(v.conversation.completion?.state,"verified");
 await tier(f,"full-protected");f.mode("native-claim");v=await exchange(f,"Write native-result.txt");assert.notEqual(v.conversation.state,"completed");assert.notEqual(v.conversation.completion?.state,"verified");
});
test("tier updates reject a running or draining bot and unsupported RPC paths",async t=>{
 const f=await cliMcpFixture(t,"hang");await f.send("List current colleagues?");await until(async()=>f.meta(),Boolean);
 await assert.rejects(tier(f,"controlled"),/running or draining/);const v=await f.read();await f.request("workspace.session.cancel",{...f.scope,agentId:f.main.agentId,runId:v.conversation.runId});await until(f.read,done);
 await assert.rejects(f.request("workspace.agents.setPermissionTier",{...f.scope,agentId:f.main.agentId,permissionTier:"full-protected",configRevision:1,agentEpoch:1,workRoot:"/"}),/unsupported/);
});

test("S3 attempt drain removes shell/background descendants while the same app-server handles the next message",async t=>{
 const {execFileSync}=await import("node:child_process");const alive=pid=>{try{return !execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim().startsWith('Z');}catch{return false;}};
 const f=await cliMcpFixture(t,"background");const first=await exchange(f,"List current colleagues?");assert.equal(first.conversation.state,"completed",first.conversation.blockReason);const a=f.meta();assert.equal(alive(a.backgroundPid),false);assert.equal(alive(a.toolPid),false);assert.equal(alive(a.pid),true);
 f.mode("list");const next=await exchange(f,"List current colleagues again?");assert.equal(next.conversation.state,"completed");assert.equal(f.meta().pid,a.pid);assert.equal(f.native().filter(x=>x.method==="thread/start").length,1);assert.equal(f.native().filter(x=>x.method==="thread/resume").length,1);
});
