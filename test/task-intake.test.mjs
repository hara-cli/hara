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
    async turn({ system, onText }) {
      systems.push(system);
      const result = turns[Math.min(index++, turns.length - 1)];
      if (result.text) onText?.(result.text);
      return result;
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
    {
      text: "",
      toolUses: [{
        id: "c1",
        name: "task_checkpoint",
        input: { completion: { state: "verified", evidence: ["the edit completed and targeted verification passed"] } },
      }],
      stop: "tool_use",
    },
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
        updateSawClosedRound ||= Boolean(
          tail?.role === "tool" &&
          tail.results.some((result) => result.name === "task_intake" && result.content.includes("Task brief accepted"))
        );
      },
      onCheckpoint(next) {
        task = next;
        const tail = history.at(-1);
        checkpointSawClosedRound ||= Boolean(
          tail?.role === "tool" &&
          tail.results.some((result) => result.name === "task_intake" && result.content.includes("Task brief accepted"))
        );
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

test("an accepted change task cannot end as advice when an authorized tool can act", async () => {
  const turn = newTurnInteraction();
  let task = createTaskExecution("apply the available change", turn.turnId);
  let edits = 0;
  const visible = [];
  const notices = [];
  const edit = {
    name: "fixture_owned_edit",
    description: "test-only authorized edit",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() {
      edits += 1;
      return "edited and verified";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    { text: "You can run the edit yourself with this command.", toolUses: [], stop: "end" },
    { text: "I'll handle the edit and verify it now.", toolUses: [{ id: "e1", name: edit.name, input: {} }], stop: "tool_use" },
    {
      text: "",
      toolUses: [{
        id: "c1",
        name: "task_checkpoint",
        input: { completion: { state: "verified", evidence: ["fixture edit returned edited and verified"] } },
      }],
      stop: "tool_use",
    },
    { text: "The requested change is verified.", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "apply the available change" }];
  const outcome = await runAgent(history, {
    provider: p,
    ctx: {
      cwd: process.cwd(),
      ui: {
        text: (value) => visible.push(value),
        reasoning: () => {},
        tool: () => {},
        diff: () => {},
        notice: (value) => notices.push(value),
      },
    },
    approval: "full-auto",
    confirm: async () => true,
    extraTools: [edit],
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
  assert.equal(outcome.status, "completed");
  assert.equal(edits, 1);
  assert.equal(task.checkpoint.completion.state, "verified");
  assert.doesNotMatch(visible.join(""), /run the edit yourself/);
  assert.match(visible.join(""), /I'll handle the edit/, "a tool-backed acknowledgement remains visible before execution");
  assert.match(visible.join(""), /requested change is verified/);
  assert.match(notices.join("\n"), /action ownership guard/);
  assert.doesNotMatch(JSON.stringify(history), /run the edit yourself/);
  assert.match(JSON.stringify(history), /Execution ownership correction/);
});

test("the action ownership guard fails closed when a model refuses to act twice", async () => {
  const turn = newTurnInteraction();
  let task = createTaskExecution("perform the available change", turn.turnId);
  let reads = 0;
  const read = {
    name: "fixture_ownership_read",
    description: "test-only read",
    input_schema: { type: "object", properties: {} },
    kind: "read",
    async run() {
      reads += 1;
      return "inspected current state";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "r1", name: read.name, input: {} }], stop: "tool_use" },
    { text: "Do it yourself.", toolUses: [], stop: "end" },
    { text: "Still do it yourself.", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "perform the available change" }];
  const outcome = await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [read],
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
  assert.equal(outcome.status, "error");
  assert.equal(reads, 1, "read-only investigation does not satisfy a change task's execution ownership");
  assert.match(outcome.error, /execution ownership guard/);
  assert.doesNotMatch(JSON.stringify(history), /Do it yourself|Still do it yourself/);
});

test("successful owned work is preserved when the model omits its completion receipt twice", async () => {
  const turn = newTurnInteraction();
  let task = createTaskExecution("save the requested records", turn.turnId);
  let writes = 0;
  const visible = [];
  const notices = [];
  const write = {
    name: "fixture_owned_write",
    description: "test-only write",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() {
      writes += 1;
      return "records saved successfully";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "w1", name: write.name, input: {} }], stop: "tool_use" },
    { text: "The records were saved successfully.", toolUses: [], stop: "end" },
    { text: "The records were saved successfully.", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "save the requested records" }];
  const outcome = await runAgent(history, {
    provider: p,
    ctx: {
      cwd: process.cwd(),
      ui: {
        text: (value) => visible.push(value),
        reasoning: () => {},
        tool: () => {},
        diff: () => {},
        notice: (value) => notices.push(value),
      },
    },
    approval: "full-auto",
    confirm: async () => true,
    extraTools: [write],
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

  assert.equal(outcome.status, "completed");
  assert.equal(writes, 1, "finished work is not repeated merely to satisfy a missing receipt");
  assert.equal(task.checkpoint.completion, undefined, "the engine never fabricates verified evidence");
  assert.match(notices.join("\n"), /completion receipt guard/);
  assert.match(notices.join("\n"), /resumable checkpoint/);
  assert.doesNotMatch(notices.join("\n"), /advice was not accepted|twice returned advice/);
  assert.equal(visible.join("").match(/records were saved successfully/gi)?.length, 1);
  assert.match(JSON.stringify(history), /Completion receipt correction/);
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

test("an investigate brief may render a web page while computer approval remains mandatory", async () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("inspect a JavaScript-rendered page", interaction.turnId);
  const accepted = applyTaskBrief(created, {
    ...BRIEF,
    intent: "investigate",
    goal: "read the rendered page without changing external or project state",
  });
  assert.equal(accepted.ok, true);
  let runs = 0;
  let confirmations = 0;
  const renderedFetch = {
    name: "fixture_rendered_fetch",
    description: "test-only isolated page renderer",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    kind: "read",
    classify() {
      return { effect: "read", concurrencySafe: false, approvalKind: "computer" };
    },
    async run() {
      runs += 1;
      return "rendered page text";
    },
  };
  const p = provider([
    {
      text: "",
      toolUses: [{ id: "render1", name: renderedFetch.name, input: { url: "https://example.com/app" } }],
      stop: "tool_use",
    },
    { text: "diagnosed", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "inspect the page" }];
  const outcome = await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => {
      confirmations += 1;
      return true;
    },
    quiet: true,
    extraTools: [renderedFetch],
    taskIntake: { task: accepted.task },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(runs, 1, "the read-only render is permitted by an investigate brief");
  assert.equal(confirmations, 1, "computer-use approval is never bypassed by read-only semantics");
  assert.doesNotMatch(JSON.stringify(history), /intent is 'investigate'/);
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

test("a bounded diagnostic probe runs under an investigate brief without granting mutation authority", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("check one endpoint", interaction.turnId);
  task = applyTaskBrief(task, {
    intent: "investigate",
    goal: "check one endpoint",
    constraints: ["do not change host state"],
    acceptance: ["probe result captured"],
    steps: ["run the bounded probe"],
    createdAt: "2026-08-17T00:00:00.000Z",
  });
  let probes = 0;
  const probe = {
    name: "fixture_probe",
    description: "test-only bounded diagnostic",
    input_schema: { type: "object", properties: {} },
    kind: "exec",
    classify() {
      return { effect: "probe", concurrencySafe: true, approvalKind: "exec" };
    },
    async run() {
      probes += 1;
      return "reachable";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "p1", name: probe.name, input: {} }], stop: "tool_use" },
    { text: "diagnosed", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "check the endpoint without changing anything" }];
  const outcome = await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [probe],
    taskIntake: { task },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(probes, 1);
  assert.doesNotMatch(JSON.stringify(history), /intent is 'investigate'/);
});

test("task_intake and a diagnostic probe in the same response cannot bypass the round boundary", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("check one endpoint", interaction.turnId);
  let probes = 0;
  const probe = {
    name: "fixture_same_round_probe",
    description: "test-only bounded diagnostic",
    input_schema: { type: "object", properties: {} },
    kind: "exec",
    classify() {
      return { effect: "probe", concurrencySafe: true, approvalKind: "exec" };
    },
    async run() {
      probes += 1;
      return "reachable";
    },
  };
  const investigateBrief = {
    ...BRIEF,
    intent: "investigate",
    goal: "check one endpoint",
  };
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "b1", name: "task_intake", input: investigateBrief },
        { id: "p0", name: probe.name, input: {} },
      ],
      stop: "tool_use",
    },
    { text: "", toolUses: [{ id: "p1", name: probe.name, input: {} }], stop: "tool_use" },
    { text: "diagnosed", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "check the endpoint without changing anything" }];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [probe],
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

  assert.equal(probes, 1, "same-response probe stayed blocked; the next-round probe ran");
  const firstToolRound = history.find((message) => message.role === "tool");
  assert.match(firstToolRound.results.find((result) => result.name === probe.name).content, /Wait for the next model round/);
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

test("task_checkpoint persists after a closed tool round and becomes the next round's authoritative state", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("inspect and publish", interaction.turnId, "2026-08-05T00:00:00.000Z");
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    {
      text: "",
      toolUses: [{
        id: "c1",
        name: "task_checkpoint",
        input: {
          current_step: "publish verified output",
          next_step: "read back the public artifact",
          artifacts: ["dist/result.json"],
          facts: [{ key: "checks_passed", value: 4, evidence: "four focused checks passed" }],
          capabilities: [{ name: "publish", state: "available", detail: "authenticated preflight succeeded" }],
        },
      }],
      stop: "tool_use",
    },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "inspect and publish" }];
  const checkpoints = [];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    taskIntake: {
      task,
      current: () => task,
      onUpdate(next) {
        task = next;
      },
      onCheckpoint(next) {
        const tail = history.at(-1);
        checkpoints.push({
          task: next,
          closed: tail?.role === "tool" && tail.results.some((result) => result.name === "task_checkpoint"),
        });
        task = next;
      },
    },
  });

  assert.equal(checkpoints.length, 2, "both the brief and structured state have durable boundaries");
  assert.equal(checkpoints[1].closed, true, "checkpoint persistence waits for its tool result to close the round");
  assert.equal(task.checkpoint.facts.checks_passed.value, 4);
  assert.equal(task.checkpoint.capabilities.publish.state, "available");
  assert.deepEqual(task.checkpoint.artifacts, ["dist/result.json"]);
  assert.match(p.systems.at(-1), /checks_passed = 4/);
  assert.match(p.systems.at(-1), /publish: available/);
  assert.match(p.systems.at(-1), /dist\/result\.json/);
});

