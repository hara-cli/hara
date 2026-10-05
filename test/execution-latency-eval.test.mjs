import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateExecutionLatencyMetrics, evaluateExecutionLatencySuite } from "../scripts/evaluate-execution-latency.mjs";

let measuredSuite;
const currentSuite = () => measuredSuite ??= evaluateExecutionLatencySuite();

test("current engine meets provider-call budgets while preserving task gates and steering", () => {
  const suite = currentSuite();
  assert.equal(suite.passed, true, JSON.stringify(suite.reports));
  assert.deepEqual(suite.summary, { cases: 8, passed: 8, failed: 0 });
  const smallChange = suite.reports.find((report) => report.id === "small-change-four-provider-calls");
  assert.equal(smallChange.metrics.providerCalls, 4);
  assert.equal(smallChange.metrics.journalProviderCalls, 4);
  assert.equal(smallChange.metrics.logicalRounds, 5, "the carried action remains a logical round, not another provider request");
  for (const intent of ["answer", "investigate"]) {
    const gated = suite.reports.find((report) => report.id === `${intent}-does-not-gain-change-authority`);
    assert.equal(gated.metrics.effectCalls, 0);
    assert.equal(gated.metrics.deniedToolCalls, 1);
    assert.equal(gated.metrics.finalIntent, intent);
  }
});

test("the engine latency budget rejects extra provider calls and inconsistent telemetry", () => {
  const suite = currentSuite();
  const measured = suite.reports.find((report) => report.id === "small-change-four-provider-calls").metrics;
  const expected = { id: "budget-regression", maxProviderCalls: 4, maxLogicalRounds: 5, effectCalls: 1, firstIntent: "change", verified: true };
  const extraCall = evaluateExecutionLatencyMetrics(expected, { ...measured, providerCalls: 5, statsProviderCalls: 5, runtimeProviderCalls: 5, journalProviderCalls: 5 });
  assert.equal(extraCall.passed, false);
  assert.match(extraCall.errors.join("\n"), /providerCalls exceeded: 5 > 4/);
  const mismatched = evaluateExecutionLatencyMetrics(expected, { ...measured, journalProviderCalls: 3 });
  assert.equal(mismatched.passed, false);
  assert.match(mismatched.errors.join("\n"), /journalProviderCalls differs/);
});

test("the internal evaluation worker cannot bypass HOME isolation through a direct CLI call", () => {
  const environment = { ...process.env };
  delete environment.HARA_EXECUTION_LATENCY_WORKER;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/evaluate-execution-latency.mjs", import.meta.url)), "--worker"], {
    env: environment, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /execution-latency-eval failed/);
});
