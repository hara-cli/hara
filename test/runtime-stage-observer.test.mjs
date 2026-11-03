import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RuntimeStageRecorder } from "../dist/workspace/runtime-stage-events.js";
import { createRuntimeStageProcessObserver, runtimeStageErrorKind } from "../dist/agent-runtime/stage-observer.js";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";
function fixture(runtime = "codex") {
  let clock = 100;
  const recorder = new RuntimeStageRecorder({workspaceId:"ws_"+randomUUID(),resourceGeneration:randomUUID(),agentId:"ag_"+randomUUID(),
    sessionId:randomUUID(),runId:randomUUID(),attemptId:randomUUID(),historyStart:0},
    {id:runtime,version:"1.2.3",loginSource:"isolated",model:"fixture-model",effort:"medium"},{now:()=>clock});
  const controller=new AbortController();
  return {recorder,controller,advance:ms=>{clock+=ms;},observer:createRuntimeStageProcessObserver(recorder,runtime,controller.signal)};
}
test("native lifecycle and completed messages never masquerade as a first token, including split JSON",()=>{
 const f=fixture();f.advance(5);f.observer.onSpawn();
 f.observer.onStdout('{"type":"thread.st');f.advance(8);f.observer.onStdout('arted","thread_id":"native-private-id","token":"PRIVATE_SECRET"}\n');
 assert.equal(f.recorder.snapshot().events.some(e=>e.kind==="first_token"||e.kind==="first_output"),false);
 f.advance(20);f.observer.onStdout(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"PRIVATE_REPLY"},agentId:"forged"})+"\n");
 f.observer.finish(true);f.recorder.finish("completed");const r=f.recorder.snapshot();
 assert.equal(r.events.find(e=>e.kind==="cold_start"&&e.phase==="end").durationMs,13);
 assert.equal(r.events.filter(e=>e.kind==="first_output").length,1);assert.equal(r.events.some(e=>e.kind==="first_token"),false);
 for(const hidden of ["PRIVATE_SECRET","PRIVATE_REPLY","native-private-id","forged"])assert.equal(JSON.stringify(r).includes(hidden),false);
});
test("bounded noise and cancellation cannot fabricate output or revive terminal telemetry",()=>{
 const f=fixture();f.observer.onStdout("x".repeat(70_000)+"\n");f.observer.onStdout('{"type":"tool.output","text":"PRIVATE_TOOL"}\n');
 f.advance(10);f.controller.abort();f.observer.onStdout('{"type":"response.output_text.delta","delta":"PRIVATE_REPLY"}\n');
 f.observer.finish(false,"timeout");f.recorder.finish("cancelled");const before=JSON.stringify(f.recorder.snapshot());
 f.observer.onSpawn();f.observer.onStdout('{"type":"item.completed","item":{"type":"agent_message","text":"late"}}\n');
 assert.equal(JSON.stringify(f.recorder.snapshot()),before);assert.equal(f.recorder.snapshot().events.some(e=>e.kind==="first_token"||e.kind==="first_output"),false);
 assert.equal(f.recorder.snapshot().events.at(-1).outcome,"cancelled");
});
test("buffered Claude output is explicitly a host-delivery observation and errors retain only a closed category",()=>{
 const f=fixture("claude");f.observer.onSpawn();f.advance(15);f.observer.finish(true,undefined,true);f.recorder.finish("completed");
 const mark=f.recorder.snapshot().events.find(e=>e.kind==="first_output");assert.equal(mark.source,"host");
 assert.equal(f.recorder.snapshot().events.some(e=>e.kind==="first_token"),false);
 assert.equal(runtimeStageErrorKind('hara_runtime_failure_v1={"kind":"runtime_proxy","prompt":"PRIVATE"}'),"runtime_proxy");
 assert.equal(runtimeStageErrorKind("PRIVATE_PROVIDER_REPLY"),"runtime_failed");
});
test("OS spawn observer is optional and its failure cannot change command success",async()=>{
 let calls=0;const result=await runExternalCommandCapture({command:process.execPath},["-e","process.stdout.write('fixture')"],
  {onSpawn(){calls++;throw new Error("synthetic observer failure");},timeoutMs:5000});
 assert.equal(result.ok,true);assert.equal(calls,1);
});
