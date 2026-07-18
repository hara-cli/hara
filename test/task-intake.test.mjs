import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import {
  applyTaskBrief,
  createTaskExecution,
  newTurnInteraction,
  recordTaskSteering,
  taskExecutionContext,
} from "../dist/session/task.js";

const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), "hara-task-intake-home-"));
process.env.HOME = TEST_HOME;
after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function provider(turns) {
  let index = 0;
  const systems = [];
  return {
    id: "intake-fixture",
    model: "intake-fixture",
    systems,
    async turn({ system }) {
      systems.push(system);
      return turns[Math.min(index++, turns.length - 1)];
    },
  };
}

const BRIEF = {
  intent: "change",
  goal: "update the requested file without touching unrelated work",
  constraints: ["preserve unrelated user changes"],
  acceptance: ["the edit tool completes", "targeted verification passes"],
  steps: ["inspect relevant context", "apply the edit", "verify the result"],
};

test("understanding gate blocks a direct edit, checkpoints task_intake, then permits execution", async () => {
  const turn = newTurnInteraction();
  let task = createTaskExecution("fix the parser", turn.turnId);
  let editRuns = 0;
  let checkpointSawClosedRound = false;
  let updateSawClosedRound = false;
  const edit = {
    name: "fixture_edit",
    description: "test-only edit",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    kind: "edit",
    async run() {
      editRuns += 1;
      return "edited";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "e0", name: edit.name, input: { path: "a.ts" } }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "e1", name: edit.name, input: { path: "a.ts" } }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "fix the parser" }];
  const outcome = await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [edit],
    taskIntake: {
      task,
      onUpdate(next) {
        task = next;
        const tail = history.at(-1);
        updateSawClosedRound =
          tail?.role === "tool" &&
          tail.results.some((result) => result.name === "task_intake" && result.content.includes("Task brief accepted"));
      },
      onCheckpoint(next) {
        task = next;
        const tail = history.at(-1);
        checkpointSawClosedRound =
          tail?.role === "tool" &&
          tail.results.some((result) => result.name === "task_intake" && result.content.includes("Task brief accepted"));
      },
    },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(editRuns, 1, "the pre-brief edit was blocked; only the post-brief edit ran");
  assert.equal(task.brief.intent, "change");
  assert.equal(task.brief.goal, BRIEF.goal);
  assert.equal(updateSawClosedRound, true, "the owner sees a new brief only after its tool result closes the round");
  assert.equal(checkpointSawClosedRound, true, "checkpoint happens after the task_intake tool result closes the protocol round");
  assert.match(JSON.stringify(history), /Understanding gate: this action was NOT executed/);
  assert.match(p.systems[0], /Do not jump from a raw request straight into side effects/);
  assert.match(p.systems.at(-1), /The task brief below is the accepted interpretation/);
});

test("task_intake and an edit in the same model response cannot bypass the round boundary", async () => {
  const turn = newTurnInteraction();
  let task = createTaskExecution("change one file", turn.turnId);
  let editRuns = 0;
  const edit = {
    name: "fixture_same_round_edit",
    description: "test-only edit",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() {
      editRuns += 1;
      return "edited";
    },
  };
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "b1", name: "task_intake", input: BRIEF },
        { id: "e0", name: edit.name, input: {} },
      ],
      stop: "tool_use",
    },
    { text: "", toolUses: [{ id: "e1", name: edit.name, input: {} }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "change one file" }];
  const checkpoints = [];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [edit],
    taskIntake: {
      task,
      onUpdate(next) {
        task = next;
      },
      onCheckpoint(next) {
        task = next;
        checkpoints.push(history.length);
      },
    },
  });

  assert.equal(editRuns, 1, "same-response edit stayed blocked; the next-round edit ran");
  assert.deepEqual(checkpoints.length, 1);
  const firstToolRound = history.find((message) => message.role === "tool");
  assert.ok(firstToolRound.results.find((result) => result.name === edit.name)?.isError);
});

