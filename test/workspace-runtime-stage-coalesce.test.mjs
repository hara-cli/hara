import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {LocalWorkspaceHost} from "../dist/workspace/local-host.js";
import {WorkspaceResourceStorage,currentWorkspaceResourceBinding,workspaceStateHome} from "../dist/workspace/resource-context.js";
import {RuntimeStageRecorder,WorkspaceRuntimeStageStore} from "../dist/workspace/runtime-stage-events.js";
const save=(job,force=false)=>LocalWorkspaceHost.prototype.saveRuntimeStages.call({},job,force);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){const home=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"hara-stage-coalesce-")));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));let live=true;
 const scope={schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}};
 const storage=new WorkspaceResourceStorage(home,scope,()=>{if(!live)throw new Error("authority revoked");});storage.initialize();
 const identity={workspaceId:scope.workspaceId,resourceGeneration:storage.run(()=>currentWorkspaceResourceBinding().generation),agentId:"ag_"+randomUUID(),sessionId:randomUUID(),runId:randomUUID(),attemptId:randomUUID(),historyStart:0};
 const store=new WorkspaceRuntimeStageStore(storage,identity.sessionId,identity.agentId),runtimeStages=new RuntimeStageRecorder(identity,{id:"codex",version:"1.2.3",loginSource:"host",model:"fixture",effort:"medium"});
 const file=storage.run(()=>path.join(workspaceStateHome(),".hara","runtime-stages-"+identity.sessionId+".json"));
 return{store,runtimeStages,file,job:{stageStore:store,runtimeStages,stageSavedAt:0},revoke(){live=false;}};
}
test("a queued running projection cannot overwrite a synchronously persisted terminal receipt",async t=>{
 const f=fixture(t);save(f.job,true);f.job.stageSavedAt=0;
 const end=f.runtimeStages.beginEvent("model_roundtrip",{call:1});save(f.job);end();save(f.job);
 f.runtimeStages.finish("completed");save(f.job,true);const terminal=f.store.list();assert.equal(terminal.at(-1).state,"completed");
 await tick();assert.deepEqual(f.store.list(),terminal);
});
test("deferred diagnostics recheck their original authority and failures remain optional",async t=>{
 const f=fixture(t);save(f.job,true);const original=fs.readFileSync(f.file,"utf8");f.job.stageSavedAt=0;
 f.runtimeStages.mark("first_output","host");save(f.job);f.revoke();await tick();
 assert.equal(fs.readFileSync(f.file,"utf8"),original);assert.throws(()=>f.store.list(),/authority revoked/);
 assert.doesNotThrow(()=>save({stageStore:f.store,runtimeStages:{snapshot(){throw new Error("optional snapshot failed");}}},true));
});
