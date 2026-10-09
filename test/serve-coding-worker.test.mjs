import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServe } from "../dist/serve/server.js";
import { RemoteCommandLedger } from "../dist/serve/remote-command-ledger.js";

const features=["external.delegated-interaction.v1","external.questions.v1","coding.settings.v1"];
const TURN_FIXTURE_TIMEOUT_MS=30_000;
const done=text=>({text,toolUses:[],stop:"end",usage:{input:3,output:2}});
function memoryStore(){const records=new Map();return {
  load:id=>records.get(id)??null,save:(meta,history,task)=>records.set(meta.id,{meta:{...meta},history:structuredClone(history),task:task&&structuredClone(task)}),
  list:()=>[...records.values()].map(record=>record.meta),acquire:()=>({ok:true}),release(){},delete:id=>records.delete(id),
};}
async function connect(port){
  const ws=new WebSocket(`ws://127.0.0.1:${port}`),pending=new Map(),events=[],waiters=[];let nextId=1;
  const failAll=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error("fixture disconnected"));}pending.clear();
    for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(new Error("fixture disconnected"));}};
  ws.on("message",raw=>{const message=JSON.parse(String(raw));const item=pending.get(message.id);
    if(item){pending.delete(message.id);clearTimeout(item.timer);item.resolve(message);return;}
    if(!message.method)return;events.push(message);
    for(const waiter of [...waiters])if(waiter.method===message.method&&waiter.predicate(message.params)){
      waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(message.params);
    }
  });ws.on("close",failAll);
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  return {ws,events,call(method,params={},{timeoutMs=12_000}={}){return new Promise((resolve,reject)=>{
    const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`fixture RPC timeout: ${method}`));},timeoutMs);
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({jsonrpc:"2.0",id,method,params}));
  });},wait(method,predicate=()=>true){const prior=events.find(item=>item.method===method&&predicate(item.params));if(prior)return Promise.resolve(prior.params);
    return new Promise((resolve,reject)=>{const item={method,predicate,resolve,reject,timer:undefined};item.timer=setTimeout(()=>{
      waiters.splice(waiters.indexOf(item),1);reject(new Error(`fixture event timeout: ${method}`));},8_000);waiters.push(item);});
  }};
}

function provider(state){
  const instance={id:"synthetic",model:"unchanged-hara-fixture",async turn(args){
    assert.equal(this,instance,"the worker must use the exact main Hara provider instance");
    const worker=args.system.includes("Hara-owned coding worker");state.calls.push({worker,system:args.system,tools:args.tools.map(tool=>tool.name)});
    if(worker){
      state.workerRounds++;state.workerHistories.push(structuredClone(args.history));
      if(state.blockWorker){
        state.workerInputEstimate=Buffer.byteLength(JSON.stringify({system:args.system,history:args.history,tools:args.tools}));
        state.workerStarted.resolve();
        return await new Promise((_,reject)=>{
          const abort=()=>{state.workerAborted++;reject(new Error("synthetic worker model cancelled"));};
          if(args.signal.aborted)abort();else args.signal.addEventListener("abort",abort,{once:true});
        });
      }
      let name,input;
      if(state.workerRounds===1){name="hara_read_file";input={path:"source.txt"};}
      else if(state.workerRounds===2){name="hara_write_file";input={path:"source.txt",content:"isolated worker change\n"};}
      else if(state.workerRounds===3){name="hara_ask_user";input={question:"Which bounded implementation should be recorded?",options:["A","B"]};}
      const result=done("Worker finished its isolated fixture.");result.usage={input:101,output:11};
      if(name){result.text="";result.stop="tool_use";result.toolUses=[{id:`worker_${state.workerRounds}`,name,input}];}
      return result;
    }
    state.rootRounds++;let name,input;
    if(state.rootRounds===1){name="task_intake";input={intent:"change",goal:"make one isolated coding change",constraints:["do not modify the source checkout"],acceptance:["an isolated diff and explicit human choice exist"],steps:["delegate","wait","inspect result"]};}
    else if(state.rootRounds===2){name="spawn_agent";input={task_name:"coder",message:"Read source.txt, propose an isolated edit, ask which implementation and report the result.",runtime:"coding",workspace:"isolated-write"};}
    else if(state.rootRounds===3){name="wait_agent";input={target:"/root/coder",timeout_ms:10_000};}
    else if(state.rootRounds===4){name="task_checkpoint";input={completion:{state:"verified",evidence:["the simulated worker has returned its isolated result; no GUI or real model was used"]}};}
    return name?{text:"",toolUses:[{id:`root_${state.rootRounds}`,name,input}],stop:"tool_use",usage:{input:3,output:2}}:done("Parent fixture complete.");
  }};return instance;
}

