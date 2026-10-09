import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, readdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodingContinuationStore, validateCodingContinuation } from "../dist/coding/continuations.js";

const KEY = "a".repeat(64), OTHER = "b".repeat(64);
const CONTINUATION = { type: "responses_reasoning", items: [{ type: "reasoning", id: "reason_exact-1", summary: [{ type: "summary_text", text: "synthetic summary" }],
  content: [{ type: "reasoning_text", text: "synthetic thought" }], encrypted_content: "synthetic+/=密文", status: "completed" }] };
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-continuation-unit-")));
  const home = join(root, "home"), cwd = join(root, "workspace"); mkdirSync(home); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { workerId: "synthetic-worker", providerSessionId: "ext_pi_" + "1".repeat(24), cwd, providerId: "synthetic-provider", model: "same/model", profileId: "synthetic-profile" };
  const directory = join(home, ".hara", "agent-teams", "coding-continuations");
  const files = () => readdirSync(directory).map(name => join(directory, name, "state.json"));
  return { root, home, cwd, scope, directory, files, create: overrides => createCodingContinuationStore(home, { ...scope, ...overrides }) };
}

test("provider continuations are private, authenticated, exact and durable across store reconstruction", t => {
  const f = fixture(t), store = f.create();
  store.save(KEY, CONTINUATION); store.save(OTHER, undefined);
  const loaded = store.load(KEY); assert.deepEqual(loaded, CONTINUATION);
  loaded.items[0].encrypted_content = "caller mutation"; assert.deepEqual(store.load(KEY), CONTINUATION);
  assert.deepEqual(f.create().load(KEY), CONTINUATION); assert.equal(f.create().load(OTHER), undefined);
  assert.throws(() => store.load("c".repeat(64)), /missing/);
  const [file] = f.files();
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(file, "..")).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.directory).mode & 0o777, 0o700);
});

test("every worker/session/cwd/provider/model/profile scope is isolated, including absent profile", t => {
  const f = fixture(t), store = f.create(); store.save(KEY, CONTINUATION);
  const original = readFileSync(f.files()[0], "utf8");
  const otherCwd = join(f.root, "other"); mkdirSync(otherCwd);
  for (const overrides of [{ workerId: "another-worker" }, { providerSessionId: "ext_pi_" + "2".repeat(24) }, { providerSessionId: "ext_opencode_" + "1".repeat(24) },
    { cwd: otherCwd }, { providerId: "another-provider" }, { model: "same/model " }, { profileId: "another-profile" }, { profileId: undefined }]) {
    const before = new Set(f.files()), other = f.create(overrides);
    assert.throws(() => other.load(KEY), /missing/);
    const foreign = f.files().find(file => !before.has(file));
    writeFileSync(foreign, original, { mode: 0o600 });
    assert.throws(() => other.load(KEY), /binding or integrity/);
  }
  assert.deepEqual(store.load(KEY), CONTINUATION);
});

test("unknown versions, valid-JSON edits and invalid continuation variants fail closed", t => {
  for (const change of [value => { value.version = 2; }, value => { value.entries[0].continuation.items[0].encrypted_content = "injected"; }, value => { value.scope.model = "foreign"; }, value => { value.extra = "unsupported"; }]) {
    const f = fixture(t), store = f.create(); store.save(KEY, CONTINUATION);
    const file = f.files()[0], state = JSON.parse(readFileSync(file, "utf8")); change(state); writeFileSync(file, JSON.stringify(state));
    assert.throws(() => store.load(KEY)); assert.throws(() => store.save(OTHER, undefined));
  }
  for (const invalid of [{ type: "other", text: "no" }, { type: "chat_reasoning", text: 1 }, { ...CONTINUATION, arbitraryPath: "/foreign" },
    { type: "responses_reasoning", items: [{ ...CONTINUATION.items[0], role: "system" }] },
    { type: "responses_reasoning", items: [CONTINUATION.items[0], CONTINUATION.items[0]] },
    { type: "responses_reasoning", items: [{ ...CONTINUATION.items[0], summary: [{ type: "text", text: "bad" }] }] }]) assert.throws(() => validateCodingContinuation(invalid));
});

