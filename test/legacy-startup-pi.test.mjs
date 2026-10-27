import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/legacy-startup-fixture.mjs";
// TAP diagnostics are only printed when a subtest finishes, so a file-deadline cancellation used to hide
// where this scenario stalled (live26 Intel). Mirror each phase to stderr immediately as well.
function phases(t,began){
  return label=>{const line=`inherited Pi ${label}: ${Date.now()-began}ms`;t.diagnostic(line);process.stderr.write(`${line}\n`);};
}

test("an inherited Pi colleague performs an actual synthetic file task and remains isolated from another Workspace",async t=>{
  const began=Date.now(),phase=phases(t,began),f=fixture(t),host=f.open();let watchdog;try{
    await host.initialize();const id=host.list().workspaces[0].workspaceId,a=host.snapshot(id).agents.find(row=>row.kind==="colleague"&&row.state==="active");
    phase("fixture initialized");
    const accepted=host.start("test",id,a.agentId,"生成 hello.md 並驗證",randomUUID());
    phase("task accepted");
    // Observation only: never fails or extends the test; reports the live task state while draining.
    watchdog=setInterval(()=>{try{const c=host.snapshot(id,a.agentId).conversation;phase(`task still draining (taskState=${c.taskState}, messages=${c.messages?.length??"?"})`);}catch(error){phase(`task still draining (snapshot failed: ${error.message})`);}},15000);watchdog.unref();
    await host.wait(accepted.runId);clearInterval(watchdog);
    phase("task drained");
    const conversation=host.snapshot(id,a.agentId).conversation;
    assert.equal(conversation.taskState,"completed",JSON.stringify(conversation));assert.equal(fs.readFileSync(join(f.root,"project",id,"hello.md"),"utf8"),"hello workspace\n");
    const other=host.createWorkspace("Other",host.list().revision);assert.equal(other.agents.length,1);assert.equal(other.connections.connections.length,0);
    assert.equal(host.workspaceFeatures(other.workspaceId).schedules.length,0);assert.equal(host.workspaceFeatures(other.workspaceId).skills.length,0);
  }finally{clearInterval(watchdog);await host.close();phase("host closed");}
});
