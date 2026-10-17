import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";

const temporary=[];after(()=>{for(const path of temporary)fs.rmSync(path,{recursive:true,force:true});});
function dir(){const path=fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(),"hara-local-crash-")));temporary.push(path);return path;}
test("actual process death after writing recovers the frozen task, closes protocol history and does not rewrite the verified file",async()=>{
 const root=dir(),callerHome=dir(),first=new LocalWorkspaceHost(root),workspace=first.createWorkspace("Personal",first.list().revision);
 first.configureSynthetic(workspace.workspaceId,0);await first.close();
 const base=pathToFileURL(resolve("dist/workspace")).href+"/";
 const code=`import {LocalWorkspaceHost} from '${base}local-host.js';import {createWorkspaceSyntheticProvider} from '${base}synthetic-provider.js';import {randomUUID} from 'node:crypto';
 const host=new LocalWorkspaceHost(process.argv[1],{providerFactory(c,b,x){const p=createWorkspaceSyntheticProvider(c,b,x);return {...p,async turn(args){if(args.history.some(m=>m.role==='tool'&&m.results.some(r=>r.name==='workspace_write'))){console.log('AFTER_WRITE');await new Promise(()=>{});}return p.turn(args);}};}});
 host.start('child',process.argv[2],process.argv[3],'生成 hello.md 並驗證',randomUUID());process.stdin.resume();`;
 const child=spawn(process.execPath,["--input-type=module","--eval",code,root,workspace.workspaceId,workspace.selectedAgentId],{env:{PATH:process.env.PATH,HOME:callerHome,USERPROFILE:callerHome},stdio:["pipe","pipe","pipe"]});
 const exited=once(child,"exit");let stderr="";child.stderr.on("data",chunk=>stderr+=chunk);
 try{
  const ready=once(child.stdout,"data").then(([bytes])=>bytes.toString());
  assert.match(await Promise.race([ready,exited.then(([exitCode])=>{throw new Error(`isolated child exited before write: ${exitCode}: ${stderr}`);})]),/AFTER_WRITE/);
  const file=join(root,"project","hello.md"),before=fs.statSync(file),hash=createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  child.kill("SIGKILL");await exited;
  const restored=new LocalWorkspaceHost(root);try{
   const pending=restored.snapshot(workspace.workspaceId);assert.equal(pending.conversation.state,"needs_recovery");
   for(let i=0;i<pending.conversation.history.length;i++){const row=pending.conversation.history[i];if(row.role==="assistant"&&row.tools.length)assert.equal(pending.conversation.history[i+1]?.role,"tool");}
   const resumed=restored.start("resumed",workspace.workspaceId,workspace.selectedAgentId,"/continue",randomUUID(),true);await restored.wait(resumed.runId);
   const done=restored.snapshot(workspace.workspaceId);assert.equal(done.conversation.taskState,"completed");assert.equal(done.conversation.completion.state,"verified");
   assert.equal(fs.statSync(file).ino,before.ino,"resume must read/verify existing bytes instead of repeating the write");
   assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"),hash);
   assert.ok(done.conversation.runUsage.modelCalls>pending.conversation.runUsage.modelCalls,"usage survives resume rather than resetting");
  }finally{await restored.close();}
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}}
});
