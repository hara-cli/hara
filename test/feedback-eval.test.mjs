import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateFeedbackSuite,
  evaluateFeedbackTrace,
  loadFeedbackTraces,
} from "../scripts/evaluate-feedback-traces.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const traceDirectory = join(root, "evals", "feedback");

test("sanitized real-feedback regression suite passes its budgets", () => {
  const suite = evaluateFeedbackSuite(loadFeedbackTraces(traceDirectory));
  assert.equal(suite.passed, true, JSON.stringify(suite.reports));
  assert.deepEqual(suite.summary, {
    cases: 5,
    passed: 5,
    failed: 0,
    expectedCompleted: 4,
    completed: 4,
    completionSuccessRate: 1,
    averageRounds: 3.6,
    averageToolCalls: 2.4,
    approvals: 0,
    userInterventions: 0,
    maxRepeatedFailureAttempts: 2,
  });
});

test("false completion and repeated no-progress failures fail closed", () => {
  const trace = JSON.parse(
    readFileSync(join(traceDirectory, "windows-executor-fallback.json"), "utf8"),
  );
  trace.observed.completion.evidence = [];
  trace.observed.events = [
    {
      type: "tool_result",
      tool: "bash",
      strategy: "git-bash",
      outcome: "failure",
      failureClass: "executor.unavailable",
    },
    {
      type: "tool_result",
      tool: "read_file",
      strategy: "inspect-error",
      outcome: "success",
    },
    {
      type: "tool_result",
      tool: "bash",
      strategy: "git-bash",
      outcome: "failure",
      failureClass: "executor.unavailable",
    },
    {
      type: "tool_result",
      tool: "bash",
      strategy: "git-bash",
      outcome: "failure",
      failureClass: "executor.unavailable",
    },
  ];
  const report = evaluateFeedbackTrace(trace);
  assert.equal(report.passed, false);
  assert.match(report.errors.join("\n"), /observable completion evidence/);
  assert.match(report.errors.join("\n"), /maxRepeatedFailureAttempts exceeded: 3 > 2/);
  assert.match(report.errors.join("\n"), /never switched to powershell-native/);
});

test("credential-like content and user-specific paths are rejected", () => {
  const trace = JSON.parse(
    readFileSync(join(traceDirectory, "attachment-identity-awaiting-user.json"), "utf8"),
  );
  trace.observed.completion.waitingFor = "read /Users/example/.hara/config with token=secretvalue123";
  const report = evaluateFeedbackTrace(trace);
  assert.equal(report.passed, false);
  assert.match(report.errors.join("\n"), /trace contains/);
});
