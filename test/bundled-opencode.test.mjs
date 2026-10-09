import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundledOpenCodeRuntime, materializeBundledOpenCodeRuntime, BundledOpenCodeRuntimeError } from "../dist/coding/bundled-opencode.js";

function native(platform, arch) {
  const bytes = Buffer.alloc(256);
  if (platform === "darwin") { bytes.writeUInt32BE(0xcffaedfe); bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4); }
  else if (platform === "linux") { bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18); }
  else { bytes.set([0x4d, 0x5a]); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 132); }
  return bytes;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t, platform = "darwin", arch = "arm64", libc) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hara-bundled-code-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const bytes = native(platform, arch); let reads = 0;
  const metadata = { version: "1.18.32", platform, arch, ...(libc ? { libc } : {}), sha256: digest(bytes), size: bytes.length,
    assetPath: platform === "win32" ? "B:/~BUN/root/opencode-native.exe" : "/$bunfs/root/opencode-native" };
  const options = { home, platform, arch, libc, readAsset: (path) => { assert.equal(path, metadata.assetPath); reads++; return bytes; } };
  const target = `${platform}-${arch}${libc ? `-${libc}` : ""}`;
  const path = join(home, ".hara", "runtime", "coding", metadata.version, target, metadata.sha256, platform === "win32" ? "opencode.exe" : "opencode");
  return { root, home, path, bytes, metadata, options, reads: () => reads,
    materialize: (patch = {}, optionPatch = {}) => materializeBundledOpenCodeRuntime({ ...metadata, ...patch }, { ...options, ...optionPatch }) };
}
function refused(operation, reason) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof BundledOpenCodeRuntimeError); assert.equal(error.reason, reason);
    assert.doesNotMatch(error.message, /private\/|Users\/|secret/u); return true;
  });
}

test("Node/npm builds contain an undefined embedded-runtime stub", () => assert.equal(bundledOpenCodeRuntime, undefined));

for (const [platform, arch, libc] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64", "glibc"],
  ["linux", "arm64", "musl"], ["win32", "x64"], ["win32", "arm64"]]) {
  test(`bundled ${platform}/${arch}/${libc ?? "native"} materializes and reuses only its checked private file`, (t) => {
    const f = fixture(t, platform, arch, libc);
    assert.equal(f.materialize(), f.path); const before = lstatSync(f.path);
    assert.equal(before.nlink, 1); assert.equal(before.uid, process.getuid?.() ?? before.uid);
    if (process.platform !== "win32") assert.equal(before.mode & 0o777, 0o500);
    assert.deepEqual(readFileSync(f.path), f.bytes); assert.equal(f.reads(), 1);
    assert.equal(f.materialize(), f.path); const after = lstatSync(f.path);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
    assert.equal(f.reads(), 1, "reuse still verifies disk checksum but does not reread embedded bytes");
  });
}

test("a verified 0600 crash-residue is finalized through its fd without overwriting or rereading payload", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t); f.materialize(); const before = lstatSync(f.path); chmodSync(f.path, 0o600);
  assert.equal(f.materialize(), f.path); assert.equal(lstatSync(f.path).mode & 0o777, 0o500);
  assert.equal(lstatSync(f.path).ino, before.ino); assert.equal(f.reads(), 1);
});

test("an existing wrong checksum is refused without overwriting or reloading the asset", (t) => {
  const f = fixture(t); f.materialize(); chmodSync(f.path, 0o600);
  const tampered = Buffer.from(f.bytes); tampered[tampered.length - 1] = 1; writeFileSync(f.path, tampered);
  refused(() => f.materialize(), "invalid_cache"); assert.deepEqual(readFileSync(f.path), tampered); assert.equal(f.reads(), 1);
});

test("a cache symlink never chmods, reads or replaces the outside target", (t) => {
  const f = fixture(t); f.materialize(); rmSync(f.path);
  const outside = join(f.root, "outside"); writeFileSync(outside, f.bytes, { mode: 0o644 }); const before = lstatSync(outside);
  symlinkSync(outside, f.path); refused(() => f.materialize(), "invalid_cache");
  assert.equal(lstatSync(f.path).isSymbolicLink(), true); assert.equal(lstatSync(outside).mode, before.mode);
  assert.deepEqual(readFileSync(outside), f.bytes); assert.equal(f.reads(), 1);
});

test("a hard-linked cache is refused without modifying either alias", (t) => {
  const f = fixture(t); f.materialize(); const alias = join(f.root, "alias"); linkSync(f.path, alias);
  refused(() => f.materialize(), "invalid_cache"); assert.equal(lstatSync(f.path).nlink, 2);
  assert.equal(lstatSync(alias).ino, lstatSync(f.path).ino); assert.equal(f.reads(), 1);
});

test("unexpected executable mode is refused instead of repairing a shared-looking entry", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t); f.materialize(); chmodSync(f.path, 0o755);
  refused(() => f.materialize(), "invalid_cache"); assert.equal(lstatSync(f.path).mode & 0o777, 0o755);
});

test("symlinked private-state ancestors fail closed before touching the external directory", (t) => {
  const f = fixture(t); const outside = join(f.root, "outside"); mkdirSync(outside, { mode: 0o755 });
  const before = lstatSync(outside); symlinkSync(outside, join(f.home, ".hara"));
  refused(() => f.materialize(), "invalid_cache"); assert.equal(lstatSync(outside).mode, before.mode); assert.equal(f.reads(), 0);
});

test("invalid manifest identities, traversal, unsupported metadata and host mismatches never create state", (t) => {
  const f = fixture(t);
  for (const patch of [{ version: "1.18.33" }, { platform: "freebsd" }, { arch: "x86" }, { sha256: "../escape" },
    { sha256: "A".repeat(64) }, { size: 0 }, { size: NaN }, { size: 513 * 1024 * 1024 }, { libc: "musl" }, { command: "/evil" }]) {
    refused(() => f.materialize(patch), "invalid_manifest");
  }
  for (const assetPath of ["/tmp/opencode", "https://example.invalid/runtime", "/$bunfs/../escape", "/$bunfs//root/file", "/$bunfs/root/./file", "/$bunfs\\root\\file"]) {
    refused(() => f.materialize({ assetPath }), "invalid_asset");
  }
  refused(() => f.materialize({}, { arch: "x64" }), "target_mismatch");
  refused(() => f.materialize({}, { platform: "linux", libc: "glibc" }), "target_mismatch");
  assert.equal(existsSync(join(f.home, ".hara")), false); assert.equal(f.reads(), 0);
});

test("wrong payload size, checksum, architecture or unavailable virtual asset is never published", (t) => {
  const f = fixture(t);
  refused(() => f.materialize({}, { readAsset: () => Buffer.alloc(10) }), "invalid_asset");
  refused(() => f.materialize({}, { readAsset: () => Buffer.alloc(256) }), "invalid_asset");
  const wrongCpu = native("darwin", "x64");
  refused(() => f.materialize({ sha256: digest(wrongCpu) }, { readAsset: () => wrongCpu }), "invalid_asset");
  refused(() => f.materialize({}, { readAsset: () => { throw new Error("private/secret-path"); } }), "invalid_asset");
  assert.equal(existsSync(f.path), false);
});

test("linux payload never adopts another libc target", (t) => {
  const f = fixture(t, "linux", "x64", "musl");
  refused(() => f.materialize({}, { libc: "glibc" }), "target_mismatch");
  refused(() => f.materialize({}, { libc: "unknown" }), "target_mismatch");
});
