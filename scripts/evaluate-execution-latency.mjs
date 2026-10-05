#!/usr/bin/env node

// Synthetic engine regressions, not live-model latency measurements. Reports contain metadata only.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const BRIEF = {
  intent: "change",
  goal: "Update and verify the synthetic parser",
  constraints: ["synthetic tools only"],
  acceptance: ["the synthetic parser check passes"],
  steps: ["inspect the parser", "update the parser", "verify the parser"],
};
const STEERING = "Stop editing; inspect and explain the synthetic parser only.";
const READ_ONLY_BRIEF = {
  goal: "Explain the synthetic parser without changing it",
  acceptance: ["the explanation is supported by the synthetic context"],
  steps: ["inspect the synthetic context", "explain the observed behavior"],
};
const toolCall = (id, name, input = {}) => ({ id, name, input });
const turn = (...toolUses) => ({ text: "", toolUses, stop: "tool_use" });
const intake = (id, intent = "change", extra = {}) => toolCall(id, "task_intake", { ...BRIEF, intent, ...extra });
const edit = (id) => toolCall(id, "fixture_latency_edit", { path: "parser.ts" });
const receipt = (id) => turn(toolCall(id, "task_checkpoint", {
  completion: { state: "verified", evidence: ["the synthetic parser check passes"], final_answer: "The synthetic result is verified." },
}));

function scenarios() {
  return [
    {
      id: "small-change-four-provider-calls", maxProviderCalls: 4, maxLogicalRounds: 5,
      effectCalls: 1, firstIntent: "change", verified: true, adaptiveSmallChange: true,
      turns: [turn(toolCall("read", "fixture_latency_read")), turn(intake("brief"), edit("edit")), turn(toolCall("verify", "fixture_latency_verify")), receipt("done")],
    },
    {
      id: "inline-capability-preflight", maxProviderCalls: 2, maxLogicalRounds: 3,
      effectCalls: 1, firstIntent: "change", requiresCapability: true,
      turns: [turn(intake("brief", "change", { required_capabilities: ["synthetic_publish"] }), toolCall("preflight", "task_checkpoint", {
        capabilities: [{ name: "synthetic_publish", state: "available", detail: "the synthetic connector check passed" }],
      }), edit("edit")), receipt("done")],
    },
    {
      id: "wrong-intent-explicit-repair", maxProviderCalls: 3, maxLogicalRounds: 5,
      effectCalls: 1, deniedToolCalls: 1, firstIntent: "investigate",
      turns: [turn(intake("wrong", "investigate"), edit("denied")), turn(intake("revised", "change"), edit("edit")), receipt("done")],
    },
    ...["answer", "investigate"].map((intent) => ({
      id: `${intent}-does-not-gain-change-authority`, maxProviderCalls: 2, maxLogicalRounds: 3,
      effectCalls: 0, deniedToolCalls: 1, firstIntent: intent, finalIntent: intent,
      request: "Inspect and explain the synthetic parser. Do not edit it.",
      turns: [turn(intake("brief", intent, READ_ONLY_BRIEF), edit("denied")), receipt("done")],
    })),
    {
      id: "rejected-brief-discards-carry", maxProviderCalls: 3, maxLogicalRounds: 3,
      effectCalls: 0, failedStateCalls: 1, firstIntent: "investigate", finalIntent: "investigate", discardedCallId: "discarded",
      request: "Inspect and explain the synthetic parser. Do not edit it.",
      turns: [turn(intake("invalid", "not-an-intent", READ_ONLY_BRIEF), edit("discarded")), turn(intake("revised", "investigate", READ_ONLY_BRIEF)), receipt("done")],
    },
    {
      id: "write-ahead-steering-discards-carry", maxProviderCalls: 3, maxLogicalRounds: 3,
      effectCalls: 0, firstIntent: "change", finalIntent: "investigate", steering: true, discardedCallId: "discarded",
      turns: [turn(intake("brief"), edit("discarded")), turn(intake("revised", "investigate", READ_ONLY_BRIEF)), receipt("done")],
    },
    {
      id: "unknown-capability-stays-gated", maxProviderCalls: 2, maxLogicalRounds: 3,
      effectCalls: 0, deniedToolCalls: 1, firstIntent: "change", requiresCapability: true, completionState: "awaiting_user",
      turns: [turn(intake("brief", "change", { required_capabilities: ["synthetic_publish"] }), toolCall("preflight", "task_checkpoint", {
        capabilities: [{ name: "synthetic_publish", state: "unknown", detail: "the synthetic connector has not been authorized" }],
      }), edit("denied")), turn(toolCall("blocked", "task_checkpoint", {
        capabilities: [{ name: "synthetic_publish", state: "blocked", detail: "the synthetic connector requires authorization from its owner" }],
        completion: {
          state: "awaiting_user", evidence: ["the synthetic connector rejected the authorization check"],
          dependency: { kind: "missing_authority", capability: "synthetic_publish", detail: "Authorize the synthetic connector in its trusted settings surface.", evidence: ["the synthetic authorization check returned blocked"] },
          final_answer: "Authorize the synthetic connector through its trusted settings surface, then continue.",
        },
      }))],
    },
  ];
}

