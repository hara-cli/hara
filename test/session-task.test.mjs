import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TASK_STEERING_ENTRIES,
  applyTaskBrief,
  applyTaskCheckpoint,
  continueTaskExecution,
  consumePendingTaskSteering,
  createTaskExecution,
  finishTaskExecution,
  forkTaskExecution,
  isTaskExecution,
  newSteerInteraction,
  newTurnInteraction,
  recordTaskRoundUsage,
  recordTaskSteering,
  routeTaskInteraction,
  requestsTaskContinuation,
  recoverTaskExecution,
  taskRoundBudget,
  taskExecutionContext,
  taskCheckpointContext,
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

test("task brief records the interpreted goal and acceptance separately from the raw objective", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("这个全面优化一下", interaction.turnId, "2026-07-18T00:00:00.000Z");
  const accepted = applyTaskBrief(task, {
    intent: "change",
    goal: "separate conversation routing from task execution",
    constraints: ["preserve unrelated changes"],
    acceptance: ["control-command input is never steered or dropped", "side effects require an accepted brief"],
    steps: ["fix routing", "gate execution", "run regression tests"],
  }, "2026-07-18T00:01:00.000Z");
  assert.equal(accepted.ok, true);
  assert.equal(accepted.task.objective, "这个全面优化一下", "the user's original request remains immutable");
  assert.equal(accepted.task.brief.goal, "separate conversation routing from task execution");
  assert.doesNotMatch(
    taskExecutionContext(accepted.task, interaction),
    /Accepted task brief|side effects require an accepted brief/,
    "the mutable brief is composed dynamically by the agent loop instead of frozen into execution context",
  );
  assert.equal(isTaskExecution(accepted.task), true);
});

