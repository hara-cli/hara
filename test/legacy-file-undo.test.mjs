import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceResourceStorage, inspectWorkspaceResourceFile, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { writePrivateStateFileSync, writePrivateStateBytesOnceSync, removePrivateStateFile } from "../dist/security/private-state.js";
import { observePrivateStateWrites } from "../dist/security/private-write-observer.js";
import { LegacyScopedFileUndo } from "../dist/workspace/legacy-file-undo.js";

function fixture(t) {
  const home=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-legacy-file-undo-")));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const scope={schemaVersion:1,workspaceId:"ws_10000000-0000-4000-8000-000000000001",authority:{kind:"local",localAuthorityId:"20000000-0000-4000-8000-000000000001"}};
  const storage=new WorkspaceResourceStorage(home,scope);storage.initialize();
  const file=path=>inspectWorkspaceResourceFile(join(workspaceStateHome(),path),100000);
  return {storage, tx:()=>new LegacyScopedFileUndo(storage,"settings","a".repeat(64)),
    path:path=>storage.run(()=>join(workspaceStateHome(),path)),
    read:path=>storage.run(()=>file(path).snapshot?.text??null),
    write(path,text,options={}) {storage.run(()=>{const f=file(path);writePrivateStateFileSync(f,text,{...(f.snapshot?{expectedText:f.snapshot.text}:{expectedMissing:true}),...options});});},
    binary(path) {storage.run(()=>writePrivateStateBytesOnceSync(file(path),Buffer.from([0,255])));},
    remove(path) {storage.run(()=>{const f=file(path);removePrivateStateFile(f.path,f.snapshot,f.directory);});},
  };
}
test("preimages are durable before writes and rollback restores old bytes/removes only owned new files",async t=>{
  const f=fixture(t);f.write(".hara/existing.json","old");const tx=f.tx();tx.begin([".hara/existing.json",".hara/new.md"]);
  await tx.runImport(()=>{f.write(".hara/existing.json","imported");f.write(".hara/new.md","new");});
  f.tx().rollback();assert.equal(f.read(".hara/existing.json"),"old");assert.equal(f.read(".hara/new.md"),null);
});
test("a newer user edit prevents every rollback effect and preserves both versions",async t=>{
  const f=fixture(t),tx=f.tx();tx.begin([".hara/a.md",".hara/z.md"]);
  await tx.runImport(()=>{f.write(".hara/a.md","imported-a");f.write(".hara/z.md","imported-z");});
  f.write(".hara/z.md","new user edit");assert.throws(()=>tx.rollback(),/newer file edit/);
  assert.equal(f.read(".hara/a.md"),"imported-a");assert.equal(f.read(".hara/z.md"),"new user edit");
});
test("open/unknown postimages cannot be deleted by a rollback guess",t=>{
  const f=fixture(t),tx=f.tx();tx.begin([".hara/new.md"]);f.write(".hara/new.md","partial import");
  assert.throws(()=>tx.rollback(),/Incomplete/);assert.equal(f.read(".hara/new.md"),"partial import");
});
test("retrying begin on a partial import preserves the original preimage, not its own new output",async t=>{
  const f=fixture(t),tx=f.tx();f.write(".hara/existing.json","original");tx.begin([".hara/existing.json"]);
  await assert.rejects(tx.runImport(()=>{f.write(".hara/existing.json","partial");throw Error("synthetic interrupted importer");}),/interrupted/);
  f.tx().begin([".hara/existing.json"]);await f.tx().runImport(()=>f.write(".hara/existing.json","final"));f.tx().rollback();assert.equal(f.read(".hara/existing.json"),"original");
});
test("upgrade/rollback/upgrade reuses output paths without treating user edits as a previous import",async t=>{
  const f=fixture(t);let tx=f.tx();tx.begin([".hara/value.md"]);await tx.runImport(()=>f.write(".hara/value.md","one"));tx.rollback();
  tx=f.tx();assert.equal(tx.begin([".hara/value.md"]).round,2);await tx.runImport(()=>f.write(".hara/value.md","two"));tx.rollback();assert.equal(f.read(".hara/value.md"),null);
});
test("a crash after file restore but before its journal update resumes without rewriting new data",async t=>{
  const f=fixture(t),tx=f.tx();f.write(".hara/value.md","original");tx.begin([".hara/value.md"]);await tx.runImport(()=>f.write(".hara/value.md","imported"));
  const update=tx.state.update.bind(tx.state);let count=0;tx.state.update=(...args)=>{if(++count===2)throw Error("synthetic receipt crash");return update(...args);};
  assert.throws(()=>tx.rollback(),/receipt crash/);assert.equal(f.read(".hara/value.md"),"original");f.tx().rollback();assert.equal(f.tx().read().status,"rolled_back");
});
test("paths, output set changes and plaintext credential undo copies are refused",t=>{
  const f=fixture(t);assert.throws(()=>f.tx().begin(["../outside"]),/output set/);f.tx().begin([".hara/a.md"]);assert.throws(()=>f.tx().begin([".hara/b.md"]),/output set changed/);
  const g=fixture(t);g.write(".hara/connection.json",JSON.stringify({apiKey:"fake-value-never-copy-to-undo"}));assert.throws(()=>g.tx().begin([".hara/connection.json"]),/secure migration/);
});
test("freshly read user edits cannot be adopted as an import's expected version",async t=>{
  const f=fixture(t),tx=f.tx();f.write(".hara/a.md","before");tx.begin([".hara/a.md"]);
  await assert.rejects(tx.runImport(()=>{fs.writeFileSync(f.path(".hara/a.md"),"concurrent user edit");f.write(".hara/a.md","attempted overwrite");}),/Concurrent user edit/);
  assert.equal(f.read(".hara/a.md"),"concurrent user edit");
});
test("a late filesystem scan cannot turn a concurrent edit into the owned postimage",async t=>{
  const f=fixture(t),tx=f.tx();tx.begin([".hara/a.md"]);
  await assert.rejects(tx.runImport(()=>{f.write(".hara/a.md","owned import");fs.writeFileSync(f.path(".hara/a.md"),"user edit after commit");}),/cannot claim its postimage/);
  assert.equal(f.read(".hara/a.md"),"user edit after commit");assert.equal(tx.read().files[0].afterHash.length,64);
});
test("durable next-image intent recovers a crash before target publication",async t=>{
  const f=fixture(t),tx=f.tx();f.write(".hara/a.md","original");tx.begin([".hara/a.md"]);let checks=0;
  await assert.rejects(tx.runImport(()=>f.write(".hara/a.md","next",{assertCurrent(){if(++checks===2)throw Error("before publication");}})),/before publication/);
  assert.equal(f.read(".hara/a.md"),"original");await f.tx().runImport(()=>f.write(".hara/a.md","next"));f.tx().rollback();assert.equal(f.read(".hara/a.md"),"original");
});
test("durable next-image intent recovers target publication before the receipt",async t=>{
  const f=fixture(t),tx=f.tx();f.write(".hara/a.md","original");tx.begin([".hara/a.md"]);
  const update=tx.state.update.bind(tx.state);let calls=0;tx.state.update=(...args)=>{if(++calls===2)throw Error("after publication");return update(...args);};
  await assert.rejects(tx.runImport(()=>f.write(".hara/a.md","next")),/after publication/);assert.equal(f.read(".hara/a.md"),"next");
  await f.tx().runImport(()=>{});f.tx().rollback();assert.equal(f.read(".hara/a.md"),"original");
});
test("unplanned output writes fail before their target is created",async t=>{
  const f=fixture(t),tx=f.tx();tx.begin([".hara/a.md"]);await assert.rejects(tx.runImport(()=>f.write(".hara/unplanned.md","must not be created")),/Unplanned/);assert.equal(f.read(".hara/unplanned.md"),null);
});
test("binary writes cannot bypass the bounded text transaction",async t=>{
  const f=fixture(t),tx=f.tx();tx.begin([".hara/a.bin"]);await assert.rejects(tx.runImport(()=>f.binary(".hara/a.bin")),/Binary writes/);assert.equal(f.read(".hara/a.bin"),null);
});
test("deletion cannot bypass write tracing while internal CAS lock release still works",async t=>{
  const f=fixture(t),tx=f.tx();f.write(".hara/a.md","original");tx.begin([".hara/a.md"]);
  await assert.rejects(tx.runImport(()=>f.remove(".hara/a.md")),/File deletion/);
  assert.equal(f.read(".hara/a.md"),"original");
  await tx.runImport(()=>f.write(".hara/a.md","owned"));tx.rollback();assert.equal(f.read(".hara/a.md"),"original");
});
test("private writer refuses async observation before a target write",t=>{
  const f=fixture(t);
  assert.throws(()=>observePrivateStateWrites({checkPath:async()=>{},before(){},committed(){}},()=>f.write(".hara/a.md","must not publish")),/synchronous/);
  assert.equal(f.read(".hara/a.md"),null);
});
test("unawaited asynchronous work loses its transaction write authority when import returns",async t=>{
  const f=fixture(t),tx=f.tx();tx.begin([".hara/a.md"]);let release,late;const wait=new Promise(resolve=>release=resolve);
  await tx.runImport(()=>{f.write(".hara/a.md","owned");late=wait.then(()=>f.write(".hara/a.md","late")).catch(error=>error.message);});
  release();assert.match(await late,/Unplanned/);assert.equal(f.read(".hara/a.md"),"owned");
});
test("retained key-reference audit survives rollback and rejects tampering before retry cleanup",async t=>{
  const f=fixture(t),tx=f.tx(),audit=".hara/cleanup-audit.json";tx.begin([".hara/a.md",audit],[audit]);
  await tx.runImport(()=>{f.write(".hara/a.md","imported");f.write(audit,JSON.stringify({refs:["scope:mc_fixture:gen_fixture"]}));});
  tx.rollback();assert.equal(f.read(".hara/a.md"),null);assert.equal(JSON.parse(tx.retainedAuditText(audit)).refs.length,1);
  fs.writeFileSync(f.path(audit),JSON.stringify({refs:["different:credential:reference"]}));assert.throws(()=>tx.retainedAuditText(audit),/audit changed/);
});
