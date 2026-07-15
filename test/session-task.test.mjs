import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TASK_STEERING_ENTRIES,
  continueTaskExecution,
  createTaskExecution,
  finishTaskExecution,
  isTaskExecution,
  newSteerInteraction,
  newTurnInteraction,
  recordTaskSteering,
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

test("task steering audit is bounded", () => {
  const interaction = newTurnInteraction();
  let task = createTaskExecution("bounded audit", interaction.turnId);
  for (let index = 0; index < MAX_TASK_STEERING_ENTRIES + 5; index++) {
    const result = recordTaskSteering(task, interaction.turnId, `steer ${index}`);
    assert.equal(result.ok, true);
    task = result.task;
  }
  assert.equal(task.steering.length, MAX_TASK_STEERING_ENTRIES);
  assert.equal(task.steering.at(-1).content, `steer ${MAX_TASK_STEERING_ENTRIES + 4}`);
  assert.equal(isTaskExecution(task), true);
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