test("task checkpoint is one durable source for facts, capability preflight, blockers, and artifacts", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("verify and publish", interaction.turnId, "2026-08-05T00:00:00.000Z");
  const first = applyTaskCheckpoint(task, {
    current_step: "verify release assets",
    next_step: "publish the verified manifest",
    artifacts: ["dist/app.tar.gz", "dist/app.tar.gz", "reports/checksums.json"],
    facts: [
      { key: "assets_verified", value: 2, evidence: "two SHA-256 comparisons passed" },
      { key: "manifest_published", value: false },
      { key: "constructor", value: "ordinary domain fact", evidence: "stored as an own data key" },
    ],
    capabilities: [
      { name: "release_upload", state: "available", detail: "authenticated dry-run passed" },
      { name: "authenticode", state: "unavailable", detail: "no signing certificate configured" },
    ],
  }, "2026-08-05T00:01:00.000Z");
  assert.equal(first.ok, true);
  assert.deepEqual(first.checkpoint.artifacts, ["dist/app.tar.gz", "reports/checksums.json"]);
  assert.equal(first.checkpoint.facts.assets_verified.value, 2);
  assert.equal(first.checkpoint.facts.constructor.value, "ordinary domain fact");
  assert.equal(first.checkpoint.capabilities.authenticode.state, "unavailable");
  assert.match(taskCheckpointContext(first.checkpoint), /assets_verified = 2/);
  assert.match(taskCheckpointContext(first.checkpoint), /authenticode: unavailable/);
  assert.equal(isTaskExecution(first.task), true);

  const contradiction = applyTaskCheckpoint(first.task, {
    facts: [{ key: "manifest_published", value: true }],
  });
  assert.equal(contradiction.ok, false);
  assert.match(contradiction.reason, /fresh evidence/);

  const revised = applyTaskCheckpoint(first.task, {
    current_step: "",
    blocked_step: "publish manifest",
    block_reason: "release approval is pending",
    facts: [{ key: "manifest_published", value: true, evidence: "public readback matched the uploaded bytes" }],
  }, "2026-08-05T00:02:00.000Z");
  assert.equal(revised.ok, true);
  assert.equal(revised.checkpoint.currentStep, undefined);
  assert.equal(revised.checkpoint.blockedStep, "publish manifest");
  assert.equal(revised.checkpoint.facts.manifest_published.value, true);
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

test("an accepted brief requires a fresh engine-readable completion receipt", () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("publish the verified result", interaction.turnId, "2026-08-14T00:00:00.000Z");
  const briefed = applyTaskBrief(created, {
    intent: "change",
    goal: "publish the verified result",
    constraints: ["do not claim success before readback"],
    acceptance: ["public readback matches the local digest"],
    steps: ["publish", "read back", "record the evidence"],
  }, "2026-08-14T00:01:00.000Z");
  assert.equal(briefed.ok, true);

  const missing = finishTaskExecution(
    briefed.task,
    { status: "completed" },
    [{ text: "publish", status: "done" }],
    false,
    "2026-08-14T00:02:00.000Z",
  );
  assert.equal(missing.status, "paused");
  assert.match(missing.checkpoint.currentStep, /verify the accepted completion checks/);

  const waiting = applyTaskCheckpoint(briefed.task, {
    capabilities: [{
      name: "release_authority",
      state: "blocked",
      detail: "the authenticated account lacks release-owner authority",
    }],
    completion: {
      state: "awaiting_user",
      evidence: ["the release candidate was built locally"],
      dependency: {
        kind: "missing_authority",
        detail: "approval to publish the public release",
        evidence: ["the release endpoint returned an authority-required decision"],
        capability: "release_authority",
      },
    },
  }, "2026-08-14T00:02:30.000Z");
  assert.equal(waiting.ok, true);
  const paused = finishTaskExecution(waiting.task, { status: "completed" }, [], false, "2026-08-14T00:03:00.000Z");
  assert.equal(paused.status, "paused");
  assert.equal(paused.checkpoint.completion.state, "awaiting_user");
  assert.equal(paused.checkpoint.completion.dependency.kind, "missing_authority");
  assert.match(paused.checkpoint.blockReason, /approval to publish/);

  const verified = applyTaskCheckpoint(briefed.task, {
    completion: {
      state: "verified",
      evidence: ["public readback matched the local SHA-256 digest"],
    },
  }, "2026-08-14T00:04:00.000Z");
  assert.equal(verified.ok, true);
  const completed = finishTaskExecution(verified.task, { status: "completed" }, [], false, "2026-08-14T00:05:00.000Z");
  assert.equal(completed.status, "completed");
  assert.equal(completed.checkpoint.completion.state, "verified");

  const continued = continueTaskExecution(
    completed,
    newSteerInteraction(interaction.turnId),
    "2026-08-14T00:06:00.000Z",
  );
  assert.equal(continued.ok, true);
  assert.equal(continued.task.checkpoint.completion, undefined, "continuation invalidates stale success evidence");
});

test("awaiting_user rejects free-form handoff and available capabilities", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("change the deployment", interaction.turnId);
  const freeForm = applyTaskCheckpoint(task, {
    completion: {
      state: "awaiting_user",
      evidence: ["the model preferred to provide instructions"],
      waiting_for: "please run the deployment command yourself",
    },
  });
  assert.equal(freeForm.ok, false);
  assert.match(freeForm.reason, /structured dependency/);

  const available = applyTaskCheckpoint(task, {
    capabilities: [{ name: "deployment_access", state: "available", detail: "authenticated preflight succeeded" }],
    completion: {
      state: "awaiting_user",
      evidence: ["deployment access is available"],
      dependency: {
        kind: "missing_authority",
        detail: "please deploy it",
        evidence: ["the tool is available"],
        capability: "deployment_access",
      },
    },
  });
  assert.equal(available.ok, false);
  assert.match(available.reason, /blocked or unavailable/);
});

