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
    cases: 7,
    passed: 7,
    failed: 0,
    expectedCompleted: 6,
    completed: 6,
    completionSuccessRate: 1,
    averageRounds: 4,
    averageToolCalls: 2.71,
    approvals: 0,
    userInterventions: 0,
    agentOwnedActions: 1,
    wrongUserDelegations: 0,
    maxRepeatedFailureAttempts: 2,
  });
});

test("delegating an available authorized action to the user fails the ownership gate", () => {
  const trace = JSON.parse(
    readFileSync(join(traceDirectory, "authorized-change-execution-ownership.json"), "utf8"),
  );
  trace.observed.events[0] = {
    type: "action_handoff",
    owner: "user",
    strategy: "execution-ownership-guard",
    authorizedToolAvailable: true,
    outcome: "awaiting_user",
    dependencyKind: "material_choice",
  };
  const report = evaluateFeedbackTrace(trace);
  assert.equal(report.passed, false);
  assert.match(report.errors.join("\n"), /maxWrongUserDelegations exceeded/);
  assert.match(report.errors.join("\n"), /minAgentOwnedActions missed/);
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
