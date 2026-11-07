import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { cliMcpFixture, until, waitForNativeRetryWindow } from "./helpers/workspace-cli-mcp.mjs";
import { changeStanding, controls, done, events, exchange, state, turns } from "./helpers/codex-second-turn.mjs";
// Split from workspace-codex-second-turn.test.mjs: unload variants and sticky default resolution.

for (const setting of [{unloadHang:true},{unloadStatus:"notSubscribed",probeUnsubscribeWait:true},{unloadStatus:"notLoaded"}])
 test(`unload ${JSON.stringify(setting)} resumes this same attempt once, with no stale-governance turn`, async t => {
 const f=await cliMcpFixture(t,"reply",setting);await exchange(f,"你好");const before=state(f),pid=f.meta().pid;
 await changeStanding(f);const recovered=await exchange(f,"你好");assert.equal(recovered.conversation.state,"completed",recovered.conversation.blockReason);
 assert.equal(state(f).threadId,before.threadId);assert.equal(turns(f).length,2);assert.equal(controls(f).at(-1).method,"thread/resume");
 assert.equal(recovered.conversation.runUsage.modelCalls,1);
 if(setting.unloadStatus==="notLoaded")assert.equal(f.meta().pid,pid);
 else {assert.notEqual(f.meta().pid,pid);assert.equal(turns(f).filter(row=>row.pid===pid).length,1);assert.throws(()=>process.kill(pid,0));}
 assert.equal(fs.existsSync(f.command+".unload-waited"),false,"notSubscribed closes promptly instead of waiting3s");
});

function inventory(efforts, defaults=true) {
 return {data:[{id:"fixture-model",displayName:"A",isDefault:true,supportedReasoningEfforts:["low","medium","high"].map(reasoningEffort=>({reasoningEffort}))},
  {id:"fixture-model-2",displayName:"B",supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort,...(defaults&&reasoningEffort==="none"?{isDefault:true}:{})}))}]};
}

test("medium switches to the declared none default with concrete per-turn model/effort instead of inheriting sticky medium", async t => {
 const data=inventory(["none"]),f=await cliMcpFixture(t,"list",{inventory:data});
 await f.request("workspace.runtime.selectModel",{...f.scope,runtimeId:"codex",modelId:"fixture-model",effort:"medium",expectedRevision:1});
 assert.equal((await exchange(f,"List colleagues before switching models")).conversation.state,"completed");const pid=f.meta().pid;
 await f.request("workspace.runtime.selectModel",{...f.scope,runtimeId:"codex",modelId:"fixture-model-2",effort:null,expectedRevision:2});
 assert.equal((await exchange(f,"List colleagues using the declared model default")).conversation.state,"completed");
 assert.equal(turns(f)[0].params.effort,"medium");assert.equal(turns(f)[1].params.effort,"none");assert.equal(turns(f)[1].params.model,"fixture-model-2");
 assert.equal(f.meta().effort,"none");assert.equal(f.meta().pid,pid);assert.deepEqual(controls(f).map(row=>row.method),["thread/start"]);
});

test("unknown default after concrete effort leaves direct and refuses a sticky inherited value before submitting another turn", async t => {
 const data=inventory([],false),f=await cliMcpFixture(t,"list",{inventory:data});
 await f.request("workspace.runtime.selectModel",{...f.scope,runtimeId:"codex",modelId:"fixture-model",effort:"medium",expectedRevision:1});
 assert.equal((await exchange(f,"List colleagues under medium")).conversation.state,"completed");const before=state(f);
 await f.request("workspace.runtime.selectModel",{...f.scope,runtimeId:"codex",modelId:"fixture-model-2",effort:null,expectedRevision:2});
 const failed=await exchange(f,"List colleagues under an unconfirmed default");assert.equal(failed.conversation.state,"blocked");
 assert.equal(turns(f).length,1);assert.equal(controls(f).at(-1).method,"thread/resume");
 assert.equal(state(f).threadId,before.threadId);assert.equal(state(f).resets.length,0);
 assert.match(failed.conversation.blockReason,/default model or reasoning effort is unconfirmed/);assert.match(failed.conversation.blockReason,/invalid_model/);
});
