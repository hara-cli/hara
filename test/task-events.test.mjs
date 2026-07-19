import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskExecution } from "../dist/session/task.js";
import { taskLifecycleEvent, TASK_LIFECYCLE_EVENT_VERSION } from "../dist/serve/task-events.js";

test("task lifecycle event separates durable running status from a temporary approval wait", () => {
  const task = createTaskExecution("ship the verified fix", "turn-1", "2026-07-19T12:00:00.000Z");
  const event = taskLifecycleEvent(
    "session-1",
    task,
    [
      { text: "Inspect", status: "done" },
      { text: "Publish", activeForm: "Publishing release", status: "in_progress", owner: "release" },
    ],
    {
      state: "waiting",
      phase: "approval",
      detail: " Waiting   for release approval ",
      approval: { id: "approval-1", question: "Allow publish?" },
    },
    "2026-07-19T12:01:00.000Z",
  );

  assert.equal(event.version, TASK_LIFECYCLE_EVENT_VERSION);
  assert.equal(event.state, "waiting");
  assert.equal(event.taskStatus, "running");
  assert.equal(event.phase, "approval");
  assert.deepEqual(event.checkpoint, {
    done: 1,
    total: 2,
    current: "Publishing release",
    owner: "release",
  });
  assert.deepEqual(event.approval, { id: "approval-1", question: "Allow publish?" });
  assert.equal(event.detail, "Waiting for release approval");
});

test("task lifecycle event defaults its runtime state to the durable task status", () => {
  const task = {
    ...createTaskExecution("answer the question", "turn-2", "2026-07-19T12:00:00.000Z"),
    status: "completed",
    lastOutcome: "completed",
    endedAt: "2026-07-19T12:01:00.000Z",
  };
  const event = taskLifecycleEvent("session-2", task, [], { phase: "finished" }, "2026-07-19T12:01:00.000Z");
  assert.equal(event.state, "completed");
  assert.equal(event.taskStatus, "completed");
  assert.equal(event.lastOutcome, "completed");
  assert.deepEqual(event.checkpoint, { done: 0, total: 0 });
});

test("a late runtime phase cannot resurrect a terminal task as running", () => {
  const task = {
    ...createTaskExecution("finished work", "turn-3", "2026-07-19T12:00:00.000Z"),
    status: "blocked",
    lastOutcome: "error",
    endedAt: "2026-07-19T12:01:00.000Z",
  };
  const event = taskLifecycleEvent(
    "session-3",
    task,
    [],
    { state: "running", phase: "thinking" },
    "2026-07-19T12:02:00.000Z",
  );
  assert.equal(event.state, "blocked");
  assert.equal(event.taskStatus, "blocked");
});
