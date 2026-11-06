import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { cliMcpFixture, until, waitForNativeRetryWindow } from "./helpers/workspace-cli-mcp.mjs";
const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
async function exchange(f, text) { await f.send(text); return until(f.read, done); }
function state(f) {
  const relative = fs.readdirSync(f.root, { recursive: true }).find(name => /(?:^|\/)codex-thread-[a-f0-9]+\.json$/.test(name));
  assert.ok(relative); return JSON.parse(fs.readFileSync(join(f.root, relative), "utf8"));
}
const controls = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
const turns = f => f.native().filter(row => row.method === "turn/start");
const events = f => fs.readFileSync(f.command + ".events.jsonl", "utf8").trim().split("\n").map(row => JSON.parse(row));
async function changeStanding(f) {
 const agent=(await f.read()).agents.find(row=>row.agentId===f.main.agentId);
 return f.request("workspace.agents.updatePersona",{...f.scope,agentId:agent.agentId,configRevision:agent.configRevision,
  agentEpoch:agent.agentEpoch,input:{profile:{displayName:"Fresh governed persona"}}});
}

test("auto low to medium stays on one loaded PID/thread and sends the new effort on turn/start", async t => {
 const f=await cliMcpFixture(t,"reply",{reasoningEfforts:["low","medium","high"]});
 assert.equal((await exchange(f,"你好")).conversation.state,"completed");const first=state(f),meta=f.meta();
 assert.equal(turns(f)[0].params.effort,"low");
 f.mode({mode:"list",reasoningEfforts:["low","medium","high"]});
 assert.equal((await exchange(f,"Investigate current colleagues and explain what you observed")).conversation.state,"completed");
 assert.equal(turns(f)[1].params.effort,"medium");assert.equal(f.meta().effort,"medium");
 assert.equal(state(f).threadId,first.threadId);assert.equal(state(f).standingPromptHash,first.standingPromptHash);
 assert.equal(f.meta().pid,meta.pid);assert.equal(f.meta().url,meta.url);assert.deepEqual(controls(f).map(row=>row.method),["thread/start"]);
});

test("changed standing waits for thread/closed before resume and installs fresh governance and MCP URL", async t => {
 const f=await cliMcpFixture(t,"reply",{unloadDelayMs:100});
 assert.equal((await exchange(f,"你好")).conversation.state,"completed");const before=state(f),meta=f.meta();
 await changeStanding(f);
 assert.equal((await exchange(f,"你好")).conversation.state,"completed");
 assert.equal(f.meta().pid,meta.pid);assert.equal(state(f).threadId,before.threadId);
 assert.notEqual(state(f).standingPromptHash,before.standingPromptHash);assert.notEqual(f.meta().url,meta.url);
 const trace=events(f),closed=trace.findIndex(row=>row.method==="thread/closed"),resumed=trace.findIndex(row=>row.method==="thread/resume");
 assert.ok(closed>=0&&resumed>closed);assert.equal(trace[resumed].ignoredOverrides,false);
 assert.notEqual(trace[0].developerInstructions,trace[resumed].developerInstructions);
 assert.notDeepEqual(trace[0].config.mcp_servers,trace[resumed].config.mcp_servers);
 assert.equal(turns(f)[0].params.effort,turns(f)[1].params.effort);
});

for (const failure of ["rejectTurnStart","terminateBeforeTurnStart"]) test(`${failure}: empty unmaterialized thread recovers once with a reference-only history and reset reason`, async t => {
 const f=await cliMcpFixture(t,"reply",{[failure]:true});
 const failed=await exchange(f,"First failed request UNIQUE-EMPTY-ORIGINAL");assert.equal(failed.conversation.state,"blocked");
 const before=state(f);assert.equal(before.input,0);assert.equal(before.output,0);assert.equal(before.contextTokens,null);
 assert.equal(fs.existsSync(f.command+".native.json"),false);
 if(failure==="terminateBeforeTurnStart") {
  assert.match(failed.conversation.blockReason,/External runtime terminated by signal SIGTERM/);
  assert.doesNotMatch(failed.conversation.blockReason,/rmcp|runtime_network/);
 }
 await waitForNativeRetryWindow(failed);f.mode("list");
 const recovered=await exchange(f,"Second explicit request UNIQUE-EMPTY-NEXT");assert.equal(recovered.conversation.state,"completed");
 const after=state(f);assert.notEqual(after.threadId,before.threadId);assert.equal(after.resets.length,1);
 assert.equal(after.resets[0].oldThreadId,before.threadId);assert.equal(after.resets[0].actorId,"system");
 assert.deepEqual(controls(f).map(row=>row.method),["thread/start","thread/resume","thread/start"]);
 assert.equal(turns(f).length,2,"only the explicit new user request is submitted; no replay of the failed request");
 const prompt=turns(f)[1].params.input[0].text;assert.match(prompt,/<hara-context-summary>/);assert.match(prompt,/Reference only/);
 assert.match(prompt,/Never replay/);assert.match(prompt,/UNIQUE-EMPTY-NEXT/);assert.match(JSON.stringify(recovered),/UNIQUE-EMPTY-ORIGINAL/);
 const auditFile=fs.readdirSync(f.root,{recursive:true}).find(name=>/(?:^|\/)codex-empty-thread-resets-[a-f0-9]+\.json$/.test(name));
 assert.ok(auditFile);const audit=JSON.parse(fs.readFileSync(join(f.root,auditFile),"utf8"));
 assert.equal(audit.entries.length,1);assert.equal(audit.entries[0].reason,"codex_thread_never_materialized");
 assert.equal(audit.entries[0].oldThreadId,before.threadId);assert.equal(audit.entries[0].newThreadId,after.threadId);
 assert.equal(audit.entries[0].requestId,after.resets[0].requestId);
});

