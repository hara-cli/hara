import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { FakeHelperCache, helperCacheKey, assertFormalBuildSpec, assertFormalModuleGraph, inspectFormalSidecar, fakeFormalPipeline } from "../native/dev-keychain-fixture/guards.mjs";
import { DEV_SERVICE } from "../native/dev-keychain-fixture/fake-vault.mjs";
import { FixtureError } from "../native/dev-keychain-fixture/protocol.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const inputs = () => ({ sources: { "codec.m": "a".repeat(64), "codec.h": "b".repeat(64) }, sdk: "macos-sdk-fixture", clang: "clang-fixture", target: "arm64", minOS: "13.0", compileArgs: ["-O2", "-fobjc-arc", "-g0"], linkArgs: ["-framework", "Foundation"], identifier: "com.nanhara.hara.dev.keychain-helper", protocolVersion: 1, service: DEV_SERVICE });
const assembly = (core = "1", desk = "2") => ({ coreSha: core.repeat(40), deskSha: desk.repeat(40) });
function cacheFixture() {
  const calls = { compile: 0, sign: 0 };
  return { calls, cache: new FakeHelperCache({ compile: async input => { calls.compile++; return Buffer.from(JSON.stringify(input)); },
    sign: async bytes => { calls.sign++; return { bytes, cdhash: sha(bytes).slice(0, 40), identifier: inputs().identifier }; } }) };
}
test("helper cache ignores Core/Desk changes and never resigns cached bytes", async () => {
  const { cache, calls } = cacheFixture(), first = await cache.resolve(inputs(), assembly());
  const next = await cache.resolve(inputs(), assembly("3", "4"));
  assert.equal(first.key, next.key); assert.equal(first.sha256, next.sha256); assert.equal(first.cdhash, next.cdhash);
  assert.equal(next.reused, true); assert.deepEqual(calls, { compile: 1, sign: 1 });
  assert.notEqual(first.binding.coreSha, next.binding.coreSha);
});
test("same-key fake cache builds/signs once under concurrent callers", async () => {
  const { cache, calls } = cacheFixture();
  await Promise.all([cache.resolve(inputs(), assembly()), cache.resolve(inputs(), assembly("3", "4"))]);
  assert.deepEqual(calls, { compile: 1, sign: 1 });
});
test("helper source/toolchain changes get a new key; record outputs are not inputs", async () => {
  const { cache, calls } = cacheFixture(); await cache.resolve(inputs(), assembly());
  const changed = inputs(); changed.sources["codec.m"] = "c".repeat(64); await cache.resolve(changed, assembly());
  changed.sdk = "sdk-new-fixture"; await cache.resolve(changed, assembly());
  assert.deepEqual(calls, { compile: 3, sign: 3 });
  assert.throws(() => helperCacheKey({ ...inputs(), cdhash: "a".repeat(40) }), FixtureError);
});
for (const field of ["coreSha", "deskSha", "timestamp", "outputPath", "devDefine"]) {
  test(`helper inputs cannot absorb parent build field ${field}`, () => assert.throws(() => helperCacheKey({ ...inputs(), [field]: "not-a-helper-input" }), FixtureError));
}
test("corrupt or known-missing cache fails instead of silently rebuilding", async () => {
  const { cache, calls } = cacheFixture(), first = await cache.resolve(inputs(), assembly());
  cache.entries.get(first.key).bytes[0] ^= 0xff;
  await assert.rejects(cache.resolve(inputs(), assembly()), error => error.code === "unavailable");
  cache.entries.delete(first.key);
  await assert.rejects(cache.resolve(inputs(), assembly()), error => error.code === "unavailable");
  assert.deepEqual(calls, { compile: 1, sign: 1 });
});
const options = () => ({ entrypoints: ["dist/cli.js"], define: { "process.env.HARA_BUILD_VERSION": '"1.3.0"' }, compile: { outfile: "dist/bin/hara", target: "bun-darwin-arm64", autoloadBunfig: false, autoloadDotenv: false, autoloadPackageJson: false, autoloadTsconfig: false }, plugins: [] });
const context = () => ({ mode: "desktop-sidecar", resources: [], modules: ["src/cli.ts", "src/workspace/credential-vault.ts"] });
function files(t, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hara-k1-guard-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "hara-aarch64-apple-darwin"); fs.writeFileSync(file, bytes);
  return { root, file, sha256: sha(bytes) };
}
function image(size = 128) { const bytes = Buffer.alloc(size, 0x43); Buffer.from([0xcf, 0xfa, 0xed, 0xfe]).copy(bytes); return bytes; }
function hooks(artifact) { const calls = { compile: 0, sign: 0, publish: 0 }; return { calls,
  value: { compile: async () => { calls.compile++; return artifact; }, sign: async () => { calls.sign++; }, publish: async () => { calls.publish++; } } }; }
