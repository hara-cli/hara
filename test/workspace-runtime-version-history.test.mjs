import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectRuntimeVersionStatus, WorkspaceRuntimeVersionStore } from "../dist/workspace/runtime-version-history.js";
import { WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";

const temporary = [];
after(() => { for (const owned of temporary) fs.rmSync(owned, { recursive: true, force: true }); });
const fp = label => createHash("sha256").update("synthetic-runtime-" + label).digest("hex");
const success = (version = "1.9.0", fingerprint = fp("a")) => ({ runtimeId: "codex", version, fingerprint });
const current = (overrides = {}) => ({ version: "1.9.0", fingerprint: fp("a"), registered: true, requiresRetrust: false, ...overrides });
function fixture(sharedHome, suppliedScope) {
  const home = sharedHome ?? fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-runtime-version-")));
  if (!sharedHome) { temporary.push(home); fs.chmodSync(home, 0o700); }
  const scope = suppliedScope ?? { schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() } };
  let revoked = false;
  const storage = new WorkspaceResourceStorage(home, scope, () => { if (revoked) throw new Error("synthetic authority revoked"); });
  storage.initialize();
  const statePath = storage.run(() => join(workspaceStateHome(), ".hara", "runtime-successful-versions-v1.json"));
  return { home, scope, storage, statePath, store: new WorkspaceRuntimeVersionStore(storage), revoke: () => { revoked = true; } };
}

test("no success history distinguishes a known unverified version from an unknown version", () => {
  assert.deepEqual(projectRuntimeVersionStatus(null, current()), { schemaVersion: 1, lastSuccessfulVersion: null,
    currentVersion: "1.9.0", change: "no_history", compatibility: "unverified", binaryChanged: null, requiresRetrust: false });
  const unknown = projectRuntimeVersionStatus(null, current({ version: null, requiresRetrust: true }));
  assert.equal(unknown.change, "unknown"); assert.equal(unknown.compatibility, "unknown");
  assert.equal(unknown.binaryChanged, null); assert.equal(unknown.requiresRetrust, true);
});

test("version drift compares numeric major, minor and patch components rather than text", () => {
  for (const [last, now, expected] of [["1.9.0", "1.10.0", "upgraded"], ["1.10.0", "1.9.0", "downgraded"],
    ["9.99.9", "10.0.0", "upgraded"], ["2.0.0", "1.9999.9999", "downgraded"],
    ["1.2.9", "1.2.10", "upgraded"], ["1.2.10", "1.2.9", "downgraded"], ["0001.2.3", "1.02.03", "same"]]) {
    const result = projectRuntimeVersionStatus(success(last), current({ version: now }));
    assert.equal(result.change, expected, `${last} -> ${now}`);
    if (expected !== "same") assert.equal(result.compatibility, "unverified");
  }
});

test("previous success requires the same version, same binary and a current trusted registration", () => {
  assert.equal(projectRuntimeVersionStatus(success(), current()).compatibility, "previously_succeeded");
  for (const flags of [{ registered: false }, { requiresRetrust: true }, { registered: false, requiresRetrust: true }]) {
    const result = projectRuntimeVersionStatus(success(), current(flags));
    assert.equal(result.change, "same"); assert.equal(result.binaryChanged, false);
    assert.equal(result.compatibility, "unverified"); assert.equal(result.requiresRetrust, flags.requiresRetrust ?? false);
  }
});

test("a different binary remains unverified even when its version string is unchanged", () => {
  const changed = projectRuntimeVersionStatus(success(), current({ fingerprint: fp("b"), requiresRetrust: true }));
  assert.equal(changed.change, "same"); assert.equal(changed.binaryChanged, true);
  assert.equal(changed.compatibility, "unverified"); assert.equal(changed.requiresRetrust, true);
  const unavailable = projectRuntimeVersionStatus(success(), current({ fingerprint: null }));
  assert.equal(unavailable.binaryChanged, null); assert.equal(unavailable.compatibility, "unverified");
});

test("unknown last or current versions never claim compatibility, independently of binary equality", () => {
  for (const [last, now] of [[success(null), current()], [success(), current({ version: null })], [success(null), current({ version: null })]]) {
    const result = projectRuntimeVersionStatus(last, now);
    assert.equal(result.change, "unknown"); assert.equal(result.compatibility, "unknown"); assert.equal(result.binaryChanged, false);
  }
  assert.equal(projectRuntimeVersionStatus(success(null), current({ fingerprint: fp("b") })).binaryChanged, true);
  assert.equal(projectRuntimeVersionStatus(success(), current({ fingerprint: null, version: null })).binaryChanged, null);
});

