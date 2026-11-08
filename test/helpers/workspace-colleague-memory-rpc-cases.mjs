// All workspace-colleague-memory-rpc cases. Thin test files register disjoint partitions so each stays well under the unchanged
// 120s per-file deadline on hosted Intel (target <= 60s per file). A case that is not listed in exactly one
// partition fails registration, so no case can be silently dropped.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import {fixture,results,terminal} from "./workspace-colleague-rpc.mjs";
export const PARTITIONS = Object.freeze({
  "workspace-colleague-memory-rpc.test.mjs": Object.freeze([
    "RPC private memory commits for its owner and never crosses to another colleague",
  ]),
  "workspace-colleague-memory-rpc-sharing.test.mjs": Object.freeze([
    "RPC sharing needs its exact frozen confirmation before another colleague can find the note",
  ]),
});
const ASSIGNED = new Map(Object.entries(PARTITIONS).flatMap(([file, cases]) => cases.map(name => [name, file])));
if (ASSIGNED.size !== Object.values(PARTITIONS).flat().length) throw new Error("a case is listed in more than one partition");
export async function registerCases(file) {
  if (!Object.hasOwn(PARTITIONS, file)) throw new Error(`unknown partition ${file}`);
  const test = (name, ...rest) => {
    if (!ASSIGNED.has(name)) throw new Error(`case is not assigned to a partition: ${name}`);
    return ASSIGNED.get(name) === file ? nodeTest(name, ...rest) : undefined;
  };
test("RPC private memory commits for its owner and never crosses to another colleague",async t=>{
 const f=await fixture(t);await f.select(f.a.agentId);f.setAction({name:"workspace_memory_write",input:{content:"orchid private Alpha"}});await f.send("Remember orchid private Alpha");const remembered=await f.settle();
 assert(results(remembered).some(row=>row.name.endsWith("workspace_memory_write")&&!row.isError&&JSON.parse(row.content).remembered===true),"actual private commit precedes the isolation check");
 f.setAction({name:"workspace_memory_search",input:{query:"orchid",scope:"mine"}});await f.send("Find my orchid notes");const own=results(await f.settle()).filter(row=>row.name.endsWith("workspace_memory_search")).at(-1);assert(own);assert.equal(own.isError,false);assert(JSON.parse(own.content).hits.some(row=>row.snippet.includes("private Alpha")),"owner must find the note through actual search");
 await f.select(f.b.agentId);f.setAction({name:"workspace_memory_search",input:{query:"orchid",scope:"all"}});await f.send("Find orchid notes",f.b.agentId);const view=await f.settle(f.b.agentId),last=results(view).filter(row=>row.name.endsWith("workspace_memory_search")).at(-1);assert(last);assert.equal(last.isError,false,"an error is not isolation evidence");assert.deepEqual(JSON.parse(last.content).hits,[]);assert.doesNotMatch(last.content,/private Alpha/);
});
test("RPC sharing needs its exact frozen confirmation before another colleague can find the note",async t=>{
 const f=await fixture(t);await f.select(f.a.agentId);f.setAction({name:"workspace_memory_promote",input:{content:"orchid approved shared fact",scope:"global"}});await f.send("Share this orchid fact after I confirm");
 const card=await f.until(async()=>{const current=await f.read(),card=current.approvals.find(row=>row.kind==="memory_promote");if(card)return card;if(terminal(current))throw Error("Memory promotion ended before card: "+JSON.stringify({state:current.conversation.state,results:results(current).slice(-1)}));return null;});
 await assert.rejects(f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true,draft:{content:"tampered"}}),/frozen/);await f.rpc("workspace.approval.respond",{...f.scope,approvalId:card.id,approved:true});await f.settle();
 await f.select(f.b.agentId);f.setAction({name:"workspace_memory_search",input:{query:"orchid",scope:"workspace"}});await f.send("Find shared orchid notes",f.b.agentId);const view=await f.settle(f.b.agentId),last=results(view).filter(row=>row.name.endsWith("workspace_memory_search")).at(-1);assert.match(last.content,/approved shared fact/);
});
}
