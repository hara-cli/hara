import test from "node:test";
import assert from "node:assert/strict";
import {AgentRuntimeRegistry} from "../dist/agent-runtime/registry.js";
test("each selected runtime admission is fresh without projecting other runtimes or successful-use history",()=>{
 let current=true,lists=0;const calls=[];
 const installer={availability(id){calls.push(id);return{state:current?"local_registered":"integrity_failed",generalAgentDriverAvailable:current};},list(){lists++;return{options:[{runtimeId:"codex",...this.availability("codex")}]};}};
 const registry=new AgentRuntimeRegistry(undefined,installer);
 registry.assertAvailable("codex");assert.deepEqual(calls,["codex"]);assert.equal(lists,0);
 current=false;assert.throws(()=>registry.assertAvailable("codex"),/not available/);assert.deepEqual(calls,["codex","codex"]);assert.equal(lists,0);
 const display=registry.options();assert.equal(lists,1);assert.equal(display.find(row=>row.id==="codex").available,false);
});
test("built-in drivers need no optional-runtime display projection and pending adapters stay unavailable",()=>{
 const installer={list(){throw new Error("optional display must not be read");},availability(){throw new Error("no external runtime selected");}};
 const registry=new AgentRuntimeRegistry(undefined,installer);
 registry.assertAvailable("pi");registry.assertAvailable("hara");assert.throws(()=>registry.assertAvailable("agy"),/not available/);
});
