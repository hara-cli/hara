// Explicit verification under the standard private HOME/TMP guard; ordinary tests do not run mutants.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
if (process.argv[2] !== "--verify" || process.argv.length !== 3) throw new Error("Use explicit --verify under the C13 guard");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const dist = ["agent-boundary-execution", "agent-boundary-authority", "agent-command-control", "agent-command-state", "agent-lifecycle-history", "agent-lifecycle-state", "agent-routing", "agent-routing-state", "agent-routing-owner", "agent-routing-classification", "local-host", "session-lease"].map(name => `dist/workspace/${name}.js`);
const original = Object.fromEntries(dist.map(file => [file, hash(file)]));
const counts = output => Object.fromEntries(["tests", "pass", "fail", "skipped", "cancelled"].map(name => {
  const values = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))]; return [name, values.length ? Number(values.at(-1)[1]) : null];
}));
const run = (args, env = {}, timeout = 180000) => {
  const child = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: "utf8", timeout, maxBuffer: 24 * 1024 * 1024 });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`; process.stdout.write(output + "\n");
  return { output, status: child.status, signal: child.signal, error: child.error?.message ?? null };
};
const baseArgs = ["--import", "./test/setup-isolated-home.mjs", "--test", "--test-timeout=120000"];
console.log("C13 MUTATION BASELINE");
const baseline = run([...baseArgs, "--test-concurrency=4", ...["agent-boundaries-c13-routing", "agent-boundaries-c13-lifecycle", "agent-boundaries-c13-joint", "agent-boundary-execution", "agent-command-control", "agent-command-control-b", "agent-command-control-c"].map(name => `test/${name}.test.mjs`)], {}, 240000);
assert.equal(baseline.error, null); assert.equal(baseline.status, 0); assert.equal(counts(baseline.output).fail, 0); assert.equal(counts(baseline.output).skipped, 0);
const oldCases = [
  ["deny", "agent-boundary-execution", "C3 isolated C2 explicit-deny"],
  ["inode", "agent-boundary-execution", "C3 isolated C2 root inode"],
  ["scoped", "agent-boundary-execution", "C3 scope adapter identity"],
  ["drainOwner", "agent-command-control-c", "C3 drain owner alone"],
  ["unknown", "agent-command-control-c", "C3 transition independently"],
  ["unknownState", "agent-command-control-c", "C3 persisted unknown run"],
];
const cases = [
  ["bodyConflict", "agent-boundaries-c13-routing", "C13 F1 real WS"],
  ["rejectionReceipt", "agent-boundaries-c13-routing", "C13 F2 real WS"],
  ["genuineClaimReadback", "agent-boundaries-c13-joint", "C13 joint two real Hosts"],
  ["recoveryPhaseTerminal", "agent-boundaries-c13-lifecycle", "C13 F3 genuine beginRecovery"],
  ["recoveryLease", "agent-boundaries-c13-lifecycle", "C13 F3 unresolved original lease"],
  ["liveOwner", "agent-boundaries-c13-lifecycle", "C13 F4 a live foreign"],
  ["abortEarly", "agent-boundaries-c13-lifecycle", "C13 F5 refused abort"],
  ["audienceAtEffect", "agent-boundaries-c13-joint", "C13 joint real WS routing and C2 IO"],
];
function mutate([name, file, pattern], legacy) {
  console.log(`C13 MUTANT ${legacy ? "legacy-core" : "c13"}/${name}`);
  const loader = legacy ? "agent-boundary-mutant-loader" : "agent-boundaries-c13-mutant-loader";
  const flag = legacy ? "HARA_BOUNDARY_TEST_MUTATION" : "HARA_C13_TEST_MUTATION";
  const child = run(["--import", "./test/setup-isolated-home.mjs", "--import", `./test/helpers/${loader}.mjs`, "--test", "--test-concurrency=1", "--test-timeout=120000", `--test-name-pattern=${pattern}`, `test/${file}.test.mjs`], { [flag]: name });
  const marker = `[${legacy ? "BOUNDARY" : "C13"}_MUTATION_APPLIED:${name}]`;
  const applied = child.output.includes(marker), namedFailure = child.output.split("\n").some(line => /^not ok \d+ - /.test(line) && line.includes(pattern));
  const assertion = child.output.includes("ERR_ASSERTION"), killed = child.error === null && child.signal === null && child.status === 1 && applied && namedFailure && assertion;
  return { name, file, pattern, applied, namedFailure, assertion, killed, status: child.status, signal: child.signal, error: child.error };
}
const legacyCore = oldCases.map(item => mutate(item, true)), current = cases.map(item => mutate(item, false));
const suites = [];
for (const [label, file, prefix] of [["C4", "agent-lifecycle-mutations", "C4_MUTATION_SUMMARY"], ["C6", "agent-routing-mutations", "C6_MUTATION_SUMMARY"]]) {
  console.log(`C13 RETAINED SUITE ${label}`);
  const child = run([`test/helpers/${file}.mjs`, "--verify"], {}, 600000);
  const line = child.output.split("\n").find(value => value.startsWith(prefix + " "));
  const summary = line ? JSON.parse(line.slice(prefix.length + 1)) : null;
  suites.push({ label, status: child.status, signal: child.signal, error: child.error, summary,
    passed: child.error === null && child.signal === null && child.status === 0 && summary?.total > 0 && summary.killed === summary.total });
}
assert.deepEqual(Object.fromEntries(dist.map(file => [file, hash(file)])), original, "all canonical compiled modules must stay byte-identical");
const result = { schemaVersion: 1, baseline: counts(baseline.output), canonicalDistUnchanged: true, compiledSha256: original,
  legacyCore: { total: legacyCore.length, killed: legacyCore.filter(row => row.killed).length, cases: legacyCore },
  current: { total: current.length, killed: current.filter(row => row.killed).length, cases: current }, retainedSuites: suites,
  passed: legacyCore.every(row => row.killed) && current.every(row => row.killed) && suites.every(row => row.passed),
  accounting: "Legacy suites retain their original scope; overlapping UNKNOWN checks are repeat invocations, not independent new defenses." };
console.log("C13_MUTATION_SUMMARY " + JSON.stringify(result)); assert.equal(result.passed, true, "each explicit defense removal must fail its named assertion; loader/setup errors are not kills");
