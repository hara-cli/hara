import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RuntimeStageRecorder, parseRuntimeStageReport } from "../dist/workspace/runtime-stage-events.js";
import { runtimeToolTargetLabel, isSafeRuntimeTargetLabel } from "../dist/workspace/runtime-tool-label.js";
const id=()=>({workspaceId:"ws_"+randomUUID(),resourceGeneration:randomUUID(),agentId:"ag_"+randomUUID(),sessionId:randomUUID(),runId:randomUUID(),attemptId:randomUUID(),historyStart:0});
const runtime={id:"codex",version:null,loginSource:"unknown",model:null,effort:null};
test("optional provenance/context/tool targets remain closed and legacy compatible",()=>{
 const r=new RuntimeStageRecorder(id(),runtime),old=r.snapshot();assert.ok(parseRuntimeStageReport(old));assert.equal(Object.hasOwn(old.runtime,"effortSource"),false);assert.equal(Object.hasOwn(old,"contextTokens"),false);
 r.setRuntime({effort:"low",effortSource:"auto"});r.setContextTokens(12345);const end=r.beginEvent("tool_call",{call:1,toolName:"workspace_read",targetLabel:"index.ts"});end();
 const value=r.snapshot();assert.equal(value.runtime.effortSource,"auto");assert.equal(value.contextTokens,12345);assert.equal(value.events[0].targetLabel,"index.ts");assert.equal(value.events[1].targetLabel,"index.ts");assert.ok(parseRuntimeStageReport(value));
 for(const patch of [{runtime:{...value.runtime,effortSource:"inferred"}},{contextTokens:-1},{contextTokens:1.5},{contextTokens:1000000001},{contextTokens:Infinity},{events:[{...value.events[0],targetLabel:"/private/home.txt"}]}])assert.throws(()=>parseRuntimeStageReport({...value,...patch}),/Invalid Runtime stage/);
});
test("queued is a measured host span; retry is a category-only host mark",()=>{
 const r=new RuntimeStageRecorder(id(),runtime),end=r.beginEvent("queued");end();r.markRetry("runtime_rate_limit");const v=r.snapshot();assert.deepEqual(v.events.map(x=>[x.kind,x.phase]),[["queued","start"],["queued","end"],["retry","mark"]]);assert.ok(parseRuntimeStageReport(v));
 for(const event of [{...v.events[2],phase:"start"},{...v.events[2],errorKind:null},{...v.events[2],source:"native_event"},{...v.events[0],toolName:"read_file"}])assert.throws(()=>parseRuntimeStageReport({...v,events:[{...event,seq:1}]}),/Invalid Runtime stage/);
});
test("target metadata is basename-only, bounded in Unicode and never invokes getters",()=>{
 for(const name of ["workspace_read","workspace_write","workspace_verify","read_file","edit_file","ls"])assert.equal(runtimeToolTargetLabel(name,{path:"src/index.ts"}),"index.ts");
 assert.equal(runtimeToolTargetLabel("workspace_read",{path:"目录/"+"文".repeat(60)+".ts"}),"文".repeat(39)+"…");
 for(const path of [".env",".hara/config.json","/Users/jeff/.ssh/id_rsa","secret.pem","auth.json","src/ghp_abcdefghijklmnopqrstuvwxyz","src/a\u202eb.ts","src/token=private.txt"])assert.equal(runtimeToolTargetLabel("read_file",{path}),undefined,path);
 assert.equal(runtimeToolTargetLabel("bash",{path:"index.ts"}),undefined);
 assert.equal(runtimeToolTargetLabel("read_file",{get path(){throw Error("getter must not run");}}),undefined);
 assert.equal(runtimeToolTargetLabel("read_file",new Proxy({},{getOwnPropertyDescriptor(){throw Error("observation fault");}})),undefined);
 assert.equal(isSafeRuntimeTargetLabel("../private.txt"),false);assert.equal(isSafeRuntimeTargetLabel("a".repeat(41)),false);
});
