// Expected mutant failures are distinct from the passing normal suite. Does not edit source or dist.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
if (process.argv[2] !== "--verify" || process.argv.length !== 3) throw new Error("Use explicit --verify under the C6 guard");
const cases = [
  ["publicSecrets", "agent-routing-classification", "C6 classification redacts every public duty field"],
  ["audienceFirst", "agent-routing-claim", "C6 checks actual audience before directory"],
  ["ties", "agent-routing-owner", "C6 unique public duty nomination"],
  ["rejects", "agent-routing-owner", "C6 rejects precede scores"],
  ["firstFallback", "agent-routing-owner", "C6 unique public duty nomination"],
  ["claimAtomic", "agent-routing-claim", "C6 C3 accepts exactly one owner/claim"],
  ["version", "agent-routing-claim", "C6 audience changes between nomination and CAS"],
  ["consumeOnce", "agent-routing-defenses", "C6 the genuine RoutingPermit cannot be consumed twice"],
  ["submitOnce", "agent-routing-defenses", "C6 the actual provider boundary independently refuses"],
  ["unknownFrozen", "agent-routing-defenses", "C6 the persisted transition cannot reopen a classification"],
  ["strictKeys", "agent-routing-defenses", "C6 adapter itself rejects extra output fields"],
  ["whitelist", "agent-routing-defenses", "C6 adapter itself rejects extra output fields"],
  ["tools", "agent-routing-defenses", "C6 adapter itself rejects extra output fields"],
  ["oldOwner", "agent-routing-defenses", "C6 the persisted owner transition refuses dropping"],
  ["privatePersona", "agent-routing-host", "C6 public directory never consults execution resources"],
];
const result = [];
for (const [name, file, pattern] of cases) {
  const child = spawnSync(process.execPath, ["--import", "./test/setup-isolated-home.mjs", "--import", "./test/helpers/agent-routing-mutant-loader.mjs",
    "--test", "--test-concurrency=1", "--test-timeout=120000", `--test-name-pattern=${pattern}`, `test/${file}.test.mjs`],
  { env: { ...process.env, HARA_C6_TEST_MUTATION: name }, encoding: "utf8", timeout: 130000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`; process.stdout.write(`\nC6 MUTANT ${name}\n${output}\n`);
  const namedFailure = output.split("\n").some(line => /^not ok \d+ - /.test(line) && line.includes(pattern));
  const applied = output.includes(`[C6_MUTATION_APPLIED:${name}]`), assertion = output.includes("ERR_ASSERTION");
  const killed = !child.error && child.signal === null && child.status === 1 && applied && namedFailure && assertion;
  result.push({ name, applied, namedFailure, assertion, killed, status: child.status, signal: child.signal, error: child.error?.message ?? null });
}
const summary = { schemaVersion: 1, total: result.length, killed: result.filter(row => row.killed).length, cases: result };
console.log("C6_MUTATION_SUMMARY " + JSON.stringify(summary)); assert.equal(summary.killed, summary.total, "Every defense removal must make its named executed assertion red");