test("projection and persistence admit only bounded pure versions and opaque SHA256 fingerprints", () => {
  for (const version of ["1.2.3-beta", "codex 1.2.3", "1.2.3\n", "10000.2.3", "https://private.invalid", "sk-synthetic-secret", "/Users/private/tool"]) {
    const result = projectRuntimeVersionStatus(null, current({ version, fingerprint: "Bearer synthetic-secret" }));
    assert.equal(result.currentVersion, null); assert.equal(result.compatibility, "unknown");
    assert.equal(JSON.stringify(result).includes(version), false);
  }
  for (const last of [{ ...success(), path: "/private/tool" }, success("banner 1.2.3"), success("1.2.3", "Bearer secret"), { ...success(), runtimeId: "pi" }])
    assert.throws(() => projectRuntimeVersionStatus(last, current()), /Invalid Runtime version history/);
  assert.throws(() => projectRuntimeVersionStatus(null, { ...current(), output: "secret" }), /Invalid Runtime version history/);
});

test("opening or checking history writes no success record and an unsuccessful caller leaves history unchanged", () => {
  const f = fixture(); assert.equal(fs.existsSync(f.statePath), false);
  assert.equal(f.store.status("codex", current()).change, "no_history"); assert.equal(fs.existsSync(f.statePath), false);
  f.store.recordSuccessfulUse("codex", "1.9.0", fp("a")); const before = fs.readFileSync(f.statePath, "utf8");
  // Detection, registration, a newer observed version and a failed use are not successful-use calls.
  assert.equal(f.store.status("codex", current({ version: "1.10.0", fingerprint: fp("b") })).change, "upgraded");
  assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
});

test("success persistence is private, exact, reloadable, content-free and identical writes are no-ops", () => {
  const f = fixture(); f.store.recordSuccessfulUse("codex", "1.9.0", fp("a"));
  const before = fs.readFileSync(f.statePath, "utf8"), doc = JSON.parse(before);
  assert.deepEqual(Object.keys(doc).sort(), ["entries", "resourceBinding", "revision", "schemaVersion"]);
  assert.deepEqual(doc.entries, [success()]); assert.equal(doc.revision, 1);
  f.store.recordSuccessfulUse("codex", "1.9.0", fp("a")); assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
  const reopened = new WorkspaceRuntimeVersionStore(f.storage);
  assert.equal(reopened.status("codex", current()).compatibility, "previously_succeeded");
  const detached = reopened.list(); detached[0].version = "9999.0.0"; detached.length = 0;
  assert.deepEqual(reopened.list(), [success()], "list snapshots cannot change persisted history");
  f.store.recordSuccessfulUse("claude", "banner sk-synthetic-secret /Users/private", fp("c"));
  const after = fs.readFileSync(f.statePath, "utf8"); assert.equal(JSON.parse(after).entries[1].version, null);
  for (const marker of [f.home, "synthetic-secret", "/Users/private", "banner", "path", "output", "credentials"])
    assert.equal(after.includes(marker), false, marker);
  if (process.platform !== "win32") { assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o600); assert.equal(fs.statSync(dirname(f.statePath)).mode & 0o777, 0o700); }
});

test("each of the four optional runtimes retains only its most recent successful observation", () => {
  const f = fixture();
  for (const runtimeId of ["opencode", "codex", "claude", "agy"]) f.store.recordSuccessfulUse(runtimeId, "1.9.0", fp(runtimeId));
  f.store.recordSuccessfulUse("codex", "2.0.0", fp("codex-next"));
  const doc = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(doc.entries.length, 4); assert.equal(doc.entries.filter(row => row.runtimeId === "codex").length, 1);
  assert.equal(f.store.status("codex", current({ version: "2.0.0", fingerprint: fp("codex-next") })).compatibility, "previously_succeeded");
  assert.equal(f.store.status("claude", current({ fingerprint: fp("claude") })).compatibility, "previously_succeeded");
  for (const invalid of ["pi", "hara", "../codex", "sk-secret"]) assert.throws(() => f.store.recordSuccessfulUse(invalid, "1.2.3", fp("a")), /Invalid Runtime version history/);
  assert.throws(() => f.store.recordSuccessfulUse("codex", "1.2.3", "not-a-fingerprint"), /Invalid Runtime version history/);
  assert.throws(() => f.store.recordSuccessfulUse("codex", "1.2.3", fp("a") + "\n"), /Invalid Runtime version history/);
});

