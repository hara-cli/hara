import { codexVisibleAgentMessage } from "../dist/agent-runtime/codex-session.js";
import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
const done = view => ["completed","blocked","paused","cancelled"].includes(view.conversation.state);
test("visible native prose reaches only an opted-in draft before terminal drain and canonical replacement",async t=>{
 const f=await cliMcpFixture(t,"reply",{previewOptIn:true,preview:{phase:"final_answer",chunks:["你","好！"],holdMs:800}});
 await f.send("你好");await until(async()=>f.previews,frames=>frames.length>0);
 const before=await f.read(),first=f.previews[0];assert.equal(first.draft,true);assert.equal(first.evidenceVerified,false);assert.equal(first.text,"你");
 assert.equal(before.conversation.history.some(row=>row.role==="assistant"&&row.text.includes("你好")),false);
 assert.equal(before.conversation.messageTimings.at(-1).points.T7,null);assert.equal(before.conversation.messageTimings.at(-1).points.T8,null);
 const final=await until(f.read,done);assert.equal(final.conversation.state,"completed");assert.ok(final.conversation.history.some(row=>row.role==="assistant"&&row.text==="registered codex reply"));
 assert.ok(f.previews.every((row,i)=>row.seq===i+1&&row.runId===final.conversation.runId&&!row.text.includes("PRIVATE_TEXT")));
 const timing=final.conversation.messageTimings.at(-1);assert.ok(timing.points.T5>=0);assert.ok(timing.points.T6>=timing.points.T5);assert.ok(timing.points.T9>=timing.points.T8);
});
test("a verified legacy agentMessage with null phase still streams before native terminal",async t=>{
 const f=await cliMcpFixture(t,"reply",{previewOptIn:true,preview:{phase:null,chunks:["你好！"],holdMs:800}});await f.send("你好");
 await until(async()=>f.previews,frames=>frames.length>0);const before=await f.read();assert.equal(before.conversation.messageTimings.at(-1).points.T8,null);
 const final=await until(f.read,done);assert.notEqual(final.conversation.messageTimings.at(-1).points.T5,null);
});
for(const phase of ["commentary","future_private_phase"])test(`native ${phase} is never previewed`,async t=>{
 const f=await cliMcpFixture(t,"reply",{previewOptIn:true,preview:{phase,chunks:["不应提前显示"],holdMs:300}});await f.send("你好");
 const final=await until(f.read,done);assert.equal(f.previews.length,0);assert.equal(final.conversation.messageTimings.at(-1).points.T5,null);
});
test("unverified start metadata waits for the complete typed message instead of using raw deltas",async t=>{
 const f=await cliMcpFixture(t,"reply",{previewOptIn:true,preview:{phase:null,malformedStart:true,chunks:["不应","提前显示"],holdMs:300}});await f.send("你好");
 const final=await until(f.read,done);assert.ok(f.previews.every(row=>row.text==="不应提前显示"));assert.equal(final.conversation.messageTimings.at(-1).points.T5,null);
});
test("an unnegotiated client retains canonical-only output",async t=>{
 const f=await cliMcpFixture(t,"reply",{preview:{phase:"final_answer",chunks:["你好！"]}});await f.send("你好");await until(f.read,done);assert.deepEqual(f.previews,[]);
});

test("visible-item proof requires documented id/text/type and treats future phases conservatively",()=>{
 for(const phase of [undefined,null,"partial_answer","final_answer"])assert.equal(codexVisibleAgentMessage({id:"item",type:"agentMessage",text:"",phase}),true);
 for(const item of [{id:"item",type:"agentMessage",phase:null},{id:"item",type:"reasoning",text:"PRIVATE"},{id:"item",type:"agentMessage",text:"PRIVATE",phase:"future_private"},{type:"agentMessage",text:"text"}])assert.equal(codexVisibleAgentMessage(item),false);
});
