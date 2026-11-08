import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {randomUUID} from "node:crypto";
import {fixture} from "./helpers/workspace-colleague-rpc.mjs";
test("Claude RPC reset preserves UI history and subsequent launches use a fresh process without native resume",async t=>{
 const f=await fixture(t,"claude");let view=await f.select(f.a.agentId);assert.equal(view.conversation.nativeSession.runtimeId,"claude");
 await f.send("Hello");view=await f.settle();assert.equal(view.conversation.state,"completed",view.conversation.blockReason);
 const before=structuredClone(view.conversation.history),requestId=randomUUID(),fields={...f.scope,agentId:f.a.agentId,expectedRevision:view.conversation.revision,expectedNativeRevision:view.conversation.nativeSession.revision,requestId,approved:true};
 await assert.rejects(f.rpc("workspace.session.new",{...fields,expectedRevision:fields.expectedRevision-1}),/changed/);
 await f.rpc("workspace.session.new",fields);await f.restart();await f.select(f.a.agentId);assert.equal((await f.rpc("workspace.session.new",fields)).duplicate,true);
 await f.send("Hello again");view=await f.settle();assert.equal(view.conversation.state,"completed",view.conversation.blockReason);assert.deepEqual(view.conversation.history.slice(0,before.length),before);
 const allLaunches=fs.readFileSync(f.command+".launches","utf8").trim().split("\n").map(row=>JSON.parse(row)),launches=allLaunches.filter(row=>row.args[0]==="-p");assert.equal(launches.length,2,JSON.stringify(allLaunches.map(row=>({pid:row.pid,flags:row.args.filter(arg=>arg.startsWith("-"))}))));assert.notEqual(launches[0].pid,launches[1].pid);
 for(const row of launches){assert.equal(row.cwd,view.colleagueHome.path);assert(row.args.includes("-p"));assert(!row.args.includes("--resume")&&!row.args.includes("--continue")&&!row.args.includes("--session-id"));}
 assert.doesNotMatch(launches[1].args[1],/Hello from a fresh fixture session|hara-context-summary/);
});
