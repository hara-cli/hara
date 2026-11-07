import { GovernedCodexSession } from "../dist/agent-runtime/codex-session.js";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ResidentWorkspaceMcp, residentMcpToolsSupported, WORKSPACE_ATTEMPT_MARKER as MARKER } from "../dist/agent-runtime/registered-cli-resident-mcp.js";
const token="a".repeat(64),tool={name:"fixture_read",description:"Fixture only",input_schema:{type:"object",properties:{value:{type:"string"}},additionalProperties:false}};
const defer=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
function attempt(overrides={}){const controller=new AbortController();return{signal:controller.signal,assertCurrent(){},tools:()=>[tool],call:async(_name,args)=>({id:"fixture",name:"fixture_read",content:JSON.stringify(args)}),...overrides};}
async function client(endpoint){let serial=0,session;return{headers:()=>({"Content-Type":"application/json",Accept:"application/json, text/event-stream",Authorization:"Bearer "+token,...(session?{"Mcp-Session-Id":session}:{})}),async request(method,params={}){const response=await fetch(endpoint.url,{method:"POST",headers:this.headers(),body:JSON.stringify({jsonrpc:"2.0",id:++serial,method,params})});session=response.headers.get("mcp-session-id")??session;return{status:response.status,body:await response.json()};}};}
async function initialized(endpoint){const c=await client(endpoint);assert.ok((await c.request("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"fixture",version:"1"}})).body.result);return c;}
test("resident transport rejects idle and old/missing markers even while a new attempt is active",async()=>{
 let calls=0;const resident=await ResidentWorkspaceMcp.create(token);let a,b;
 try{a=resident.bind(attempt({call:async(_name,args)=>{calls++;assert.equal(Object.hasOwn(args,MARKER),false);return{id:"a",name:"fixture_read",content:"safe"};}}));const c=await initialized(a);
  const list=(await c.request("tools/list")).body.result;assert.ok(list.tools[0].inputSchema.required.includes(MARKER));
  assert.equal((await c.request("tools/call",{name:tool.name,arguments:{[MARKER]:a.attemptMarker,value:"a"}})).body.result.content[0].text,"safe");
  assert.throws(()=>resident.bind(attempt()),/unavailable/);assert.ok(resident.retireCurrent());assert.ok(resident.reusable);
  assert.equal((await c.request("tools/list")).status,403);
  b=resident.bind(attempt({call:async()=>{calls++;return{id:"b",name:tool.name,content:"new"};}}));assert.equal(b.url,a.url);assert.notEqual(b.attemptMarker,a.attemptMarker);
  for(const arguments_ of [{},{[MARKER]:a.attemptMarker},{[MARKER]:"forged"}])assert.ok((await c.request("tools/call",{name:tool.name,arguments:arguments_})).body.error);
  await a.close();assert.equal((await c.request("tools/call",{name:tool.name,arguments:{[MARKER]:b.attemptMarker}})).body.result.content[0].text,"new");assert.equal(calls,2);
 }finally{await b?.close();await a?.close();await resident.close();}
});
test("a body admitted on an old connection cannot acquire the next attempt after delayed parsing",async()=>{
 let calls=0;const resident=await ResidentWorkspaceMcp.create(token),a=resident.bind(attempt()),c=await initialized(a);let b;
 try{const body=JSON.stringify({jsonrpc:"2.0",id:99,method:"tools/call",params:{name:tool.name,arguments:{[MARKER]:a.attemptMarker,value:"old"}}});
  let request;const result=new Promise((resolve,reject)=>{request=http.request(a.url,{method:"POST",headers:{...c.headers(),"Content-Length":Buffer.byteLength(body)}},response=>{let data="";response.on("data",chunk=>data+=chunk);response.on("end",()=>resolve(JSON.parse(data)));});request.on("error",reject);request.flushHeaders();});
  await new Promise(resolve=>setTimeout(resolve,20));assert.ok(resident.retireCurrent());b=resident.bind(attempt({call:async()=>{calls++;return{id:"b",name:tool.name,content:"BAD"};}}));request.end(body);
  assert.ok((await result).error);assert.equal(calls,0);
 }finally{await b?.close();await a.close();await resident.close();}
});
test("an in-flight old call poisons handoff and cannot return its receipt across retirement",async()=>{
 const entered=defer(),reply=defer(),resident=await ResidentWorkspaceMcp.create(token),a=resident.bind(attempt({call:async()=>{entered.resolve();await reply.promise;return{id:"a",name:tool.name,content:"PRIVATE_RECEIPT"};}})),c=await initialized(a);
 try{const response=c.request("tools/call",{name:tool.name,arguments:{[MARKER]:a.attemptMarker}});await entered.promise;
  assert.equal(resident.retireCurrent(),false);assert.throws(()=>resident.bind(attempt()),/unavailable/);reply.resolve();const result=await response;assert.ok(result.body.error);assert.equal(JSON.stringify(result).includes("PRIVATE_RECEIPT"),false);assert.equal(resident.reusable,false);
 }finally{reply.resolve();await a.close();await resident.close();}
});
test("the same original authority is rechecked after await; replacement callbacks never authorize it",async()=>{
 let revoked=false,checks=0;const entered=defer(),reply=defer(),resident=await ResidentWorkspaceMcp.create(token),a=resident.bind(attempt({assertCurrent(){checks++;if(revoked)throw new Error("revoked");},call:async()=>{entered.resolve();await reply.promise;return{id:"a",name:tool.name,content:"PRIVATE_RECEIPT"};}})),c=await initialized(a);
 try{const response=c.request("tools/call",{name:tool.name,arguments:{[MARKER]:a.attemptMarker}});await entered.promise;revoked=true;reply.resolve();const result=await response;assert.ok(result.body.error);assert.equal(JSON.stringify(result).includes("PRIVATE_RECEIPT"),false);assert.ok(checks>=3);
 }finally{reply.resolve();await a.close();await resident.close();}
});
test("foreign HTTP authority and schemas that cannot carry a routing marker fail closed",async()=>{
 for(const schema of [{type:"array"},{type:"object",properties:{[MARKER]:{type:"string"}}},{type:"object",required:[1]}])assert.equal(residentMcpToolsSupported(attempt({tools:()=>[{...tool,input_schema:schema}]})),false);
 const resident=await ResidentWorkspaceMcp.create(token),a=resident.bind(attempt());try{
  assert.equal((await fetch(a.url,{headers:{Authorization:"Bearer "+token,Origin:"https://foreign.invalid"}})).status,403);
  assert.equal((await fetch(a.url,{headers:{Authorization:"Bearer "+"b".repeat(64)}})).status,401);
 }finally{await a.close();await resident.close();}
});

test("unsupported schema keeps the isolated attempt transport and its real native bearer", async () => {
  // Exercise transport selection only. No native permission response or execution permit is fabricated.
  let revoked = false, calls = 0;
  const controller = new AbortController(), original = {
    signal: controller.signal,
    assertCurrent() { if (revoked) throw Error("owned revocation"); },
    tools: () => [{ ...tool, input_schema: { type: "array" } }],
    call: async () => { calls++; throw Error("not called"); }
  };
  const endpoint = await GovernedCodexSession.prototype.createEndpoint.call({ busy: true, closing: false, token }, original);
  try {
    assert.equal(endpoint.prepare, undefined);
    assert.equal(endpoint.attemptMarker, undefined);
    assert.equal(endpoint.env.HARA_WORKSPACE_MCP_TOKEN, token);
    const c = await initialized(endpoint);
    revoked = true;
    assert.equal((await c.request("tools/list")).status, 403);
    assert.equal(calls, 0);
  } finally { await endpoint.close(); }
});
