import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const build = readFileSync(new URL("../scripts/build-binary.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

test("standalone compile disables every ambient project config loader", () => {
  for (const loader of ["autoloadBunfig", "autoloadDotenv", "autoloadPackageJson", "autoloadTsconfig"]) {
    assert.match(build, new RegExp(`${loader}:\\s*false`), `${loader} must stay explicitly disabled`);
  }
});

test("standalone releases use baseline x64 targets and runtime boundary smoke", () => {
  assert.match(packageJson.scripts["build:binaries"], /bun-darwin-x64-baseline/);
  assert.match(packageJson.scripts["build:binaries"], /bun-linux-x64-baseline/);
  assert.match(build, /bun-\(\?:darwin\|linux\|windows\)-x64/);
  for (const target of ["bun-linux-x64-baseline", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64-baseline"]) {
    assert.match(ci, new RegExp(target), `native standalone CI must exercise ${target}`);
  }
  assert.match(ci, /standalone-boundary-smoke\.mjs/);
  assert.match(release, /standalone-boundary-smoke\.mjs/);
});
