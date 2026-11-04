import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { storageFixture } from "./helpers/workspace-user-interaction.mjs";
import { VersionedSettings } from "../dist/workspace/versioned-settings.js";
import { workspaceStateHome } from "../dist/workspace/resource-context.js";
import { withPrivateStateLockSync } from "../dist/security/private-state.js";

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


test("never-configured defaults need no writer fsync and a later backup is recovered read-only", t => {
  const a = storageFixture(t), home = a.storage.run(() => workspaceStateHome()), name = "unconfigured-settings-v1.json";
  const settings = new VersionedSettings(() => home, name, 1, () => ({ schemaVersion: 1, revision: 0, value: "empty" }), value => value, {}, a.storage);
  const original = fs.fsyncSync; let syncs = 0; fs.fsyncSync = function(...args) { syncs++; return original.apply(this, args); }; syncBuiltinESMExports();
  try {
    withPrivateStateLockSync(home, [], name.slice(0, -5), () => { const before = syncs; assert.equal(settings.read().value.value, "empty"); assert.equal(syncs, before); });
  } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  const file = join(home, ".hara", name), backup = file.replace(/.json$/, "-backup.json"), text = JSON.stringify({ schemaVersion: 1, revision: 7, value: "recovered" });
  fs.writeFileSync(backup, text, { mode: 0o600 }); const result = settings.read();
  assert.equal(result.recovered, true); assert.equal(result.readOnly, true); assert.equal(result.value.value, "recovered");
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(backup, "utf8"), text);
});
