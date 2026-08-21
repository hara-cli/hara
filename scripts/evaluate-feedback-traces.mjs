#!/usr/bin/env node

// Deterministic, credential-free evaluation of sanitized traces derived from real Hara feedback.
// Live or recorded runs can emit this schema; CI evaluates outcomes, budgets, strategy changes, and
// completion honesty without requiring a model API key.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultTraceDirectory = join(root, "evals", "feedback");
const MAX_TRACE_BYTES = 256 * 1024;
const MAX_EVENTS = 500;
const TRACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const OUTCOMES = new Set(["completed", "awaiting_user", "failed"]);
const EVENT_TYPES = new Set(["tool_result", "model_request", "approval", "user_intervention", "action_handoff"]);
const HUMAN_DEPENDENCIES = new Set([
  "missing_secret",
  "missing_authority",
  "physical_action",
  "material_choice",
  "external_state",
  "destructive_confirmation",
]);
const SENSITIVE_PATTERNS = [
  { label: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/u },
  { label: "authorization header", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/iu },
  { label: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/u },
  {
    label: "inline credential",
    pattern: /(?:api[_ -]?key|token|password|secret)\s*[:=]\s*["']?(?!<redacted>|\[redacted\])[A-Za-z0-9._~+/=-]{8,}/iu,
  },
  { label: "macOS user path", pattern: /\/Users\/[^/\s]+/u },
  { label: "Linux user path", pattern: /\/home\/[^/\s]+/u },
  { label: "Windows user path", pattern: /\b[A-Za-z]:\\Users\\[^\\\s]+/u },
];

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function pushError(errors, condition, message) {
  if (!condition) errors.push(message);
}

function pushExactKeys(errors, value, expected, label) {
  if (!plainObject(value)) return;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  pushError(
    errors,
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} keys mismatch; expected ${wanted.join(", ")}, got ${actual.join(", ")}`,
  );
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (plainObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function sensitiveFinding(trace) {
  for (const value of collectStrings(trace)) {
    for (const { label, pattern } of SENSITIVE_PATTERNS) {
      if (pattern.test(value)) return label;
    }
  }
  return undefined;
}

function evaluateEvents(events, errors) {
  const metrics = {
    toolCalls: 0,
    approvals: 0,
    userInterventions: 0,
    maxRepeatedFailureAttempts: 0,
    agentOwnedActions: 0,
    wrongUserDelegations: 0,
  };
  const activeFailures = new Map();
  const strategies = new Set();
  const sentModels = new Set();

  pushError(errors, Array.isArray(events), "observed.events must be an array");
  if (!Array.isArray(events)) return { metrics, strategies, sentModels };
  pushError(errors, events.length <= MAX_EVENTS, `observed.events exceeds ${MAX_EVENTS}`);

  for (const [index, event] of events.entries()) {
    const label = `observed.events[${index}]`;
    if (!plainObject(event)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    pushError(errors, EVENT_TYPES.has(event.type), `${label}.type is unsupported`);

    if (event.type === "tool_result") {
      pushExactKeys(
        errors,
        event,
        event.outcome === "failure"
          ? ["type", "tool", "strategy", "outcome", "failureClass"]
          : ["type", "tool", "strategy", "outcome"],
        label,
      );
      metrics.toolCalls++;
      pushError(errors, typeof event.tool === "string" && event.tool.length > 0, `${label}.tool is required`);
      pushError(
        errors,
        typeof event.strategy === "string" && event.strategy.length > 0,
        `${label}.strategy is required`,
      );
      pushError(errors, event.outcome === "success" || event.outcome === "failure", `${label}.outcome is invalid`);
      if (event.outcome === "success") {
        for (const [failureClass, failure] of activeFailures) {
          if (failure.strategies.has(event.strategy)) activeFailures.delete(failureClass);
        }
      } else if (event.outcome === "failure") {
        pushError(
          errors,
          typeof event.failureClass === "string" && event.failureClass.length > 0,
          `${label}.failureClass is required for failures`,
        );
        if (typeof event.failureClass === "string" && event.failureClass) {
          const prior = activeFailures.get(event.failureClass) ?? {
            count: 0,
            strategies: new Set(),
          };
          prior.count++;
          prior.strategies.add(event.strategy);
          activeFailures.set(event.failureClass, prior);
          metrics.maxRepeatedFailureAttempts = Math.max(
            metrics.maxRepeatedFailureAttempts,
            prior.count,
          );
        }
      }
    } else if (event.type === "model_request") {
      pushExactKeys(errors, event, ["type", "model", "strategy", "outcome"], label);
      pushError(errors, typeof event.model === "string" && event.model.length > 0, `${label}.model is required`);
      pushError(
        errors,
        typeof event.strategy === "string" && event.strategy.length > 0,
        `${label}.strategy is required`,
      );
      pushError(errors, event.outcome === "sent" || event.outcome === "blocked", `${label}.outcome is invalid`);
      if (event.outcome === "sent" && typeof event.model === "string") sentModels.add(event.model);
    } else if (event.type === "approval") {
      pushExactKeys(errors, event, ["type", "outcome"], label);
      metrics.approvals++;
      pushError(errors, event.outcome === "approved" || event.outcome === "denied", `${label}.outcome is invalid`);
    } else if (event.type === "user_intervention") {
      pushExactKeys(errors, event, ["type", "reason"], label);
      metrics.userInterventions++;
      pushError(errors, typeof event.reason === "string" && event.reason.length > 0, `${label}.reason is required`);
    } else if (event.type === "action_handoff") {
      const userOwned = event.owner === "user";
      pushExactKeys(
        errors,
        event,
        userOwned
          ? ["type", "owner", "strategy", "authorizedToolAvailable", "outcome", "dependencyKind"]
          : ["type", "owner", "strategy", "authorizedToolAvailable", "outcome"],
        label,
      );
      pushError(errors, event.owner === "agent" || event.owner === "user", `${label}.owner is invalid`);
      pushError(errors, typeof event.strategy === "string" && event.strategy.length > 0, `${label}.strategy is required`);
      pushError(errors, typeof event.authorizedToolAvailable === "boolean", `${label}.authorizedToolAvailable must be boolean`);
      if (event.owner === "agent") {
        metrics.agentOwnedActions++;
        pushError(errors, event.outcome === "executed", `${label}.outcome must be executed for agent ownership`);
      } else if (event.owner === "user") {
        pushError(errors, event.outcome === "awaiting_user", `${label}.outcome must be awaiting_user for user ownership`);
        pushError(errors, HUMAN_DEPENDENCIES.has(event.dependencyKind), `${label}.dependencyKind is not an allowed human dependency`);
        if (event.authorizedToolAvailable === true || !HUMAN_DEPENDENCIES.has(event.dependencyKind)) {
          metrics.wrongUserDelegations++;
        }
      }
    }
    if (typeof event.strategy === "string" && event.strategy) strategies.add(event.strategy);
  }
  return { metrics, strategies, sentModels };
}

function validateTransition(transition, events, errors, index) {
  const label = `expected.requiredTransitions[${index}]`;
  if (!plainObject(transition)) {
    errors.push(`${label} must be an object`);
    return;
  }
  pushExactKeys(
    errors,
    transition,
    ["fromFailureClass", "toStrategy", "withinToolCalls"],
    label,
  );
  pushError(
    errors,
    typeof transition.fromFailureClass === "string" && transition.fromFailureClass.length > 0,
    `${label}.fromFailureClass is required`,
  );
  pushError(
    errors,
    typeof transition.toStrategy === "string" && transition.toStrategy.length > 0,
    `${label}.toStrategy is required`,
  );
  pushError(
    errors,
    Number.isSafeInteger(transition.withinToolCalls) && transition.withinToolCalls >= 1,
    `${label}.withinToolCalls must be a positive integer`,
  );
  if (
    typeof transition.fromFailureClass !== "string" ||
    typeof transition.toStrategy !== "string" ||
    !Number.isSafeInteger(transition.withinToolCalls) ||
    !Array.isArray(events)
  ) return;

  const failureIndex = events.findIndex(
    (event) =>
      event?.type === "tool_result" &&
      event.outcome === "failure" &&
      event.failureClass === transition.fromFailureClass,
  );
  if (failureIndex < 0) {
    errors.push(`${label} source failure ${transition.fromFailureClass} was not observed`);
    return;
  }
  let laterToolCalls = 0;
  for (let eventIndex = failureIndex + 1; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event?.type === "tool_result") laterToolCalls++;
    if (event?.strategy === transition.toStrategy) {
      if (laterToolCalls > transition.withinToolCalls) {
        errors.push(
          `${label} switched after ${laterToolCalls} tool call(s), limit ${transition.withinToolCalls}`,
        );
      }
      return;
    }
  }
  errors.push(`${label} never switched to ${transition.toStrategy}`);
}

export function evaluateFeedbackTrace(trace) {
  const errors = [];
  if (!plainObject(trace)) {
    return { id: "<invalid>", passed: false, errors: ["trace must be an object"], metrics: {} };
  }
  const id = typeof trace.id === "string" ? trace.id : "<invalid>";
  pushExactKeys(
    errors,
    trace,
    ["schema", "id", "traceKind", "source", "expected", "observed"],
    "trace",
  );
  pushError(errors, trace.schema === 1, "schema must be 1");
  pushError(errors, TRACE_ID.test(id), "id must be lower-case kebab-case");
  pushError(errors, trace.traceKind === "sanitized-feedback", "traceKind must be sanitized-feedback");
  pushError(errors, plainObject(trace.source), "source must be an object");
  if (plainObject(trace.source)) {
    pushExactKeys(errors, trace.source, ["channel", "reference"], "source");
    pushError(errors, trace.source.channel === "hara-feedback", "source.channel must be hara-feedback");
    pushError(
      errors,
      typeof trace.source.reference === "string" && trace.source.reference.startsWith("redacted-"),
      "source.reference must be redacted",
    );
  }
  pushError(errors, plainObject(trace.expected), "expected must be an object");
  pushError(errors, plainObject(trace.observed), "observed must be an object");

  const expected = plainObject(trace.expected) ? trace.expected : {};
  const observed = plainObject(trace.observed) ? trace.observed : {};
  const expectedKeys = [
    "outcome",
    "maxRounds",
    "maxToolCalls",
    "maxApprovals",
    "maxUserInterventions",
    "maxRepeatedFailureAttempts",
    "requiredStrategies",
    "requiredTransitions",
  ];
  if (Object.hasOwn(expected, "forbiddenSentModels")) expectedKeys.push("forbiddenSentModels");
  if (Object.hasOwn(expected, "maxWrongUserDelegations")) expectedKeys.push("maxWrongUserDelegations");
  if (Object.hasOwn(expected, "minAgentOwnedActions")) expectedKeys.push("minAgentOwnedActions");
  pushExactKeys(errors, expected, expectedKeys, "expected");
  pushExactKeys(errors, observed, ["outcome", "rounds", "completion", "events"], "observed");
  pushError(errors, OUTCOMES.has(expected.outcome), "expected.outcome is invalid");
  pushError(errors, OUTCOMES.has(observed.outcome), "observed.outcome is invalid");
  pushError(errors, observed.outcome === expected.outcome, "observed outcome does not match expected outcome");
  pushError(errors, finiteNonNegativeInteger(observed.rounds), "observed.rounds must be a non-negative integer");

  const { metrics, strategies, sentModels } = evaluateEvents(observed.events, errors);
  metrics.rounds = finiteNonNegativeInteger(observed.rounds) ? observed.rounds : 0;

  for (const [field, actual] of [
    ["maxRounds", metrics.rounds],
    ["maxToolCalls", metrics.toolCalls],
    ["maxApprovals", metrics.approvals],
    ["maxUserInterventions", metrics.userInterventions],
    ["maxRepeatedFailureAttempts", metrics.maxRepeatedFailureAttempts],
  ]) {
    pushError(errors, finiteNonNegativeInteger(expected[field]), `expected.${field} must be a non-negative integer`);
    if (finiteNonNegativeInteger(expected[field]) && actual > expected[field]) {
      errors.push(`${field} exceeded: ${actual} > ${expected[field]}`);
    }
  }
  if (expected.maxWrongUserDelegations !== undefined) {
    pushError(errors, finiteNonNegativeInteger(expected.maxWrongUserDelegations), "expected.maxWrongUserDelegations must be a non-negative integer");
    if (finiteNonNegativeInteger(expected.maxWrongUserDelegations) && metrics.wrongUserDelegations > expected.maxWrongUserDelegations) {
      errors.push(`maxWrongUserDelegations exceeded: ${metrics.wrongUserDelegations} > ${expected.maxWrongUserDelegations}`);
    }
  }
  if (expected.minAgentOwnedActions !== undefined) {
    pushError(errors, finiteNonNegativeInteger(expected.minAgentOwnedActions), "expected.minAgentOwnedActions must be a non-negative integer");
    if (finiteNonNegativeInteger(expected.minAgentOwnedActions) && metrics.agentOwnedActions < expected.minAgentOwnedActions) {
      errors.push(`minAgentOwnedActions missed: ${metrics.agentOwnedActions} < ${expected.minAgentOwnedActions}`);
    }
  }

  const completion = observed.completion;
  if (observed.outcome === "completed") {
    pushError(errors, plainObject(completion), "completed trace requires observed.completion");
    if (plainObject(completion)) {
      pushExactKeys(errors, completion, ["state", "evidence"], "observed.completion");
      pushError(errors, completion.state === "verified", "completed trace requires verified completion state");
      pushError(
        errors,
        Array.isArray(completion.evidence) &&
          completion.evidence.length > 0 &&
          completion.evidence.every((item) => typeof item === "string" && item.length > 0),
        "completed trace requires observable completion evidence",
      );
    }
  } else if (observed.outcome === "awaiting_user") {
    pushError(errors, plainObject(completion), "awaiting_user trace requires observed.completion");
    if (plainObject(completion)) {
      pushExactKeys(
        errors,
        completion,
        ["state", "evidence", "waitingFor", "dependency"],
        "observed.completion",
      );
      pushError(errors, completion.state === "awaiting_user", "awaiting_user trace requires matching completion state");
      pushError(
        errors,
        Array.isArray(completion.evidence)
          && completion.evidence.length > 0
          && completion.evidence.every((item) => typeof item === "string" && item.length > 0),
        "awaiting_user trace requires observable blocker evidence",
      );
      pushError(
        errors,
        typeof completion.waitingFor === "string" && completion.waitingFor.length > 0,
        "awaiting_user trace requires the exact missing input",
      );
      pushError(errors, plainObject(completion.dependency), "awaiting_user trace requires a typed dependency");
      if (plainObject(completion.dependency)) {
        const dependencyKeys = ["kind", "detail", "evidence"];
        if (Object.hasOwn(completion.dependency, "capability")) dependencyKeys.push("capability");
        pushExactKeys(errors, completion.dependency, dependencyKeys, "observed.completion.dependency");
        pushError(errors, HUMAN_DEPENDENCIES.has(completion.dependency.kind), "awaiting_user dependency kind is invalid");
        pushError(errors, completion.dependency.detail === completion.waitingFor, "dependency detail must match waitingFor");
        pushError(
          errors,
          Array.isArray(completion.dependency.evidence)
            && completion.dependency.evidence.length > 0
            && completion.dependency.evidence.every((item) => typeof item === "string" && item.length > 0),
          "awaiting_user dependency requires observed evidence",
        );
        if (completion.dependency.kind === "missing_secret" || completion.dependency.kind === "missing_authority") {
          pushError(errors, typeof completion.dependency.capability === "string" && completion.dependency.capability.length > 0, "authority/secret dependency requires a capability");
        }
      }
    }
  } else if (observed.outcome === "failed") {
    pushError(errors, plainObject(completion), "failed trace requires observed.completion");
    if (plainObject(completion)) {
      pushExactKeys(errors, completion, ["state", "evidence"], "observed.completion");
      pushError(errors, completion.state === "failed", "failed trace requires matching completion state");
      pushError(
        errors,
        Array.isArray(completion.evidence) &&
          completion.evidence.length > 0 &&
          completion.evidence.every((item) => typeof item === "string" && item.length > 0),
        "failed trace requires observable failure evidence",
      );
    }
  }

  pushError(errors, Array.isArray(expected.requiredStrategies), "expected.requiredStrategies must be an array");
  const requiredStrategies = Array.isArray(expected.requiredStrategies) ? expected.requiredStrategies : [];
  for (const strategy of requiredStrategies) {
    pushError(errors, typeof strategy === "string" && strategy.length > 0, "required strategy must be a string");
    if (typeof strategy === "string" && !strategies.has(strategy)) {
      errors.push(`required strategy was not observed: ${strategy}`);
    }
  }
  pushError(
    errors,
    expected.forbiddenSentModels === undefined || Array.isArray(expected.forbiddenSentModels),
    "expected.forbiddenSentModels must be an array when provided",
  );
  const forbiddenSentModels = Array.isArray(expected.forbiddenSentModels) ? expected.forbiddenSentModels : [];
  for (const model of forbiddenSentModels) {
    if (sentModels.has(model)) errors.push(`forbidden model request was sent: ${model}`);
  }
  pushError(errors, Array.isArray(expected.requiredTransitions), "expected.requiredTransitions must be an array");
  const transitions = Array.isArray(expected.requiredTransitions) ? expected.requiredTransitions : [];
  transitions.forEach((transition, index) =>
    validateTransition(transition, observed.events, errors, index));

  const sensitive = sensitiveFinding(trace);
  if (sensitive) errors.push(`trace contains ${sensitive}; sanitize it before evaluation`);
  return { id, passed: errors.length === 0, errors, metrics };
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

export function evaluateFeedbackSuite(traces) {
  if (!Array.isArray(traces) || traces.length === 0) {
    throw new Error("feedback evaluation suite must contain at least one trace");
  }
  const reports = traces.map(evaluateFeedbackTrace);
  const idCounts = new Map();
  for (const report of reports) idCounts.set(report.id, (idCounts.get(report.id) ?? 0) + 1);
  for (const report of reports) {
    if ((idCounts.get(report.id) ?? 0) > 1) {
      report.errors.push(`duplicate trace id: ${report.id}`);
      report.passed = false;
    }
  }
  const expectedCompleted = traces.filter((trace) => trace?.expected?.outcome === "completed").length;
  const completed = traces.filter(
    (trace, index) => trace?.observed?.outcome === "completed" && reports[index].passed,
  ).length;
  const totalRounds = reports.reduce((sum, report) => sum + (report.metrics.rounds ?? 0), 0);
  const totalToolCalls = reports.reduce((sum, report) => sum + (report.metrics.toolCalls ?? 0), 0);
  const summary = {
    cases: reports.length,
    passed: reports.filter((report) => report.passed).length,
    failed: reports.filter((report) => !report.passed).length,
    expectedCompleted,
    completed,
    completionSuccessRate: expectedCompleted ? rounded(completed / expectedCompleted) : 1,
    averageRounds: rounded(totalRounds / reports.length),
    averageToolCalls: rounded(totalToolCalls / reports.length),
    approvals: reports.reduce((sum, report) => sum + (report.metrics.approvals ?? 0), 0),
    userInterventions: reports.reduce(
      (sum, report) => sum + (report.metrics.userInterventions ?? 0),
      0,
    ),
    agentOwnedActions: reports.reduce(
      (sum, report) => sum + (report.metrics.agentOwnedActions ?? 0),
      0,
    ),
    wrongUserDelegations: reports.reduce(
      (sum, report) => sum + (report.metrics.wrongUserDelegations ?? 0),
      0,
    ),
    maxRepeatedFailureAttempts: Math.max(
      ...reports.map((report) => report.metrics.maxRepeatedFailureAttempts ?? 0),
    ),
  };
  return { passed: summary.failed === 0, reports, summary };
}

export function loadFeedbackTraces(directory = defaultTraceDirectory) {
  const traceDirectory = resolve(directory);
  const directoryInfo = lstatSync(traceDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("feedback trace path must be a real directory");
  }
  const files = readdirSync(traceDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error("feedback trace directory contains no JSON files");
  return files.map((name) => {
    const tracePath = join(traceDirectory, name);
    const info = lstatSync(tracePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_TRACE_BYTES) {
      throw new Error(`feedback trace must be a regular file up to ${MAX_TRACE_BYTES} bytes: ${name}`);
    }
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    if (`${trace?.id}.json` !== name) {
      throw new Error(`feedback trace filename must match its id: ${name}`);
    }
    return trace;
  });
}

function main() {
  const [, , directoryArgument, extra] = process.argv;
  if (extra) {
    console.error("usage: node scripts/evaluate-feedback-traces.mjs [trace-directory]");
    process.exitCode = 2;
    return;
  }
  const suite = evaluateFeedbackSuite(loadFeedbackTraces(directoryArgument));
  for (const report of suite.reports) {
    if (report.passed) {
      console.log(
        `PASS ${report.id} rounds=${report.metrics.rounds} tools=${report.metrics.toolCalls} approvals=${report.metrics.approvals} interventions=${report.metrics.userInterventions} wrong_handoffs=${report.metrics.wrongUserDelegations}`,
      );
    } else {
      console.error(`FAIL ${report.id}`);
      for (const error of report.errors) console.error(`  - ${error}`);
    }
  }
  console.log(`feedback-eval: ${JSON.stringify(suite.summary)}`);
  if (!suite.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
