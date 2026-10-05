import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent/loop.js";
import { INTERJECT_PREFIX } from "../dist/agent/reminders.js";
import {
  consumePendingTaskSteering,
  createTaskExecution,
  newTurnInteraction,
  recordTaskSteering,
} from "../dist/session/task.js";
import { loadSession, newSessionId, saveSession } from "../dist/session/store.js";

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const fixtureHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-carried-steering-")));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(fixtureHome, { recursive: true, force: true });
});

test("write-ahead steering appended by the host cancels carried actions when pendingInput returns []", async () => {
  const turn = newTurnInteraction();
  let task = createTaskExecution("Update the mock parser", turn.turnId);
  const history = [{ role: "user", content: "Update the mock parser" }];
  const meta = {
    id: newSessionId(),
    cwd: fixtureHome,
    provider: "carried-steering-fixture",
    model: "carried-steering-fixture",
    title: "carried steering fixture",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  const brief = {
    intent: "change",
    goal: "Update the mock parser",
    constraints: ["mock tools only"],
    acceptance: ["the mock parser check passes"],
    steps: ["update the parser", "verify the parser"],
  };
  const steerText = "Stop; do not edit the parser. Explain the current behavior only.";
  const steerContent = `${INTERJECT_PREFIX}\n\n${steerText}`;
  let edits = 0;
  let steeringRecorded = false;
  let calls = 0;
  const requests = [];
  const snapshots = [];
  const edit = {
    name: "fixture_carried_edit",
    description: "mock edit",
    kind: "edit",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run() {
      edits += 1;
      return "edited the mock parser";
    },
  };
  const responses = [
    {
      text: "",
      toolUses: [
        { id: "brief", name: "task_intake", input: brief },
        { id: "carried-edit", name: edit.name, input: { path: "parser.ts" } },
      ],
      stop: "tool_use",
    },
    {
      text: "",
      toolUses: [{
        id: "revised-brief",
        name: "task_intake",
        input: { ...brief, intent: "investigate", goal: "Explain the current parser behavior without editing" },
      }],
      stop: "tool_use",
    },
    {
      text: "",
      toolUses: [{
        id: "receipt",
        name: "task_checkpoint",
        input: { completion: { state: "verified", evidence: ["the mock context explains the current parser"], final_answer: "Stopped as requested; no edit was made." } },
      }],
      stop: "tool_use",
    },
  ];
  const provider = {
    id: meta.provider,
    model: meta.model,
    async turn({ history: requestHistory }) {
      requests.push(structuredClone(requestHistory));
      assert.ok(calls < responses.length, "no extra provider request is needed");
      return responses[calls++];
    },
  };
  saveSession(meta, history, task);
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: fixtureHome },
    approval: "full-auto",
    approvalChannel: false,
    confirm: async () => true,
    quiet: true,
    hooks: false,
    extraTools: [edit],
    maxRounds: 6,
    taskIntake: {
      task,
      current: () => task,
      onUpdate(next) { task = next; },
      onCheckpoint(next) {
        task = next;
        saveSession(meta, history, task);
        if (!steeringRecorded) {
          steeringRecorded = true;
          const recorded = recordTaskSteering(task, task.turnId, steerText);
          assert.equal(recorded.ok, true);
          task = recorded.task;
          saveSession(meta, history, task);
        }
      },
    },
    pendingInput: async () => {
      const consumed = consumePendingTaskSteering(task);
      if (!consumed) return [];
      const messages = consumed.entries.map((entry) => ({ role: "user", content: `${INTERJECT_PREFIX}\n\n${entry.content}` }));
      // CLI and Serve save the consumed inbox together with the projected transcript before mutating
      // their shared history. They return [] so runAgent does not append the same steering twice.
      saveSession(meta, [...history, ...messages], consumed.task);
      snapshots.push(loadSession(meta.id));
      task = consumed.task;
      history.push(...messages);
      return [];
    },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(edits, 0, "calls issued before the user's steering must be discarded");
  assert.equal(calls, 3);
  assert.equal(requests[1].filter((message) => message.role === "user" && message.content === steerContent).length, 1);
  assert.equal(history.filter((message) => message.role === "user" && message.content === steerContent).length, 1);
  assert.equal(task.steering[0].deliveryState, "consumed");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].history.filter((message) => message.role === "user" && message.content === steerContent).length, 1);
  assert.equal(snapshots[0].task.steering[0].deliveryState, "consumed");
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (message.role !== "assistant" || message.toolUses.length === 0) continue;
    assert.equal(history[index + 1].role, "tool", "every persisted tool round is closed before steering");
    assert.deepEqual(history[index + 1].results.map((result) => result.id), message.toolUses.map((toolUse) => toolUse.id));
    assert.equal(message.toolUses.some((toolUse) => toolUse.id === "carried-edit"), false, "the discarded call never becomes a persisted round");
  }
});
