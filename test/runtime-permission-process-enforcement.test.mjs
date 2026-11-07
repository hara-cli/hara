import test from "node:test";
import assert from "node:assert/strict";
import {cliMcpFixture,until} from "./helpers/workspace-cli-mcp.mjs";
import {done,exchange,tier} from "./helpers/runtime-permission-process.mjs";
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
 f.mode("list");const next=await exchange(f,"List current colleagues again?");assert.equal(next.conversation.state,"completed");assert.equal(f.meta().pid,a.pid);assert.equal(f.native().filter(x=>x.method==="thread/start").length,1);assert.equal(f.native().filter(x=>x.method==="thread/resume").length,0);assert.equal(f.native().filter(x=>x.method==="turn/start").length,2);assert.equal(f.native().filter(x=>x.method==="thread/unsubscribe").length,0);
});
