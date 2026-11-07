import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceMediaRegistry, MAX_MEDIA_RESPONSE_BYTES } from "../dist/workspace/media.js";
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
function fixture(t) {
 const parent=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-media-"))), project=join(parent,"project"), registered=join(parent,"registered");
 fs.mkdirSync(project);fs.mkdirSync(registered);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 let roots=[project,registered],current=true;const registry=new WorkspaceMediaRegistry(project,()=>roots,()=>{if(!current)throw Error("Generation changed");});
 return{parent,project,registered,registry,revoke(){roots=[project];},change(){current=false;}};
}
test("local GIF registrations expose only an opaque identity and serve verified bytes",t=>{
 const f=fixture(t),path=join(f.project,"a space.gif");fs.writeFileSync(path,gif);
 const entry=f.registry.register(pathToFileURL(path).href);assert.deepEqual(Object.keys(entry).sort(),["bytes","id","mime"]);
 assert.match(entry.id,/^[a-f0-9]{64}$/);assert.equal(entry.mime,"image/gif");assert.equal(entry.bytes,gif.length);
 assert.deepEqual(f.registry.read(entry.id).bytes,gif);assert.equal(f.registry.read(entry.id,undefined,true).bytes.length,0);
 assert.equal(f.registry.register("a space.gif").id,entry.id);
});
test("traversal, root outsiders, symlink escapes and hard-link aliases are rejected",t=>{
 const f=fixture(t),outside=join(f.parent,"outside.gif");fs.writeFileSync(outside,gif);fs.writeFileSync(join(f.project,"good.gif"),gif);
 fs.symlinkSync(outside,join(f.project,"link.gif"));fs.symlinkSync(f.parent,join(f.project,"escape"));fs.linkSync(outside,join(f.project,"hard.gif"));
 for(const path of ["../outside.gif",outside,"link.gif","escape/outside.gif","hard.gif",f.project,join(f.project,"..","outside.gif")]) assert.throws(()=>f.registry.register(path),/media unavailable/);
 assert.deepEqual(f.registry.read(f.registry.register("good.gif").id).bytes,gif);
});
test("only current registered project roots survive revalidation and no stale inode is reused",t=>{
 const f=fixture(t),path=join(f.registered,"render.gif");fs.writeFileSync(path,gif);const entry=f.registry.register(path);
 assert.deepEqual(f.registry.read(entry.id).bytes,gif);f.revoke();assert.throws(()=>f.registry.read(entry.id),/media unavailable/);
 const local=join(f.project,"local.gif");fs.writeFileSync(local,gif);const a=f.registry.register(local);
 fs.renameSync(local,local+".old");fs.writeFileSync(local,gif);assert.throws(()=>f.registry.read(a.id),/media unavailable/);
 const b=f.registry.register(local);assert.notEqual(b.id,a.id);fs.unlinkSync(local);fs.symlinkSync(local+".old",local);assert.throws(()=>f.registry.read(b.id),/media unavailable/);
});
test("moved files, generation changes, unsupported MIME and disguised text fail closed",t=>{
 const f=fixture(t);for(const [name,bytes]of[["page.gif",Buffer.from("<html>not an image</html>")],["image.svg",Buffer.from("<svg/>")],["note.txt",gif]]){fs.writeFileSync(join(f.project,name),bytes);assert.throws(()=>f.registry.register(name),/media unavailable/);}
 fs.writeFileSync(join(f.project,"good.gif"),gif);const entry=f.registry.register("good.gif");fs.renameSync(join(f.project,"good.gif"),join(f.project,"moved.gif"));assert.throws(()=>f.registry.read(entry.id),/media unavailable/);
 const b=f.registry.register("moved.gif");f.change();assert.throws(()=>f.registry.read(b.id),/Generation changed/);
});
test("videos use bounded byte ranges; invalid and multi-ranges never become file reads",t=>{
 const f=fixture(t),path=join(f.project,"clip.mp4"),fd=fs.openSync(path,"w");fs.writeSync(fd,Buffer.from([0,0,0,24,...Buffer.from("ftypisom")]));fs.ftruncateSync(fd,MAX_MEDIA_RESPONSE_BYTES+64);fs.closeSync(fd);
 const entry=f.registry.register("clip.mp4"),part=f.registry.read(entry.id,"bytes=0-11");assert.equal(part.status,206);assert.equal(part.bytes.length,12);assert.equal(part.headers["Content-Range"],`bytes 0-11/${entry.bytes}`);
 assert.equal(f.registry.read(entry.id,"bytes=0-999999999").bytes.length,MAX_MEDIA_RESPONSE_BYTES);
 assert.equal(f.registry.read(entry.id,"bytes=-8").bytes.length,8);assert.equal(f.registry.read(entry.id).bytes.length,MAX_MEDIA_RESPONSE_BYTES);
 for(const range of["bytes=999999999-","bytes=3-1","bytes=0-2,4-6","bytes=-0","bytes=-999999999999999999999999","bytes=0-999999999999999999999999","bad"] )assert.throws(()=>f.registry.read(entry.id,range),RangeError);
});

