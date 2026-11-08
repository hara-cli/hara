import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {cliMcpFixture,until} from "./workspace-cli-mcp.mjs";
import {LocalWorkspaceCatalog} from "../../dist/workspace/local-catalog.js";
import {WorkspaceResourceStorage} from "../../dist/workspace/resource-context.js";
import {WorkspaceConversationStore} from "../../dist/workspace/conversations.js";
const done=view=>!["running","draining"].includes(view.conversation.state);
export async function codexCwdCase(t,legacy){
 const f=await cliMcpFixture(t,"create-direct",{productionLayout:true});await f.send("Create a colleague");const proposal=await until(f.read,view=>view.approvals.length===1),card=proposal.approvals[0];
 await f.request("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true,draft:{...card.draft,runtimeId:"codex"}});const created=await until(f.read,done),agent=created.agents.find(row=>row.kind==="colleague");assert(agent);
 const read=()=>f.request("workspace.snapshot",{workspaceId:f.scope.workspaceId,agentId:agent.agentId});await f.request("workspace.agent.select",{...f.scope,agentId:agent.agentId});
 if(legacy){const home=join(f.workspaceRoot,"home"),catalog=new LocalWorkspaceCatalog(home),storage=new WorkspaceResourceStorage(home,catalog.resolve(f.scope.workspaceId).scope);storage.initialize();const store=new WorkspaceConversationStore(storage,agent.agentId),value=store.read();value.history.push({role:"user",content:"LEGACY-CODEX-CONTEXT"},{role:"assistant",text:"Retained legacy fixture",toolUses:[]});store.save(value.revision,value);}
 f.mode("reply");const send=async()=>{await f.request("workspace.session.send",{...f.scope,agentId:agent.agentId,message:"Hello",requestId:randomUUID(),source:"ui"});return until(read,done);};
 let view=await send();assert.equal(view.conversation.state,"completed",view.conversation.blockReason);const home=view.colleagueHome.path,expected=legacy?f.project:home;
 let starts=f.native().filter(row=>row.method==="thread/start");assert.equal(starts.at(-1).params.cwd,expected);const pid=f.meta().pid;
 view=await send();assert.equal(view.conversation.state,"completed",view.conversation.blockReason);assert.equal(f.meta().pid,pid);assert.equal(f.native().filter(row=>row.method==="thread/start").length,starts.length);
 if(legacy){assert.equal(view.colleagueHome.codexMigrationPending,true);const reset={...f.scope,agentId:agent.agentId,expectedRevision:view.conversation.revision,expectedNativeRevision:view.conversation.nativeSession.revision,requestId:randomUUID(),approved:true};
 await assert.rejects(f.request("workspace.session.new",{...reset,expectedGeneration:"wrong"}),/generation/);
 await f.request("workspace.session.new",reset);assert.equal((await f.request("workspace.session.new",reset)).duplicate,true);view=await send();assert.equal(view.conversation.state,"completed",view.conversation.blockReason);assert.equal(view.colleagueHome.codexMigrationPending,false);
 starts=f.native().filter(row=>row.method==="thread/start");assert.equal(starts.at(-1).params.cwd,home);assert.notEqual(f.meta().pid,pid);const latest=f.native().filter(row=>row.method==="turn/start").at(-1);assert.doesNotMatch(JSON.stringify(latest.params.input),/LEGACY-CODEX-CONTEXT|hara-context-summary/);assert(fs.existsSync(f.project));}
}