test("Workspace and authority isolation rejects a copied history rather than adopting another scope", () => {
  const first = fixture(); first.store.recordSuccessfulUse("codex", "1.9.0", fp("a"));
  for (const scope of [undefined, { ...first.scope, authority: { kind: "local", localAuthorityId: randomUUID() } }]) {
    const other = fixture(first.home, scope); assert.notEqual(other.statePath, first.statePath);
    assert.equal(other.store.status("codex", current()).change, "no_history");
    const foreign = fs.readFileSync(first.statePath, "utf8"); fs.writeFileSync(other.statePath, foreign, { mode: 0o600 });
    assert.throws(() => other.store.status("codex", current()), /Invalid Runtime version history/);
    assert.throws(() => other.store.recordSuccessfulUse("codex", "2.0.0", fp("b")), /Invalid Runtime version history/);
    assert.equal(fs.readFileSync(other.statePath, "utf8"), foreign);
  }
});

test("malformed JSON and extended, duplicate or unsupported records are preserved without repair", () => {
  for (const mutate of [() => "{broken private state", doc => ({ ...doc, prompt: "private" }),
    doc => ({ ...doc, entries: [{ ...doc.entries[0], output: "private" }] }),
    doc => ({ ...doc, entries: [doc.entries[0], doc.entries[0]] }),
    doc => ({ ...doc, entries: [{ ...doc.entries[0], version: "raw banner" }] }),
    doc => ({ ...doc, entries: [{ ...doc.entries[0], fingerprint: "/private/path" }] }),
    doc => ({ ...doc, schemaVersion: 2 }), doc => ({ ...doc, resourceBinding: { ...doc.resourceBinding, generation: randomUUID() } }),
    doc => ({ ...doc, entries: Array(5).fill(doc.entries[0]) })]) {
    const f = fixture(); f.store.recordSuccessfulUse("codex", "1.9.0", fp("a"));
    const mutated = mutate(JSON.parse(fs.readFileSync(f.statePath, "utf8")));
    const poisoned = typeof mutated === "string" ? mutated : JSON.stringify(mutated); fs.writeFileSync(f.statePath, poisoned, { mode: 0o600 });
    assert.throws(() => f.store.status("codex", current()));
    assert.throws(() => f.store.recordSuccessfulUse("codex", "2.0.0", fp("b")));
    assert.equal(fs.readFileSync(f.statePath, "utf8"), poisoned);
  }
});

test("revoked authority and a replaced resource generation block reads and successful-use writes", () => {
  const revoked = fixture(); revoked.store.recordSuccessfulUse("codex", "1.9.0", fp("a")); revoked.revoke();
  assert.throws(() => revoked.store.status("codex", current()), /synthetic authority revoked/);
  assert.throws(() => revoked.store.recordSuccessfulUse("codex", "2.0.0", fp("b")), /synthetic authority revoked/);
  const f = fixture(); f.store.recordSuccessfulUse("codex", "1.9.0", fp("a")); const before = fs.readFileSync(f.statePath, "utf8");
  const markerPath = join(f.home, ".hara", "workspace-data", "v1", f.storage.scopeKey, "scope.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, generation: randomUUID() }) + "\n", { mode: 0o600 });
  assert.throws(() => f.store.status("codex", current()), /scope marker changed/);
  assert.throws(() => f.store.recordSuccessfulUse("codex", "2.0.0", fp("b")), /scope marker changed/);
  assert.throws(() => fixture(f.home, f.scope), /generation or data binding mismatch/);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
});

test("a linked history file cannot redirect private state into a foreign file", () => {
  const f = fixture(), foreign = fixture(); const target = join(foreign.home, "retain.txt");
  fs.writeFileSync(target, "private retained sentinel", { mode: 0o600 }); fs.symlinkSync(target, f.statePath);
  assert.throws(() => f.store.status("codex", current()));
  assert.throws(() => f.store.recordSuccessfulUse("codex", "1.9.0", fp("a")));
  assert.equal(fs.readFileSync(target, "utf8"), "private retained sentinel");
});
