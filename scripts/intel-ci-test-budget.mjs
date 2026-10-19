// Temporary 1.0.1 test-only budgets for the measured slow Intel CI files.
// All files/assertions still run; Linux, arm64 and every other file retain their original budgets.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;
export const INTEL_SLOW_FILES = Object.freeze([
  "config-live.test.mjs", "cron-route-binding.test.mjs", "gateway-runtime-state.test.mjs", "home-workspace-cli.test.mjs",
  "legacy-copy-roundtrip.test.mjs", "legacy-startup.test.mjs",
  "session-profile-cli.test.mjs", "workspace-local-host.test.mjs", "workspace-model-context.test.mjs", "workspace-production-entry.test.mjs",
]);
export function usesIntelBudget({ platform = process.platform, arch = process.arch, env = process.env, release = version } = {}) {
  return release === "1.0.1" && platform === "darwin" && arch === "x64"
    && env.GITHUB_ACTIONS === "true" && env.HARA_INTEL_TEST_BUDGET === "1.0.1";
}
export function intelCaseTimeout(normal, intel, options) { return usesIntelBudget(options) ? intel : normal; }
export function intelTestBatches(files) {
  assert.equal(new Set(files).size, files.length, "duplicate test file");
  for (const file of INTEL_SLOW_FILES) assert(files.includes(file), `required Intel test missing: ${file}`);
  return [
    { timeout: 300000, concurrency: 1, files: files.filter(file => INTEL_SLOW_FILES.includes(file)), slow: true },
    { timeout: 120000, concurrency: 4, files: files.filter(file => !INTEL_SLOW_FILES.includes(file)), slow: false },
  ];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(version, "1.0.1", "temporary Intel budget is specific to 1.0.1");
  assert(process.platform === "darwin" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true", "Intel CI only");
  const run = (args, env = process.env) => {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  // Same build, feedback evaluation, isolation and assertions as npm test. Heavy durable migration
  // fixtures must not contend with each other on Intel's virtual disk. Keep ordinary concurrency4.
  run(["node_modules/typescript/bin/tsc"]);
  run(["scripts/normalize-dist-modes.mjs"]); run(["scripts/check-local-bin-link.mjs"]);
  run(["scripts/evaluate-feedback-traces.mjs"]);
  const files = readdirSync("test").filter(file => file.endsWith(".test.mjs")).sort();
  for (const batch of intelTestBatches(files)) {
    console.log(`Intel 1.0.1 test batch: ${batch.files.length} files, ${batch.timeout}ms, concurrency${batch.concurrency}; no skips`);
    const env = { ...process.env }; delete env.HARA_INTEL_TEST_BUDGET;
    if (batch.slow) env.HARA_INTEL_TEST_BUDGET = "1.0.1";
    const groups = batch.slow
      ? ["workspace-production-entry.test.mjs", ...batch.files.filter(file => file !== "workspace-production-entry.test.mjs")].map(file => [file])
      : [batch.files];
    for (const group of groups) {
      const started = Date.now();
      console.log(`Intel test start: ${group.length === 1 ? group[0] : `${group.length} ordinary files`}`);
      run(["--import", "./test/setup-isolated-home.mjs", "--test", `--test-concurrency=${batch.concurrency}`,
        `--test-timeout=${batch.timeout}`, ...group.map(file => `test/${file}`)], env);
      console.log(`Intel test completed: ${group.length === 1 ? group[0] : `${group.length} ordinary files`}; ${Date.now() - started}ms`);
    }
  }
}
