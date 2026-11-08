// All versioned-settings-fast-read cases. Thin test files register disjoint partitions so each stays well under the unchanged
// 120s per-file deadline on hosted Intel (target <= 60s per file). A case that is not listed in exactly one
// partition fails registration, so no case can be silently dropped.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { storageFixture } from "./workspace-user-interaction.mjs";
import { VersionedSettings } from "../../dist/workspace/versioned-settings.js";
import { workspaceStateHome } from "../../dist/workspace/resource-context.js";
import { withPrivateStateLockSync } from "../../dist/security/private-state.js";
export const PARTITIONS = Object.freeze({
  "versioned-settings-fast-read.test.mjs": Object.freeze([
    "missing defaults respect the writer lock and a later backup is recovered read-only",
    "current-schema reads use verified live bytes without fsync or taking the writer/backup lock",
    "newer or missing primary never enters the writable current-schema shortcut",
  ]),
  "versioned-settings-fast-read-claimed.test.mjs": Object.freeze([
    "a claimed primary and backup cannot make configured settings appear empty during publication",
    "damaged primary still needs the writer lock, recovers read-only and preserves both files",
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

function fixture(t) {
  const a = storageFixture(t), name = "latency-settings-v1.json";
  const parse = value => { if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || typeof value.value !== "string") throw new Error("invalid setting"); return value; };
  const settings = new VersionedSettings(() => a.storage.run(() => workspaceStateHome()), name, 1, () => ({ schemaVersion: 1, revision: 0, value: "empty" }), parse, {}, a.storage);
  settings.update(0, value => ({ ...value, value: "first" }));
  const home = a.storage.run(() => workspaceStateHome()), file = join(home, ".hara", name), backup = file.replace(/.json$/, "-backup.json");
  return { ...a, settings, home, file, backup, name };
}
test("current-schema reads use verified live bytes without fsync or taking the writer/backup lock", t => {
  const a = fixture(t), original = fs.fsyncSync; let syncs = 0;
  fs.fsyncSync = function(...args) { syncs++; return original.apply(this, args); }; syncBuiltinESMExports();
  try {
    withPrivateStateLockSync(a.home, [], a.name.slice(0, -5), () => {
      const before = syncs;
      for (let n = 0; n < 3; n++) assert.equal(a.settings.read().value.value, "first");
      assert.equal(syncs, before);
    });
    fs.writeFileSync(a.file, JSON.stringify({ schemaVersion: 1, revision: 2, value: "revoked-or-changed" }), { mode: 0o600 });
    assert.equal(a.settings.read().value.value, "revoked-or-changed", "no setting value or credential generation is cached");
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
});
test("damaged primary still needs the writer lock, recovers read-only and preserves both files", t => {
  const a = fixture(t), backup = fs.readFileSync(a.backup); fs.writeFileSync(a.file, "{broken", { mode: 0o600 });
  withPrivateStateLockSync(a.home, [], a.name.slice(0, -5), () => assert.throws(() => a.settings.read(), /busy|retry|lock/i));
  const result = a.settings.read(); assert.equal(result.recovered, true); assert.equal(result.readOnly, true); assert.equal(result.value.value, "first");
  assert.equal(fs.readFileSync(a.file, "utf8"), "{broken"); assert.equal(fs.readFileSync(a.backup).equals(backup), true);
  assert.throws(() => a.settings.update(1, value => ({ ...value, value: "must not replace backup" })), /read-only/);
});
test("newer or missing primary never enters the writable current-schema shortcut", t => {
  const a = fixture(t); fs.writeFileSync(a.file, JSON.stringify({ schemaVersion: 2, revision: 1, value: "newer" }), { mode: 0o600 });
  assert.equal(a.settings.read().readOnly, true); fs.unlinkSync(a.file);
  const result = a.settings.read(); assert.equal(result.recovered, true); assert.equal(result.readOnly, true); assert.equal(result.value.value, "first"); assert.equal(fs.existsSync(a.file), false);
});


test("missing defaults respect the writer lock and a later backup is recovered read-only", t => {
  const a = storageFixture(t), home = a.storage.run(() => workspaceStateHome()), name = "unconfigured-settings-v1.json";
  const settings = new VersionedSettings(() => home, name, 1, () => ({ schemaVersion: 1, revision: 0, value: "empty" }), value => value, {}, a.storage);
  const original = fs.fsyncSync; let syncs = 0; fs.fsyncSync = function(...args) { syncs++; return original.apply(this, args); }; syncBuiltinESMExports();
  try {
    withPrivateStateLockSync(home, [], name.slice(0, -5), () => assert.throws(() => settings.read(), /busy|retry|lock/i));
    assert.equal(settings.read().value.value, "empty");
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  const file = join(home, ".hara", name), backup = file.replace(/.json$/, "-backup.json"), text = JSON.stringify({ schemaVersion: 1, revision: 7, value: "recovered" });
  fs.writeFileSync(backup, text, { mode: 0o600 }); const result = settings.read();
  assert.equal(result.recovered, true); assert.equal(result.readOnly, true); assert.equal(result.value.value, "recovered");
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(backup, "utf8"), text);
});


test("a claimed primary and backup cannot make configured settings appear empty during publication", t => {
  const a = fixture(t), claimed = join(a.home, ".hara", ".hara-claim-primary-fixture.tmp"), claimedBackup = join(a.home, ".hara", ".hara-claim-backup-fixture.tmp");
  withPrivateStateLockSync(a.home, [], a.name.slice(0, -5), () => {
    fs.renameSync(a.file, claimed); fs.renameSync(a.backup, claimedBackup);
    try { assert.throws(() => a.settings.read(), /busy|retry|lock/i); }
    finally { fs.renameSync(claimed, a.file); fs.renameSync(claimedBackup, a.backup); }
  });
  assert.equal(a.settings.read().value.value, "first");
  assert.equal(fs.existsSync(claimed), false); assert.equal(fs.existsSync(claimedBackup), false);
});
}
