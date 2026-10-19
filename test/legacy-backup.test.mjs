import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyBackup, verifyLegacyBackup } from "../dist/workspace/legacy-backup.js";

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-legacy-backup-test-")));
  const home = join(root, "home"), launch = join(root, "launch"), destination = join(root, "backup");
  for (const path of [join(home, ".hara"), launch, destination]) mkdirSync(path, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, launch, destination, write(name, value) { const path = join(home, ".hara", name); mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, value, { mode: 0o600 }); return path; },
    copy() { return createLegacyBackup({ sourceHome: home, launchAgentsRoot: launch, destination }); } };
}
test("owner snapshot copies opaque credentials privately without modifying source bytes or modes", t => {
  const f = fixture(t), path = f.write("profiles.json", JSON.stringify({ profiles: [{ apiKey: "fixture-only-never-print" }] }));
  chmodSync(path, 0o400); const before = readFileSync(path), mode = lstatSync(path).mode;
  const result = f.copy(); assert.equal(result.manifest.files.length, 1);
  assert.deepEqual(readFileSync(path), before); assert.equal(lstatSync(path).mode, mode);
  assert.deepEqual(readFileSync(join(result.sourceHome, ".hara/profiles.json")), before);
  assert.equal(lstatSync(join(result.sourceHome, ".hara/profiles.json")).mode & 0o777, 0o400);
  assert.equal(JSON.stringify(result.manifest).includes("fixture-only-never-print"), false);
  assert.equal(verifyLegacyBackup(f.destination).sourceFingerprint, result.manifest.sourceFingerprint);
});
test("snapshot excludes only named media/checkpoints and inventories rather than follows symlinks", t => {
  const f = fixture(t); f.write("checkpoints/one", "excluded"); f.write("wechat-group/media", "excluded"); f.write("roles/fanli.md", "fixture persona");
  const outside = join(f.root, "outside"); writeFileSync(outside, "must-not-copy"); symlinkSync(outside, join(f.home, ".hara/link"));
  const result = f.copy(); assert.deepEqual(result.manifest.files.map(row => row.path), [".hara/roles/fanli.md"]);
  assert.deepEqual(result.manifest.skipped.map(row => row.reason).sort(), ["excluded", "excluded", "symlink"]);
  assert.equal(existsSync(join(result.sourceHome, ".hara/link")), false);
});
test("only relevant launchd plists are copied, never executed", t => {
  const f = fixture(t);
  for (const name of ["net.nanhara.hara.cron.plist", "com.nanhara.pi-talk-meeting.plist", "com.nanhara.unrelated.plist", "net.nanhara.yimatrix.support-checks.plist", "other.plist"]) writeFileSync(join(f.launch, name), "<plist>opaque fixture</plist>", { mode: 0o600 });
  const result = f.copy(); assert.equal(result.manifest.files.length, 2);
  assert(result.manifest.files.every(row => row.path.startsWith("LaunchAgents/"))); assert.equal(verifyLegacyBackup(f.destination).files.length, 2);
});
test("existing backup or a public destination is refused without replacing any data", t => {
  const f = fixture(t); f.write("config.json", "{}"); writeFileSync(join(f.destination, "retain"), "retained");
  assert.throws(() => f.copy(), /empty/); assert.equal(readFileSync(join(f.destination, "retain"), "utf8"), "retained");
  const publicDestination = join(f.root, "public"); mkdirSync(publicDestination, { mode: 0o755 }); chmodSync(publicDestination, 0o755);
  assert.throws(() => createLegacyBackup({ sourceHome: f.home, launchAgentsRoot: f.launch, destination: publicDestination }), /private/);
});
test("nested destinations and symlink roots cannot widen the approved read boundary", t => {
  const f = fixture(t), nested = join(f.home, ".hara/new-backup"); mkdirSync(nested, { mode: 0o700 });
  assert.throws(() => createLegacyBackup({ sourceHome: f.home, launchAgentsRoot: f.launch, destination: nested }), /disjoint/);
  const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
  assert.throws(() => createLegacyBackup({ sourceHome: link, launchAgentsRoot: f.launch, destination: f.destination }), /canonical/);
});
test("post-backup tampering and path traversal fail hash verification", t => {
  const f = fixture(t); f.write("roles/fanli.md", "original fixture"); const result = f.copy();
  const copied = join(result.sourceHome, ".hara/roles/fanli.md"); chmodSync(copied, 0o600); writeFileSync(copied, "changed fixture");
  assert.throws(() => verifyLegacyBackup(f.destination), /verification/);
  const manifestPath = join(f.destination, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.files[0].path = "../outside"; writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyLegacyBackup(f.destination), /entry/);
});
test("a modified manifest byte count cannot masquerade as verified backup metadata", t => {
  const f=fixture(t);f.write("config.json","{}");f.copy();const path=join(f.destination,"manifest.json"),manifest=JSON.parse(readFileSync(path,"utf8"));
  manifest.files[0].bytes++;writeFileSync(path,JSON.stringify(manifest));assert.throws(()=>verifyLegacyBackup(f.destination),/verification/);
});
test("malformed manifests never echo any input content in error messages", t => {
  const f=fixture(t);writeFileSync(join(f.destination,"manifest.json"),"{\"fixture-secret-never-echo\": incomplete",{mode:0o600});
  try{verifyLegacyBackup(f.destination);assert.fail("expected refusal");}catch(error){assert.equal(error.message.includes("fixture-secret-never-echo"),false);assert.match(error.message,/Invalid legacy backup manifest/);}
});
