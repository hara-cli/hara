import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {WorkspaceResourceStorage,workspaceStateHome} from "../dist/workspace/resource-context.js";
import {WorkspaceConversationStore} from "../dist/workspace/conversations.js";
function fixture(t){const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"hara-conversation-noop-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let live=true;
 const storage=new WorkspaceResourceStorage(root,{schemaVersion:1,workspaceId:"ws_"+randomUUID(),authority:{kind:"local",localAuthorityId:randomUUID()}},()=>{if(!live)throw new Error("authority revoked");});storage.initialize();
 const store=new WorkspaceConversationStore(storage,"ag_"+randomUUID());const first=store.saveIfChanged(0,store.read());assert.equal(first.revision,1,"initial state must be durable");
 const file=storage.run(()=>path.join(workspaceStateHome(),".hara","conversation-"+store.sessionId+".json"));return{store,file,first,revoke(){live=false;}};}
test("identical durable conversation preserves its revision/inode while changes still persist",t=>{
 const f=fixture(t),before=fs.statSync(f.file),text=fs.readFileSync(f.file,"utf8");
 assert.deepEqual(f.store.saveIfChanged(f.first.revision,f.first),f.first);assert.equal(fs.statSync(f.file).ino,before.ino);assert.equal(fs.readFileSync(f.file,"utf8"),text);
 const next=f.store.saveIfChanged(f.first.revision,{...f.first,history:[{role:"user",content:"A harmless fixture message"}]});
 assert.equal(next.revision,f.first.revision+1);assert.equal(f.store.read().history[0].content,"A harmless fixture message");
 assert.throws(()=>f.store.saveIfChanged(f.first.revision,f.first),/state changed/);
});
test("unchanged projection cannot bypass revoked authority or linked private files",t=>{
 const f=fixture(t);f.revoke();assert.throws(()=>f.store.saveIfChanged(f.first.revision,f.first),/authority revoked/);
 const g=fixture(t);fs.linkSync(g.file,g.file+".alias");assert.throws(()=>g.store.saveIfChanged(g.first.revision,g.first),/hard.link|multiple hard links/);
});