function mockOpenCode(state){
  const id=`ext_opencode_${"b".repeat(24)}`;
  return {async createCodingSession(input){state.createdInput=input;return {session:{id,sourceId:"opencode",state:"idle"},messages:[],readOnly:false,controlMode:"managed"};},
    async submit(sessionId,task,sink){
      assert.equal(sessionId,id);state.submitted++;assert.equal(typeof sink.prepareCodingHost,"function");
      const bridge=await sink.prepareCodingHost(sink.signal);state.bridge=bridge;
      const client=new Client({name:"mock-opencode-worker",version:"1"});
      try{
        await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcp.url),{requestInit:{headers:bridge.mcp.headers}}));
        const listed=await client.listTools();assert.deepEqual(listed.tools.map(tool=>tool.name),["read_file","write_file","edit_file","list_files","ask_user"]);
        const tools=listed.tools.map(tool=>({type:"function",function:{name:`hara_${tool.name}`,description:tool.description,parameters:tool.inputSchema}}));
        const messages=[{role:"user",content:task}];let reply="";
        for(let round=0;round<5;round++){
          const response=await fetch(new URL("/v1/chat/completions",bridge.mcp.url),{method:"POST",headers:{...bridge.mcp.headers,"Content-Type":"application/json"},
            body:JSON.stringify({model:"hara/coding",messages,tools}),signal:AbortSignal.any([sink.signal,AbortSignal.timeout(6_000)])});
          assert.equal(response.status,200);const value=await response.json();const message=value.choices[0].message;messages.push(message);
          if(!message.tool_calls?.length){reply=message.content;break;}
          for(const call of message.tool_calls){const result=await client.callTool({name:call.function.name.replace(/^hara_/,""),arguments:JSON.parse(call.function.arguments)},undefined,{signal:sink.signal});
            messages.push({role:"tool",tool_call_id:call.id,content:result.content.map(part=>part.text??"").join("\n")});}
        }
        assert.ok(reply);
        // Provider-native event estimates can be absent/zero even after actual Hara HTTP/tool usage.
        // The host's live counters must remain authoritative instead of regressing this generation.
        state.sdkMetrics={providerRounds:0,toolCalls:0,inputTokens:0,outputTokens:0};
        return {sessionId,turnId:"private-fixture-turn",status:"completed",reply,metrics:state.sdkMetrics};
      }finally{await client.close().catch(()=>{});await bridge.close();}
    },async interrupt(){},async close(){},
  };
}

async function fixture(t,{executor="pi",personal=true,expiry,blockWorker=false}={}){
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),"hara-serve-coding-worker-"))),home=join(root,"home"),repo=join(root,"repo");mkdirSync(home,{mode:0o700});mkdirSync(repo);
  writeFileSync(join(repo,"source.txt"),"original checkout\n");
  for(const args of [["init","-q"],["config","user.name","Hara Fixture"],["config","user.email","fixture@example.test"],["add","source.txt"],["commit","-qm","fixture"]]){
    const result=spawnSync("git",["-c","core.hooksPath=/dev/null",...args],{cwd:repo,encoding:"utf8",timeout:5_000});assert.equal(result.status,0,result.stderr);
  }
  let resolveWorkerStarted;const started=new Promise(resolve=>{resolveWorkerStarted=resolve;});
  const state={calls:[],rootRounds:0,workerRounds:0,workerHistories:[],submitted:0,settingsReads:0,
    blockWorker,workerStarted:{promise:started,resolve:resolveWorkerStarted},workerAborted:0,workerInputEstimate:0};const instance=provider(state);
  let server,client;const store=memoryStore();
  t.after(async()=>{client?.ws.close();await server?.close();rmSync(root,{recursive:true,force:true});});
  server=await startServe({host:"127.0.0.1",port:0,token:"fixture-token",cwd:repo},{
    version:"fixture",providerId:instance.id,model:instance.model,buildSessionProvider:async()=>instance,spawnSubagent:async()=>{throw new Error("unexpected native Hara worker");},
    sandbox:"off",approval:"full-auto",quietDiscovery:true,store,agentTeamHome:home,discoveryHome:home,serveStateHome:home,
    remoteCommandLedger:new RemoteCommandLedger({home}),runtimeInfo:()=>({providerId:instance.id,model:instance.model,profileId:"fixture",spaceId:personal?"personal":"organization:fixture"}),
    codingSettings:()=>{state.settingsReads++;return {version:1,revision:0,executor,effectiveExecutor:executor,recommendedExecutor:"opencode",executorEditable:true,experimental:executor==="pi"};},
    saveCodingSettings:()=>{throw new Error("test must not save preferences");},
    ...(executor==="opencode"?{externalSessions:mockOpenCode(state)}:{}),...(expiry===undefined?{}:{externalUserQuestionTimeoutMs:expiry}),
  });client=await connect(server.port);const initialized=await client.call("initialize",{token:"fixture-token",capabilities:{features}});
  assert.equal(initialized.error,undefined);const created=await client.call("session.create");assert.equal(created.error,undefined,JSON.stringify(created));const parent=created.result.sessionId;
  return {root,home,repo,state,server,client,parent,initialized,async launch(){
    // Legacy session.send resolves after the complete interactive turn, including human input.
    // Match the outer turn-test bound; individual control RPCs and event waits keep their shorter deadlines.
    const sending=client.call("session.send",{sessionId:parent,text:"Implement this bounded coding fixture."},{timeoutMs:TURN_FIXTURE_TIMEOUT_MS});
    void sending.catch(()=>{});const approval=await client.wait("approval.request");
    assert.equal((await client.call("approval.reply",{approvalId:approval.approvalId,allow:true})).error,undefined);return {sending};
  },async agents(){const result=await client.call("session.agents.list",{sessionId:parent});assert.equal(result.error,undefined);return result.result;}};
}

