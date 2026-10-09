import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import { createTaskExecution, finishTaskExecution } from "../dist/session/task.js";
import "../dist/tools/todo.js";

const fixture = mkdtempSync(join(tmpdir(), "hara-finalization-boundary-"));
after(() => rmSync(fixture, { recursive: true, force: true }));

async function runFixture(finalize) {
  let task = createTaskExecution("deliver the fixture result once", "finalization-turn");
  let sends = 0;
  let reads = 0;
  let requests = 0;
  let approvals = 0;
  const progress = [];
  const text = [];
  const notices = [];
  const send = {
    name: "fixture_deliver_once",
    description: "In-memory delivery fixture; no external service is contacted.",
    input_schema: { type: "object", properties: {} },
    kind: "exec",
    async run() { sends += 1; return "fixture delivery accepted exactly once"; },
  };
  const inspect = {
    name: "fixture_delivery_status",
    description: "In-memory receipt read; no external service is contacted.",
    input_schema: { type: "object", properties: { pass: { type: "number" } }, required: ["pass"] },
    kind: "read",
    async run(input) { reads += 1; return `verified fixture delivery status ${input.pass}`; },
  };
  const turns = [
    {
      text: "", stop: "tool_use", usage: { input: 50_000, output: 1 },
      toolUses: [{ id: "brief", name: "task_intake", input: {
        intent: "change", goal: "deliver the fixture result once",
        constraints: ["never repeat the delivery"], acceptance: ["the receipt confirms delivery"],
        steps: ["deliver", "inspect the receipt", "record completion"],
      } }],
    },
    { text: "", stop: "tool_use", usage: { input: 70_000, output: 1 }, toolUses: [{ id: "send", name: send.name, input: {} }] },
    { text: "", stop: "tool_use", usage: { input: 70_000, output: 1 }, toolUses: [{ id: "read-1", name: inspect.name, input: { pass: 1 } }] },
    { text: "", stop: "tool_use", usage: { input: 70_000, output: 1 }, toolUses: [{ id: "read-2", name: inspect.name, input: { pass: 2 } }] },
  ];
  const provider = {
    id: "finalization-fixture", model: "finalization-fixture",
    async turn(request) {
      const index = requests++;
      assert.ok(index < 6, "the finalization boundary must stay bounded");
      return turns[index] ?? finalize(request, { send, inspect, index });
    },
  };
  const history = [{ role: "user", content: "deliver the fixture result once" }];
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: fixture, todoScope: "finalization-fixture", ui: {
      text: (value) => text.push(value), notice: (value) => notices.push(value),
      reasoning() {}, tool() {}, diff() {},
    } },
    approval: "suggest",
    confirm: async () => { approvals += 1; return true; },
    stats: { input: 0, output: 0 },
    extraTools: [send, inspect],
    onProgress: (value) => progress.push(value),
    taskIntake: { task, current: () => task, onUpdate(next) { task = next; }, onCheckpoint(next) { task = next; } },
  });
  return { outcome, task: finishTaskExecution(task, outcome), sends, reads, requests, approvals, progress, text, notices, history };
}

function verifiedReceipt() {
  return {
    text: "", stop: "tool_use", usage: { input: 1, output: 1 },
    toolUses: [{ id: "completion", name: "task_checkpoint", input: {
      completion: { state: "verified", evidence: ["fixture receipt confirms one delivery"], final_answer: "Fixture delivery verified." },
    } }],
  };
}

test("successful work closes from existing receipts when the finalization request exposes only checkpoint tools", async () => {
  let finalTools;
  const result = await runFixture((request, { inspect }) => {
    finalTools = request.tools.map((tool) => tool.name).sort();
    // A provider choosing an available status tool used to spend its only close-out round re-reading.
    // Removing that tool directs this request to the already-observed receipt, without another action.
    return finalTools.includes(inspect.name)
      ? { text: "", stop: "tool_use", usage: { input: 1, output: 1 }, toolUses: [{ id: "extra-read", name: inspect.name, input: { pass: 3 } }] }
      : verifiedReceipt();
  });
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.task.status, "completed");
  assert.deepEqual(finalTools, ["task_checkpoint", "todo_write"]);
  assert.equal(result.sends, 1);
  assert.equal(result.reads, 2);
  assert.equal(result.requests, 5);
  assert.equal(result.progress.some((event) => event.state === "stopped"), false);
  assert.equal(result.text.join(""), "Fixture delivery verified.");
});

test("a hidden external action cannot be approved or repeated during no-progress finalization", async () => {
  const result = await runFixture((_request, { send }) => ({
    text: "", stop: "tool_use", usage: { input: 1, output: 1 },
    toolUses: [{ id: "repeat-send", name: send.name, input: {} }],
  }));
  assert.equal(result.sends, 1, "an advertised-tool filter must also be enforced before approval and dispatch");
  assert.equal(result.approvals, 1, "the denied close-out action never requests another approval");
  assert.equal(result.outcome.status, "halted");
  assert.equal(result.outcome.stopReason, "no_progress");
  assert.equal(result.task.status, "paused");
  assert.equal(result.requests, 5);
  const rejected = result.history.flatMap((message) => message.results ?? []).find((row) => row.id === "repeat-send");
  assert.match(rejected.content, /finalization.*NOT executed/i);
  assert.match(result.text.join(""), /paused.*not been verified/i, "missing evidence gets an honest paused handoff, never a completion claim");
});

test("finalization still rejects an empty completion receipt and pauses without repeating delivery", async () => {
  const response = verifiedReceipt();
  response.toolUses[0].input.completion.evidence = [];
  const result = await runFixture(() => response);
  assert.equal(result.sends, 1);
  assert.equal(result.requests, 5);
  assert.equal(result.outcome.status, "halted");
  assert.equal(result.task.status, "paused");
  assert.match(result.text.join(""), /paused.*not been verified/i);
  assert.equal(result.task.checkpoint.completion, undefined);
});