/** Budgets count actual provider invocations; synthetic carried rounds count only as logical rounds. */
export function evaluateExecutionLatencyMetrics(expected, metrics) {
  const errors = [];
  for (const [field, budget] of [["providerCalls", expected.maxProviderCalls], ["logicalRounds", expected.maxLogicalRounds]]) {
    if (!Number.isSafeInteger(metrics[field]) || metrics[field] < 1) errors.push(`${field} is invalid`);
    else if (metrics[field] > budget) errors.push(`${field} exceeded: ${metrics[field]} > ${budget}`);
  }
  for (const field of ["statsProviderCalls", "runtimeProviderCalls", "journalProviderCalls"]) {
    if (metrics[field] !== metrics.providerCalls) errors.push(`${field} differs from actual provider invocations`);
  }
  for (const [field, value] of [
    ["effectCalls", expected.effectCalls], ["deniedToolCalls", expected.deniedToolCalls ?? 0],
    ["failedStateCalls", expected.failedStateCalls ?? 0], ["firstIntent", expected.firstIntent],
    ["finalIntent", expected.finalIntent ?? "change"], ["completionState", expected.completionState ?? "verified"],
  ]) if (metrics[field] !== value) errors.push(`${field} differs from the scenario contract`);
  if (metrics.outcome !== "completed") errors.push(`engine outcome was ${metrics.outcome}`);
  if (!metrics.closedProtocol || !metrics.checkpointBeforeEffect) errors.push("closed durable task-state boundary was not preserved");
  if (!metrics.discardedCallAbsent) errors.push("a discarded carried call entered the persisted protocol");
  if (!metrics.journalValid) errors.push("runtime journal contains invalid or torn records");
  if (expected.verified && metrics.verificationCalls !== 1) errors.push("the acceptance check was not executed exactly once");
  if (expected.steering && (metrics.steeringCopies !== 1 || metrics.steeringSeenOnNextRequest !== true)) errors.push("new user steering was not delivered exactly once before the next provider request");
  return { id: expected.id, passed: errors.length === 0, errors, metrics };
}

function closedProtocol(history) {
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (message.role !== "assistant" || !message.toolUses.length) continue;
    const result = history[index + 1];
    if (result?.role !== "tool" || result.results.length !== message.toolUses.length) return false;
    if (result.results.some((item, itemIndex) => item.id !== message.toolUses[itemIndex].id)) return false;
  }
  return true;
}

