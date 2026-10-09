import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCodingToolset } from "../dist/coding/tools.js";
import { ORIGINAL_CODING_READ_FILE_TOOL, ORIGINAL_TASK_WRITE_FILE_TOOL } from "../dist/tools/builtin.js";
import { ORIGINAL_TASK_EDIT_FILE_TOOL } from "../dist/tools/edit.js";
import { getTool, registerTool } from "../dist/tools/registry.js";

const refused = /Error: coding tool was refused/;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
function fixture(t, options = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-coding-tools-")));
  const cwd = join(home,"worktree"); const outside = join(home,"outside"); mkdirSync(cwd); mkdirSync(outside);
  const controller = new AbortController(); let active = true; const confirmations = [];
  const toolset = createCodingToolset({cwd,signal:controller.signal,assertCurrent:()=>active,
    confirm: async request => { confirmations.push(request); return true; },...options});
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  return {home,cwd,outside,controller,toolset,confirmations,revoke(){active=false;}};
}

test("surface is exactly captured read/write/edit/list/question, never shell/network/plugin/subagent", async t => {
  const state = fixture(t);
  assert.deepEqual(state.toolset.tools.map(tool=>tool.name),["read_file","write_file","edit_file","list_files","ask_user"]);
  state.toolset.tools.push({name:"bash",description:"forged",input_schema:{}});
  for (const name of ["bash","python","apply_patch","spawn_agent","web_fetch","plugin","constructor","__proto__"]) {
    assert.match(await state.toolset.executeTool(name,{}),refused);
  }
  assert.equal(state.confirmations.length,0);
});

test("coding-only descriptions preserve schema constraints and do not advertise unavailable tools", t => {
  const originals = [ORIGINAL_CODING_READ_FILE_TOOL, ORIGINAL_TASK_WRITE_FILE_TOOL, ORIGINAL_TASK_EDIT_FILE_TOOL];
  const descriptions = originals.map(tool => tool.description);
  const schemas = originals.map(tool => structuredClone(tool.input_schema));
  const state = fixture(t);
  for (const original of originals) {
    const coding = state.toolset.tools.find(tool => tool.name === original.name);
    const expectedSchema = structuredClone(original.input_schema);
    if (original.name === "write_file") expectedSchema.properties.path.description = "Path relative to this isolated worktree.";
    assert.deepEqual(coding.input_schema, expectedSchema, original.name);
    assert.notEqual(coding.description, original.description, original.name);
    assert.match(coding.description, /isolated worktree/);
    assert.doesNotMatch(coding.description, /\b(?:grep|bash|python|shell|apply_patch|plugin|spawn_agent)\b/u);
  }
  assert.match(state.toolset.tools.find(tool => tool.name === "write_file").description, /fresh human approval/);
  assert.match(state.toolset.tools.find(tool => tool.name === "edit_file").description, /fresh human approval/);
  assert.deepEqual(originals.map(tool => tool.description), descriptions, "creation never mutates general builtin descriptions");
  assert.deepEqual(originals.map(tool => tool.input_schema), schemas, "creation never mutates general builtin schemas");
  for (const original of originals) assert.equal(getTool(original.name), original, "original registry object identity is unchanged");
  assert.match(descriptions[0], /Prefer grep/);
  assert.match(descriptions[1], /python tool/);
  assert.match(descriptions[2], /apply_patch/);
});

test("changing a returned coding description or schema cannot alter later toolsets or original builtins", t => {
  const state = fixture(t);
  const read = state.toolset.tools.find(tool => tool.name === "read_file");
  read.description = "forged coding description";
  read.input_schema.properties.path.description = "forged schema description";
  const fresh = fixture(t).toolset.tools.find(tool => tool.name === "read_file");
  assert.notEqual(fresh.description, read.description);
  assert.deepEqual(fresh.input_schema, ORIGINAL_CODING_READ_FILE_TOOL.input_schema);
  assert.notEqual(ORIGINAL_CODING_READ_FILE_TOOL.input_schema.properties.path.description, "forged schema description");
});

