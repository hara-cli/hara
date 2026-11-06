import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
const done=v=>["completed","blocked","paused","cancelled"].includes(v.conversation.state);
const turns=f=>f.native().filter(row=>row.method==="turn/start");
test("native prose-only change gets one same-thread follow-up and then a typed resumable pause, without leaked reminders",async t=>{
 const f=await cliMcpFixture(t,"reply");await f.send("建一个负责video项目的同事");const v=await until(f.read,done);
 assert.equal(v.conversation.taskState,"paused");assert.equal(v.conversation.runUsage.modelCalls,2);assert.equal(v.conversation.runUsage.toolCalls,0);
 assert.equal(turns(f).length,2);assert.equal(turns(f)[0].params.threadId,turns(f)[1].params.threadId);
 assert.equal(turns(f)[0].pid,turns(f)[1].pid);assert.equal(f.native().some(row=>row.method==="thread/resume"),false);
 assert.doesNotMatch(JSON.stringify(v.conversation.history),/未见实际修改回执|previous prose-only|<system-reminder>/);
 assert.match(turns(f)[1].params.input[0].text,/previous prose-only/);assert.doesNotMatch(v.conversation.blockReason??"",/hara_runtime_failure_v1|Native CLI ended/);
 assert(v.conversation.history.some(row=>row.role==="assistant"&&/registered codex reply/.test(row.text)),"uncompleted prose remains available without claiming tool completion");
});
test("explicit Host follow-up can reach the editable colleague card, and cancellation creates nobody",async t=>{
 const f=await cliMcpFixture(t,"reply",{nextMode:"create-direct"});await f.send("建一个负责video项目的同事");const pending=await until(f.read,v=>v.approvals.length===1);
 assert.equal(turns(f).length,2);assert.equal(turns(f)[0].params.threadId,turns(f)[1].params.threadId);
 assert.equal(pending.agents.length,1);assert.doesNotMatch(JSON.stringify(pending.conversation.history),/previous prose-only/);
 await f.request("workspace.approval.respond",{...f.scope,approvalId:pending.approvals[0].id,approved:false});const ended=await until(f.read,done);
 assert.equal(ended.agents.length,1);assert.doesNotMatch(ended.conversation.blockReason??"",/Native CLI ended|hara_runtime_failure_v1/);
});
