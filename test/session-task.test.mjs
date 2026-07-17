import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TASK_STEERING_ENTRIES,
  continueTaskExecution,
  consumePendingTaskSteering,
  createTaskExecution,
  finishTaskExecution,
  forkTaskExecution,
  isTaskExecution,
  newSteerInteraction,
  newTurnInteraction,
  recordTaskSteering,
  requestsTaskContinuation,
  recoverTaskExecution,
  taskExecutionContext,
} from "../dist/session/task.js";
import { loadSession, newSessionId, saveSession } from "../dist/session/store.js";

test("task execution keeps the original objective across turns and steering", () => {
  const first = newTurnInteraction();
  let task = createTaskExecution("implement the file boundary", first.turnId, "2026-07-15T00:00:00.000Z");
  const steered = recordTaskSteering(task, first.turnId, "also cover symlinks", "2026-07-15T00:01:00.000Z");
  assert.equal(steered.ok, true);
  task = steered.task;
  assert.equal(task.objective, "implement the file boundary");

  const next = newSteerInteraction(first.turnId);
  const continued = continueTaskExecution(task, next, "2026-07-15T00:02:00.000Z");
  assert.equal(continued.ok, true);
  assert.equal(continued.task.objective, "implement the file boundary");
  assert.equal(continued.task.turnId, next.turnId);
  assert.match(taskExecutionContext(continued.task, next), /Objective: implement the file boundary/);
});

test("task execution context restores the bounded checklist as an immediate recovery cursor", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("ship migration", interaction.turnId);
  const context = taskExecutionContext(task, interaction, [
    { text: "edit schema", status: "done" },
    { text: "run migration test", status: "in_progress" },
    { text: "deploy", status: "pending" },
  ]);
  assert.match(context, /Persisted execution checkpoint/);
  assert.match(context, /\[done\] edit schema/);
  assert.match(context, /\[in progress\] run migration test/);
  assert.match(context, /first unfinished item/);
});

test("task steering rejects stale turn identity", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("fix it", interaction.turnId);
  const stale = recordTaskSteering(task, "old-turn", "do something else");
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale steer/);
});

test("task execution recovery pauses an interrupted run and never claims completion", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("finish the release", interaction.turnId, "2026-07-15T00:00:00.000Z");
  const recovered = recoverTaskExecution(task, "2026-07-15T00:10:00.000Z");
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.lastOutcome, "interrupted");
});

test("task completion remains paused while durable todos are unfinished", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("finish the release", interaction.turnId);
  const paused = finishTaskExecution(task, { status: "completed" }, [{ text: "publish", status: "pending" }]);
  assert.equal(paused.status, "paused");
  const completed = finishTaskExecution(task, { status: "completed" }, [{ text: "publish", status: "done" }]);
  assert.equal(completed.status, "completed");
});

test("a total deadline is a resumable pause while loop breakers remain blocked", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("finish the long task", interaction.turnId);
  const deadline = finishTaskExecution(task, { status: "halted", stopReason: "deadline", error: "deadline" });
  assert.equal(deadline.status, "paused");
  assert.equal(deadline.lastOutcome, "halted");

  const loop = finishTaskExecution(task, { status: "halted", stopReason: "repeat_loop", error: "loop" });
  assert.equal(loop.status, "blocked");
});

test("task steering audit is bounded", () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("bounded audit", interaction.turnId);
  for (let index = 0; index < MAX_TASK_STEERING_ENTRIES + 5; index++) {
    const result = recordTaskSteering(task, interaction.turnId, `steer ${index}`);
    assert.equal(result.ok, true);
    const consumed = consumePendingTaskSteering(result.task, `2026-07-15T00:${String(index).padStart(2, "0")}:30.000Z`);
    assert.ok(consumed);
    task = consumed.task;
  }
  assert.equal(task.steering.length, MAX_TASK_STEERING_ENTRIES);
  assert.equal(task.steering.at(-1).content, `steer ${MAX_TASK_STEERING_ENTRIES + 4}`);
  assert.equal(isTaskExecution(task), true);
});