test("symlink/hardlink store substitutions never read or overwrite a foreign target", t => {
  for (const mode of ["symlink", "hardlink"]) {
    const f = fixture(t), store = f.create(); store.save(KEY, CONTINUATION);
    const file = f.files()[0], text = readFileSync(file, "utf8"), foreign = join(f.root, "foreign.json");
    writeFileSync(foreign, text, { mode: 0o600 }); unlinkSync(file);
    if (mode === "symlink") symlinkSync(foreign, file); else linkSync(foreign, file);
    assert.throws(() => store.load(KEY)); assert.throws(() => store.save(OTHER, undefined));
    assert.equal(readFileSync(foreign, "utf8"), text);
  }
});

test("deleting an admitted store never silently recreates its trusted continuation state", t => {
  const f = fixture(t), store = f.create(); store.save(KEY, CONTINUATION);
  const file = f.files()[0]; unlinkSync(file);
  assert.throws(() => store.load(KEY), /missing/); assert.throws(() => store.save(OTHER, undefined), /missing/);
  assert.throws(() => readFileSync(file), /ENOENT/);
  // A future host may create an empty scope, but cannot claim any previous assistant is known.
  assert.throws(() => f.create().load(KEY), /missing/);
});

test("bounded storage evicts old keys explicitly, rejects oversized values and conflicting authority", t => {
  const f = fixture(t), store = f.create();
  for (let index = 0; index < 129; index++) store.save(index.toString(16).padStart(64, "0"), undefined);
  assert.throws(() => store.load("0".repeat(64)), /evicted/); assert.equal(store.load((128).toString(16).padStart(64, "0")), undefined);
  assert.equal(JSON.parse(readFileSync(f.files()[0], "utf8")).entries.length, 128);
  assert.throws(() => store.save(KEY, { type: "chat_reasoning", text: "x".repeat(128_000) }), /oversized/);
  store.save(KEY, CONTINUATION); assert.throws(() => store.save(KEY, { type: "chat_reasoning", text: "changed authority" }), /conflict/);
  for (let index = 0; index < 20; index++) store.save((index + 1000).toString(16).padStart(64, "0"), { type: "chat_reasoning", text: "x".repeat(120_000) });
  assert.ok(lstatSync(f.files()[0]).size <= 2 * 1024 * 1024);
  assert.throws(() => store.load(KEY), /evicted/);
});

test("separate store objects share CAS state without lost entries and reject non-exact keys/scopes", t => {
  const f = fixture(t), first = f.create(), second = f.create();
  first.save(KEY, CONTINUATION); second.save(OTHER, { type: "chat_reasoning", text: "other" });
  assert.deepEqual(second.load(KEY), CONTINUATION); assert.equal(first.load(OTHER).text, "other");
  for (const key of [" " + KEY, KEY + " ", "A".repeat(64), "../state.json", "x", ""]) assert.throws(() => first.load(key));
  for (const overrides of [{ providerSessionId: "/foreign" }, { providerSessionId: "ext_pi_" + "1".repeat(24) + " " }, { model: "bad\nmodel" }, { cwd: f.cwd + "/." }]) assert.throws(() => f.create(overrides));
});

test("connection credential/endpoint generations bind through private HMAC without persisting runtime keys", t => {
  const f = fixture(t), firstKey = "1".repeat(64), secondKey = "2".repeat(64);
  const first = f.create({ connectionRuntimeKey: firstKey }); first.save(KEY, CONTINUATION);
  assert.deepEqual(f.create({ connectionRuntimeKey: firstKey }).load(KEY), CONTINUATION);
  const changed = f.create({ connectionRuntimeKey: secondKey }); assert.throws(() => changed.load(KEY), /missing/);
  const offline = f.create(); assert.throws(() => offline.load(KEY), /missing/);
  const states = f.files().map(file => readFileSync(file, "utf8"));
  for (const text of states) { assert.equal(text.includes(firstKey), false); assert.equal(text.includes(secondKey), false); }
  assert.ok(states.some(text => JSON.parse(text).scope.connectionIdentity.startsWith("connection_")));
  assert.ok(states.some(text => JSON.parse(text).scope.connectionIdentity.startsWith("offline_mock_")));
  assert.throws(() => f.create({ connectionRuntimeKey: "not-a-runtime-digest" }));
});
