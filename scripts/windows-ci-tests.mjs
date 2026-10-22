// Shared Windows contract subset for ordinary CI and candidate testing. This is NOT Windows
// full-suite coverage. The POSIX-oriented full-suite port is tracked separately.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const windowsContractTestFiles = Object.freeze([
  "test/runtime.test.mjs", "test/windows-shell.test.mjs", "test/private-state-portable.test.mjs",
  "test/fs-read.test.mjs", "test/external-agent.test.mjs", "test/npm-package-smoke.test.mjs",
  "test/agent-worktree-registration.test.mjs", "test/workspace-run-binding-portable.test.mjs",
]);
export const windowsTestCoverage = "windows-contract-subset-v1";
export function windowsContractTestCommand() {
  return ["--import", "./test/setup-isolated-home.mjs", "--test", "--test-timeout=120000", ...windowsContractTestFiles];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, "Windows contracts do not accept test filters or mode overrides");
  for (const args of [["node_modules/typescript/bin/tsc"], ["scripts/normalize-dist-modes.mjs"], ["scripts/check-local-bin-link.mjs"], windowsContractTestCommand()]) {
    const result = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
}