test("awaiting_user rejects Hara output compaction as a human dependency", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("finish the local import", interaction.turnId);
  const rejected = applyTaskCheckpoint(task, {
    completion: {
      state: "awaiting_user",
      evidence: ["read_file results contain [hara: 512 chars omitted from historical tool output]"],
      dependency: {
        kind: "external_state",
        detail: "请用户另开会话运行 .tmp/fc.mjs，并粘贴完整 bash/Python 输出",
        evidence: ["工具输出被截断，当前会话无法读取完整文件内容"],
      },
    },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /engine-recoverable/);
  assert.match(rejected.reason, /read_file offset\+limit/);
});

test("verified completion cannot coexist with a persisted blocker", () => {
  const interaction = newTurnInteraction();
  const created = createTaskExecution("verify the artifact", interaction.turnId, "2026-08-14T00:00:00.000Z");
  const blocked = applyTaskCheckpoint(created, {
    blocked_step: "read back artifact",
    block_reason: "artifact is not public",
  }, "2026-08-14T00:01:00.000Z");
  assert.equal(blocked.ok, true);
  const rejected = applyTaskCheckpoint(blocked.task, {
    completion: { state: "verified", evidence: ["local build passed"] },
  }, "2026-08-14T00:02:00.000Z");
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /cannot retain a blocker/);
});

test("lifecycle and strategy boundaries are resumable pauses while exact loop breakers remain blocked", () => {
  const interaction = newTurnInteraction();
  const task = createTaskExecution("finish the long task", interaction.turnId);
  const deadline = finishTaskExecution(task, { status: "halted", stopReason: "deadline", error: "deadline" });
  assert.equal(deadline.status, "paused");
  assert.equal(deadline.lastOutcome, "halted");

  const roundBudget = finishTaskExecution(task, { status: "halted", stopReason: "task_round_budget", error: "checkpoint" });
  assert.equal(roundBudget.status, "paused");
  assert.equal(roundBudget.lastOutcome, "halted");

  const maxRounds = finishTaskExecution(task, { status: "halted", stopReason: "max_rounds", error: "bounded pause" });
  assert.equal(maxRounds.status, "paused");

  const strategyStall = finishTaskExecution(task, { status: "halted", stopReason: "strategy_stall", error: "re-plan" });
  assert.equal(strategyStall.status, "paused");

  const loop = finishTaskExecution(task, { status: "halted", stopReason: "repeat_loop", error: "loop" });
  assert.equal(loop.status, "blocked");
});

test("task rounds persist cumulatively and only explicit continuation opens another 100-round tranche", () => {
  const first = newTurnInteraction();
  const created = createTaskExecution("finish a bounded long task", first.turnId, "2026-08-10T00:00:00.000Z");
  assert.deepEqual(taskRoundBudget(created), { used: 0, limit: 100, checkpointAt: 50 });

  const atLimit = recordTaskRoundUsage(created, 100, "2026-08-10T00:10:00.000Z");
  assert.deepEqual(taskRoundBudget(atLimit), { used: 100, limit: 100, checkpointAt: 50 });
  assert.equal(recordTaskRoundUsage(created, 101).roundsUsed, 100, "accounting cannot overshoot its current tranche");
  assert.match(taskExecutionContext(atLimit, first), /Cumulative round budget: 100\/100/);
  assert.equal(isTaskExecution(atLimit), true);

  const paused = finishTaskExecution(atLimit, {
    status: "halted",
    stopReason: "task_round_budget",
    error: "bounded checkpoint",
  });
  assert.equal(paused.status, "paused");

  const resumedInteraction = newSteerInteraction(first.turnId);
  const resumed = continueTaskExecution(paused, resumedInteraction, "2026-08-10T00:11:00.000Z");
  assert.equal(resumed.ok, true);
  assert.deepEqual(taskRoundBudget(resumed.task), { used: 100, limit: 200, checkpointAt: 150 });
  assert.equal(isTaskExecution(resumed.task), true);

  const belowLimit = recordTaskRoundUsage(created, 25, "2026-08-10T00:05:00.000Z");
  const normalContinuation = continueTaskExecution(
    belowLimit,
    newSteerInteraction(first.turnId),
    "2026-08-10T00:06:00.000Z",
  );
  assert.equal(normalContinuation.ok, true);
  assert.deepEqual(taskRoundBudget(normalContinuation.task), { used: 25, limit: 100, checkpointAt: 50 });
  assert.equal(isTaskExecution({ ...created, roundBudgetLimit: undefined }), false, "partial budget metadata fails closed");
  assert.equal(isTaskExecution({ ...created, roundsUsed: undefined }), false, "a forged limit without usage fails closed");
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
  for (const text of ["继续", "继续，补测试", "重新执行", "现在去执行任务", "go on", "resume: verify it", "/continue deploy"]) {
    assert.equal(requestsTaskContinuation(text), true, text);
  }
  for (const text of ["review another project", "修复桌面端", "继续教育模块要改名", "the resume parser is broken", "/resume deadbeef"]) {
    assert.equal(requestsTaskContinuation(text), false, text);
  }
});