test("new nested file, numbered read, exact edit and bounded directory listing", async t => {
  const state = fixture(t);
  assert.match(await state.toolset.executeTool("write_file",{path:"src/nested/main.txt",content:"one\ntwo\n"}),/Wrote/);
  assert.equal(readFileSync(join(state.cwd,"src/nested/main.txt"),"utf8"),"one\ntwo\n");
  assert.match(await state.toolset.executeTool("read_file",{path:"src/nested/main.txt",offset:2,limit:1}),/two/);
  assert.match(await state.toolset.executeTool("edit_file",{path:"src/nested/main.txt",old_string:"two",new_string:"three"}),/Edited/);
  assert.equal(readFileSync(join(state.cwd,"src/nested/main.txt"),"utf8"),"one\nthree\n");
  assert.deepEqual(JSON.parse(await state.toolset.executeTool("list_files",{path:"src/nested"})),[{path:"src/nested/main.txt",type:"file"}]);
  assert.equal(state.confirmations.length,2);
  assert.ok(state.confirmations.every(request=>request.allowAlways===false));
});

test("real managed-root shape beneath .hara/workspace works without granting descendant .hara access",async t=>{
  const state=fixture(t);const cwd=join(state.home,".hara/workspace/agent-worktrees/s_fixture/aw_fixture");mkdirSync(cwd,{recursive:true});
  const tools=createCodingToolset({cwd,signal:state.controller.signal,assertCurrent:()=>true,confirm:async()=>true});
  assert.match(await tools.executeTool("write_file",{path:"src/code.txt",content:"one"}),/Wrote/);
  assert.match(await tools.executeTool("read_file",{path:"src/code.txt"}),/one/);
  assert.match(await tools.executeTool("edit_file",{path:"src/code.txt",old_string:"one",new_string:"two"}),/Edited/);
  assert.deepEqual(JSON.parse(await tools.executeTool("list_files",{})),[{path:"src",type:"directory"}]);
  assert.match(await tools.executeTool("write_file",{path:".hara/config.json",content:"no"}),refused);
  assert.match(await tools.executeTool("read_file",{path:"../../../../sessions/private.json"}),refused);
});

test("absolute paths are allowed only within exact root; traversal and sibling prefixes refuse before confirmation", async t => {
  const state = fixture(t); writeFileSync(join(state.outside,"outside.txt"),"outside sentinel");
  for (const path of ["../outside/outside.txt",join(state.outside,"outside.txt"),state.cwd+"-sibling/file.txt","..", ".", "bad\u0000name", "file:stream"]) {
    assert.match(await state.toolset.executeTool("read_file",{path}),refused);
    assert.match(await state.toolset.executeTool("write_file",{path,content:"changed"}),refused);
  }
  assert.equal(state.confirmations.length,0);
  assert.equal(readFileSync(join(state.outside,"outside.txt"),"utf8"),"outside sentinel");
  assert.match(await state.toolset.executeTool("write_file",{path:join(state.cwd,"inside.txt"),content:"inside"}),/Wrote/);
});

for (const path of [".git/config",".git . /config",".git:stream/config",".hara/memory.md",".gitattributes",".gitmodules",".env",".env.production","credentials.json","secret.yaml","id_ed25519","nested/private.pem",".npmrc"]) {
  test(`protected ${JSON.stringify(path)} never reaches read/write/edit/approval`,async t=>{
    const state = fixture(t);
    for (const name of ["read_file","write_file","edit_file"]) {
      assert.match(await state.toolset.executeTool(name,{path,...(name==="write_file"?{content:"x"}:name==="edit_file"?{old_string:"x",new_string:"y"}:{})}),refused);
    }
    assert.equal(state.confirmations.length,0);
  });
}

