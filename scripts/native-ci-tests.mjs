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
/** Candidate/default-suite deadlines with the same durable-fixture isolation as native main CI.
 * This mode never enables the temporary Intel case/file budget extensions. */
export function strictNativeTestBatches(files, arch) {
  return nativeTestBatches(files, arch).map(batch => ({ ...batch, timeout: 120000 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, "darwin", "native Mac full-suite runner only");
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === "--original-deadlines"), "unsupported native test mode");
  const strict = args[0] === "--original-deadlines";
  const run = (args, env = process.env) => {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (process.arch === "x64" && !strict) {
    run(["scripts/intel-ci-test-budget.mjs"]);
  } else {
    assert(["arm64", "x64"].includes(process.arch), "do not infer native Mac coverage from emulation");
    run(["node_modules/typescript/bin/tsc"]);
    run(["scripts/normalize-dist-modes.mjs"]); run(["scripts/check-local-bin-link.mjs"]);
    run(["scripts/evaluate-feedback-traces.mjs"]);
    const files = readdirSync("test").filter(file => file.endsWith(".test.mjs")).sort();
    const env = { ...process.env }; delete env.HARA_INTEL_TEST_BUDGET;
    const batches = strict ? strictNativeTestBatches(files, process.arch) : nativeTestBatches(files, process.arch);
    for (const batch of batches) {
      const groups = batch.slow || batch.isolated ? batch.files.map(file => [file]) : [batch.files];
      for (const group of groups) {
        const label = group.length === 1 ? group[0] : `${group.length} ordinary files`, started = Date.now();
        console.log(`Native ${process.arch} full-suite start: ${label}; original ${batch.timeout}ms deadline; concurrency${batch.concurrency}`);
        run(["--import", "./test/setup-isolated-home.mjs", "--test", `--test-concurrency=${batch.concurrency}`,
          `--test-timeout=${batch.timeout}`, ...group.map(file => `test/${file}`)], env);
        console.log(`Native ${process.arch} full-suite completed: ${label}; ${Date.now() - started}ms`);
      }
    }
  }
}
