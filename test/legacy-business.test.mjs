import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { businessFixture, hash } from "./helpers/legacy-business-fixture.mjs";
import { WorkspaceLegacyBusiness } from "../dist/workspace/legacy-business.js";
import { WorkspaceLegacyOutcomes } from "../dist/workspace/legacy-outcomes.js";
import { LegacyScopedCli } from "../dist/workspace/legacy-cli.js";
import { legacyProcessLauncher } from "../dist/workspace/legacy-process.js";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { executeLegacyPrint } from "../dist/workspace/legacy-print.js";
const exec = promisify(execFile), cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const job = (id="one", extra={}) => ({id,name:id,mode:"command",task:"Fixture command; never a copied business script",cwd:"/copy/old-cwd",enabled:true,createdAt:0,schedule:{kind:"cron",expr:"* * * * *"},...extra});
async function fixture(t, extra={}) {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-biz-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=await businessFixture(root,[job("one",extra)]);let calls=0,sends=[];
  const options={
    commands:{authorize:f.grant,async launch(inv){calls++;inv.onOutput("stdout","fixture output\n");return{code:0,terminated:true};}},
    notifications:{authorize(review){return{review,assertCurrent(){},async send(message){sends.push(message);return{state:"sent",receiptId:"fixture_sent"};}};}},
  };
  const make=patch=>new WorkspaceLegacyBusiness(f.storage,f.features,f.folders,{...options,...patch});
  const outcome=(patch={})=>({requestId:randomUUID(),runId:randomUUID(),scheduleId:"one",definitionHash:hash(f.rows[0]),status:"error",output:"fixture failure",hadStdout:false,finishedAt:30_000_000,...patch});
  return{root,...f,make,options,outcome,calls:()=>calls,sends};
}
test("Host composition closes command → outcome → once-only delivery and restart never reruns or resends",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture",alertAfter:2}),a=f.make(),id=randomUUID();
  const first=await a.execute("one",id);assert.equal(first.command.state,"completed");assert.equal(first.effects.length,1);
  assert.equal(f.calls(),1);await a.outcomes.flush(first.effects[0]);assert.equal(f.sends.length,1);
  const second=await f.make().execute("one",id);assert.deepEqual(second,first);await f.make().outcomes.flush(first.effects[0]);assert.equal(f.calls(),1);assert.equal(f.sends.length,1);
});
test("counter-only alerts inherit streaks but never guess a destination; success resets and repeat never increments twice",async t=>{
  const f=await fixture(t,{alertAfter:3,consecutiveErrors:4}),o=f.make().outcomes,input=f.outcome();
  assert.deepEqual(o.record(input),[]);assert.equal(o.list().counts[0].consecutiveErrors,5);o.record(input);assert.equal(o.list().counts[0].consecutiveErrors,5);
  o.record(f.outcome({status:"ok"}));assert.equal(o.list().counts[0].consecutiveErrors,0);assert.equal(o.list().effects.length,0);assert.equal(f.sends.length,0);
});
test("on-output ignores stderr-only work; independent threshold alert and cooldown start only after confirmation",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture",deliverMode:"on-output",alertAfter:2,consecutiveErrors:1});let now=30_000_000;
  const o=new WorkspaceLegacyOutcomes(f.storage,f.features,{...f.options.notifications,now:()=>now});
  const effects=o.record(f.outcome());assert.equal(effects.length,1);assert.equal(o.list().effects[0].kind,"alert");assert.equal(o.list().counts[0].lastAlertAt,null);
  await o.flush(effects[0]);assert.equal(o.list().counts[0].lastAlertAt,now);
  o.record(f.outcome({finishedAt:now+1}));assert.equal(o.list().effects.length,1);
  now+=6*3600_000+1;o.record(f.outcome({finishedAt:now}));assert.equal(o.list().effects.length,2);
});
test("on-error suppresses successful outcomes and always mode still emits an empty confirmed outcome",async t=>{
  for(const mode of["on-error","always"]){const f=await fixture(t,{deliver:"feishu:fixture",deliverMode:mode});const ids=f.make().outcomes.record(f.outcome({status:"ok",output:""}));assert.equal(ids.length,mode==="always"?1:0);}
});
test("an inherited zero alert timestamp means no cooldown, matching the legacy scheduler",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture",deliverMode:"on-error",alertAfter:1,lastAlertAt:0}),o=f.make().outcomes;
  const effects=o.record(f.outcome({finishedAt:1}));assert.equal(effects.length,2);
  assert.equal(o.list().counts[0].lastAlertAt,null);assert.equal(o.list().effects.filter(row=>row.kind==="alert").length,1);
});
test("unknown transport result and crash-sending state survive restart without automatic replay",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture"});let sends=0;
  const options={authorize:review=>({review,assertCurrent(){},async send(){sends++;throw Error("opaque private transport failure");}})};
  const a=new WorkspaceLegacyOutcomes(f.storage,f.features,options),[id]=a.record(f.outcome({status:"ok"}));
  assert.equal((await a.flush(id)).state,"unknown");assert.equal((await new WorkspaceLegacyOutcomes(f.storage,f.features,options).flush(id)).state,"unknown");assert.equal(sends,1);
});
test("a stalled transport reaches unknown at its bounded deadline without replay",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture"});let calls=0,aborted=false;
  const options={deliveryTimeoutMs:20,authorize:review=>({review,assertCurrent(){},send(input){calls++;input.signal.addEventListener("abort",()=>aborted=true);return new Promise(()=>{});}})};
  const o=new WorkspaceLegacyOutcomes(f.storage,f.features,options),[id]=o.record(f.outcome({status:"ok"}));assert.equal((await o.flush(id)).state,"unknown");assert.equal(aborted,true);
  await new WorkspaceLegacyOutcomes(f.storage,f.features,options).flush(id);assert.equal(calls,1);
});
test("active notification claim is durable across independent instances and only one sender runs",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture"});let release,entered;const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r);let sends=0;
  const options={authorize:review=>({review,assertCurrent(){},async send(){sends++;entered();await held;return{state:"sent",receiptId:"confirmed"};}})};
  const a=new WorkspaceLegacyOutcomes(f.storage,f.features,options),[id]=a.record(f.outcome({status:"ok"}));const running=a.flush(id);await ready;
  assert.equal((await new WorkspaceLegacyOutcomes(f.storage,f.features,options).flush(id)).state,"unknown");assert.equal(sends,1);release();assert.equal((await running).state,"sent");
});
test("wrong Workspace target/permit and explicit not-sent remain blocked without transport fallback",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture"});let sends=0;
  for(const wrong of[true,false]){const o=new WorkspaceLegacyOutcomes(f.storage,f.features,{authorize:review=>({review:wrong?{...review,workspaceId:"foreign"}:review,assertCurrent(){},async send(){sends++;return{state:"not_sent"};}})});
    const[id]=o.record(f.outcome({status:"ok"}));assert.equal((await o.flush(id)).state,"blocked");}
  assert.equal(sends,1);
});
test("changed outcome identity refuses increments; known secrets and opaque errors never enter queued messages",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture"}),secret="opaqueFixtureSecretAcrossChunks";
  const o=new WorkspaceLegacyOutcomes(f.storage,f.features,{...f.options.notifications,knownSecrets:[secret]}),input=f.outcome({output:secret});o.record(input);
  assert(!JSON.stringify(o.list()).includes(secret));const before=o.list();assert.throws(()=>o.record({...input,status:"ok"}),/conflicts/);assert.deepEqual(o.list(),before);
});
test("outcome-unknown or cancelled commands never increment streak or issue notifications",async t=>{
  const f=await fixture(t,{deliver:"feishu:fixture",alertAfter:1}),a=f.make({commands:{...f.options.commands,async launch(){throw Error("fixture unknown");}}});
  const result=await a.execute("one",randomUUID());assert.equal(result.command.state,"unknown");assert.equal(a.outcomes.list().outcomes.length,0);assert.equal(f.sends.length,0);
});
test("private process adapter executes only an explicit authored fixture with clean environment, timeout and owned group",{skip:process.platform==="win32"},async t=>{
  const f=await fixture(t,{task:"printf '%s %s\\n' fixture \"${AWS_SECRET_ACCESS_KEY-unset}\""});let checks=0;
  const launch=legacyProcessLauncher({shell:"/bin/bash",assertLaunch(inv){checks++;assert.equal(inv.cwd,f.cwd);assert.equal(inv.env.HOME,f.isolatedHome);assert.equal(inv.env.AWS_SECRET_ACCESS_KEY,undefined);}});
  const a=f.make({commands:{...f.options.commands,launch}}),r=await a.execute("one",randomUUID());assert.equal(r.command.state,"completed");assert.match(r.command.output,/fixture unset/);assert.equal(checks,1);
  const slow=await fixture(t,{task:"sleep 10"}),b=slow.make({commands:{...slow.options.commands,timeoutMs:50,terminationGraceMs:1000,launch:legacyProcessLauncher({shell:"/bin/bash",assertLaunch(){}})}});
  assert.equal((await b.execute("one",randomUUID())).command.state,"timed_out");
});
test("an asynchronous process grant is refused before starting even when its rejection is delayed",{skip:process.platform==="win32"},async t=>{
  const f=await fixture(t,{task:"printf should-not-run"});
  const launch=legacyProcessLauncher({shell:"/bin/bash",async assertLaunch(){throw Error("fixture async rejection");}});
  const a=f.make({commands:{...f.options.commands,launch}}),r=await a.execute("one",randomUUID());
  assert.equal(r.command.state,"unknown");assert.equal(r.command.output,"");
});
test("scoped CLI runs through the actual early entry and owned process; token/scope revocation fail closed",{skip:process.platform==="win32"},async t=>{
  const f=await fixture(t,{task:"hara cron logs one -n 5; printf 'done\\n'",deliver:"feishu:fixture"}),id=randomUUID(),socketRoot=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-lcli-")));
  t.after(()=>fs.rmSync(socketRoot,{recursive:true,force:true}));let current=true,reads=0;
  const bridge=new LegacyScopedCli({socketRoot,review:f.review("one",id),assertCurrent(){if(!current)throw Error();},readLogs(jobId,lines){reads++;assert.equal(jobId,"one");assert.equal(lines,5);return"scoped fixture log\n";}});
  await bridge.start();t.after(()=>bridge.close());
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  fs.writeFileSync(join(f.bin,"hara"),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,{mode:0o700});
  const a=f.make({commands:{...f.options.commands,prepareCli:review=>bridge.lease(review),launch:legacyProcessLauncher({shell:"/bin/bash",assertLaunch(){}})}});
  const r=await a.execute("one",id);assert.equal(r.command.state,"completed");assert.match(r.command.output,/scoped fixture log[\s\S]*done/);assert.equal(reads,1);
  const env={...bridge.lease(f.review("one",id)).env,HOME:f.isolatedHome,PATH:"/usr/bin:/bin"};
  await assert.rejects(exec(process.execPath,[cli,"org","run","anything"],{env}),e=>e.code===2);
  await assert.rejects(exec(process.execPath,[cli,"cron","logs","foreign"],{env}),e=>e.code===2);
  await assert.rejects(exec(process.execPath,[cli,"cron","logs","one"],{env:{...env,HARA_LEGACY_CLI_TOKEN:"0".repeat(64)}}),e=>e.code===2);
  current=false;await assert.rejects(exec(process.execPath,[cli,"cron","logs","one"],{env}),e=>e.code===2);assert.equal(reads,1);await bridge.close();
});
test("a partial scoped CLI env cannot enter global workspace/profile/cron startup",async t=>{
  const f=await fixture(t);for(const args of[["workspace","--help"],["--runtime-manifest"]])await assert.rejects(exec(process.execPath,[cli,...args],{env:{HOME:f.isolatedHome,PATH:"/usr/bin:/bin",HARA_LEGACY_CLI_TOKEN:"invalid"}}),e=>e.code===2&&/no global fallback/.test(e.stderr));
  assert.equal(fs.existsSync(join(f.isolatedHome,".hara")),false);
});
test("print → actual synthetic Pi Host → verified artifact → durable outcome and restart replay without another Provider",async t=>{
  const f=await fixture(t,{mode:"print",task:"生成 hello.md 並驗證",deliver:"feishu:fixture"}),host=new LocalWorkspaceHost(f.root),id=randomUUID();
  let result;try{
    host.configureSynthetic(f.record.scope.workspaceId,0);
    result=await executeLegacyPrint(host,f.storage,f.features,f.make().outcomes,"one",id);
    assert.equal(result.status,"ok");assert.equal(result.effects.length,1);
    assert.equal(fs.readFileSync(join(f.root,"project",f.record.scope.workspaceId,"hello.md"),"utf8"),"hello workspace\n");
    await f.make().outcomes.flush(result.effects[0]);assert.equal(f.sends.length,1);
  }finally{await host.close();}
  const restored=new LocalWorkspaceHost(f.root,{providerFactory(){assert.fail("replay may not create a Provider");}});
  try{const duplicate=await executeLegacyPrint(restored,f.storage,f.features,f.make().outcomes,"one",id);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.runId,result.runId);await f.make().outcomes.flush(result.effects[0]);assert.equal(f.sends.length,1);}finally{await restored.close();}
});