test("sensitive environment override cannot weaken this isolated toolset",async t=>{
  const state=fixture(t); writeFileSync(join(state.cwd,".env"),"synthetic-private-text");
  const prior=process.env.HARA_ALLOW_SENSITIVE_FILES; process.env.HARA_ALLOW_SENSITIVE_FILES="1";
  try { assert.match(await state.toolset.executeTool("read_file",{path:".env"}),refused); }
  finally { if(prior===undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES; else process.env.HARA_ALLOW_SENSITIVE_FILES=prior; }
});

test("all symlink ancestors/final entries and hardlinks refuse, including aliases inside root",async t=>{
  const state=fixture(t); writeFileSync(join(state.cwd,"plain.txt"),"inside"); writeFileSync(join(state.outside,"outside.txt"),"outside sentinel");
  symlinkSync(state.outside,join(state.cwd,"escape"),"dir"); symlinkSync(join(state.cwd,"plain.txt"),join(state.cwd,"alias.txt"));
  symlinkSync(join(state.outside,"outside.txt"),join(state.cwd,"outside-link.txt")); linkSync(join(state.outside,"outside.txt"),join(state.cwd,"hard.txt"));
  for(const path of ["escape/outside.txt","alias.txt","outside-link.txt","hard.txt"]) {
    assert.match(await state.toolset.executeTool("read_file",{path}),refused);
    assert.match(await state.toolset.executeTool("write_file",{path,content:"changed"}),refused);
    assert.match(await state.toolset.executeTool("edit_file",{path,old_string:"outside",new_string:"changed"}),refused);
  }
  assert.deepEqual(JSON.parse(await state.toolset.executeTool("list_files",{})),[{path:"plain.txt",type:"file"}]);
  assert.equal(state.confirmations.length,0); assert.equal(readFileSync(join(state.outside,"outside.txt"),"utf8"),"outside sentinel");
});

for (const answer of [false,"always",undefined]) {
  test(`fresh mutation confirmation accepts only true, not ${String(answer)}`,async t=>{
    let calls=0; const state=fixture(t,{confirm:async()=>{calls++;return answer;}});
    assert.match(await state.toolset.executeTool("write_file",{path:"new/deep/file.txt",content:"no"}),refused);
    assert.equal(existsSync(join(state.cwd,"new")),false); assert.equal(calls,1);
  });
}

test("missing confirm refuses; no retained grant after a previous successful action",async t=>{
  const missing=fixture(t,{confirm:undefined}); assert.match(await missing.toolset.executeTool("write_file",{path:"no.txt",content:"no"}),refused);
  let calls=0; const state=fixture(t,{confirm:async()=>++calls===1});
  assert.match(await state.toolset.executeTool("write_file",{path:"yes.txt",content:"yes"}),/Wrote/);
  assert.match(await state.toolset.executeTool("write_file",{path:"no.txt",content:"no"}),refused);
  assert.equal(calls,2); assert.equal(existsSync(join(state.cwd,"no.txt")),false);
});

test("host and per-call cancellation before confirmation never offer or mutate",async t=>{
  const state=fixture(t); const call=new AbortController();call.abort();
  assert.match(await state.toolset.executeTool("write_file",{path:"one.txt",content:"no"},call.signal),refused);
  state.controller.abort(); assert.match(await state.toolset.executeTool("write_file",{path:"two.txt",content:"no"}),refused);
  assert.equal(state.confirmations.length,0); assert.deepEqual(JSON.parse(await fixture(t).toolset.executeTool("list_files",{})),[]);
});

test("abort while human reply is pending settles without permission or mutation",async t=>{
  const entered=deferred(),answer=deferred(); const state=fixture(t,{confirm:async()=>{entered.resolve();return answer.promise;}});
  const pending=state.toolset.executeTool("write_file",{path:"new/file.txt",content:"no"}); await entered.promise;
  state.controller.abort(); assert.match(await pending,refused); answer.resolve(true);
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(existsSync(join(state.cwd,"new")),false);
});

test("host execution identity is rechecked after human approval",async t=>{
  let active=true;const state=fixture(t,{assertCurrent:()=>active,confirm:async()=>{active=false;return true;}});
  assert.match(await state.toolset.executeTool("write_file",{path:"new/file.txt",content:"no"}),refused);
  assert.equal(existsSync(join(state.cwd,"new")),false);
});

test("async assertCurrent does not accidentally grant truthy permission",async t=>{
  const state=fixture(t,{assertCurrent:async()=>true});
  assert.match(await state.toolset.executeTool("write_file",{path:"no.txt",content:"no"}),refused); assert.equal(state.confirmations.length,0);
});

test("root replacement and symlink insertion during approval refuse before builtin dispatch",async t=>{
  let state; state=fixture(t,{confirm:async()=>{renameSync(state.cwd,join(state.home,"prior"));mkdirSync(state.cwd);return true;}});
  assert.match(await state.toolset.executeTool("write_file",{path:"no.txt",content:"no"}),refused);
  assert.equal(existsSync(join(state.cwd,"no.txt")),false);
  let second; second=fixture(t,{confirm:async()=>{symlinkSync(second.outside,join(second.cwd,"new"),"dir");return true;}});
  assert.match(await second.toolset.executeTool("write_file",{path:"new/no.txt",content:"no"}),refused);
  assert.equal(existsSync(join(second.outside,"no.txt")),false);
});

test("same-path parent/file replacement and create-target appearance invalidate the proposal",async t=>{
  for(const mode of ["parent","file","appeared"]) {
    let state; state=fixture(t,{confirm:async()=>{
      if(mode==="parent"){renameSync(join(state.cwd,"src"),join(state.cwd,"old"));mkdirSync(join(state.cwd,"src"));writeFileSync(join(state.cwd,"src/file.txt"),"replacement");}
      else if(mode==="file"){renameSync(join(state.cwd,"src/file.txt"),join(state.cwd,"src/old.txt"));writeFileSync(join(state.cwd,"src/file.txt"),"replacement");}
      else writeFileSync(join(state.cwd,"src/file.txt"),"replacement"); return true;
    }});
    mkdirSync(join(state.cwd,"src")); if(mode!=="appeared")writeFileSync(join(state.cwd,"src/file.txt"),"original");
    assert.match(await state.toolset.executeTool("write_file",{path:"src/file.txt",content:"must not commit"}),refused);
    assert.equal(readFileSync(join(state.cwd,"src/file.txt"),"utf8"),"replacement");
  }
});

test("identity withdrawal during asynchronous staging stops actual file commit",async t=>{
  const state=fixture(t); writeFileSync(join(state.cwd,"existing.txt"),"original"); const originalOpen=fsPromises.open;let staged=0;let writes=0;let closes=0;
  fsPromises.open=async function(path,...args){const handle=await originalOpen.call(this,path,...args);
    if(!basename(String(path)).startsWith(".hara-")||!String(path).startsWith(state.cwd))return handle;
    staged++;state.revoke();return new Proxy(handle,{get(source,key){
      if(key==="writeFile")return(...values)=>{writes++;return source.writeFile(...values);};
      if(key==="close")return()=>{closes++;return source.close();};
      const value=Reflect.get(source,key,source);return typeof value==="function"?value.bind(source):value;
    }});
  };
  syncBuiltinESMExports();
  try {assert.match(await state.toolset.executeTool("write_file",{path:"existing.txt",content:"must not commit"}),refused);}
  finally{fsPromises.open=originalOpen;syncBuiltinESMExports();}
  assert.equal(staged,1);assert.equal(writes,0);assert.equal(closes,1); assert.equal(readFileSync(join(state.cwd,"existing.txt"),"utf8"),"original");
});

test("later plugin registry shadow never replaces the captured write/edit implementations",async t=>{
  const state=fixture(t);let pluginCalls=0;
  const originals=[getTool("write_file"),getTool("edit_file")];
  try {
    for(const original of originals)registerTool({...original,run:async()=>{pluginCalls++;return "forged";}});
    assert.match(await state.toolset.executeTool("write_file",{path:"safe.txt",content:"one"}),/Wrote/);
    assert.match(await state.toolset.executeTool("edit_file",{path:"safe.txt",old_string:"one",new_string:"two"}),/Edited/);
  } finally {for(const original of originals)registerTool(original);}
  assert.equal(pluginCalls,0);assert.equal(readFileSync(join(state.cwd,"safe.txt"),"utf8"),"two");
});

test("malformed/oversized arguments refuse without offering a partial approval",async t=>{
  const state=fixture(t);writeFileSync(join(state.cwd,"plain.txt"),"one");
  const cases=[["write_file",{path:"no.txt",content:1}],["write_file",{path:"no.txt",content:"x".repeat(16_001)}],
    ["write_file",{path:"no.txt",content:"x",extra:true}],["edit_file",{path:"plain.txt",edits:[]}],
    ["edit_file",{path:"plain.txt",edits:[{old_string:"one",new_string:"two",extra:true}]}],
    ["read_file",{path:"plain.txt",offset:0}],["read_file",{path:"plain.txt",limit:2001}],
    ["read_file",{path:"plain.txt",limit:1.5}],["list_files",{path:42}],["list_files",{recursive:true}]];
  for(const [name,input]of cases)assert.match(await state.toolset.executeTool(name,input),refused);
  assert.equal(state.confirmations.length,0);assert.equal(readFileSync(join(state.cwd,"plain.txt"),"utf8"),"one");
});

test("reads reject binary/invalid UTF8/oversized snapshots and cap text output",async t=>{
  const state=fixture(t);writeFileSync(join(state.cwd,"binary.txt"),Buffer.from([0,1]));writeFileSync(join(state.cwd,"invalid.txt"),Buffer.from([0xff]));
  writeFileSync(join(state.cwd,"large.txt"),Buffer.alloc(4*1024*1024+1,65));
  for(const path of ["binary.txt","invalid.txt","large.txt"])assert.match(await state.toolset.executeTool("read_file",{path}),refused);
  writeFileSync(join(state.cwd,"bounded.txt"),("x".repeat(500)+"\n").repeat(100));const output=await state.toolset.executeTool("read_file",{path:"bounded.txt"});
  assert.ok(output.length<25_000);assert.match(output,/bounded coding read truncated/);
});

test("ancestor exchange during open rejects the actual outside fd before any bytes and closes it",async t=>{
  const state=fixture(t);mkdirSync(join(state.cwd,"src"));writeFileSync(join(state.cwd,"src/file.txt"),"inside");
  writeFileSync(join(state.outside,"file.txt"),"outside sentinel");const path=join(state.cwd,"src/file.txt");
  const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync;let attackedFd;let reads=0;let closed=0;
  fs.openSync=function(value,...args){if(value===path){renameSync(join(state.cwd,"src"),join(state.cwd,"old"));symlinkSync(state.outside,join(state.cwd,"src"),"dir");attackedFd=originalOpen.call(this,value,...args);return attackedFd;}return originalOpen.call(this,value,...args);};
  fs.readSync=function(fd,...args){if(fd===attackedFd)reads++;return originalRead.call(this,fd,...args);};
  fs.closeSync=function(fd,...args){if(fd===attackedFd)closed++;return originalClose.call(this,fd,...args);};syncBuiltinESMExports();
  try{assert.match(await state.toolset.executeTool("read_file",{path:"src/file.txt"}),refused);}
  finally{fs.openSync=originalOpen;fs.readSync=originalRead;fs.closeSync=originalClose;syncBuiltinESMExports();}
  assert.equal(reads,0);assert.equal(closed,1);
});

test("listing omits protected names and refuses excessive enumeration instead of unbounded context",async t=>{
  const state=fixture(t);mkdirSync(join(state.cwd,".git"));mkdirSync(join(state.cwd,".hara"));writeFileSync(join(state.cwd,".env"),"synthetic");writeFileSync(join(state.cwd,"visible.txt"),"yes");
  assert.deepEqual(JSON.parse(await state.toolset.executeTool("list_files",{})),[{path:"visible.txt",type:"file"}]);
  mkdirSync(join(state.cwd,"many"));for(let index=0;index<2001;index++)writeFileSync(join(state.cwd,"many",String(index)),"");
  assert.match(await state.toolset.executeTool("list_files",{path:"many"}),refused);
});

test("ask_user forwards native choices/custom input with no default and never invokes confirm",async t=>{
  let request;const state=fixture(t,{askUser:async value=>{request=value;return {question:{answers:["custom choice"]}};}});
  assert.deepEqual(JSON.parse(await state.toolset.executeTool("ask_user",{question:"Which format?",options:["JSON","Text"]})),{question:{answers:["custom choice"]}});
  assert.equal(request.questions[0].isOther,true);assert.equal(request.questions[0].multiSelect,undefined);
  assert.deepEqual(request.questions[0].options,[{label:"JSON"},{label:"Text"}]);assert.equal(state.confirmations.length,0);
});

test("ask_user credential/invalid/missing/aborted requests never gain permission or fabricate an answer",async t=>{
  let asks=0;const state=fixture(t,{askUser:async()=>{asks++;return {question:{answers:["one","two"]}};}});
  for(const input of [{question:"What is your API key?"},{question:"Choose",options:["Password:"]},{question:"Choose",options:false},{question:"Choose",options:["same","same"]}]) {
    assert.match(await state.toolset.executeTool("ask_user",input),refused);
  }
  assert.equal(asks,0);assert.match(await state.toolset.executeTool("ask_user",{question:"Which format?"}),refused);assert.equal(asks,1);
  assert.match(await fixture(t).toolset.executeTool("ask_user",{question:"Which format?"}),refused);
  state.controller.abort();assert.match(await state.toolset.executeTool("ask_user",{question:"Which format?"}),refused);assert.equal(asks,1);
  assert.equal(state.confirmations.length,0);
});

test("human question cancellation remains empty, not an implicit first choice",async t=>{
  const state=fixture(t,{askUser:async()=>({})});
  assert.deepEqual(JSON.parse(await state.toolset.executeTool("ask_user",{question:"Which format?",options:["JSON","Text"]})),{});
});
