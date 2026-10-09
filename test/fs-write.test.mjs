import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { atomicWriteText, FileChangedError } from "../dist/fs-write.js";

function fixture() {
  return mkdtempSync(join(tmpdir(), "hara-atomic-write-"));
}

test("atomicWriteText preserves mode and refuses to overwrite a stale edit base", async () => {
  const dir = fixture();
  try {
    const path = join(dir, "script.sh");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o755);

    await assert.rejects(
      atomicWriteText(path, "new\n", { expected: "different\n" }),
      (error) => error instanceof FileChangedError,
    );
    assert.equal(readFileSync(path, "utf8"), "old\n", "stale writes leave the destination untouched");
    assert.ok(!readdirSync(dir).some((name) => name.includes(".hara-")), "failed writes clean their staging file");

    await atomicWriteText(path, "new\n", { expected: "old\n" });
    assert.equal(readFileSync(path, "utf8"), "new\n");
    assert.equal(lstatSync(path).mode & 0o777, 0o755, "executable bit survives replacement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteText checks the opened staging parent before any content write", async () => {
  const dir = realpathSync.native(fixture()); const src = join(dir,"src"); const outside = join(dir,"outside");
  mkdirSync(src);mkdirSync(outside); const originalOpen=fsPromises.open;let swapped=false;let writes=0;let closes=0;
  fsPromises.open=async function(path,...args) {
    const staging=String(path).startsWith(src+"/")&&String(path).includes("/.hara-");
    if(staging&&!swapped){swapped=true;renameSync(src,join(dir,"old"));symlinkSync(outside,src,"dir");}
    const handle=await originalOpen.call(this,path,...args);
    if(!staging)return handle;
    return new Proxy(handle,{get(source,key){
      if(key==="writeFile")return (...values)=>{writes++;return source.writeFile(...values);};
      if(key==="close")return ()=>{closes++;return source.close();};
      const value=Reflect.get(source,key,source);return typeof value==="function"?value.bind(source):value;
    }});
  };syncBuiltinESMExports();
  try {
    await assert.rejects(atomicWriteText(join(src,"new.txt"),"synthetic-staging-sentinel",{expected:null}),FileChangedError);
    assert.equal(swapped,true);assert.equal(writes,0);assert.equal(closes,1);
    assert.ok(readdirSync(outside).every(name=>lstatSync(join(outside,name)).size===0),"unsafe-path cleanup retains at most an empty inode, never staged content");
    assert.equal(readdirSync(join(dir,"old")).length,0,"the original owned parent was never written");
  } finally {fsPromises.open=originalOpen;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test("atomicWriteText cancellation after staging open writes no bytes and cleans stable-parent temp",async()=>{
  const dir=realpathSync.native(fixture());const controller=new AbortController();const originalOpen=fsPromises.open;let writes=0;let closes=0;
  fsPromises.open=async function(path,...args){
    const handle=await originalOpen.call(this,path,...args);
    if(!String(path).startsWith(dir+"/")||!String(path).includes("/.hara-"))return handle;
    controller.abort();return new Proxy(handle,{get(source,key){
      if(key==="writeFile")return(...values)=>{writes++;return source.writeFile(...values);};
      if(key==="close")return()=>{closes++;return source.close();};
      const value=Reflect.get(source,key,source);return typeof value==="function"?value.bind(source):value;
    }});
  };syncBuiltinESMExports();
  try {
    await assert.rejects(atomicWriteText(join(dir,"new.txt"),"synthetic-staging-sentinel",{expected:null,signal:controller.signal}),/cancelled before commit/);
    assert.equal(writes,0);assert.equal(closes,1);assert.deepEqual(readdirSync(dir),[]);
  } finally {fsPromises.open=originalOpen;syncBuiltinESMExports();rmSync(dir,{recursive:true,force:true});}
});

test("atomicWriteText create-if-absent never clobbers and edits through symlinks", async () => {
  const dir = fixture();
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "target-v1");
    symlinkSync(target, link);

    await atomicWriteText(link, "target-v2", { expected: "target-v1" });
    assert.ok(lstatSync(link).isSymbolicLink(), "editing a symlink does not replace the link itself");
    assert.equal(readFileSync(target, "utf8"), "target-v2");

    await assert.rejects(
      atomicWriteText(target, "clobbered", { expected: null }),
      (error) => error instanceof FileChangedError,
    );
    assert.equal(readFileSync(target, "utf8"), "target-v2", "create-if-absent preserves the existing file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