for(const executor of ["pi","opencode"]){
  test(`Serve ${executor} uses the same Hara provider and parent-chat fresh tool/question cards`,{timeout:TURN_FIXTURE_TIMEOUT_MS},async t=>{
    const f=await fixture(t,{executor});assert.ok(f.initialized.result.capabilities.features.includes("coding.settings.v1"));
    assert.equal((await f.client.call("settings.coding.get")).result.effectiveExecutor,executor);const {sending}=await f.launch();
    const approval=await f.client.wait("external.approval.request");assert.equal(approval.parentSessionId,f.parent);assert.equal(approval.agentPath,"/root/coder");
    assert.equal(approval.allowAlways,false);assert.match(approval.sessionId,new RegExp(`^ext_${executor}_[a-f0-9]{24}$`));assert.match(approval.question,/write_file/);
    const initial=await f.agents();assert.equal(initial.agents[0].runtime,executor);assert.equal(initial.budget.providerRounds,2);assert.equal(initial.budget.toolCalls,2);
    assert.equal(readFileSync(join(f.repo,"source.txt"),"utf8"),"original checkout\n");
    assert.equal((await f.client.call("external.approval.reply",{approvalId:approval.approvalId,sessionId:approval.sessionId,turnId:approval.turnId,allow:true,commandId:randomUUID()})).error,undefined);
    const question=await f.client.wait("external.question.request");assert.equal(question.parentSessionId,f.parent);assert.equal(question.sessionId,approval.sessionId);assert.equal(question.turnId,approval.turnId);
    assert.deepEqual(question.questions[0].options,[{label:"A"},{label:"B"}]);assert.equal(question.questions[0].isOther,true);
    const during=await f.agents();assert.ok(during.budget.providerRounds>=initial.budget.providerRounds);assert.ok(during.budget.inputTokens>=initial.budget.inputTokens);
    assert.equal((await f.client.call("external.question.reply",{questionId:question.questionId,sessionId:question.sessionId,turnId:question.turnId,answers:{question:{answers:["B"]}},commandId:randomUUID()})).error,undefined);
    const sent=await sending;assert.equal(sent.error,undefined,JSON.stringify(sent));const final=await f.agents();const worker=final.agents[0];
    if(executor==="opencode")assert.equal(f.state.bridge.metrics.providerRounds,4,"wrapping a live bridge must not snapshot its getter to initial zero metrics");
    assert.equal(worker.status,"completed",JSON.stringify(worker));assert.equal(worker.runtime,executor);assert.equal(worker.generation,1);
    assert.deepEqual(worker.workspace.changedPaths,["source.txt"]);assert.ok(worker.workspace.patchBytes>0);assert.match(worker.workspace.patchSha256,/^[a-f0-9]{64}$/);
    assert.equal(readFileSync(join(f.repo,"source.txt"),"utf8"),"original checkout\n");
    assert.equal(f.state.workerRounds,4);assert.equal(final.budget.providerRounds,4);assert.equal(final.budget.toolCalls,3);
    assert.equal(final.budget.inputTokens,404);assert.equal(final.budget.outputTokens,44);
    assert.equal(sent.result.usage.input,404+3*f.state.rootRounds);assert.equal(sent.result.usage.output,44+2*f.state.rootRounds);
    assert.equal(sent.result.usage.requests,f.state.workerRounds+f.state.rootRounds);
    assert.ok(f.state.workerHistories[1].some(message=>message.role==="tool"&&message.results.some(result=>result.content.includes("original checkout"))),"read_file actually returned the isolated source bytes, not a refused placeholder");
    assert.ok(f.state.workerHistories.at(-1).some(message=>message.role==="tool"&&message.results.some(result=>result.content.includes('"B"'))));
    assert.ok(f.state.calls.filter(call=>call.worker).every(call=>call.tools.every(name=>/^hara_(?:read_file|write_file|edit_file|list_files|ask_user)$/.test(name))));
    if(executor==="opencode"){assert.equal(f.state.submitted,1);assert.notEqual(f.state.createdInput.cwd,f.repo);assert.equal(f.state.sdkMetrics.providerRounds,0);}
  });
}

