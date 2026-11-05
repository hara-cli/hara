import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {WorkspaceResourceStorage,workspaceStateHome,sameWorkspaceResourceBinding,workspaceResourceScopeKey} from "../dist/workspace/resource-context.js";
import {WorkspaceJsonState} from "../dist/workspace/local-state.js";
function fixture(t){
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"hara-json-validation-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const scope={schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}};
 let live=true,hook=()=>{},state;
 const storage=new WorkspaceResourceStorage(root,scope,()=>{if(!live)throw new Error("authority revoked");});storage.initialize();
 state=new WorkspaceJsonState(storage,"validation.json",value=>{
  if(!sameWorkspaceResourceBinding(value.resourceBinding,state.binding()))throw new Error("foreign binding");
  hook();return{revision:value.revision,resourceBinding:state.binding(),count:value.count};
 },()=>({revision:0,resourceBinding:state.binding(),count:0}));
 state.update(0,value=>({...value,count:1}));
 const file=storage.run(()=>path.join(workspaceStateHome(),".hara","validation.json"));
 return{root,scope,state,file,revoke(){live=false;},hook(value){hook=value;}};
}
test("JSON validation projects the original binding but cannot return data after authority changes",t=>{
 const f=fixture(t);const original=f.state.binding();f.hook(()=>{assert.deepEqual(f.state.binding(),original);f.revoke();});
 assert.throws(()=>f.state.read(),/authority revoked/);
 assert.throws(()=>f.state.binding(),/authority revoked/);
});
test("binding projection never escapes a validator or an await and writes retain their fresh commit fence",async t=>{
 const f=fixture(t);f.state.read();await Promise.resolve();f.revoke();
 assert.throws(()=>f.state.binding(),/authority revoked/);
 const g=fixture(t),before=fs.readFileSync(g.file,"utf8");
 assert.throws(()=>g.state.update(1,value=>{g.revoke();return{...value,count:2};}),/authority revoked/);
 assert.equal(fs.readFileSync(g.file,"utf8"),before,"denied update cannot publish replacement bytes");
});
test("generation replacement during validation and final file aliases remain rejected",t=>{
 const f=fixture(t),marker=path.join(f.root,".hara","workspace-data","v1",workspaceResourceScopeKey(f.scope),"scope.json");
 f.hook(()=>{const value=JSON.parse(fs.readFileSync(marker,"utf8"));value.generation=randomUUID();fs.writeFileSync(marker,JSON.stringify(value)+"\n");});
 assert.throws(()=>f.state.read(),/scope marker changed|generation/);
 for(const kind of ["symlink","hardlink"]){
  const g=fixture(t),alias=g.file+".original";fs.renameSync(g.file,alias);
  if(kind==="symlink")fs.symlinkSync(alias,g.file);else fs.linkSync(alias,g.file);
  assert.throws(()=>g.state.read(),/symbolic link|hard.link|multiple hard links/);
 }
});
