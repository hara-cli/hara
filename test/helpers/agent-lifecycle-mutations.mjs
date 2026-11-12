// Run only under the standard private HOME/TMP guard. Expected failures are not a passing normal suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
if (process.argv[2] !== "--verify" || process.argv.length !== 3) throw new Error("Use explicit --verify under the C4 guard");
const cases = [
  ["issuance", "agent-lifecycle-drain", "C4 persistence fences issuance before the first real gate"],
  ["quiescence", "agent-lifecycle-drain", "C4 persistence fences issuance before the first real gate"],
  ["terminalOrder", "agent-lifecycle-recovery", "C4 terminal publication precedes lease closure"],
  ["capabilityScope", "agent-lifecycle-maintenance", "C4 persistent task revocation rejects copied C1 grants"],
  ["coldRead", "agent-lifecycle-history", "C4 missing history refuses dependent reads/admission"],
  ["closedProof", "agent-lifecycle-history", "C4 unconfirmed issued ownership cannot be archived"],
  ["unknown", "agent-command-control", "C3 transition independently refuses erasing UNKNOWN effect"],
  ["drainCasIsolation", "agent-lifecycle-drain", "C4 stale final-drain publication keeps sibling effects"],
  ["partialDowngrade", "agent-lifecycle-contract", "C4 a partial downgrade retaining lifecycle"],
];
const result = [];
for (const [name, file, pattern] of cases) {
  const child = spawnSync(process.execPath, ["--import", "./test/setup-isolated-home.mjs", "--import", "./test/helpers/agent-lifecycle-mutant-loader.mjs",
    "--test", "--test-concurrency=1", "--test-timeout=120000", `--test-name-pattern=${pattern}`, `test/${file}.test.mjs`],
  { env: { ...process.env, HARA_C4_TEST_MUTATION: name }, encoding: "utf8", timeout: 130000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`; process.stdout.write(`\nC4 MUTANT ${name}\n${output}\n`);
  const namedFailure = output.split("\n").some(line => /^not ok \d+ - /.test(line) && line.includes(pattern));
  const applied = output.includes(`[C4_MUTATION_APPLIED:${name}]`), assertion = output.includes("ERR_ASSERTION");
  const killed = !child.error && child.signal === null && child.status === 1 && applied && namedFailure && assertion;
  result.push({ name, applied, namedFailure, assertion, killed, status: child.status, signal: child.signal, error: child.error?.message ?? null });
}
const summary = { schemaVersion: 1, total: result.length, killed: result.filter(row => row.killed).length, cases: result };
console.log("C4_MUTATION_SUMMARY " + JSON.stringify(summary)); assert.equal(summary.killed, summary.total, "Each real defense removal must make its named assertion red");