test("revising an existing change brief cannot inherit its permission for a same-round side effect", async () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("change one file", interaction.turnId);
  const initial = applyTaskBrief(created, BRIEF);
  assert.equal(initial.ok, true);
  let task = initial.task;
  let editRuns = 0;
  const edit = {
    name: "fixture_revision_edit",
    description: "test-only edit",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() {
      editRuns += 1;
      return "edited";
    },
  };
  const revisedBrief = {
    ...BRIEF,
    intent: "investigate",
    goal: "new read-only diagnosis",
  };
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "b1", name: "task_intake", input: revisedBrief },
        { id: "e0", name: edit.name, input: {} },
      ],
      stop: "tool_use",
    },
    { text: "diagnosed", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "diagnose instead" }];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [edit],
    taskIntake: {
      task,
      onUpdate(next) {
        task = next;
      },
      onCheckpoint(next) {
        task = next;
      },
    },
  });

  assert.equal(editRuns, 0, "the old change brief cannot authorize an edit beside its own revision");
  assert.equal(task.brief.intent, "investigate");
  assert.equal(task.brief.goal, revisedBrief.goal);
  const resultRound = history.find((message) => message.role === "tool");
  assert.match(resultRound.results.find((result) => result.name === edit.name).content, /Wait for the next model round/);
});

test("a revised brief replaces the old brief in the next model prompt instead of being duplicated", async () => {
  const interaction = newTurnInteraction();
  const oldGoal = "OLD interpretation that must disappear";
  const newGoal = "NEW authoritative interpretation";
  const created = createTaskExecution("revise the plan", interaction.turnId);
  const initial = applyTaskBrief(created, { ...BRIEF, goal: oldGoal });
  assert.equal(initial.ok, true);
  let task = initial.task;
  const p = provider([
    {
      text: "",
      toolUses: [{ id: "b1", name: "task_intake", input: { ...BRIEF, goal: newGoal } }],
      stop: "tool_use",
    },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "revise the plan" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    executionContext: taskExecutionContext(task, interaction),
    taskIntake: {
      task,
      onUpdate(next) {
        task = next;
      },
      onCheckpoint(next) {
        task = next;
      },
    },
  });

  assert.match(p.systems[0], new RegExp(oldGoal));
  assert.doesNotMatch(p.systems[1], new RegExp(oldGoal));
  assert.match(p.systems[1], new RegExp(newGoal));
});

test("a persisted change brief survives resume and opens the side-effect gate without reclassification", async () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("ship the fix", interaction.turnId);
  const accepted = applyTaskBrief(created, BRIEF, "2026-07-18T00:00:00.000Z");
  assert.equal(accepted.ok, true);
  let runs = 0;
  const edit = {
    name: "fixture_resumed_edit",
    description: "test-only edit",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() {
      runs += 1;
      return "ok";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "e1", name: edit.name, input: {} }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "continue" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [edit],
    taskIntake: { task: accepted.task },
  });
  assert.equal(runs, 1);
  assert.match(p.systems[0], /Intent: change/);
  assert.match(p.systems[0], /Goal: update the requested file/);
});

test("an investigate brief may inspect with a read-only command but cannot mutate through an allowed exec path", async () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("diagnose repository state", interaction.turnId);
  const accepted = applyTaskBrief(created, {
    ...BRIEF,
    intent: "investigate",
    goal: "inspect the repository without changing it",
  });
  assert.equal(accepted.ok, true);
  const commands = [];
  const shell = {
    name: "fixture_shell",
    description: "test-only shell boundary",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    kind: "exec",
    async run(input) {
      commands.push(input.command);
      return "ok";
    },
  };
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "read1", name: shell.name, input: { command: "git status --short" } },
        { id: "write1", name: shell.name, input: { command: "git commit --allow-empty -m test" } },
        { id: "bg1", name: shell.name, input: { command: "git status --short", background: true } },
        { id: "bg2", name: shell.name, input: { command: "git status --short", background: "true" } },
      ],
      stop: "tool_use",
    },
    { text: "diagnosed", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "diagnose repository state" }];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [shell],
    taskIntake: { task: accepted.task },
  });

  assert.deepEqual(commands, ["git status --short"], "only the semantically read-only command ran");
  const resultRound = history.find((message) => message.role === "tool");
  assert.match(resultRound.results.find((result) => result.id === "write1").content, /intent is 'investigate'/);
  assert.match(resultRound.results.find((result) => result.id === "bg1").content, /intent is 'investigate'/);
  assert.match(resultRound.results.find((result) => result.id === "bg2").content, /intent is 'investigate'/);
});