test("a queued steer with no executable task falls forward to a normal turn without changing its id", () => {
  const steer = newSteerInteraction("ui-control-turn");
  const routed = routeTaskInteraction(undefined, steer);
  assert.equal(routed.recoveredMissingTask, true);
  assert.deepEqual(routed.interaction, { kind: "turn", turnId: steer.turnId });

  const existing = createTaskExecution("real task", "active-turn");
  const stale = newSteerInteraction("different-turn");
  const retained = routeTaskInteraction(existing, stale);
  assert.equal(retained.recoveredMissingTask, false);
  assert.equal(retained.interaction.kind, "steer", "an existing-task mismatch remains visible to the stale-turn guard");

  const completed = finishTaskExecution(existing, { status: "completed" }, []);
  const late = routeTaskInteraction(completed, newSteerInteraction(existing.turnId));
  assert.equal(late.interaction.kind, "turn", "a retained but finished task is not an executable steer target");
  assert.equal(late.recoveredMissingTask, true);

  const explicit = routeTaskInteraction(completed, newSteerInteraction(existing.turnId), { allowInactive: true });
  assert.equal(explicit.interaction.kind, "steer", "explicit /continue may deliberately reopen an inactive task");
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
    let task = createTaskExecution("deploy with API_KEY=super-secret-123456", interaction.turnId);
    const briefed = applyTaskBrief(task, {
      intent: "change",
      goal: "deploy using API_KEY=super-secret-123456 from the environment",
      constraints: ["never print API_KEY=super-secret-123456"],
      acceptance: ["deployment succeeds"],
      steps: ["deploy"],
    });
    assert.equal(briefed.ok, true);
    task = briefed.task;
    const checkpointed = applyTaskCheckpoint(task, {
      artifacts: ["report-API_KEY=super-secret-123456.json"],
      facts: [{ key: "deployment_ready", value: true, evidence: "API_KEY=super-secret-123456 validated" }],
      capabilities: [{ name: "deploy", state: "available", detail: "DEPLOY_TOKEN=super-secret-123456 accepted" }],
    });
    assert.equal(checkpointed.ok, true);
    task = checkpointed.task;
    saveSession(meta, [{ role: "user", content: "continue" }], task);
    const loaded = loadSession(id);
    assert.ok(loaded.task, "new top-level task is restored");
    assert.equal(loaded.task.roundsUsed, 0, "cumulative round usage survives the redacted session copy");
    assert.equal(loaded.task.roundBudgetLimit, 100, "the bounded tranche survives the redacted session copy");
    assert.equal(loaded.history[0].content, "continue", "transcript remains independent");
    assert.ok(!loaded.task.objective.includes("super-secret-123456"), "task objective is redacted too");
    assert.ok(!JSON.stringify(loaded.task.brief).includes("super-secret-123456"), "interpreted task brief is redacted too");
    assert.ok(!JSON.stringify(loaded.task.checkpoint).includes("super-secret-123456"), "structured task checkpoint is redacted too");

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
