import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { WorkspaceConversationStore } from "../dist/workspace/conversations.js";
import { WorkspaceContextCompactions, contextSummary } from "../dist/workspace/context-compaction.js";
import { CodexHistoryBoundaries } from "../dist/workspace/codex-history-boundary.js";
import { codexCompactionThreshold, nativeContextLimit } from "../dist/workspace/codex-thread.js";
function fixture(t) {
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),"hara-native-boundary-")));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const storage=new WorkspaceResourceStorage(root,{schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();
 const source=new WorkspaceConversationStore(storage,"ag_"+randomUUID()).read();source.history=[{role:"user",content:"new hello"}];source.task={objective:"current goal",status:"running",workspaceRunBinding:{runId:randomUUID()}};
 return {storage,source,ledger:new WorkspaceContextCompactions(storage,source.agentId,source.sessionId),boundaries:new CodexHistoryBoundaries(storage,source.agentId,source.sessionId)};
}
test("native thresholds leave headroom below the existing hard cap and do not compact a fresh21k context",t=>{
 const f=fixture(t),large={modelContextWindow:475000},small={modelContextWindow:32000},unknown={modelContextWindow:null};
 assert.equal(nativeContextLimit(large),96000);assert.equal(codexCompactionThreshold(large),67200);assert.equal(codexCompactionThreshold(small),16800);assert.equal(codexCompactionThreshold(unknown),67200);
 f.source.history.push({role:"user",content:"second short request"});
 const plan=tokens=>f.ledger.plan(f.source,{runtimeId:"codex",sourceKey:"a".repeat(64),tokens,idle:true,tokenThreshold:codexCompactionThreshold(large)});
 assert.equal(plan(20789),null);assert.ok(plan(70000));assert.equal(nativeContextLimit(large),96000);
});
test("write-ahead boundaries apply only to committed resets, survive reopen, and keep old facts out of the new seed",t=>{
 const f=fixture(t),requestId=randomUUID();f.source.history=Array.from({length:48},()=>({role:"user",content:"OLD-PRIVATE-TASK"}));
 f.source.pastTasks=[{task:{objective:"OLD-PRIVATE-GOAL",status:"completed"}}];
 f.boundaries.record(requestId,48,[]);assert.equal(f.boundaries.read([],48),0,"uncommitted reset must not drop history");
 const resets=[{requestId}];assert.equal(f.boundaries.read(resets,48),48);
 f.boundaries.record(randomUUID(),48,resets);assert.equal(new CodexHistoryBoundaries(f.storage,f.source.agentId,f.source.sessionId).read(resets,48),48);
 f.source.history.push({role:"user",content:"fresh current request"});const before=JSON.stringify(f.source);
 assert.equal(f.ledger.plan(f.source,{runtimeId:"codex",sourceKey:"b".repeat(64),tokens:null,idle:true,historyBoundary:48,tokenThreshold:67200}),null);
 assert.doesNotMatch(JSON.stringify(contextSummary(f.source,48)),/OLD-PRIVATE/);assert.match(JSON.stringify(contextSummary(f.source,48)),/current goal/);
 assert.equal(JSON.stringify(f.source),before);assert.throws(()=>f.boundaries.read(resets,47),/behind/);
 assert.equal(new CodexHistoryBoundaries(f.storage,f.source.agentId,randomUUID()).read(resets,49),0,"other sessions cannot inherit the boundary");
});
test("legacy internal reminders neither trigger the human-message threshold nor enter recent summary prose",t=>{
 const f=fixture(t);f.source.history.unshift(...Array.from({length:50},()=>({role:"user",content:"<system-reminder>INTERNAL-NOT-A-PERSON</system-reminder>"})));
 assert.equal(f.ledger.plan(f.source,{runtimeId:"codex",sourceKey:"c".repeat(64),tokens:20789,idle:true,tokenThreshold:67200}),null);
 assert.doesNotMatch(JSON.stringify(contextSummary(f.source)),/INTERNAL-NOT-A-PERSON/);
});