test("read-only actions inside mixed task and cron tools remain available for investigation", async () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("inspect task and scheduler state", interaction.turnId);
  const calls = [];
  const taskTool = {
    name: "task",
    description: "test-only mixed task tool",
    input_schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    kind: "edit",
    async run(input) {
      calls.push(`task:${input.action}`);
      return "tasks listed";
    },
  };
  const cronTool = {
    name: "cronjob",
    description: "test-only mixed cron tool",
    input_schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    kind: "exec",
    async run(input) {
      calls.push(`cronjob:${input.action}`);
      return "cron jobs listed";
    },
  };
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "tasks", name: taskTool.name, input: { action: "list" } },
        { id: "cron", name: cronTool.name, input: { action: "list" } },
      ],
      stop: "tool_use",
    },
    { text: "reported", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "inspect state" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [taskTool, cronTool],
    taskIntake: { task },
  });

  assert.deepEqual(calls.sort(), ["cronjob:list", "task:list"], "list operations are evidence gathering even before a brief exists");
});

test("stopping a background job is a state change even when the job tool is classified read-only", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("stop the stuck background process", interaction.turnId);
  let killRuns = 0;
  const job = {
    name: "job",
    description: "test-only background process control",
    input_schema: {
      type: "object",
      properties: { action: { type: "string" }, id: { type: "string" } },
      required: ["action", "id"],
    },
    // Job status/list operations are read-only, but action=kill is a state transition.
    kind: "read",
    async run() {
      killRuns += 1;
      return "stopped";
    },
  };
  const kill = { action: "kill", id: "fixture-job" };
  const p = provider([
    { text: "", toolUses: [{ id: "k0", name: job.name, input: kill }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "k1", name: job.name, input: kill }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "stop the stuck background process" }];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [job],
    taskIntake: {
      task,
      onUpdate(next) {
        task = next;
      },
      onCheckpoint(next) {
        task = next;
      },
    },
  });

  assert.equal(killRuns, 1, "the kill before task_intake was blocked; only the accepted change ran");
  const firstToolRound = history.find((message) => message.role === "tool");
  assert.match(firstToolRound.results.find((result) => result.id === "k0").content, /Understanding gate/);
});

test("a revised brief and steering accepted while another intake-round read settles both survive the checkpoint", async () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("fix the task router", interaction.turnId);
  const initial = applyTaskBrief(created, {
    ...BRIEF,
    goal: "old interpretation that must be revised",
  });
  assert.equal(initial.ok, true);
  let task = initial.task;
  let readRuns = 0;
  const steeringRead = {
    name: "fixture_steering_read",
    description: "test-only read that simulates input acknowledged during the tool round",
    input_schema: { type: "object", properties: {} },
    kind: "read",
    async run() {
      readRuns += 1;
      const steered = recordTaskSteering(task, interaction.turnId, "also preserve the same-round correction");
      assert.equal(steered.ok, true);
      task = steered.task;
      return "inspected";
    },
  };
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "b1", name: "task_intake", input: BRIEF },
        { id: "r1", name: steeringRead.name, input: {} },
      ],
      stop: "tool_use",
    },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "fix the task router" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [steeringRead],
    taskIntake: {
      task,
      current: () => task,
      onUpdate(next) {
        task = next;
      },
      onCheckpoint(next) {
        task = next;
      },
    },
  });

  assert.equal(readRuns, 1);
  assert.equal(task.brief.goal, BRIEF.goal);
  assert.equal(task.steering.length, 1);
  assert.equal(task.steering[0].content, "also preserve the same-round correction");
});

test("task_intake refreshes authoritative steering state instead of overwriting a mid-turn user update", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("fix the task router", interaction.turnId);
  let injected = false;
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "fix the task router" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    pendingInput: async () => {
      if (injected) return [];
      injected = true;
      const steered = recordTaskSteering(task, interaction.turnId, "also preserve the queued correction");
      assert.equal(steered.ok, true);
      task = steered.task;
      return [{ role: "user", content: "also preserve the queued correction" }];
    },
    taskIntake: {
      task,
      current: () => task,
      onUpdate(next) {
        task = next;
      },
    },
  });
  assert.equal(task.brief.goal, BRIEF.goal);
  assert.equal(task.steering.length, 1, "the accepted steering audit survives the later immutable brief update");
  assert.equal(task.steering[0].content, "also preserve the queued correction");
});
