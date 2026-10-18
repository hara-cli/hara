import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runtimeDistribution } from "../dist/runtime-distribution.js";
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
test("Pi is the only preinstalled Agent runtime in both dependency manifests", () => {
  const pkg = JSON.parse(read("package.json")), lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "1.1.0");
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) assert.ok(!/^opencode-/.test(name) && name !== "@anthropic-ai/claude-agent-sdk", name);
  for (const name of Object.keys(lock.packages)) assert.ok(!/node_modules\/(?:opencode-(?:darwin|linux|windows)-|@anthropic-ai\/claude-agent-sdk(?:\/|$))/.test(name), name);
  assert.deepEqual(runtimeDistribution.preinstalled, ["pi"]); assert.deepEqual(runtimeDistribution.optional, ["opencode", "codex", "claude"]);
});
test("standalone and Desktop sidecar compile only Pi, preserve CPU baseline and disable ambient loaders", () => {
  const source = read("scripts/build-binary.ts");
  assert.match(source, /process\.argv\[5\] \|\| "pi-only"/); assert.match(source, /\["pi-only", "desktop-sidecar"\]\.includes\(mode\)/);
  assert.match(source, /process\.arch === "x64"[\s\S]*?-x64-baseline/); assert.match(source, /\$\{requested\}-baseline/);
  for (const name of ["autoloadBunfig", "autoloadDotenv", "autoloadPackageJson", "autoloadTsconfig"]) assert.match(source, new RegExp(`${name}: false`));
  assert.doesNotMatch(source, /prepareBundledCodeRuntime|bundledCodeRuntimeModule|type: "file"|codeRuntimeTarget|opencode-/);
  assert.equal(existsSync(new URL("../scripts/bundled-opencode.mjs", import.meta.url)), false, "obsolete embedder must not remain callable");
  assert.match(source, /__HARA_BUNDLED_PI_SDK_VERSION__/);
});
test("all native CI/release jobs still execute the standalone distribution and Pi gates", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const source = read(path); assert.match(source, /standalone-coding-runtime-smoke\.mjs/); assert.match(source, /standalone-pi-runtime-smoke\.mjs/);
  }
  const gate = read("scripts/standalone-coding-runtime-smoke.mjs"); assert.match(gate, /--runtime-manifest/); assert.match(gate, /preinstalled/); assert.match(gate, /no optional runtime/);
});
