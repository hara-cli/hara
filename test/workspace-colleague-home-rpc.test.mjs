import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {RuntimeExecutionPolicy} from "../dist/agent-runtime/execution-policy.js";
import {fixture,results} from "./helpers/workspace-colleague-rpc.mjs";
import {SEATBELT} from "./helpers/platform-tier.mjs";
test("RPC colleague runs use the lazily pinned home, confirmed rules take effect, and offline homes refuse without fallback",async t=>{
 const f=await fixture(t),before=await f.select(f.a.agentId),home=before.colleagueHome.path;assert.equal(before.colleagueHome.created,false);assert.equal(fs.existsSync(home),false);
 const roots=[],wrap=RuntimeExecutionPolicy.prototype.wrap;RuntimeExecutionPolicy.prototype.wrap=function(input){roots.push(this.workRoot);return wrap.call(this,input);};t.after(()=>{RuntimeExecutionPolicy.prototype.wrap=wrap;});
 fs.writeFileSync(join(f.project,"artifact.txt"),"wrong legacy file");
 f.setAction({name:"workspace_write",input:{path:"artifact.txt",content:"own folder"}});await f.send("Write artifact.txt with own folder");let view=await f.settle();assert.equal(fs.readFileSync(join(home,"artifact.txt"),"utf8"),"own folder");assert.equal(fs.readFileSync(join(f.project,"artifact.txt"),"utf8"),"wrong legacy file");// Only a full-tier Pi run launches a wrapped native child; off macOS the controlled tier runs Host tools in process.
 assert(SEATBELT?roots.includes(home):roots.length===0,JSON.stringify(roots));
 const media=await f.rpc("workspace.media.register",{...f.scope,path:"artifact.txt"});assert.equal(media.bytes,Buffer.byteLength("own folder"));assert.equal(Object.hasOwn(media,"path"),false);
 f.setAction({name:"workspace_instruction_update",input:{file:"AGENTS.md",content:"Approved orchid guidance."}});await f.send("Update your AGENTS.md guidance after I confirm");let card=await f.until(async()=>(await f.read()).approvals.find(row=>row.kind==="instruction_update"));assert.equal(fs.existsSync(join(home,"AGENTS.md")),false);
 await assert.rejects(f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true,draft:{...card.draft,content:"tampered"}}),/frozen/);
 await f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true});await f.settle();assert.equal(fs.readFileSync(join(home,"AGENTS.md"),"utf8"),"Approved orchid guidance.");
 f.setAction(null);const turnStart=f.turns.length;await f.send("Hello");await f.settle();assert(f.turns.slice(turnStart).some(row=>row.system.includes("Approved orchid guidance.")));
 f.setAction({name:"workspace_write",input:{path:"AGENTS.md",content:"bypass"}});await f.send("Write AGENTS.md directly");view=await f.settle();assert.equal(fs.readFileSync(join(home,"AGENTS.md"),"utf8"),"Approved orchid guidance.");assert(results(view).some(row=>row.name.endsWith("workspace_write")&&row.isError));
 const retained=join(f.root,"retained-home");fs.renameSync(home,retained);f.setAction(null);await assert.rejects(f.send("Hello"),/folder is unavailable|folder.*changed/);assert.equal(fs.existsSync(home),false);assert.equal(fs.readFileSync(join(retained,"artifact.txt"),"utf8"),"own folder");
});