async function runMockSuite() {
  // The worker is started with setup-isolated-home before importing any Hara runtime module.
  if (process.env.HARA_EXECUTION_LATENCY_WORKER !== "1" || !basename(process.env.HOME ?? "").startsWith("hara-test-home-")) {
    throw new Error("execution-latency workers require the repository's isolated HOME preload");
  }
  const { runAgent } = await import("../dist/agent/loop.js");
  const { INTERJECT_PREFIX } = await import("../dist/agent/reminders.js");
  const { createTaskExecution, newTurnInteraction, recordTaskSteering, consumePendingTaskSteering } = await import("../dist/session/task.js");
  const { newSessionId, saveSession, loadSession, deleteSession, readSessionJournal, recordSessionRuntimeItem } = await import("../dist/session/store.js");
  const reports = [];
  for (const scenario of scenarios()) {
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-latency-eval-workspace-")));
    let task = createTaskExecution(scenario.id, newTurnInteraction().turnId);
    const history = [{ role: "user", content: scenario.request ?? "Update the synthetic parser and verify the change." }];
    const meta = { id: newSessionId(), cwd, title: "synthetic latency evaluation", provider: "latency-fixture", model: "latency-fixture", createdAt: task.createdAt, updatedAt: task.updatedAt };
    const stats = { input: 0, output: 0 };
    const runtimeItems = [];
    let calls = 0;
    let effectCalls = 0;
    let verificationCalls = 0;
    let logicalRounds = 0;
    let firstIntent;
    let checkpointBeforeEffect = true;
    let steeringRecorded = false;
    let steeringSeenOnNextRequest = false;
    let protocolValidAtCheckpoint = true;
    let smallChangePhase = 0;
    let repairedOldIntakeBoundary = false;
    const steerContent = `${INTERJECT_PREFIX}\n\n${STEERING}`;
    const tools = [
      { name: "fixture_latency_read", kind: "read", description: "synthetic inspection", input_schema: { type: "object", properties: {} }, classify: () => ({ effect: "read", concurrencySafe: true }), async run() { return "synthetic parser observed"; } },
      { name: "fixture_latency_verify", kind: "read", description: "synthetic acceptance check", input_schema: { type: "object", properties: {} }, classify: () => ({ effect: "probe", concurrencySafe: false }), async run() { verificationCalls += 1; return "synthetic parser check passed"; } },
      {
        name: "fixture_latency_edit", kind: "edit", description: "synthetic edit", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        classify: () => ({ effect: "edit", concurrencySafe: false }),
        async run() {
          effectCalls += 1;
          const durable = loadSession(meta.id);
          checkpointBeforeEffect &&= durable?.task?.brief?.intent === "change" && closedProtocol(durable.history);
          if (scenario.requiresCapability) checkpointBeforeEffect &&= durable?.task?.checkpoint?.capabilities?.synthetic_publish?.state === "available";
          return "synthetic parser edited";
        },
      },
    ];
    try {
      saveSession(meta, history, task);
      const outcome = await runAgent(history, {
        provider: {
          id: meta.provider, model: meta.model,
          async turn({ history: requestHistory }) {
            calls += 1;
            if (scenario.steering && calls === 2) steeringSeenOnNextRequest = requestHistory.filter((message) => message.role === "user" && message.content === steerContent).length === 1;
            let response;
            if (scenario.adaptiveSmallChange) {
              // Act like a minimal model that reacts to the engine's observed tool receipts. The former
              // standalone-intake boundary needs a real extra request to retry the rejected edit; the
              // former standalone-completion boundary needs another request for final prose. Both old
              // and new engines can finish the same task, but only the new mechanism meets the budget.
              if (smallChangePhase === 2) {
                const lastEdit = requestHistory.flatMap((message) => message.role === "tool" ? message.results : [])
                  .findLast((result) => result.name === "fixture_latency_edit");
                if (!lastEdit) throw new Error("the synthetic model did not observe its edit receipt");
                if (lastEdit.content.includes("Understanding gate:") && !repairedOldIntakeBoundary) {
                  repairedOldIntakeBoundary = true;
                  response = turn(edit("retry-edit"));
                } else {
                  response = scenario.turns[smallChangePhase++];
                }
              } else if (smallChangePhase < scenario.turns.length) {
                response = scenario.turns[smallChangePhase++];
              } else if (smallChangePhase === scenario.turns.length) {
                smallChangePhase += 1;
                response = { text: "The synthetic result is verified.", toolUses: [], stop: "end" };
              }
            } else {
              response = scenario.turns[calls - 1];
            }
            if (!response) throw new Error("the engine made an unplanned provider request");
            return structuredClone(response);
          },
        },
        ctx: { cwd, todoScope: meta.id }, approval: "full-auto", approvalChannel: false,
        confirm: async () => false, quiet: true, hooks: false, extraTools: tools,
        maxRounds: scenario.maxLogicalRounds + 2, autoContinue: false, timeoutMs: 30_000, stats,
        taskIntake: {
          task, current: () => task,
          onUpdate(next) { task = next; firstIntent ??= next.brief?.intent; },
          onCheckpoint(next) {
            task = next;
            protocolValidAtCheckpoint &&= closedProtocol(history);
            saveSession(meta, history, task);
            if (scenario.steering && !steeringRecorded) {
              steeringRecorded = true;
              const recorded = recordTaskSteering(task, task.turnId, STEERING);
              if (!recorded.ok) throw new Error("synthetic steering could not be accepted");
              task = recorded.task;
              saveSession(meta, history, task);
            }
          },
          onRoundUsage(next) {
            task = next;
            // Final prose-only requests do not emit a tool-round progress event. The engine's committed
            // lifecycle usage includes those rounds too, so a redundant closing request cannot hide.
            logicalRounds = Math.max(logicalRounds, next.roundsUsed);
          },
        },
        ...(scenario.steering ? {
          pendingInput: async () => {
            const consumed = consumePendingTaskSteering(task);
            if (!consumed) return [];
            const messages = consumed.entries.map((entry) => ({ role: "user", content: `${INTERJECT_PREFIX}\n\n${entry.content}` }));
            saveSession(meta, [...history, ...messages], consumed.task);
            task = consumed.task;
            history.push(...messages);
            return [];
          },
        } : {}),
        onProgress(event) { logicalRounds = Math.max(logicalRounds, event.rounds); },
        onRuntimeItem(event) {
          runtimeItems.push(event);
          recordSessionRuntimeItem({ sessionId: meta.id, taskId: task.id, turnId: task.turnId, ...event });
        },
      });
      const journal = readSessionJournal(meta.id);
      const isProviderStart = (event) => event.kind === "provider" && event.state === "started";
      const metrics = {
        providerCalls: calls, statsProviderCalls: stats.providerCalls ?? 0,
        runtimeProviderCalls: runtimeItems.filter(isProviderStart).length,
        journalProviderCalls: journal.events.filter((event) => event.type === "runtime.item" && isProviderStart(event)).length,
        logicalRounds, toolRounds: history.filter((message) => message.role === "tool").length,
        effectCalls, verificationCalls,
        deniedToolCalls: runtimeItems.filter((event) => event.kind === "tool" && event.state === "denied").length,
        failedStateCalls: runtimeItems.filter((event) => event.kind === "tool" && event.state === "failed" && ["task_intake", "task_checkpoint"].includes(event.name)).length,
        firstIntent, finalIntent: task.brief?.intent, completionState: task.checkpoint?.completion?.state,
        outcome: outcome.status, closedProtocol: protocolValidAtCheckpoint && closedProtocol(history), checkpointBeforeEffect,
        discardedCallAbsent: !scenario.discardedCallId || !history.some((message) => message.role === "assistant" && message.toolUses.some((call) => call.id === scenario.discardedCallId)),
        journalValid: journal.invalidRecords === 0 && !journal.truncatedTail,
        steeringCopies: history.filter((message) => message.role === "user" && message.content === steerContent).length,
        steeringSeenOnNextRequest,
      };
      reports.push(evaluateExecutionLatencyMetrics(scenario, metrics));
    } finally {
      deleteSession(meta.id);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  return { passed: reports.every((report) => report.passed), reports, summary: { cases: reports.length, passed: reports.filter((report) => report.passed).length, failed: reports.filter((report) => !report.passed).length } };
}

/** Always isolate HOME before runtime imports, even when eval:feedback runs in a developer shell. */
export function evaluateExecutionLatencySuite() {
  const childEnvironment = { ...process.env };
  delete childEnvironment.HARA_GATEWAY;
  delete childEnvironment.HARA_CRON;
  childEnvironment.HARA_EXECUTION_LATENCY_WORKER = "1";
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(join(root, "test", "setup-isolated-home.mjs")).href, scriptPath, "--worker"], {
    cwd: root, env: childEnvironment, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (child.error || child.signal || !child.stdout.trim()) throw new Error("isolated execution-latency evaluation did not complete; build dist before running the gate");
  let suite;
  try { suite = JSON.parse(child.stdout); } catch { throw new Error("isolated execution-latency evaluation returned invalid metadata"); }
  if (child.status !== (suite.passed ? 0 : 1)) throw new Error("isolated execution-latency evaluation exit status was inconsistent");
  return suite;
}

export function printExecutionLatencySuite(suite) {
  for (const report of suite.reports) {
    const log = report.passed ? console.log : console.error;
    log(`${report.passed ? "PASS" : "FAIL"} ${report.id} provider_calls=${report.metrics.providerCalls} logical_rounds=${report.metrics.logicalRounds} effects=${report.metrics.effectCalls} denied=${report.metrics.deniedToolCalls}`);
    for (const error of report.errors) console.error(`  - ${error}`);
  }
  console.log(`execution-latency-eval: ${JSON.stringify(suite.summary)} (synthetic engine runs; no live model requests)`);
}

async function main() {
  if (process.argv[2] === "--worker" && process.argv.length === 3) {
    const suite = await runMockSuite();
    console.log(JSON.stringify(suite));
    if (!suite.passed) process.exitCode = 1;
    return;
  }
  if (process.argv.length !== 2) throw new Error("usage: node scripts/evaluate-execution-latency.mjs");
  const suite = evaluateExecutionLatencySuite();
  printExecutionLatencySuite(suite);
  if (!suite.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch(() => {
    console.error("execution-latency-eval failed; build dist and rerun the isolated synthetic gate");
    process.exitCode = 1;
  });
}
