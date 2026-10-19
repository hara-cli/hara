import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { INTEL_SLOW_FILES, usesIntelBudget, intelCaseTimeout, intelTestBatches } from "../scripts/intel-ci-test-budget.mjs";

test("temporary slow budgets require the exact Intel CI platform, flag and 1.0.1 release", () => {
  const approved = { platform: "darwin", arch: "x64", release: "1.0.1", env: { GITHUB_ACTIONS: "true", HARA_INTEL_TEST_BUDGET: "1.0.1" } };
  assert.equal(intelCaseTimeout(5000, 30000, approved), 30000);
  for (const changed of [{ platform: "linux" }, { arch: "arm64" }, { release: "1.0.2" }, { env: {} }, { env: { ...approved.env, GITHUB_ACTIONS: "false" } }]) {
    assert.equal(usesIntelBudget({ ...approved, ...changed }), false);
    assert.equal(intelCaseTimeout(5000, 30000, { ...approved, ...changed }), 5000);
  }
});
test("Intel batching runs every original test exactly once and only measured slow files receive extra time", () => {
  const files = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".test.mjs")).sort();
  const [normal, slow] = intelTestBatches(files);
  assert.equal(normal.timeout, 120000); assert.equal(slow.timeout, 300000);
  assert.deepEqual([...normal.files, ...slow.files].sort(), files);
  assert.deepEqual([...slow.files].sort(), [...INTEL_SLOW_FILES].sort());
  assert.throws(() => intelTestBatches(files.filter(file => file !== INTEL_SLOW_FILES[0])), /missing/);
  assert.throws(() => intelTestBatches([...files, files[0]]), /duplicate/);
  for (const name of ["ci.yml", "release.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    assert.match(workflow, /intel-ci-test-budget\.mjs/);
    assert.doesNotMatch(workflow, /continue-on-error/);
    assert.match(workflow, /run: npm test/);
  }
});
