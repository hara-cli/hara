import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeRuntimeTarget, lockedCodeRuntimePackage, bundledCodeRuntimeModule } from "../scripts/bundled-opencode.mjs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("every standalone target selects a fixed exact-version native package and lock integrity", () => {
  for (const target of ["bun-darwin-arm64", "bun-darwin-x64-baseline", "bun-linux-arm64", "bun-linux-arm64-musl",
    "bun-linux-x64-baseline", "bun-linux-x64-musl-baseline", "bun-windows-x64-baseline"]) {
    const native = codeRuntimeTarget(target), entry = lockedCodeRuntimePackage(lock, pkg, native);
    assert.equal(native.bunTarget, target);
    assert.equal(native.version, "1.18.32"); assert.match(entry.url, /^https:\/\/registry\.npmjs\.org\/opencode-/);
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.throws(() => codeRuntimeTarget("bun-darwin-x64"), /unsupported/);
  assert.throws(() => codeRuntimeTarget("bun-linux-riscv64"), /unsupported/);
  assert.throws(() => codeRuntimeTarget("bun-windows-arm64"), /unsupported/, "pinned Bun 1.3.9 has no Windows ARM64 standalone target");
  assert.equal(codeRuntimeTarget(undefined, "darwin", "x64").bunTarget, "bun-darwin-x64-baseline");
  assert.equal(codeRuntimeTarget(undefined, "win32", "x64").bunTarget, "bun-windows-x64-baseline");
});

test("build rejects changed package pins, registries, target architecture, and digest", () => {
  const target = codeRuntimeTarget("bun-darwin-arm64"), key = `node_modules/${target.packageName}`;
  for (const change of [entry => { entry.version = "latest"; }, entry => { entry.resolved = "https://example.test/runtime.tgz"; },
    entry => { entry.cpu = ["x64"]; }, entry => { entry.integrity = "sha512-invalid"; }]) {
    const copy = structuredClone(lock); change(copy.packages[key]);
    assert.throws(() => lockedCodeRuntimePackage(copy, pkg, target), /invalid locked/);
  }
  assert.throws(() => lockedCodeRuntimePackage(lock, { optionalDependencies: {} }, target), /pin mismatch/);
});

test("embedded metadata replaces exactly the build sentinel and retains private extraction code", () => {
  const source = "export const bundledOpenCodeRuntime = undefined;\nexport function materialize() { return true; }";
  const built = bundledCodeRuntimeModule(source, { version: "1.18.32", sha256: "a".repeat(64) }, "/private/tmp/signed-runtime");
  assert.match(built, /with \{ type: "file" \}/); assert.match(built, /assetPath: haraBundledOpenCodeAsset/);
  assert.match(built, /export function materialize/);
  assert.throws(() => bundledCodeRuntimeModule("", {}, "/tmp/runtime"), /sentinel/);
  assert.throws(() => bundledCodeRuntimeModule(source + source, {}, "/tmp/runtime"), /sentinel/);
});

test("standalone embeds by default while Desktop explicitly reuses its external runtime", () => {
  const source = readFileSync(new URL("../scripts/build-binary.ts", import.meta.url), "utf8");
  assert.match(source, /const codeRuntimeMode = process\.argv\[5\] \?\? "embedded"/);
  assert.match(source, /codeRuntimeMode !== "embedded" && codeRuntimeMode !== "desktop-sidecar"/);
  assert.match(source, /codeRuntimeMode === "embedded" \? await prepareBundledCodeRuntime\(target\) : undefined/);
  assert.match(source, /bundledCodeRuntime \? \[\{/);
  assert.match(source, /bundledCodeRuntime\?\.cleanup\(\)/);
  assert.match(source, /codeRuntimeTarget\(undefined\)\.bunTarget/);
  assert.match(source, /result\.success && bundledCodeRuntime && embeddedModuleCount !== 1/);
  assert.match(source, /if \(embeddedModuleCount !== 1\) throw/);
});
