import test from "node:test";
import assert from "node:assert/strict";
import {cliMcpFixture,until} from "./helpers/workspace-cli-mcp.mjs";
import {done,exchange,tier} from "./helpers/runtime-permission-process.mjs";
import { DEFAULT_TIER, FULL_TIER_SKIP, SEATBELT } from "./helpers/platform-tier.mjs";
test("S3 reuses an outer sandbox per tier and recycles it on a new frozen tier while resuming the same thread",{skip:FULL_TIER_SKIP},async t=>{
 const f=await cliMcpFixture(t,"list");let v=await exchange(f,"List current colleagues?");assert.equal(v.conversation.state,"completed",v.conversation.blockReason);const a=f.meta();
 assert.equal(v.conversation.permissionTier,"full-protected");
 v=await exchange(f,"List current colleagues again?");assert.equal(v.conversation.state,"completed");assert.equal(f.meta().pid,a.pid);
 await tier(f,"controlled");v=await f.read();assert.equal(v.conversation.permissionTier,"full-protected","old task remains frozen");
 v=await exchange(f,"List current colleagues with controlled access?");assert.equal(v.conversation.state,"completed");assert.equal(v.conversation.permissionTier,"controlled");assert.notEqual(f.meta().pid,a.pid);
 const requests=f.native().filter(x=>["thread/start","thread/resume"].includes(x.method));assert.deepEqual(requests.map(x=>x.method),["thread/start","thread/resume"]);
 const turns=f.native().filter(x=>x.method==="turn/start");assert.equal(turns.length,3);assert.ok(turns.every(x=>x.params.threadId===turns[0].params.threadId));assert.equal(requests.at(-1).params.threadId,turns[0].params.threadId);assert.equal(requests[0].params.sandbox,"danger-full-access");assert.equal(requests.at(-1).params.sandbox,"read-only");assert.equal(requests.at(-1).params.approvalPolicy,"never");
 assert.ok(f.native().filter(x=>x.method==="turn/start").every(x=>!Object.hasOwn(x.params,"sandboxPolicy")));
});
test("actual native file change closes a simple file task and persists observed risk separately",{skip:FULL_TIER_SKIP},async t=>{
 const f=await cliMcpFixture(t,"native-write");const v=await exchange(f,"Write native-result.txt");
 assert.equal(v.conversation.state,"completed",JSON.stringify(v.conversation));assert.equal(v.conversation.completion.state,"verified");assert.match(v.conversation.completion.evidence.join(" "),/native-workspace-diff/);
 f.mode("risk");const risky=await exchange(f,"Inspect publication status");assert.equal(risky.conversation.nativeRisks.length,1);assert.equal(risky.conversation.nativeRisks[0].kind,"external-publish");assert.equal(risky.conversation.nativeRisks[0].state,"observed");assert.doesNotMatch(JSON.stringify(risky.conversation.nativeRisks),/PRIVATE_ARGUMENT/);
 await f.restart();const persisted=await f.read();assert.equal(persisted.conversation.nativeRisks[0].id,risky.conversation.nativeRisks[0].id);
});