test("a current registered image survives long pauses without a time-based broken-image state",t=>{
 const f=fixture(t);fs.writeFileSync(join(f.project,"still.gif"),gif);const entry=f.registry.register("still.gif"),now=Date.now;
 try{Date.now=()=>now()+2*60*60*1000;assert.deepEqual(f.registry.read(entry.id).bytes,gif);assert.equal(f.registry.register("still.gif").id,entry.id);}finally{Date.now=now;}
 assert.deepEqual(f.registry.read(entry.id,"bytes=0-99999").bytes,gif);
});

test("media states distinguish missing in-root artifacts from forbidden paths without exposing outside existence", t => {
 const f=fixture(t);fs.writeFileSync(join(f.project,"ready.gif"),gif);fs.writeFileSync(join(f.project,"broken.gif"),Buffer.from("not a GIF"));
 assert.equal(f.registry.describe("ready.gif").state,"ready");
 assert.deepEqual(f.registry.describe("missing.gif"),{state:"missing"});
 assert.deepEqual(f.registry.describe("broken.gif"),{state:"failed"});
 const outside=join(f.parent,"outside.gif");fs.writeFileSync(outside,gif);
 assert.deepEqual(f.registry.describe(outside),{state:"outside"});assert.deepEqual(f.registry.describe(join(f.parent,"absent.gif")),{state:"outside"});
 fs.symlinkSync(outside,join(f.project,"link.gif"));assert.deepEqual(f.registry.describe("link.gif"),{state:"outside"});
 assert.deepEqual(f.registry.describe("../outside.gif"),{state:"outside"});
 const result=f.registry.describe("ready.gif");fs.renameSync(join(f.project,"ready.gif"),join(f.project,"moved.gif"));
 assert.deepEqual(f.registry.describe("ready.gif"),{state:"missing"});assert.throws(()=>f.registry.read(result.media.id),/media unavailable/);
 f.change();assert.throws(()=>f.registry.describe("moved.gif"),/Generation changed/);
});

test("passive file cards use closed MIME families and retain all opaque-id and root checks", t => {
 const f=fixture(t), types=[["paper.pdf",Buffer.from("%PDF-1.7\nfixture"),"application/pdf"],["bundle.zip",Buffer.from([80,75,3,4,0,0,0,0]),"application/zip"],["sheet.xlsx",Buffer.from([80,75,3,4,0,0,0,0]),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],["note.md",Buffer.from("# Fixture\nOnly synthetic text."),"text/markdown"]];
 for(const[name,bytes,mime]of types){fs.writeFileSync(join(f.project,name),bytes);const result=f.registry.describe(name);assert.equal(result.state,"ready");assert.equal(result.media.mime,mime);assert.deepEqual(f.registry.read(result.media.id).bytes,bytes);assert.equal("path"in result.media,false);}
 for(const[name,bytes]of[["run.command",Buffer.from("exit 1")],["fake.pdf",Buffer.from("<html>not PDF</html>")],["fake.xlsx",Buffer.from("not zip")],["binary.md",Buffer.from([0,1,2])]]){fs.writeFileSync(join(f.project,name),bytes);assert.deepEqual(f.registry.describe(name),{state:"failed"});}
 fs.writeFileSync(join(f.parent,"outside.md"),"# Outside");assert.deepEqual(f.registry.describe(join(f.parent,"outside.md")),{state:"outside"});
 fs.symlinkSync(join(f.parent,"outside.md"),join(f.project,"alias.md"));assert.deepEqual(f.registry.describe("alias.md"),{state:"outside"});
});

test("file URL decoding cannot hide bidi controls in a registered filename",t=>{
 const f=fixture(t),path=join(f.project,"misleading\u202e.md");fs.writeFileSync(path,"# Synthetic fixture");
 assert.deepEqual(f.registry.describe(path),{state:"outside"});assert.deepEqual(f.registry.describe(pathToFileURL(path).href),{state:"outside"});
});
