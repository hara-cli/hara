import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentProgressWatchdog,
  REPEATED_SUCCESSFUL_CALL_STOP,
  normalizeProgressObservation,
  progressObservationSimilarity,
} from "../dist/agent/progress-watchdog.js";
import { applyTaskCheckpoint, createTaskExecution } from "../dist/session/task.js";

function round(overrides = {}) {
  return {
    observations: [],
    toolCalls: 1,
    substantive: true,
    userIntervened: false,
    todos: [],
    ...overrides,
  };
}

test("progress similarity ignores only volatile transport values", () => {
  const left = "upload attempt 41 completed at 2026-09-08T10:00:01Z request_id=6ba7b810-9dad-11d1-80b4-00c04fd430c8; artifact is still pending";
  const right = "upload attempt 42 completed at 2026-09-08T10:00:09Z request_id=123e4567-e89b-12d3-a456-426614174000; artifact is still pending";
  const changed = "upload completed and the signed artifact checksum now matches the release manifest";
  assert.ok(progressObservationSimilarity(left, right) >= 0.8);
  assert.ok(progressObservationSimilarity(left, changed) < 0.8);
  assert.match(normalizeProgressObservation(left), /attempt=<volatile>/);
  assert.match(normalizeProgressObservation(left), /request_id=<uuid>/);
  assert.equal(progressObservationSimilarity("state-1", "state-2"), 0, "short counters remain progress signals");
  assert.equal(
    progressObservationSimilarity(
      "Upload progress: 10% complete. The signed artifact is being transferred and validation remains pending.",
      "Upload progress: 45% complete. The signed artifact is being transferred and validation remains pending.",
    ),
    0,
    "a changed explicit progress metric is not hidden by otherwise similar prose",
  );
});

test("four unchanged successful calls stop without waiting for a general round limit", () => {
  const watchdog = new AgentProgressWatchdog({ unattended: false });
  let decision;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    decision = watchdog.recordRound(round({
      observations: [{ name: "probe", input: { target: "same" }, content: "The remote artifact is still unchanged and no new evidence is available." }],
    }));
  }
  assert.equal(decision.stop, true);
  assert.equal(decision.state.trigger, "repeated_tool_call");
  assert.equal(decision.state.repeatedCount, 4);
  assert.equal(decision.state.toolCalls, 4);
});

test("progress receipts never expose an unsafe provider-authored tool name", () => {
  const watchdog = new AgentProgressWatchdog({ unattended: true });
  const secretLikeName = "read_file --token sk-progress-secret-1234567890";
  let decision;
  for (let round = 0; round < REPEATED_SUCCESSFUL_CALL_STOP; round += 1) {
    decision = watchdog.recordRound({
      observations: [{ name: secretLikeName, input: { path: "stable.txt" }, content: "same safe result" }],
      toolCalls: 1,
      substantive: true,
      userIntervened: false,
      todos: [],
    });
  }
  assert.equal(decision.stop, true);
  assert.equal(decision.state.repeatedTool, "tool");
  assert.equal(JSON.stringify(decision.state).includes("sk-progress-secret"), false);
});

test("a changing explicit progress counter keeps a healthy poll out of the similarity stop", () => {
  const watchdog = new AgentProgressWatchdog({ unattended: false });
  let decision;
  for (const percent of [10, 25, 40, 55, 70, 85]) {
    decision = watchdog.recordRound(round({
      observations: [{
        name: "deployment_status",
        input: { deployment: "same" },
        content: `Upload progress: ${percent}% complete. The signed artifact is being transferred and validation remains pending.`,
      }],
    }));
    assert.equal(decision.stop, false);
  }
  assert.equal(decision.state.evidenceStaleRounds, 0);
});

test("unattended work pauses at eight rounds without a durable checkpoint", () => {
  const watchdog = new AgentProgressWatchdog({ unattended: true });
  let decision;
  for (let currentRound = 1; currentRound <= 8; currentRound += 1) {
    decision = watchdog.recordRound(round({
      observations: [{ name: `probe_${currentRound}`, input: { currentRound }, content: `state-${currentRound}` }],
    }));
    if (currentRound === 5) assert.equal(decision.warn, true);
    if (currentRound < 8) assert.equal(decision.stop, false);
  }
  assert.equal(decision.stop, true);
  assert.equal(decision.state.trigger, "unattended_without_checkpoint");
  assert.equal(decision.state.checkpointStaleRounds, 8);
});

