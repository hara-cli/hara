import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { windowsContractTestFiles, windowsContractTestCommand, windowsTestCoverage } from "../scripts/windows-ci-tests.mjs";

test("Windows CI and candidate share an explicit contract subset without claiming a full-suite port", () => {
  assert.equal(windowsTestCoverage, "windows-contract-subset-v1");
  assert.equal(Object.isFrozen(windowsContractTestFiles), true);
  assert.deepEqual(windowsContractTestFiles, ["test/runtime.test.mjs", "test/windows-shell.test.mjs", "test/private-state-portable.test.mjs",
    "test/fs-read.test.mjs", "test/external-agent.test.mjs", "test/npm-package-smoke.test.mjs",
    "test/agent-worktree-registration.test.mjs", "test/workspace-run-binding-portable.test.mjs"]);
  assert(windowsContractTestFiles.every(file => fs.existsSync(file)));
  const command = windowsContractTestCommand(); assert(command.includes("--test-timeout=120000"));
  assert.deepEqual(command.filter(arg => arg.startsWith("test/")), windowsContractTestFiles);
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /node scripts\/windows-ci-tests\.mjs/);
  const strict = workflow.slice(workflow.indexOf("  complete-default-suite:"), workflow.indexOf("  docker-runtime:"));
  assert.match(strict, /os: \[macos-15-intel\]/); assert.doesNotMatch(strict, /windows-latest|npm test/);
  assert.match(strict, /native-ci-tests\.mjs --original-deadlines/);
});
