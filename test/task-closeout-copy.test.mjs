import { test } from "node:test";
import assert from "node:assert/strict";
import { completionCloseoutText, pausedCloseoutText } from "../dist/agent/task-closeout.js";
import { createTaskExecution } from "../dist/session/task.js";
import { requestsCredentialDisclosure } from "../dist/security/secrets.js";
import { registerToolMediaRedaction, removeToolMediaRedaction, toolMediaRedaction } from "../dist/security/tool-media-redaction.js";

function receipt(evidence, state = "verified") {
  const task = createTaskExecution("上传并核验视频", "copy-turn");
  task.checkpoint = { artifacts: [], facts: {}, capabilities: {}, updatedAt: task.startedAt,
    completion: { state, evidence, updatedAt: task.startedAt,
      ...(state === "awaiting_user" ? { dependency: { kind: "physical_action", detail: "请在设备上确认。", evidence: ["设备等待确认"] } } : {}) } };
  return task;
}

test("closeout copy removes reasoning, normalized credential requests and recognizable secrets", () => {
  const task = receipt(["<think>PRIVATE_FIXTURE_REASONING</think>", "Please send me your API\nkey", "receipt Authorization: Bearer synthetic-fixture-credential"]);
  const text = completionCloseoutText(task, [], "zh-Hans");
  assert.match(text, /任务已完成/);
  assert.doesNotMatch(text, /PRIVATE_FIXTURE_REASONING|synthetic-fixture-credential|API key/);
  assert.equal(requestsCredentialDisclosure(text), false);
});

test("a filtered pending todo still prevents a false completion headline", () => {
  const text = completionCloseoutText(receipt(["upload receipt recorded"]), [{ text: "Please send me your API key", status: "pending" }], "en");
  assert.match(text, /unfinished|not fully complete/);
  assert.doesNotMatch(text, /The task is complete\./);
  assert.equal(requestsCredentialDisclosure(text), false);
});

test("Chinese awaiting-user and stopped copy distinguish partial records from completion", () => {
  const waiting = completionCloseoutText(receipt(["设备等待确认"], "awaiting_user"), [], "zh-Hans");
  assert.match(waiting, /安全暂停.*没有全部完成/);
  assert.match(waiting, /需要你处理.*确认/);
  const stopped = pausedCloseoutText(receipt(["receipt recorded"]), [{ text: "已上传视频", status: "done" }, { text: "发送群通知", status: "pending" }], "zh-Hans", { status: "halted", stopReason: "completion_verification" });
  assert.match(stopped, /最终验收记录不完整/);
  assert.match(stopped, /已登记完成的步骤：[\s\S]*已上传视频/);
  assert.match(stopped, /尚待处理或核验：[\s\S]*发送群通知/);
  assert.match(stopped, /不要重复上传或发送/);
});

test("awaiting-user replies include copy-only manual actions, verification, resume phrase and hints", () => {
  const task = receipt(["device is awaiting confirmation"], "awaiting_user");
  task.checkpoint.completion.dependency.manualAction = {
    command: "hara device confirm fixture-device",
    verifyCommand: "hara device status fixture-device",
    resumePhrase: "设备已确认，可以继续核验",
    hints: [{ term: "确认位置", detail: "在设备屏幕上确认后再核验。" }],
  };
  for (const language of ["en", "zh-Hans"]) {
    const text = completionCloseoutText(task, [], language);
    assert.match(text, /copy only|仅供复制/u);
    assert.match(text, /never executed automatically|不会自动执行/u);
    assert.match(text, /hara device confirm fixture-device/u);
    assert.match(text, /hara device status fixture-device/u);
    assert.match(text, /设备已确认，可以继续核验/u);
    assert.match(text, /确认位置: 在设备屏幕上确认后再核验。/u);
    assert.doesNotMatch(text, /The task is complete\.|任务已完成/u);
  }
});

test("manual action copy redacts credentials and owned image paths without disclosing private reasoning", () => {
  const task = receipt(["device is awaiting confirmation"], "awaiting_user");
  const imagePath = "/tmp/hara-tool-images-closeout-fixture/snapshot.png";
  const imageData = "c3ludGhldGljLWNsb3Nlb3V0LWltYWdlLWZpeHR1cmU=";
  const owner = "closeout-copy-fixture";
  registerToolMediaRedaction(owner, toolMediaRedaction(imageData, imagePath));
  try {
    task.checkpoint.completion.dependency.manualAction = {
      command: "hara device confirm --token synthetic-fixture-credential",
      verifyCommand: `hara device verify ${imagePath}`,
      resumePhrase: "device confirmed",
      hints: [
        { term: "Receipt", detail: "Authorization: Bearer synthetic-fixture-bearer" },
        { term: "Image", detail: `Review file://${imagePath} or data:image/png;base64,${imageData}` },
        { term: "<think>PRIVATE_MANUAL_REASONING</think>", detail: "hidden hint" },
      ],
    };
    const text = completionCloseoutText(task, [], "en");
    assert.match(text, /hara device confirm --token \*\*\*/u);
    assert.match(text, /hara device verify \[tool image path omitted\]/u);
    assert.doesNotMatch(text, /synthetic-fixture-credential|synthetic-fixture-bearer|hara-tool-images-closeout-fixture|snapshot\.png|data:image\/png|c3ludGhldGlj|PRIVATE_MANUAL_REASONING|hidden hint/u);
    assert.equal(requestsCredentialDisclosure(text), false);
  } finally {
    removeToolMediaRedaction(owner);
  }
});