test("rewriting the same checkpoint does not reset stale progress", () => {
  const created = createTaskExecution("verify one artifact", "progress-duplicate-checkpoint");
  const saved = applyTaskCheckpoint(created, {
    facts: [{ key: "artifact_state", value: "pending", evidence: "first observation" }],
  });
  assert.equal(saved.ok, true);
  const watchdog = new AgentProgressWatchdog({ unattended: true, task: saved.task });
  let task = saved.task;
  for (let currentRound = 1; currentRound <= 7; currentRound += 1) {
    const duplicate = applyTaskCheckpoint(task, {
      facts: [{ key: "artifact_state", value: "pending", evidence: "first observation" }],
    });
    assert.equal(duplicate.ok, true);
    task = duplicate.task;
    const decision = watchdog.recordRound(round({ task }));
    assert.equal(decision.state.checkpointAdvanced, false);
    assert.equal(decision.stop, false);
  }
  const stopped = watchdog.recordRound(round({ task }));
  assert.equal(stopped.stop, true);
  assert.equal(stopped.state.trigger, "unattended_without_checkpoint");
});

test("new checkpoint evidence breaks similar receipts and lets healthy long work continue", () => {
  let task = createTaskExecution("collect verified artifacts", "progress-real-checkpoints");
  const watchdog = new AgentProgressWatchdog({ unattended: true, task });
  for (let currentRound = 1; currentRound <= 16; currentRound += 1) {
    if (currentRound % 4 === 0) {
      const updated = applyTaskCheckpoint(task, {
        facts: [{
          key: `artifact_${currentRound}`,
          value: "verified",
          evidence: `checksum receipt ${currentRound}`,
        }],
      });
      assert.equal(updated.ok, true);
      task = updated.task;
    }
    const decision = watchdog.recordRound(round({
      task,
      observations: [{
        name: currentRound % 4 === 0 ? "task_checkpoint" : "probe",
        input: currentRound % 4 === 0 ? { fact: currentRound } : { target: "artifact" },
        content: currentRound % 4 === 0
          ? "Task checkpoint saved successfully."
          : "The bounded artifact probe completed with the same receipt shape.",
      }],
    }));
    assert.equal(decision.stop, false, `round ${currentRound} should retain verified progress`);
    if (currentRound % 4 === 0) {
      assert.equal(decision.state.checkpointAdvanced, true);
      assert.equal(decision.state.evidenceStaleRounds, 0);
    }
  }
});

test("a live user steer starts a fresh unattended window", () => {
  const watchdog = new AgentProgressWatchdog({ unattended: true });
  for (let currentRound = 1; currentRound <= 7; currentRound += 1) {
    assert.equal(watchdog.recordRound(round({ observations: [{ name: `before_${currentRound}`, input: {}, content: `before-${currentRound}` }] })).stop, false);
  }
  const steered = watchdog.recordRound(round({
    userIntervened: true,
    observations: [{ name: "steered", input: {}, content: "new-user-direction" }],
  }));
  assert.equal(steered.stop, false);
  assert.equal(steered.state.unattendedRounds, 0);
  for (let currentRound = 1; currentRound <= 7; currentRound += 1) {
    assert.equal(watchdog.recordRound(round({ observations: [{ name: `after_${currentRound}`, input: {}, content: `after-${currentRound}` }] })).stop, false);
  }
  const stopped = watchdog.recordRound(round({ observations: [{ name: "after_8", input: {}, content: "after-8" }] }));
  assert.equal(stopped.stop, true);
  assert.equal(stopped.state.trigger, "unattended_without_checkpoint");
});

test("an unattended 200k-token run pauses early when durable state does not advance", () => {
  const watchdog = new AgentProgressWatchdog({ unattended: true, usage: { input: 1_000, output: 500 } });
  let decision;
  for (let currentRound = 1; currentRound <= 4; currentRound += 1) {
    decision = watchdog.recordRound(round({
      observations: [{ name: `large_${currentRound}`, input: {}, content: `state-${currentRound}` }],
      usage: { input: 1_000 + currentRound * 40_000, output: 500 + currentRound * 10_000 },
    }));
  }
  assert.equal(decision.stop, true);
  assert.equal(decision.state.trigger, "unattended_token_budget");
  assert.equal(decision.state.tokens.total, 200_000);
});
