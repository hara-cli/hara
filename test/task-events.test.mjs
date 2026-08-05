import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTaskCheckpoint, createTaskExecution } from "../dist/session/task.js";
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
    { streamId: "serve-1", sequence: 7 },
    "2026-07-19T12:01:00.000Z",
  );

  assert.equal(event.version, TASK_LIFECYCLE_EVENT_VERSION);
  assert.equal(event.streamId, "serve-1");
  assert.equal(event.sequence, 7);
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
  const event = taskLifecycleEvent(
    "session-2",
    task,
    [],
    { phase: "finished" },
    { streamId: "serve-1", sequence: 8 },
    "2026-07-19T12:01:00.000Z",
  );
  assert.equal(event.state, "completed");
  assert.equal(event.taskStatus, "completed");
  assert.equal(event.lastOutcome, "completed");
  assert.deepEqual(event.checkpoint, { done: 0, total: 0 });
});

test("task lifecycle event projects the same persisted blocker, facts, capabilities, and artifacts used on resume", () => {
  const task = createTaskExecution("publish verified output", "turn-state", "2026-08-05T00:00:00.000Z");
  const applied = applyTaskCheckpoint(task, {
    current_step: "publish manifest",
    blocked_step: "publish manifest",
    block_reason: "approval is pending",
    next_step: "approve and retry once",
    artifacts: ["dist/manifest.json"],
    facts: [{ key: "assets_verified", value: 16, evidence: "all digests matched" }],
    capabilities: [{ name: "upload", state: "blocked", detail: "waiting for approval" }],
  }, "2026-08-05T00:01:00.000Z");
  assert.equal(applied.ok, true);
  const event = taskLifecycleEvent(
    "session-state",
    applied.task,
    [],
    { state: "waiting", phase: "approval" },
    { streamId: "serve-1", sequence: 81 },
    "2026-08-05T00:02:00.000Z",
  );
  assert.deepEqual(event.checkpoint, {
    done: 0,
    total: 0,
    current: "publish manifest",
    blockedStep: "publish manifest",
    blockReason: "approval is pending",
    nextStep: "approve and retry once",
    artifacts: ["dist/manifest.json"],
    facts: { assets_verified: 16 },
    capabilities: { upload: { state: "blocked", detail: "waiting for approval" } },
  });
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
    { streamId: "serve-1", sequence: 9 },
    "2026-07-19T12:02:00.000Z",
  );
  assert.equal(event.state, "blocked");
  assert.equal(event.taskStatus, "blocked");
});

test("task lifecycle cursors fail closed when ordering metadata is invalid", () => {
  const task = createTaskExecution("ordered work", "turn-4", "2026-07-19T12:00:00.000Z");
  assert.throws(
    () => taskLifecycleEvent(
      "session-4",
      task,
      [],
      { phase: "starting" },
      { streamId: " ", sequence: 1 },
    ),
    /streamId/,
  );
  assert.throws(
    () => taskLifecycleEvent(
      "session-4",
      task,
      [],
      { phase: "starting" },
      { streamId: "serve-1", sequence: 0 },
    ),
    /sequence/,
  );
});