test("parent cancellation denies the outstanding Pi tool permission and rejects its late answer",{timeout:TURN_FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t);const {sending}=await f.launch();const approval=await f.client.wait("external.approval.request");
  assert.equal((await f.client.call("session.interrupt",{sessionId:f.parent})).error,undefined);await sending;
  const resolved=await f.client.wait("external.approval.resolved",value=>value.approvalId===approval.approvalId);assert.equal(resolved.outcome,"interrupted");
  assert.ok((await f.client.call("external.approval.reply",{approvalId:approval.approvalId,sessionId:approval.sessionId,turnId:approval.turnId,allow:true,commandId:randomUUID()})).error);
  const final=await f.agents();assert.notEqual(final.agents[0].status,"completed");assert.deepEqual(final.agents[0].workspace.changedPaths,[]);
  assert.equal(readFileSync(join(f.repo,"source.txt"),"utf8"),"original checkout\n");assert.equal(f.client.events.some(event=>event.method==="external.question.request"),false);
});

test("parent cancellation of an in-flight Pi model charges final conservative host input exactly once",{timeout:TURN_FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t,{blockWorker:true});const {sending}=await f.launch();
  let timer;try{await Promise.race([f.state.workerStarted.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("fixture worker did not enter provider")),8_000);})]);}
  finally{clearTimeout(timer);}
  const before=await f.agents();assert.equal(before.budget.providerRounds,1);assert.equal(before.budget.inputTokens,0);
  assert.equal((await f.client.call("session.interrupt",{sessionId:f.parent})).error,undefined);
  const sent=await sending;assert.match(sent.error?.message??"",/interrupted/);
  const ended=await f.client.wait("event.turn_end",value=>value.sessionId===f.parent);
  const final=await f.agents();assert.notEqual(final.agents[0].status,"completed");assert.deepEqual(final.agents[0].workspace.changedPaths,[]);
  assert.equal(f.state.workerRounds,1);assert.equal(f.state.workerAborted,1);assert.ok(f.state.workerInputEstimate>0);
  assert.equal(final.budget.providerRounds,1);assert.equal(final.budget.toolCalls,0);assert.equal(final.budget.inputTokens,f.state.workerInputEstimate);assert.equal(final.budget.outputTokens,0);
  assert.equal(ended.usage.input,f.state.workerInputEstimate+3*f.state.rootRounds);
  assert.equal(ended.usage.output,2*f.state.rootRounds);assert.equal(ended.usage.requests,1+f.state.rootRounds);
  const repeated=await f.agents();assert.deepEqual(repeated.budget,final.budget,"inspection must not reconcile the same host usage twice");
  assert.equal(readFileSync(join(f.repo,"source.txt"),"utf8"),"original checkout\n");
  assert.equal(f.client.events.some(event=>event.method==="external.approval.request"||event.method==="external.question.request"),false);
});

test("expired Pi write permission never defaults to allow or revives on a late reply",{timeout:TURN_FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t,{expiry:30});const {sending}=await f.launch();const approval=await f.client.wait("external.approval.request");
  const resolved=await f.client.wait("external.approval.resolved",value=>value.approvalId===approval.approvalId);assert.equal(resolved.outcome,"timed_out");
  assert.ok((await f.client.call("external.approval.reply",{approvalId:approval.approvalId,sessionId:approval.sessionId,turnId:approval.turnId,allow:true,commandId:randomUUID()})).error);
  await sending;const final=await f.agents();assert.deepEqual(final.agents[0].workspace.changedPaths,[]);
  assert.equal(readFileSync(join(f.repo,"source.txt"),"utf8"),"original checkout\n");
  assert.ok(f.state.workerHistories.some(history=>history.some(message=>message.role==="tool"&&message.results.some(result=>result.content.includes("coding tool was refused")))));
});

test("Company session has no Personal coding setting read/update surface",{timeout:15_000},async t=>{
  const f=await fixture(t,{personal:false});assert.equal(f.initialized.result.capabilities.features.includes("coding.settings.v1"),false);
  assert.ok((await f.client.call("settings.coding.get")).error);assert.ok((await f.client.call("settings.coding.update",{executor:"pi",expectedRevision:0})).error);
  assert.equal(f.state.settingsReads,0);assert.equal(f.state.workerRounds,0);assert.equal(f.state.submitted,0);
});
