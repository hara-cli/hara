import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { WorkspaceExecutionAudit } from "../dist/workspace/execution-audit.js";

function fixture() {
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"hara-execution-audit-")));
  const catalog=new LocalWorkspaceCatalog(root),scope=catalog.create("Synthetic",1).scope;
  const storage=new WorkspaceResourceStorage(root,scope);storage.initialize();
  const runId=randomUUID(),agentId=`wa-${randomUUID()}`,audit=new WorkspaceExecutionAudit(storage,runId,agentId);
  const file=storage.run(()=>join(workspaceStateHome(),".hara",`execution-${runId}.json`));
  return{audit,storage,runId,agentId,file,close(){rmSync(root,{recursive:true,force:true});}};
}
test("an interrupted audit retains an unfinished physical call across reopening without inventing completion or a retry",()=>{
  const a=fixture();try{
    const index=a.audit.start("model",1,"provider");
    const reopened=new WorkspaceExecutionAudit(a.storage,a.runId,a.agentId);
    const pending=reopened.read().operations[index];
    assert.equal(pending.outcome,"running");assert.equal(pending.endedAt,null);assert.equal(pending.durationMs,null);assert.equal(pending.retryCount,0);
    for(let attempt=1;attempt<=10;attempt++)a.audit.retry(index,{provider:"SYNTHETIC_SECRET",model:"SYNTHETIC_SECRET",attempt,nextAttempt:attempt+1,kind:"timeout",delayMs:attempt,elapsedMs:attempt*2});
    const row=reopened.read().operations[index];assert.equal(row.retryCount,10);assert.equal(row.retries.length,8);assert.equal(row.retries[0].attempt,3);
    assert.equal(JSON.stringify(reopened.read()).includes("SYNTHETIC_SECRET"),false);
    a.audit.finish(index,5,"cancelled","cancelled");assert.equal(reopened.read().operations[index].outcome,"cancelled");
    assert.throws(()=>a.audit.finish(index,6,"completed",null),/already ended/);
  }finally{a.close();}
});
test("malformed retry telemetry and foreign generation audits fail closed while retaining existing bytes",()=>{
  const a=fixture();try{
    const index=a.audit.start("tool",1,"workspace_read"),original=readFileSync(a.file,"utf8");
    assert.throws(()=>a.audit.retry(index,{attempt:1,nextAttempt:2,kind:"timeout",delayMs:Infinity,elapsedMs:0}),/invalid Workspace execution audit/);
    assert.equal(readFileSync(a.file,"utf8"),original);
    const foreign=JSON.parse(original);foreign.resourceBinding.generation=randomUUID();const changed=JSON.stringify(foreign)+"\n";writeFileSync(a.file,changed);
    assert.throws(()=>a.audit.read(),/invalid Workspace execution audit/);
    assert.throws(()=>a.audit.finish(index,1,"completed",null),/invalid Workspace execution audit/);
    assert.equal(readFileSync(a.file,"utf8"),changed);
  }finally{a.close();}
});
