import { test } from "node:test";
import assert from "node:assert/strict";
import { pausedCloseoutText } from "../dist/agent/task-closeout.js";
import { createTaskExecution } from "../dist/session/task.js";

test("no-progress closing replies distinguish the I/O guard from a human dependency", () => {
  const task = createTaskExecution("diagnose without changing files", "fixture-turn");
  const outcome = { status: "halted", stopReason: "no_progress", progress: {
    trigger: "unattended_token_budget", rounds: 3, checkpointStaleRounds: 2, tokens: { input: 255000, output: 608, total: 255608 },
  } };
  for (const language of ["zh-Hans", "en"]) {
    const result = pausedCloseoutText(task, [], language, outcome);
    assert.match(result, /255,608/); assert.match(result, /I\/O/);
    assert.match(result, /不是.*缺少|not.*missing/);
    assert.doesNotMatch(result, /已完成。|task is complete/);
  }
  const legacy = pausedCloseoutText(task, [], "en", { status: "halted", stopReason: "no_progress" });
  assert.match(legacy, /Recent work produced no new verifiable progress/);
  assert.doesNotMatch(legacy, /NaN|undefined/);
});
