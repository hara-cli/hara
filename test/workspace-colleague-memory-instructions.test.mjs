import { readVerifiedRegularFileSnapshotSync } from "../dist/fs-read.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {WorkspaceResourceStorage} from "../dist/workspace/resource-context.js";
import {WorkspaceColleagueHomes} from "../dist/workspace/colleague-homes.js";
import {WorkspaceColleagueInstructions} from "../dist/workspace/colleague-instructions.js";
import {withWorkspaceAgentMemory,withWorkspaceSharedMemory} from "../dist/memory/agent-scope.js";
import * as memory from "../dist/memory/store.js";
import {localWorkspaceFileTools} from "../dist/workspace/local-tools.js";
import {WorkspaceNativeSessions} from "../dist/workspace/native-session-boundary.js";
import {contextSummary} from "../dist/workspace/context-compaction.js";
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-colleague-memory-"))),id="ws_"+randomUUID();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(join(root,"state"));
 const storage=new WorkspaceResourceStorage(join(root,"state"),{schemaVersion:1,workspaceId:id,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();const project=join(root,"project",id);fs.mkdirSync(project,{recursive:true});
 const homes=new WorkspaceColleagueHomes(storage,project),a="ag_"+randomUUID(),b="ag_"+randomUUID();homes.ensure(a);homes.ensure(b);
 return{root,id,storage,project,homes,a,b,as:(agent,fn)=>withWorkspaceAgentMemory(storage,agent,project,fn)};
}
test("private facts remain bound to agentId across cwd/git changes, global scope and concurrent runs",async t=>{
 const f=fixture(t);let aPath,bPath;
 await Promise.all([f.as(f.a,async()=>{await new Promise(r=>setImmediate(r));aPath=await memory.appendMemory("global","memory","orchid private Alpha",f.homes.path(f.a));}),f.as(f.b,async()=>{bPath=await memory.appendMemory("project","memory","orchid private Beta",f.homes.path(f.b));})]);
 assert.notEqual(aPath,bPath);assert.match(aPath,new RegExp(f.a));assert.match(bPath,new RegExp(f.b));
 fs.mkdirSync(join(f.project,".git"));
 f.as(f.a,()=>{assert.equal(memory.memoryDir("project",f.project),memory.memoryDir("global",f.homes.path(f.b)));const roots=memory.memoryRoots(f.project);assert(roots[0].includes(f.a));assert(roots.every(path=>!path.includes(f.b)));assert.equal(memory.memoryDigest(f.project).includes("private Beta"),false);assert.equal((memory.memoryDigest(f.project).match(/private Alpha/g)||[]).length,1);});
 const shared=await f.as(f.a,()=>withWorkspaceSharedMemory(()=>memory.appendMemory("global","memory","orchid approved sharing",f.project)));
 assert(!shared.includes(f.a));f.as(f.b,()=>{assert(memory.memoryRoots(f.project,"workspace").includes(join(shared,"..")));assert(memory.memoryRoots(f.project,"mine").every(path=>path.includes(f.b)));});
});
test("managed rules are denied by direct file tools; Host CAS write and stable prompt work only in the exact own home",async t=>{
 const f=fixture(t),manager=new WorkspaceColleagueInstructions(f.homes,f.a),home=f.homes.path(f.a);let writes=0;
 const tools=localWorkspaceFileTools(home,()=>f.homes.ensure(f.a),{legacyProject:f.project,ownHome:home,onWrite:()=>writes++}),write=tools.find(row=>row.name==="workspace_write");
 for(const input of[{path:"AGENTS.md",content:"bypass"},{root:"legacy",path:"CLAUDE.md",content:"bypass"},{root:"legacy",path:"colleagues/"+f.b+"/note.txt",content:"bypass"}])await assert.rejects(write.run(input,{}),/confirmation|read-only/);
 await write.run({root:"legacy",path:"old-artifact.txt",content:"allowed"},{});assert.equal(writes,1);assert.equal(fs.readFileSync(join(f.project,"old-artifact.txt"),"utf8"),"allowed");
 await assert.rejects(write.run({root:"/arbitrary",path:"note.txt",content:"bypass"},{}),/root/);
 const draft=manager.prepare("AGENTS.md","Use the orchid convention."),reply=await manager.write(draft,()=>{});assert.equal(reply.humanConfirmed,true);assert.equal(fs.readFileSync(join(home,"AGENTS.md"),"utf8"),draft.content);
 const prompt=manager.prompt("pi");assert.match(prompt,/orchid convention/);assert.equal(manager.prompt("pi"),prompt);await assert.rejects(manager.write(draft,()=>{}),/changed/);
 const stale=manager.prepare("AGENTS.md","replacement");fs.writeFileSync(join(home,"AGENTS.md"),"human edit");await assert.rejects(manager.write(stale,()=>{}),/changed/);assert.equal(fs.readFileSync(join(home,"AGENTS.md"),"utf8"),"human edit");
 await assert.rejects(manager.write(manager.prepare("CLAUDE.md","denied"),()=>{throw Error("view changed");}),/view changed/);assert.equal(fs.existsSync(join(home,"CLAUDE.md")),false);
 fs.symlinkSync(join(f.project,"old-artifact.txt"),join(home,"CLAUDE.md"));assert.throws(()=>manager.prepare("CLAUDE.md","no"));
});
test("Pi and Claude reset audits preserve history, are idempotent and cut old summaries after reopen",t=>{
 const f=fixture(t),session=randomUUID(),old=Array.from({length:48},(_,i)=>({role:"user",content:"OLD-CONTEXT-"+i})),conversation={history:[...old,{role:"user",content:"current"}],pastTasks:[],task:null};
 for(const runtime of["pi","claude"]){const ledger=new WorkspaceNativeSessions(f.storage,f.a,session),before=ledger.read(),request=randomUUID(),receipt=ledger.reset(before.revision,request,runtime,old.length,"tester");
 assert.equal(receipt.duplicate,false);const reopened=new WorkspaceNativeSessions(f.storage,f.a,session);assert.equal(reopened.reset(before.revision,request,runtime,old.length,"tester").duplicate,true);const boundary=reopened.latest(runtime,conversation.history.length);assert.equal(boundary.historyStart,48);assert(boundary.epoch);assert.doesNotMatch(JSON.stringify(contextSummary({...conversation,history:conversation.history.slice(boundary.historyStart)})),/OLD-CONTEXT/);
 assert.deepEqual(conversation.history.slice(0,48),old);assert.throws(()=>reopened.latest(runtime,47),/behind/);assert.throws(()=>reopened.reset(0,randomUUID(),runtime,48,"tester"),/changed/);}
});

test("managed Host files work under the real default layout in a synthetic HOME, with credentials and aliases still blocked",async t=>{
 const account=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-managed-file-home-"))),previous=process.env.HOME;process.env.HOME=account;t.after(()=>{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;fs.rmSync(account,{recursive:true,force:true});});
 const root=join(account,".hara","workspaces-v1"),id="ws_"+randomUUID(),project=join(root,"project",id),state=join(root,"home");fs.mkdirSync(project,{recursive:true});fs.mkdirSync(state,{recursive:true});
 const storage=new WorkspaceResourceStorage(state,{schemaVersion:1,workspaceId:id,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();const homes=new WorkspaceColleagueHomes(storage,project),agent="ag_"+randomUUID(),home=homes.ensure(agent).project.root;
 const tools=localWorkspaceFileTools(home,()=>homes.ensure(agent),{legacyProject:project,ownHome:home,onWrite:()=>{}}),write=tools.find(row=>row.name==="workspace_write"),read=tools.find(row=>row.name==="workspace_read");
 await write.run({path:"nested/result.txt",content:"managed allowed"},{});assert.equal(JSON.parse(await read.run({path:"nested/result.txt"},{})).text,"managed allowed");
 for(const path of[".codex/auth.json","credentials.json","AGENTS.md.","AGENTS.md:stream","colleagues/../AGENTS.md"])await assert.rejects(write.run({path,content:"deny"},{}),undefined,path);
 const instructions=new WorkspaceColleagueInstructions(homes,agent);await instructions.write(instructions.prepare("AGENTS.md","managed confirmed"),()=>{});assert.match(instructions.prompt("pi"),/managed confirmed/);
 await assert.rejects(write.run({path:"AGENTS.md",content:"deny"},{}),/confirmation/);assert.equal(fs.existsSync(join(home,".codex","auth.json")),false);
});

test("the managed read exception rejects a parent alias before returning any bytes",t=>{
 const f=fixture(t),home=f.homes.path(f.a),outside=join(f.root,"outside");fs.mkdirSync(outside);fs.writeFileSync(join(outside,"ordinary.txt"),"synthetic outside data");const alias=join(home,"alias");fs.symlinkSync(outside,alias,"dir");const requested=join(alias,"ordinary.txt");
 assert.throws(()=>readVerifiedRegularFileSnapshotSync(requested,1024,{protectSensitive:false,expectedCanonicalPath:requested}),/canonical path changed/);
 const exact=join(home,"ordinary.txt");fs.writeFileSync(exact,"admitted");assert.equal(readVerifiedRegularFileSnapshotSync(exact,1024,{protectSensitive:false,expectedCanonicalPath:exact}).text,"admitted");
});
