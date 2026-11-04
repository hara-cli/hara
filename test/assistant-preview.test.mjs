import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantPreview } from "../dist/agent-runtime/assistant-preview.js";
test("first safe text is immediate and subsequent batches use a non-sliding deadline",()=>{
 const frames=[],scheduled=[],cancelled=[];const p=createAssistantPreview({source:{},emit:text=>frames.push(text),schedule:callback=>{scheduled.push(callback);return scheduled.length;},cancel:id=>cancelled.push(id)});
 p.push("你");assert.deepEqual(frames,["你"]);p.push("好");p.push("！");assert.equal(scheduled.length,1);assert.deepEqual(frames,["你"]);
 scheduled[0]();assert.deepEqual(frames,["你","你好！"]);p.push("Hello ");assert.equal(scheduled.length,2);p.stop();scheduled[1]();assert.equal(frames.length,2);
});
test("ASCII words are held until stable and unknown credential/code/URL contexts remain canonical-only",()=>{
 for(const value of ['password="hello world"','-----BEGIN PRIVATE KEY-----\nprivate\n','https://example.invalid/?token=secret','```code','Bearer opaquevalue123456']){
  const frames=[],p=createAssistantPreview({source:{},emit:text=>frames.push(text)});for(const char of value)p.push(char);p.finish();
  assert.equal(frames.join("").includes("opaquevalue"),false);assert.equal(frames.join("").includes("hello world"),false);assert.equal(frames.join("").includes("private"),false);
 }
 const frames=[],p=createAssistantPreview({source:{},emit:text=>frames.push(text)});p.push("Hell");assert.equal(frames.length,0);p.push("o ");assert.deepEqual(frames,["Hello "]);p.stop();
});
test("every split of recognizable and whitespace-containing opaque secrets is safe before the next chunk",()=>{
 for(const value of ["sk-proj-abcdefghijklmno", "ghp_abcdefghijklmnopqrstuvwxyz", "opaque value. with spaces", "密钥值不应提前显示"]){
  for(let split=1;split<value.length;split++){
   const frames=[],p=createAssistantPreview({source:{FIXTURE_API_KEY:value},emit:text=>frames.push(text)});
   p.push(value.slice(0,split));assert.equal(frames.some(text=>text.includes(value.slice(0,Math.min(6,split)))),false,`prefix split ${split}`);
   p.push(value.slice(split)+" ");p.finish();assert.ok(frames.every(text=>!text.includes(value)));assert.ok(frames.at(-1)?.includes("***"));
  }
 }
});
test("stopped/oversized streams cannot release later fragments",()=>{
 const frames=[],p=createAssistantPreview({source:{},emit:text=>frames.push(text)});p.push("a".repeat(24001));p.push("LEAK ");p.finish();assert.deepEqual(frames,[]);
});