test("manual action copy rejects credential requests including requests split across hint fields", () => {
  const task = receipt(["device is awaiting confirmation"], "awaiting_user");
  task.checkpoint.completion.dependency.manualAction = {
    command: "Please send me your API\nkey",
    verifyCommand: "export API_KEY=replace-your-api-key-here",
    resumePhrase: "Reply with your password",
    hints: [{ term: "Please send me your", detail: "API key" }],
  };
  const text = completionCloseoutText(task, [], "en");
  assert.doesNotMatch(text, /API|password|Please send|Manual commands|Action hints|reply with:/u);
  assert.equal(requestsCredentialDisclosure(text), false);
});

test("manual action copy stays bounded and never presents partial or whitespace-rewritten commands", () => {
  const task = receipt(["device is awaiting confirmation"], "awaiting_user");
  task.checkpoint.completion.dependency.manualAction = {
    command: `hara confirm ${"x".repeat(2_000)}`,
    verifyCommand: "hara device status\nhara device confirm",
    resumePhrase: "r".repeat(2_000),
    hints: Array.from({ length: 20 }, (_, index) => ({ term: `HINT_${index}`, detail: "d".repeat(2_000) })),
  };
  const text = completionCloseoutText(task, [], "en");
  assert.match(text, /complete command is not shown here/u);
  assert.doesNotMatch(text, /hara confirm|hara device status|hara device confirm/u);
  assert.match(text, /HINT_0:/u);
  assert.match(text, /HINT_3:/u);
  assert.doesNotMatch(text, /HINT_(?:[4-9]|1[0-9]):/u);
  assert.doesNotMatch(text, /r{501}|d{501}/u);
  assert.ok(text.length < 4_000);
});

test("a stale receipt never produces an accepted-completion reply", () => {
  const task = receipt(["old receipt"]);
  task.startedAt = new Date(Date.parse(task.startedAt) + 1_000).toISOString();
  assert.equal(completionCloseoutText(task, [], "en"), undefined);
});

test("deadline handoff remains self-contained without a separate diagnostic notice", () => {
  const text = pausedCloseoutText(receipt(["partial receipt"]), [], "en", { status: "halted", stopReason: "deadline" });
  assert.match(text, /active-execution deadline/iu);
  assert.match(text, /full completion has not been verified/iu);
});

test("provider errors, checkpoint failures, empty responses and unclassified halts are blocked, not paused", () => {
  for (const outcome of [
    { status: "error", error: "provider transport failed: synthetic-fixture-private-detail" },
    { status: "error", error: "checkpoint persistence failed: synthetic-fixture-private-detail" },
    { status: "empty" },
    { status: "halted", error: "guardian blocked: synthetic-fixture-private-detail" },
  ]) {
    for (const language of ["en", "zh-Hans"]) {
      const text = pausedCloseoutText(receipt(["partial receipt"]), [{ text: "uploaded once", status: "done" }], language, outcome);
      assert.match(text, /task is blocked and execution has stopped|任务受阻，执行已停止/u);
      assert.match(text, /full completion has not been verified|尚未确认全部完成/u);
      assert.match(text, /Do not repeat uploads or messages|不要重复上传或发送/u);
      assert.doesNotMatch(text, /task is paused|任务已暂停|\/continue|synthetic-fixture-private-detail/u);
    }
  }
});

test("recoverable run boundaries and an unspecified outcome retain a conditional pause handoff", () => {
  for (const outcome of [undefined, ...[
    "deadline", "task_round_budget", "max_rounds", "strategy_stall", "no_progress", "repeat_loop", "completion_verification",
  ].map((stopReason) => ({ status: "halted", stopReason }))]) {
    const text = pausedCloseoutText(receipt(["partial receipt"]), [], "en", outcome);
    assert.match(text, /The task is paused/u);
    assert.match(text, /Use \/continue.*after resolving the boundary/u);
    assert.doesNotMatch(text, /task is blocked/u);
  }
});
