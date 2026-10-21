// Both real Mac architectures run the complete suite BEFORE a tag, then again in release.
// Migration fixtures fsync thousands of times. Run those files without competing durable fixtures;
// ARM64 keeps the original 120s file deadline and every original case/assertion. No retries/skips.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { intelTestBatches } from "./intel-ci-test-budget.mjs";

export function nativeTestBatches(files, arch) {
  assert(["arm64", "x64"].includes(arch), "a real supported Mac architecture is required");
  return intelTestBatches(files).map(batch => ({ ...batch, timeout: arch === "arm64" ? 120000 : batch.timeout }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, "darwin", "native Mac full-suite runner only");
  const run = (args, env = process.env) => {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (process.arch === "x64") {
    run(["scripts/intel-ci-test-budget.mjs"]);
  } else {
    assert.equal(process.arch, "arm64", "do not infer native ARM coverage from emulation");
    run(["node_modules/typescript/bin/tsc"]);
    run(["scripts/normalize-dist-modes.mjs"]); run(["scripts/check-local-bin-link.mjs"]);
    run(["scripts/evaluate-feedback-traces.mjs"]);
    const files = readdirSync("test").filter(file => file.endsWith(".test.mjs")).sort();
    const env = { ...process.env }; delete env.HARA_INTEL_TEST_BUDGET;
    for (const batch of nativeTestBatches(files, process.arch)) {
      const groups = batch.slow || batch.isolated ? batch.files.map(file => [file]) : [batch.files];
      for (const group of groups) {
        const label = group.length === 1 ? group[0] : `${group.length} ordinary files`, started = Date.now();
        console.log(`ARM64 full-suite start: ${label}; original ${batch.timeout}ms deadline; concurrency${batch.concurrency}`);
        run(["--import", "./test/setup-isolated-home.mjs", "--test", `--test-concurrency=${batch.concurrency}`,
          `--test-timeout=${batch.timeout}`, ...group.map(file => `test/${file}`)], env);
        console.log(`ARM64 full-suite completed: ${label}; ${Date.now() - started}ms`);
      }
    }
  }
}
