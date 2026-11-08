import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {WorkspaceResourceStorage} from "../dist/workspace/resource-context.js";
import {WorkspaceColleagueHomes} from "../dist/workspace/colleague-homes.js";
const agent=()=>"ag_"+randomUUID();
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-colleague-home-"))),id="ws_"+randomUUID();
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(join(root,"state"),{mode:0o700});
 const storage=new WorkspaceResourceStorage(join(root,"state"),{schemaVersion:1,workspaceId:id,authority:{kind:"local",localAuthorityId:randomUUID()}});storage.initialize();
 const project=join(root,"project",id);fs.mkdirSync(project,{recursive:true});
 return{root,id,storage,project,homes:new WorkspaceColleagueHomes(storage,project)};
}
test("home metadata is read-only until lazy creation and identity survives reopen",t=>{
 const f=fixture(t),a=agent(),b=agent();fs.writeFileSync(join(f.project,"old-artifact.txt"),"Keep legacy artifact");
 assert.deepEqual(f.homes.view(a),{path:join(f.project,"colleagues",a),legacyPath:f.project,created:false,available:false,memoryScope:"private"});
 assert.equal(fs.existsSync(join(f.project,"colleagues")),false);
 const one=f.homes.ensure(a),two=f.homes.ensure(b);assert.notEqual(one.project.root,two.project.root);
 assert.equal(fs.readFileSync(join(f.project,"old-artifact.txt"),"utf8"),"Keep legacy artifact");
 const reopened=new WorkspaceColleagueHomes(f.storage,f.project);assert.deepEqual(reopened.ensure(a),one);assert.equal(reopened.view(a).available,true);
});
test("an offline home or replacement inode never falls back or gets re-adopted",t=>{
 const f=fixture(t),a=agent(),row=f.homes.ensure(a),moved=join(f.root,"retained-home");fs.writeFileSync(join(row.project.root,"unique.txt"),"Preserve");fs.renameSync(row.project.root,moved);
 assert.equal(f.homes.view(a).available,false);assert.throws(()=>f.homes.ensure(a),error=>error.code==="workspace_primary_unavailable");assert.equal(fs.existsSync(row.project.root),false);
 fs.mkdirSync(row.project.root);assert.throws(()=>f.homes.ensure(a),error=>error.code==="workspace_primary_unavailable");assert.equal(fs.readFileSync(join(moved,"unique.txt"),"utf8"),"Preserve");
});
test("an offline legacy root is not recreated for an existing colleague",t=>{
 const f=fixture(t),a=agent();f.homes.ensure(a);const moved=join(f.root,"unmounted-fixture");fs.renameSync(f.project,moved);
 assert.throws(()=>f.homes.ensure(a),error=>error.code==="workspace_primary_unavailable");assert.equal(fs.existsSync(f.project),false);assert(fs.existsSync(moved));
});
test("unregistered folders and symlink namespaces preserve their unique data and give no grant",t=>{
 const f=fixture(t),a=agent(),home=join(f.project,"colleagues",a);fs.mkdirSync(home,{recursive:true});fs.writeFileSync(join(home,"unique.txt"),"Unregistered");
 assert.throws(()=>f.homes.ensure(a),error=>error.code==="workspace_primary_unavailable");assert.equal(f.homes.view(a).created,false);assert.equal(fs.readFileSync(join(home,"unique.txt"),"utf8"),"Unregistered");
 const other=fixture(t),outside=join(other.root,"outside");fs.mkdirSync(outside);fs.symlinkSync(outside,join(other.project,"colleagues"),"dir");
 assert.throws(()=>other.homes.ensure(a),error=>error.code==="workspace_primary_unavailable");assert.deepEqual(fs.readdirSync(outside),[]);
});
test("Codex cwd activation requires the matching committed reset, including after reopen",t=>{
 const f=fixture(t),a=agent(),session=randomUUID(),request=randomUUID();f.homes.activateCodexSession(a,session,request);
 assert.equal(f.homes.codexHomeActivated(a,session,[]),false);assert.equal(f.homes.codexHomeActivated(a,session,[{requestId:randomUUID()}]),false);
 assert.equal(f.homes.codexHomeActivated(a,session,[{requestId:request}]),true);assert.equal(f.homes.codexHomeActivated(a,randomUUID(),[{requestId:request}]),false);
 const reopened=new WorkspaceColleagueHomes(f.storage,f.project);reopened.activateCodexSession(a,session,request);assert.equal(reopened.codexHomeActivated(a,session,[{requestId:request}]),true);
});
test("paths cannot impersonate another Workspace or escape with a caller name",t=>{
 const f=fixture(t);assert.throws(()=>new WorkspaceColleagueHomes(f.storage,join(f.root,"project","ws_"+randomUUID())),error=>error.code==="workspace_primary_unavailable");
 for(const id of["../escape","name/child","ag_"+randomUUID()+"/..", ""]){assert.throws(()=>f.homes.path(id),error=>error.code==="workspace_primary_unavailable");assert.throws(()=>f.homes.ensure(id),error=>error.code==="workspace_primary_unavailable");}
 assert.equal(fs.existsSync(join(f.root,"escape")),false);
});

test("an interrupted later reset cannot erase a previously committed home activation",t=>{
 const f=fixture(t),a=agent(),session=randomUUID(),first=randomUUID(),uncommitted=randomUUID();f.homes.activateCodexSession(a,session,first);f.homes.activateCodexSession(a,session,uncommitted);
 const reopened=new WorkspaceColleagueHomes(f.storage,f.project);assert.equal(reopened.codexHomeActivated(a,session,[{requestId:first}]),true);assert.equal(reopened.codexHomeActivated(a,session,[]),false);
 reopened.activateCodexSession(a,session,uncommitted);assert.equal(reopened.codexHomeActivated(a,session,[{requestId:first}]),true);
});
