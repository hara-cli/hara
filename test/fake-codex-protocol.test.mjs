import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {writeFakeCodex} from "./helpers/workspace-cli-mcp.mjs";
import {JsonlRpcClient,ExternalJsonlRpcRequestError} from "../dist/external-sessions/process.js";

test("Codex fake lazily materializes on accepted turn and ignores loaded resume overrides until thread/closed", async t => {
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"codex-protocol-fidelity-"))),command=join(root,"codex");
 writeFakeCodex(command,{mode:"hang",unloadDelayMs:50});let closeThread;
 const closed=new Promise(resolve=>{closeThread=resolve;});
 const client=JsonlRpcClient.start({command,cwd:root,env:{HOME:root,PATH:process.env.PATH},captureErrorFirstLine:true,
  onNotification(method){if(method==="thread/closed")closeThread();}});
 t.after(async()=>{client.close();await client.waitForClose();fs.rmSync(root,{recursive:true,force:true});});
 await client.call("initialize",{});
 const params={ephemeral:false,cwd:root,sandbox:"danger-full-access",approvalPolicy:"never",approvalsReviewer:"user",model:"fixture-model",developerInstructions:"RULE-A",
  config:{model_reasoning_effort:"low",mcp_servers:{fixture:{url:"http://127.0.0.1:1/a",required:true}}}};
 const first=await client.call("thread/start",params),threadId=first.thread.id;
 assert.equal(fs.existsSync(command+".native.json"),false);
 await assert.rejects(client.call("thread/resume",{...params,threadId}),error=>error instanceof ExternalJsonlRpcRequestError&&/^no rollout found/.test(error.errorFirstLine));
 await client.call("turn/start",{threadId,input:[{type:"text",text:"fixture-only"}]});assert.equal(fs.existsSync(command+".native.json"),true);
 const changed={...params,threadId,developerInstructions:"RULE-B",model:"fixture-model-2",config:{model_reasoning_effort:"medium",mcp_servers:{fixture:{url:"http://127.0.0.1:1/b",required:true}}}};
 const ignored=await client.call("thread/resume",changed);assert.equal(ignored.model,"fixture-model");assert.equal(ignored.reasoningEffort,"low");
 await client.call("thread/unsubscribe",{threadId});await closed;
 const loaded=await client.call("thread/resume",changed);assert.equal(loaded.model,"fixture-model-2");assert.equal(loaded.reasoningEffort,"medium");
 const events=fs.readFileSync(command+".events.jsonl","utf8").trim().split("\n").map(JSON.parse);
 assert.deepEqual(events.map(row=>row.method),["thread/start","thread/resume","thread/closed","thread/resume"]);
 assert.equal(events[1].ignoredOverrides,true);assert.equal(events[1].developerInstructions,"RULE-A");assert.deepEqual(events[1].config,params.config);
 assert.equal(events[3].ignoredOverrides,false);assert.equal(events[3].developerInstructions,"RULE-B");assert.deepEqual(events[3].config,changed.config);
});
