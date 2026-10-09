import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  HARA_CODE_RUNTIME_PACKAGES, HARA_CODE_RUNTIME_VERSION, HaraCodeRuntimeUnavailableError,
  haraCodeRuntimeCommand, resolveHaraCodeRuntime,
} from "../dist/opencode-runtime.js";

function header(platform, arch) {
  const bytes = Buffer.alloc(256);
  if (platform === "darwin") { bytes.writeUInt32BE(0xcffaedfe); bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4); }
  else if (platform === "linux") { bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18); }
  else { bytes.set([0x4d, 0x5a]); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 132); }
  return bytes;
}

function fixture(t, selected = HARA_CODE_RUNTIME_PACKAGES[0], extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hara-code-runtime-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hara = join(root, "hara"); mkdirSync(join(hara, "dist"), { recursive: true });
  writeFileSync(join(hara, "package.json"), JSON.stringify({ name: "@nanhara/hara", type: "module" }));
  const packageRoot = join(hara, "node_modules", selected.name); mkdirSync(join(packageRoot, "bin"), { recursive: true });
  const metadata = { name: selected.name, version: HARA_CODE_RUNTIME_VERSION, os: [selected.platform], cpu: [selected.arch],
    ...(selected.libc === "musl" ? { libc: ["musl"] } : {}), ...extra };
  const metadataPath = join(packageRoot, "package.json"); writeFileSync(metadataPath, JSON.stringify(metadata));
  const command = join(packageRoot, "bin", selected.platform === "win32" ? "opencode.exe" : "opencode");
  writeFileSync(command, header(selected.platform, selected.arch), { mode: 0o755 });
  const options = { platform: selected.platform, arch: selected.arch, libc: selected.libc,
    moduleURL: pathToFileURL(join(hara, "dist", "opencode-runtime.js")) };
  return { root, hara, packageRoot, metadataPath, metadata, command, options,
    resolve: (env = {}, patch = {}) => resolveHaraCodeRuntime(env, { ...options, ...patch }) };
}

test("runtime allowlist has eight exact platform variants, baseline only for x64", () => {
  assert.equal(HARA_CODE_RUNTIME_VERSION, "1.18.32"); assert.equal(HARA_CODE_RUNTIME_PACKAGES.length, 8);
  assert.equal(new Set(HARA_CODE_RUNTIME_PACKAGES.map((item) => item.name)).size, 8);
  for (const item of HARA_CODE_RUNTIME_PACKAGES) {
    assert.equal(item.name.includes("baseline"), item.arch === "x64"); assert.ok(Object.isFrozen(item));
  }
});

for (const selected of HARA_CODE_RUNTIME_PACKAGES) test(`runtime resolves metadata-only ${selected.name}`, (t) => {
  const f = fixture(t, selected);
  // Fake native headers cannot run; successful resolution therefore requires no binary execution.
  assert.deepEqual(f.resolve({ PATH: f.root, NODE_PATH: f.root, OPENCODE_CONFIG: "/untrusted/config" }), {
    available: true, command: f.command, source: "installed-package", version: "1.18.32", packageName: selected.name,
  });
});

test("Desktop explicit sidecar wins and an invalid explicit sidecar never falls back", (t) => {
  const f = fixture(t);
  const sidecar = join(f.root, "hara-code-runtime"); writeFileSync(sidecar, header("darwin", "arm64"), { mode: 0o755 });
  assert.deepEqual(f.resolve({ HARA_CODE_RUNTIME_PATH: sidecar }), { available: true, command: sidecar,
    source: "desktop-sidecar", version: "1.18.32" });
  for (const path of ["opencode", join(f.root, "missing")]) {
    assert.equal(f.resolve({ HARA_CODE_RUNTIME_PATH: path }).reason, "invalid_sidecar");
  }
  const linked = join(f.root, "linked"); symlinkSync(sidecar, linked);
  assert.equal(f.resolve({ HARA_CODE_RUNTIME_PATH: linked }).reason, "invalid_sidecar");
});

test("missing optional dependency is unavailable even when PATH contains an opencode", (t) => {
  const f = fixture(t); rmSync(f.packageRoot, { recursive: true });
  writeFileSync(join(f.root, "opencode"), header("darwin", "arm64"), { mode: 0o755 });
  assert.equal(f.resolve({ PATH: f.root }).reason, "package_missing");
});

test("wrong metadata version, identity, platform, libc or executable lifecycle fails closed", (t) => {
  const f = fixture(t);
  for (const patch of [{ version: "1.18.33" }, { name: "opencode-ai" }, { os: ["linux"] }, { cpu: ["x64"] },
    { libc: ["musl"] }, { scripts: { postinstall: "unexpected" } }, { os: ["darwin", "linux"] }]) {
    writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, ...patch }));
    assert.equal(f.resolve().reason, "invalid_package");
  }
});

