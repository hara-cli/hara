import test from "node:test";
import assert from "node:assert/strict";
import { initializeKimiCodeSession, KIMI_CODE_ENV } from "../dist/agent-runtime/kimi-code-acp.js";
for(const tier of ["controlled","full-protected"])test(`Kimi Code ${tier} negotiates native mode and model without client fs/terminal or authentication`,async()=>{
 const calls=[],token="a".repeat(64),client={async call(method,params){calls.push({method,params});if(method==="initialize")return {protocolVersion:1,agentInfo:{name:"Kimi Code CLI"},agentCapabilities:{mcpCapabilities:{http:true}}};if(method==="session/new")return {sessionId:"fixture",modes:{availableModes:[{id:"plan"},{id:"auto"}]}};return {};}};
 assert.equal(await initializeKimiCodeSession(client,{cwd:"/fixture",endpoint:{url:"http://127.0.0.1:1/mcp",env:{HARA_WORKSPACE_MCP_TOKEN:token}},tier,model:"kimi-code/kimi-for-coding",assertCurrent(){}}),"fixture");
 assert.deepEqual(calls.map(x=>x.method),["initialize","session/new","session/set_mode","session/set_config_option"]);assert.deepEqual(calls[0].params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false});assert.equal(calls[1].params.mcpServers[0].headers[0].value,"Bearer "+token);assert.equal(calls[2].params.modeId,tier==="controlled"?"plan":"auto");assert.equal(calls[3].params.value,"kimi-code/kimi-for-coding");
 assert.deepEqual(KIMI_CODE_ENV,{KIMI_DISABLE_CRON:"1",KIMI_DISABLE_TELEMETRY:"1",KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT:"false"});
});
test("Kimi Code unknown protocol, CLI brand or native mode fails before prompt",async()=>{
 for(const variant of ["protocol","brand","mode"]){const calls=[];await assert.rejects(initializeKimiCodeSession({async call(method){calls.push(method);if(method==="initialize")return {protocolVersion:variant==="protocol"?2:1,agentInfo:{name:variant==="brand"?"Kimi CLI":"Kimi Code CLI"},agentCapabilities:{mcpCapabilities:{http:true}}};return {sessionId:"fixture",modes:{availableModes:[]}};}},{cwd:"/fixture",endpoint:{url:"http://127.0.0.1:1/mcp",env:{HARA_WORKSPACE_MCP_TOKEN:"a".repeat(64)}},tier:"controlled",model:null,assertCurrent(){}}),/version_incompatible/);assert.ok(!calls.includes("session/prompt"));}
});