test("required MCP initialization failure leaves no submitted user turn and the next explicit message can start", async t => {
 const f=await cliMcpFixture(t,"reply",{requiredMcpFail:true});
 const failed=await exchange(f,"Failed handshake original");assert.equal(failed.conversation.state,"blocked");
 assert.equal(turns(f).length,0);assert.equal(failed.conversation.nativeSession?.status ?? "empty","empty");assert.equal(fs.existsSync(f.command+".native.json"),false);
 await waitForNativeRetryWindow(failed);f.mode("list");
 const recovered=await exchange(f,"Retry after the handshake is available");assert.equal(recovered.conversation.state,"completed");
 assert.equal(turns(f).length,1);assert.equal(state(f).resets.length,0);assert.equal(controls(f).some(row=>row.method==="thread/resume"),false);
});

test("a nonempty missing rollout preserves history and requires explicit recovery without replacing its thread", async t => {
 const f=await cliMcpFixture(t,"list");assert.equal((await exchange(f,"Materialized original UNIQUE-NONEMPTY")).conversation.state,"completed");
 const before=state(f);assert.ok(before.input>0);assert.ok(fs.existsSync(f.command+".native.json"));await f.restart();f.mode({mode:"reply",missingRollout:true});
 const failed=await exchange(f,"Second request with missing nonempty rollout");assert.equal(failed.conversation.state,"blocked");
 assert.equal(failed.conversation.nativeSession.status,"recovery_needed");assert.equal(state(f).threadId,before.threadId);
 assert.equal(state(f).resets.length,0);assert.equal(turns(f).length,1);assert.equal(controls(f).filter(row=>row.method==="thread/start").length,1);
 assert.match(JSON.stringify(failed),/UNIQUE-NONEMPTY/);
});

test("native exit between messages cold resumes the same materialized thread without replay", async t => {
 const f=await cliMcpFixture(t,"list");assert.equal((await exchange(f,"Materialized original UNIQUE-COLD-FIRST")).conversation.state,"completed");
 const before=state(f),pid=f.meta().pid;process.kill(pid,"SIGTERM");
 await until(async()=>{try{process.kill(pid,0);return false;}catch{return true;}},value=>value);
 assert.equal((await exchange(f,"Explicit new request UNIQUE-COLD-SECOND")).conversation.state,"completed");
 assert.equal(state(f).threadId,before.threadId);assert.notEqual(f.meta().pid,pid);assert.equal(state(f).resets.length,0);
 assert.deepEqual(controls(f).map(row=>row.method),["thread/start","thread/resume"]);assert.equal(turns(f).length,2);
 assert.doesNotMatch(turns(f)[1].params.input[0].text,/UNIQUE-COLD-FIRST/);
});

test("unconfirmed unload closes the native process and sends no turn under stale governance", async t => {
 const f=await cliMcpFixture(t,"reply",{unloadHang:true});await exchange(f,"你好");const before=state(f),pid=f.meta().pid;
 await changeStanding(f);const failed=await exchange(f,"你好");assert.equal(failed.conversation.state,"blocked");
 assert.equal(state(f).threadId,before.threadId);assert.equal(turns(f).length,1);assert.equal(controls(f).length,1);
 await waitForNativeRetryWindow(failed);f.mode("reply");assert.equal((await exchange(f,"你好")).conversation.state,"completed");
 assert.notEqual(f.meta().pid,pid);assert.equal(state(f).threadId,before.threadId);assert.equal(controls(f).at(-1).method,"thread/resume");
});