test("serial task_intake and task_checkpoint updates in one tool round cannot overwrite each other", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("verify one result", interaction.turnId);
  const p = provider([
    {
      text: "",
      toolUses: [
        { id: "b1", name: "task_intake", input: BRIEF },
        {
          id: "c1",
          name: "task_checkpoint",
          input: { facts: [{ key: "verified", value: true, evidence: "readback matched" }] },
        },
      ],
      stop: "tool_use",
    },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "verify one result" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
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
  assert.equal(task.brief.goal, BRIEF.goal);
  assert.equal(task.checkpoint.facts.verified.value, true);
});

test("declared non-core capabilities must have one fixed preflight state before side effects", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("prepare a visual report", interaction.turnId);
  let edits = 0;
  const edit = {
    name: "fixture_capability_edit",
    description: "test-only report edit",
    input_schema: { type: "object", properties: {} },
    kind: "edit",
    async run() {
      edits++;
      return "edited";
    },
  };
  const brief = { ...BRIEF, required_capabilities: ["vision_model"] };
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: brief }], stop: "tool_use" },
    { text: "", toolUses: [{ id: "e0", name: edit.name, input: {} }], stop: "tool_use" },
    {
      text: "",
      toolUses: [{
        id: "c1",
        name: "task_checkpoint",
        input: { capabilities: [{ name: "vision_model", state: "unavailable", detail: "model route has no image input" }] },
      }],
      stop: "tool_use",
    },
    { text: "", toolUses: [{ id: "e1", name: edit.name, input: {} }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  const history = [{ role: "user", content: "prepare a visual report" }];
  await runAgent(history, {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [edit],
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

  assert.equal(edits, 1, "the edit before preflight was denied and the post-preflight safe partial path ran");
  assert.deepEqual(task.brief.requiredCapabilities, ["vision_model"]);
  assert.equal(task.checkpoint.capabilities.vision_model.state, "unavailable");
  const denied = history.find((message) =>
    message.role === "tool" && message.results.some((result) => result.id === "e0"));
  assert.match(denied.results.find((result) => result.id === "e0").content, /Capability preflight gate/);
});

test("a later tool call invalidates an early completion receipt", async () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("inspect then finish", interaction.turnId);
  let reads = 0;
  const inspect = {
    name: "fixture_receipt_read",
    description: "test-only read after receipt",
    input_schema: { type: "object", properties: {} },
    kind: "read",
    async run() {
      reads += 1;
      return "new evidence discovered";
    },
  };
  const p = provider([
    { text: "", toolUses: [{ id: "b1", name: "task_intake", input: BRIEF }], stop: "tool_use" },
    {
      text: "",
      toolUses: [{
        id: "c1",
        name: "task_checkpoint",
        input: { completion: { state: "verified", evidence: ["an earlier check passed"] } },
      }],
      stop: "tool_use",
    },
    { text: "", toolUses: [{ id: "r1", name: inspect.name, input: {} }], stop: "tool_use" },
    { text: "done", toolUses: [], stop: "end" },
  ]);
  await runAgent([{ role: "user", content: "inspect then finish" }], {
    provider: p,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [inspect],
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
  assert.equal(reads, 1);
  assert.equal(task.checkpoint.completion, undefined, "work after attestation requires a new final receipt");
});