test("shell placeholders, wrong-architecture headers, non-executable files and escaping symlinks are rejected", (t) => {
  const f = fixture(t);
  writeFileSync(f.command, "#!/bin/sh\necho upstream postinstall placeholder\n".repeat(4));
  assert.equal(f.resolve().reason, "invalid_executable");
  writeFileSync(f.command, header("darwin", "x64")); assert.equal(f.resolve().reason, "invalid_executable");
  writeFileSync(f.command, header("darwin", "arm64")); chmodSync(f.command, 0o600);
  assert.equal(f.resolve().reason, "invalid_executable");
  rmSync(f.command); const elsewhere = join(f.root, "binary");
  writeFileSync(elsewhere, header("darwin", "arm64"), { mode: 0o755 }); symlinkSync(elsewhere, f.command);
  assert.equal(f.resolve().reason, "invalid_executable");
});

test("dependency resolution cannot escape the containing installation through symlinked packages", (t) => {
  const f = fixture(t); const outside = join(f.root, "untrusted", "node_modules", HARA_CODE_RUNTIME_PACKAGES[0].name);
  mkdirSync(join(outside, "bin"), { recursive: true });
  writeFileSync(join(outside, "package.json"), JSON.stringify(f.metadata));
  writeFileSync(join(outside, "bin", "opencode"), header("darwin", "arm64"), { mode: 0o755 });
  rmSync(f.packageRoot, { recursive: true }); symlinkSync(outside, f.packageRoot);
  assert.equal(f.resolve().reason, "invalid_package");
});

test("pnpm dependency symlinks within the installation remain supported", (t) => {
  const f = fixture(t);
  const physical = join(f.hara, "node_modules", ".pnpm", "opencode-native-pinned", "node_modules", f.metadata.name);
  mkdirSync(join(physical, "bin"), { recursive: true });
  writeFileSync(join(physical, "package.json"), JSON.stringify(f.metadata));
  const bin = join(physical, "bin", "opencode"); writeFileSync(bin, header("darwin", "arm64"), { mode: 0o755 });
  rmSync(f.packageRoot, { recursive: true }); symlinkSync(physical, f.packageRoot);
  assert.equal(f.resolve().command, bin);
});

test("musl never falls back to an installed glibc package", (t) => {
  const selected = HARA_CODE_RUNTIME_PACKAGES.find((item) => item.platform === "linux" && item.arch === "x64" && item.libc === "glibc");
  const f = fixture(t, selected);
  assert.equal(f.resolve().packageName, selected.name);
  assert.equal(f.resolve({}, { libc: "musl" }).reason, "package_missing");
});

test("platform, architecture and unknown libc fail closed without lookup", (t) => {
  const f = fixture(t);
  assert.equal(f.resolve({}, { platform: "freebsd" }).reason, "unsupported_platform");
  assert.equal(f.resolve({}, { arch: "ia32" }).reason, "unsupported_architecture");
  assert.equal(f.resolve({}, { platform: "linux", libc: "unknown" }).reason, "unknown_libc");
});

test("string compatibility API throws a sanitized typed unavailable error, never PATH fallback", () => {
  assert.throws(() => haraCodeRuntimeCommand({ HARA_CODE_RUNTIME_PATH: "opencode" }), (error) => {
    assert.ok(error instanceof HaraCodeRuntimeUnavailableError);
    assert.equal(error.code, "hara_code_runtime_unavailable"); assert.equal(error.reason, "invalid_sidecar");
    assert.doesNotMatch(error.message, /PATH|private|Users/u); return true;
  });
});

test("baked payload takes precedence over npm but never over Desktop explicit sidecar", (t) => {
  const f = fixture(t); const bytes = header("darwin", "arm64"); let reads = 0;
  const bundledRuntime = { version: "1.18.32", platform: "darwin", arch: "arm64", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), assetPath: "/$bunfs/root/opencode-pinned" };
  const options = { bundledRuntime, home: f.root, readBundledAsset: () => { reads++; return bytes; } };
  const embedded = f.resolve({}, options);
  assert.equal(embedded.available, true); assert.equal(embedded.source, "embedded-runtime");
  assert.equal(reads, 1); assert.match(embedded.command, /\.hara\/runtime\/coding\/1\.18\.32\/darwin-arm64\//u);
  const sidecar = f.resolve({ HARA_CODE_RUNTIME_PATH: f.command }, options);
  assert.equal(sidecar.source, "desktop-sidecar"); assert.equal(sidecar.command, f.command); assert.equal(reads, 1);
  assert.equal(f.resolve({ HARA_CODE_RUNTIME_PATH: "relative" }, options).reason, "invalid_sidecar");
});

test("an invalid baked payload fails closed without npm, PATH or environment metadata fallback", (t) => {
  const f = fixture(t); let reads = 0;
  const options = { home: f.root, bundledRuntime: { version: "1.18.33", platform: "darwin", arch: "arm64",
    size: 256, sha256: "a".repeat(64), assetPath: "/$bunfs/root/opencode" }, readBundledAsset: () => { reads++; return header("darwin", "arm64"); } };
  assert.equal(f.resolve({ PATH: f.packageRoot, HARA_BUNDLED_OPENCODE_SHA256: "a".repeat(64) }, options).reason, "invalid_bundled_runtime");
  assert.equal(reads, 0); assert.equal(f.resolve({ HARA_BUNDLED_OPENCODE_ASSET_PATH: "/evil" }).source, "installed-package");
});
