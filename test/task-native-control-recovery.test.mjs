import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createTaskExecution,finishTaskExecution,continueTaskExecution,applyTaskCheckpoint,isTaskExecution,forkTaskExecution} from "../dist/session/task.js";
const start="2026-11-05T00:00:00.000Z",failedAt="2026-11-05T00:00:01.000Z",continuedAt="2026-11-05T00:00:02.000Z";
const next=task=>continueTaskExecution(task,{kind:"steer",expectedTurnId:task.turnId,turnId:randomUUID()},continuedAt);
test("explicit continuation consumes only a matching Host native-control blocker and never creates completion",()=>{
 const task=createTaskExecution("List current colleagues",randomUUID(),start);
 const failed=finishTaskExecution(task,{status:"error",error:"Control restore did not complete",nativeControlFailure:"codex_resume_failed_history_preserved"},[],false,failedAt);
 assert.ok(isTaskExecution(failed));assert.ok(failed.nativeControlFailure);
 const restored=JSON.parse(JSON.stringify(failed));assert.ok(isTaskExecution(restored));
 const resumed=next(restored);assert.ok(resumed.ok);assert.equal(resumed.task.status,"running");
 assert.equal(resumed.task.id,task.id);assert.equal(resumed.task.roundsUsed,failed.roundsUsed);assert.equal(resumed.task.roundBudgetLimit,failed.roundBudgetLimit);
 assert.equal(resumed.task.checkpoint.blockReason,undefined);assert.equal(resumed.task.checkpoint.blockedStep,undefined);
 assert.equal(resumed.task.checkpoint.completion,undefined);assert.equal(resumed.task.nativeControlFailure,undefined);
 assert.equal(failed.checkpoint.blockReason,"Control restore did not complete","old failure remains immutable");
 const fork=forkTaskExecution(restored,continuedAt);assert.ok(isTaskExecution(fork));
 assert.equal(fork.nativeControlFailure,undefined);assert.equal(fork.checkpoint.blockReason,failed.checkpoint.blockReason,"forked context never inherits transient-clear provenance");
});
test("ordinary errors and business blockers survive continuation even with native-looking prose",()=>{
 const task=createTaskExecution("List current colleagues",randomUUID(),start);
 const failed=finishTaskExecution(task,{status:"error",error:"hara_runtime_failure_v1=control restore failed"},[],false,failedAt);
 assert.equal(next(failed).task.checkpoint.blockReason,failed.checkpoint.blockReason);
 const business=applyTaskCheckpoint(task,{blocked_step:"confirm access",block_reason:"Human approval is still required"},failedAt);assert.ok(business.ok);
 const stopped=finishTaskExecution(business.task,{status:"error",error:"Control restore did not complete",nativeControlFailure:"codex_resume_failed_history_preserved"},[],false,failedAt);
 assert.equal(stopped.nativeControlFailure,undefined);assert.equal(next(stopped).task.checkpoint.blockReason,"Human approval is still required");
});
test("changed blocker text or provenance cannot clear a different checkpoint",()=>{
 const task=createTaskExecution("List current colleagues",randomUUID(),start);
 const failed=finishTaskExecution(task,{status:"error",error:"Control restore did not complete",nativeControlFailure:"codex_resume_failed_history_preserved"},[],false,failedAt);
 for(const replacement of [null,{...failed.nativeControlFailure,turnId:randomUUID()},{...failed.nativeControlFailure,blockReasonHash:"0".repeat(64)}]){
  const malformed={...failed,nativeControlFailure:replacement};assert.equal(isTaskExecution(malformed),false);
 }
 const changed={...failed,checkpoint:{...failed.checkpoint,blockReason:"Human approval is still required"}};
 assert.equal(isTaskExecution(changed),false);assert.equal(next(changed).task.checkpoint.blockReason,"Human approval is still required");
});