test("task steering is a durable, exactly-once inbox and legacy audit entries never replay", () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("ship it", interaction.turnId, "2026-07-15T00:00:00.000Z");
  task.steering = [{ id: "legacy", turnId: interaction.turnId, content: "already handled", createdAt: "2026-07-15T00:00:10.000Z" }];
  const recorded = recordTaskSteering(task, interaction.turnId, "also add a recovery test", "2026-07-15T00:01:00.000Z");
  assert.equal(recorded.ok, true);
  assert.equal(recorded.task.steering.at(-1).deliveryState, "pending");

  const consumed = consumePendingTaskSteering(recorded.task, "2026-07-15T00:02:00.000Z");
  assert.ok(consumed);
  assert.deepEqual(consumed.entries.map((entry) => entry.content), ["also add a recovery test"]);
  assert.equal(consumed.task.steering[0].deliveryState, undefined, "legacy entry stays audit-only");
  assert.equal(consumed.task.steering.at(-1).deliveryState, "consumed");
  assert.equal(consumePendingTaskSteering(consumed.task), null, "a consumed entry cannot be delivered twice");
  assert.equal(isTaskExecution(consumed.task), true);
});

test("fork copies steering audit but never duplicates executable pending ownership", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("source task", interaction.turnId, "2026-07-15T00:00:00.000Z");
  const recorded = recordTaskSteering(task, interaction.turnId, "accepted only by source", "2026-07-15T00:01:00.000Z");
  assert.equal(recorded.ok, true);
  const fork = forkTaskExecution(recorded.task, "2026-07-15T00:02:00.000Z");
  assert.equal(recorded.task.steering[0].deliveryState, "pending");
  assert.equal(fork.steering[0].deliveryState, "consumed");
  assert.equal(consumePendingTaskSteering(fork), null, "fork cannot replay source-owned input");
});

test("idle continuation detection is explicit instead of hijacking every new message", () => {
  for (const text of ["继续", "继续，补测试", "go on", "resume: verify it", "/continue deploy"]) {
    assert.equal(requestsTaskContinuation(text), true, text);
  }
  for (const text of ["review another project", "修复桌面端", "继续教育模块要改名", "the resume parser is broken", "/resume deadbeef"]) {
    assert.equal(requestsTaskContinuation(text), false, text);
  }
});

test("session task state round-trips separately, redacts secrets, and legacy sessions remain valid", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-task-session-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const id = newSessionId();
    const meta = {
      id,
      cwd: "/tmp/project",
      provider: "qwen",
      model: "glm-5",
      title: "task state",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "",
    };
    const interaction = newTurnInteraction();
    const task = createTaskExecution("deploy with API_KEY=super-secret-123456", interaction.turnId);
    saveSession(meta, [{ role: "user", content: "continue" }], task);
    const loaded = loadSession(id);
    assert.ok(loaded.task, "new top-level task is restored");
    assert.equal(loaded.history[0].content, "continue", "transcript remains independent");
    assert.ok(!loaded.task.objective.includes("super-secret-123456"), "task objective is redacted too");

    const legacyId = newSessionId();
    const legacy = { meta: { ...meta, id: legacyId, updatedAt: "2026-07-15T00:00:00.000Z" }, history: [] };
    const dir = join(home, ".hara", "sessions");
    writeFileSync(join(dir, `${legacyId}.json`), JSON.stringify(legacy));
    assert.deepEqual(loadSession(legacyId)?.task, undefined, "legacy session without task still loads");

    const corruptId = newSessionId();
    writeFileSync(join(dir, `${corruptId}.json`), JSON.stringify({ ...legacy, meta: { ...legacy.meta, id: corruptId }, task: { schemaVersion: 1 } }));
    assert.equal(loadSession(corruptId), null, "malformed task state fails closed with the session");
    assert.ok(readFileSync(join(dir, `${id}.json`), "utf8").includes('"task"'), "task is not hidden inside meta/history");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
