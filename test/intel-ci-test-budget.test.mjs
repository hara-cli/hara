import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { INTEL_SLOW_FILES, NATIVE_CONTENTION_FILES, usesIntelBudget, intelCaseTimeout, intelTestBatches, intelTestGroups } from "../scripts/intel-ci-test-budget.mjs";
import { nativeTestBatches, strictNativeTestBatches } from "../scripts/native-ci-tests.mjs";

test("temporary slow budgets require the exact Intel CI platform, matching flag and reviewed release", () => {
  const approved = { platform: "darwin", arch: "x64", release: "1.0.2", env: { GITHUB_ACTIONS: "true", HARA_INTEL_TEST_BUDGET: "1.0.2" } };
  assert.equal(intelCaseTimeout(5000, 30000, approved), 30000);
  for (const changed of [{ platform: "linux" }, { arch: "arm64" }, { release: "1.0.3" }, { release: "1.0.1" }, { env: {} }, { env: { ...approved.env, GITHUB_ACTIONS: "false" } }]) {
    assert.equal(usesIntelBudget({ ...approved, ...changed }), false);
    assert.equal(intelCaseTimeout(5000, 30000, { ...approved, ...changed }), 5000);
  }
});
test("Intel batching runs every original test exactly once and only measured slow files receive extra time", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".test.mjs")).sort();
  const [slow, normal, isolated] = intelTestBatches(files);
  assert.equal(normal.timeout, 120000); assert.equal(slow.timeout, 300000);
  assert.equal(normal.concurrency, 4); assert.equal(slow.concurrency, 1);
  assert.deepEqual([...normal.files, ...slow.files, ...isolated.files].sort(), files);
  assert.deepEqual([...slow.files].sort(), [...INTEL_SLOW_FILES].sort());
  assert.deepEqual([...isolated.files].sort(), [...NATIVE_CONTENTION_FILES].sort());
  assert.equal(isolated.timeout, 120000); assert.equal(isolated.concurrency, 1);
  assert.equal(isolated.slow, false, "isolating fixtures must not enable the extended Intel case budgets");
  assert.equal(isolated.isolated, true);
  assert.deepEqual([slow, normal, isolated].flatMap(intelTestGroups).flat().sort(), files,
    "the actual runner groups must execute every file once, without inserting the first legacy file into an isolated batch");
  assert(isolated.files.every(file => intelTestGroups(isolated).some(group => group.length === 1 && group[0] === file)));
  assert.throws(() => intelTestBatches(files.filter(file => file !== INTEL_SLOW_FILES[0])), /missing/);
  assert.throws(() => intelTestBatches(files.filter(file => file !== NATIVE_CONTENTION_FILES[0])), /missing/);
  assert.throws(() => intelTestBatches([...files, files[0]]), /duplicate/);
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    assert.match(workflow, /run: node scripts\/native-ci-tests\.mjs/);
    assert.doesNotMatch(workflow, /continue-on-error/);
    assert.match(workflow, /run: npm test/);
  }
  const runner = readFileSync(new URL("../scripts/intel-ci-test-budget.mjs", import.meta.url), "utf8");
  assert.match(runner, /\["workspace-production-entry\.test\.mjs",/);
  assert.match(runner, /batch\.slow[\s\S]*?\.map\(file => \[file\]\)/);
});
test("real ARM64 full suite precedes tag and keeps original file/case deadlines, isolation and all files", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".test.mjs")).sort();
  const batches = nativeTestBatches(files,"arm64");
  assert.deepEqual(batches.flatMap(batch=>batch.files).sort(),files);
  assert(batches.every(batch=>batch.timeout===120000));assert.equal(batches[0].concurrency,1);assert.equal(batches[1].concurrency,4);
  assert.equal(batches[2].concurrency, 1);assert.equal(batches[2].isolated, true);
  assert(batches[0].files.includes("legacy-startup.test.mjs"));
  assert.deepEqual(nativeTestBatches(files,"x64"),intelTestBatches(files));
  assert.throws(()=>nativeTestBatches(files,"ia32"),/architecture/);
  const workflow=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
  assert.match(workflow,/push:\s*branches: \[main\]/);assert.match(workflow,/if: \$\{\{ startsWith\(matrix.os, 'macos-'\) \}\}/);
  assert.match(workflow,/os: macos-15\s+target: bun-darwin-arm64/);assert.match(workflow,/os: macos-15-intel\s+target: bun-darwin-x64-baseline/);
  const runner=readFileSync(new URL("../scripts/native-ci-tests.mjs",import.meta.url),"utf8");
  assert.match(runner,/delete env\.HARA_INTEL_TEST_BUDGET/);assert.match(runner,/\.\/test\/setup-isolated-home\.mjs/);
  assert.doesNotMatch(runner,/--test-skip-pattern|--test-name-pattern|continue-on-error|\.retry\(/);
});
test("strict native candidate mode isolates every durable fixture with the original 120s deadlines on both Macs", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".test.mjs")).sort();
  for (const arch of ["arm64", "x64"]) {
    const batches = strictNativeTestBatches(files, arch);
    assert.deepEqual(batches.flatMap(batch => batch.files).sort(), files);
    assert(batches.every(batch => batch.timeout === 120000));
    assert.equal(batches[0].concurrency, 1); assert.equal(batches[2].concurrency, 1);
    for (const file of [...INTEL_SLOW_FILES, ...NATIVE_CONTENTION_FILES]) {
      const batch = batches.find(batch => batch.files.includes(file));
      assert(batch.slow || batch.isolated, `durable fixture must not compete: ${file}`);
    }
  }
  const runner = readFileSync(new URL("../scripts/native-ci-tests.mjs", import.meta.url), "utf8");
  assert.match(runner, /process\.arch === "x64" && !strict/);
  assert.match(runner, /delete env\.HARA_INTEL_TEST_BUDGET/);
  assert.throws(() => strictNativeTestBatches(files, "ia32"), /architecture/);
});