test("clean formal-shaped artifact reaches all fake stages", async t => {
  const artifact = files(t, image()), h = hooks(artifact);
  await fakeFormalPipeline(options(), context(), h.value);
  assert.deepEqual(h.calls, { compile: 1, sign: 1, publish: 1 });
});
for (const value of [true, false, "true", "false", undefined]) {
  test(`actual build spec rejects Dev define presence (${String(value)}) before compilation`, async () => {
    const spec = options(); spec.define.__HARA_DEV_PROFILE__ = value; const h = hooks(null);
    await assert.rejects(fakeFormalPipeline(spec, context(), h.value), FixtureError);
    assert.deepEqual(h.calls, { compile: 0, sign: 0, publish: 0 });
  });
}
for (const mutate of [s => { s.entrypoints = ["dist/dev-cli.js"]; }, s => { s.compile.autoloadDotenv = true; }, s => { s.define = Object.create({ __HARA_DEV_PROFILE__: false }); }, s => { Object.defineProperty(s.define, "__HARA_DEV_PROFILE__", { value: false }); }]) {
  test("unsafe effective bundler inputs fail without running a stage", async () => {
    const spec = options(); mutate(spec); const h = hooks(null);
    await assert.rejects(fakeFormalPipeline(spec, context(), h.value), FixtureError);
    assert.equal(h.calls.compile, 0);
  });
}
test("Dev resources and modules cannot enter the formal graph", () => {
  assert.throws(() => assertFormalBuildSpec(options(), { mode: "desktop-sidecar", resources: ["hara-dev-keychain-helper"] }), FixtureError);
  for (const name of ["src/dev-cli.ts", "dist/dev-cli.js", "src/dev-keychain/codec.ts", "src/credentials.dev.v1.mjs"]) assert.throws(() => assertFormalModuleGraph([name]), FixtureError);
  assertFormalBuildSpec(options(), { mode: "pi-only", resources: ["hara-credential-worker.exe"] });
});
for (const encoding of ["utf8", "utf16le"]) {
  for (const offset of [65, 65533, 65535]) {
    test(`same-name polluted sidecar is refused before signing (${encoding}, ${offset})`, async t => {
      const bytes = image(66000); Buffer.from("credentials.dev.v1", encoding).copy(bytes, offset);
      const artifact = files(t, bytes), h = hooks(artifact);
      await assert.rejects(fakeFormalPipeline(options(), context(), h.value), FixtureError);
      assert.deepEqual(h.calls, { compile: 1, sign: 0, publish: 0 });
    });
  }
}
test("missing/unknown format and wrong digest never become a scan success", t => {
  const artifact = files(t, Buffer.from("not-an-executable"));
  assert.throws(() => inspectFormalSidecar(artifact.file, artifact.sha256), FixtureError);
  assert.throws(() => inspectFormalSidecar(path.join(artifact.root, "missing"), artifact.sha256), FixtureError);
  fs.writeFileSync(artifact.file, image()); assert.throws(() => inspectFormalSidecar(artifact.file, artifact.sha256), FixtureError);
});
test("an artifact changed between scan and sign is rejected", async t => {
  const artifact = files(t, image()), h = hooks(artifact);
  h.value.beforeSign = async () => fs.writeFileSync(artifact.file, image(256));
  await assert.rejects(fakeFormalPipeline(options(), context(), h.value), FixtureError);
  assert.equal(h.calls.sign, 0); assert.equal(h.calls.publish, 0);
});
test("same-byte replacement with a different inode is rejected before sign", async t => {
  const bytes = image(), artifact = files(t, bytes), h = hooks(artifact);
  h.value.beforeSign = async () => { const replacement = path.join(artifact.root, "replacement"); fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, artifact.file); };
  await assert.rejects(fakeFormalPipeline(options(), context(), h.value), FixtureError); assert.equal(h.calls.sign, 0);
});
test("aliases and hardlinks are refused rather than scanning another same-name file", t => {
  const artifact = files(t, image()), alias = path.join(artifact.root, "alias"), hard = path.join(artifact.root, "hard");
  fs.symlinkSync(artifact.file, alias); assert.throws(() => inspectFormalSidecar(alias, artifact.sha256), FixtureError);
  fs.linkSync(artifact.file, hard); assert.throws(() => inspectFormalSidecar(hard, artifact.sha256), FixtureError);
});

test("effective bundler plugins must be the caller's exact trusted references", async t => {
  const plugin = { name: "stub-react-devtools", setup() {} }, spec = options(); spec.plugins = [plugin];
  const denied = hooks(null);
  await assert.rejects(fakeFormalPipeline(spec, context(), denied.value), FixtureError);
  assert.deepEqual(denied.calls, { compile: 0, sign: 0, publish: 0 });
  const artifact = files(t, image()), accepted = hooks(artifact);
  await fakeFormalPipeline(spec, { ...context(), trustedPlugins: [plugin] }, accepted.value);
  assert.equal(accepted.calls.sign, 1);
});
