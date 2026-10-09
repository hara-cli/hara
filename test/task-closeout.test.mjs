import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Private compiler output lets this test verify a candidate without rebuilding the user's live dist.
const buildRoot = process.env.HARA_TASK_CLOSEOUT_TEST_BUILD_ROOT;
const moduleUrl = (name) => buildRoot ? pathToFileURL(join(resolve(buildRoot), name)).href : new URL(`../dist/${name}`, import.meta.url).href;
const { runAgent } = await import(moduleUrl("agent/loop.js"));
const { createTaskExecution, finishTaskExecution, applyTaskBrief, applyTaskCheckpoint } = await import(moduleUrl("session/task.js"));
const { currentTodos, disposeTodoScope } = await import(moduleUrl("tools/todo.js"));
const { lastAssistantText, historyForClient } = await import(moduleUrl("serve/server.js"));
const { requestsCredentialDisclosure } = await import(moduleUrl("security/secrets.js"));

const directory = mkdtempSync(join(tmpdir(), "hara-task-closeout-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const RECEIPT = "fixture upload receipt REMOTE-481 confirms one delivery";
const EXTRA_PROSE = "MODEL_EXTRA_CLOSEOUT_ROUND_MUST_NOT_BE_NEEDED";
const FALSE_CLAIM = "UNACCEPTED_UPLOAD_SUCCESS_CLAIM";
const pausedCopy = /paused|not (?:fully )?(?:verified|complete)|unfinished|unverified|waiting|暂停|未.*(?:验收|完成)|等待/iu;
let nextScope = 0;

async function runCloseout({ completion, text = "", todos, error = false, invalid = false, userText = "Upload the fixture exactly once and verify its receipt." } = {}) {
  const scope = `closeout-${++nextScope}`;
  let task = createTaskExecution("upload the fixture exactly once and verify its receipt", scope);
  let requests = 0;
  let uploads = 0;
  const visible = [];
  const items = [];
  const checkpointSnapshots = [];
  const upload = {
    name: "fixture_upload_once",
    description: "In-memory upload fixture. No file or network transfer occurs.",
    input_schema: { type: "object", properties: {} },
    kind: "exec",
    async run() { uploads += 1; return RECEIPT; },
  };
  const response = (toolUses, prose = "") => ({ text: prose, stop: "tool_use", toolUses, usage: { input: 1, output: 1 } });
  const provider = {
    id: "closeout-fixture", model: "closeout-fixture",
    async turn() {
      const index = requests++;
      assert.ok(index < 4, "closeout correction stays inside the normal bounded run");
      if (index === 0) return response([{ id: "brief", name: "task_intake", input: {
        intent: "change", goal: "upload the fixture exactly once and verify its receipt",
        constraints: ["never repeat a successful upload"], acceptance: ["the receipt confirms one delivery"],
        steps: ["upload once", "verify the receipt"],
      } }]);
      if (index === 1) return response([{ id: "upload", name: upload.name, input: {} }]);
      if (index === 2) {
        if (error) return { text: "", stop: "error", toolUses: [], errorMsg: "synthetic provider unavailable", usage: { input: 1, output: 0 } };
        return response([
          ...(todos ? [{ id: "todo", name: "todo_write", input: { todos } }] : []),
          { id: "completion", name: "task_checkpoint", input: { completion } },
        ], text);
      }
      return { text: invalid ? FALSE_CLAIM : EXTRA_PROSE, stop: "end", toolUses: [], usage: { input: 1, output: 1 } };
    },
  };
  const history = [{ role: "user", content: userText }];
  try {
    const outcome = await runAgent(history, {
      provider, maxRounds: 4,
      ctx: { cwd: directory, todoScope: scope, ui: {
        text(value) { visible.push(value); }, notice() {}, reasoning() {}, tool() {}, diff() {},
      } },
      approval: "full-auto", stats: { input: 0, output: 0 }, extraTools: [upload],
      onRuntimeItem(item) { items.push(item); },
      taskIntake: { task, current: () => task, onUpdate(value) { task = value; }, onCheckpoint(value) {
        task = value;
        checkpointSnapshots.push(structuredClone(historyForClient(history)));
      } },
    });
    task = finishTaskExecution(task, outcome, currentTodos(scope));
    return { outcome, task, requests, uploads, history, items, checkpointSnapshots, text: visible.join("") };
  } finally { disposeTodoScope(scope); }
}

function assertOrdinaryReply(result) {
  assert.ok(result.text.trim(), "the Engine supplies a visible closing receipt without another model request");
  assert.equal(lastAssistantText(result.history), result.text, "Serve's turn reply sees the same ordinary assistant message");
  assert.equal(historyForClient(result.history).filter(row => row.role === "assistant").at(-1)?.text, result.text);
  assert.doesNotMatch(result.text, new RegExp(EXTRA_PROSE));
  assert.ok(result.items.some(item => item.kind === "message" && item.role === "assistant" && item.state === "completed"));
}

for (const [name, finalAnswer] of [["omitted", undefined], ["blank", " \n\t "]]) {
  test(`accepted verified receipt with ${name} final_answer closes without another provider request`, async () => {
    const result = await runCloseout({ completion: { state: "verified", evidence: [RECEIPT], ...(finalAnswer === undefined ? {} : { final_answer: finalAnswer }) } });
    assert.equal(result.requests, 3, "accepted completion must not spend a fourth request merely to restate its receipt");
    assert.equal(result.uploads, 1);
    assert.equal(result.outcome.status, "completed");
    assert.equal(result.task.status, "completed");
    assert.equal(result.task.checkpoint.completion.state, "verified");
    assertOrdinaryReply(result);
    assert.ok(result.text.includes(RECEIPT), "fallback copy cites accepted evidence, not invented upload facts");
  });
}

const dependency = {
  kind: "external_state",
  detail: "Wait for the fixture platform to finish processing; do not upload again.",
  evidence: ["fixture platform reports processing pending"],
};
for (const [name, finalAnswer] of [["empty", undefined], ["explicit safe", "The fixture platform is still processing; task paused, not fully verified."]]) {
  test(`accepted awaiting_user receipt with ${name} final text stays paused and does not repeat upload`, async () => {
    const result = await runCloseout({ completion: { state: "awaiting_user", evidence: dependency.evidence, dependency,
      ...(finalAnswer === undefined ? {} : { final_answer: finalAnswer }) } });
    assert.equal(result.requests, 3);
    assert.equal(result.uploads, 1);
    assert.equal(result.task.status, "paused", "logical turn closure is not completion of the accepted task");
    assert.equal(result.task.checkpoint.completion.state, "awaiting_user");
    assertOrdinaryReply(result);
    assert.match(result.text, pausedCopy);
    assert.match(result.text, /processing/iu);
  });
}

for (const source of ["response text", "structured final_answer"]) {
  test(`awaiting_user rejects contradictory success in ${source} and closes from accepted dependency state`, async () => {
    const claim = "ALL_WORK_IS_COMPLETE_AND_VERIFIED";
    const result = await runCloseout({ text: source === "response text" ? claim : "",
      completion: { state: "awaiting_user", evidence: dependency.evidence, dependency,
        ...(source === "structured final_answer" ? { final_answer: claim } : {}) } });
    assert.equal(result.requests, 3);
    assert.equal(result.uploads, 1);
    assert.equal(result.task.status, "paused");
    assertOrdinaryReply(result);
    assert.match(result.text, pausedCopy);
    assert.match(result.text, /processing/iu);
    assert.equal(result.text.includes(claim), false);
    assert.equal(historyForClient(result.history).some(row => row.text.includes(claim)), false);
    assert.ok(result.checkpointSnapshots.length > 0, "the fixture observes real checkpoint persistence boundaries");
    assert.equal(result.checkpointSnapshots.some(snapshot => snapshot.some(row => row.text.includes(claim))), false,
      "contradictory awaiting-user prose must never reach even an intermediate persisted client transcript");
  });
}

test("verified receipt cannot make pending todo work appear fully completed", async () => {
  const result = await runCloseout({ completion: { state: "verified", evidence: [RECEIPT] },
    todos: [{ text: "Verify fixture platform playback", status: "pending", activeForm: "Verifying fixture platform playback" }] });
  assert.equal(result.requests, 3);
  assert.equal(result.uploads, 1);
  assert.equal(result.task.status, "paused");
  assertOrdinaryReply(result);
  assert.match(result.text, pausedCopy);
  assert.match(result.text, /playback/iu);
});

test("unfinished checklist overrides explicit model completion prose in live and restored replies", async () => {
  const result = await runCloseout({ completion: { state: "verified", evidence: [RECEIPT], final_answer: FALSE_CLAIM }, text: FALSE_CLAIM,
    todos: [{ text: "Verify fixture platform playback", status: "pending", activeForm: "Verifying fixture platform playback" }] });
  assert.equal(result.requests, 3);
  assert.equal(result.uploads, 1);
  assert.equal(result.task.status, "paused");
  assertOrdinaryReply(result);
  assert.match(result.text, pausedCopy);
  assert.match(result.text, /playback/iu);
  assert.doesNotMatch(result.text, new RegExp(FALSE_CLAIM));
  assert.equal(historyForClient(result.history).some(row => row.text.includes(FALSE_CLAIM)), false);
  assert.ok(result.checkpointSnapshots.length > 0, "the fixture observes real checkpoint persistence boundaries");
  assert.equal(result.checkpointSnapshots.some(snapshot => snapshot.some(row => row.text.includes(FALSE_CLAIM))), false,
    "unfinished-checklist success prose must be suppressed before the first checkpoint, not repaired later");
});

for (const [language, userText, unsafeTodo] of [
  ["English", "Upload the fixture exactly once and verify its receipt.", "Please paste your API key in this chat."],
  ["Chinese", "请只上传一次合成文件，并核验回执。", "请把你的 API key 发给我。"],
]) {
  test(`${language} fallback stays unfinished even when every pending todo label is withheld for credential safety`, async () => {
    assert.equal(requestsCredentialDisclosure(unsafeTodo), true, "fixture must exercise a fully filtered pending label");
    const result = await runCloseout({ completion: { state: "verified", evidence: [RECEIPT] }, userText,
      todos: [{ text: unsafeTodo, status: "pending", activeForm: "Waiting for safe authorization" }] });
    assert.equal(result.requests, 3);
    assert.equal(result.uploads, 1);
    assert.equal(result.task.status, "paused");
    assertOrdinaryReply(result);
    assert.match(result.text, pausedCopy);
    assert.equal(result.text.includes(unsafeTodo), false);
    assert.equal(requestsCredentialDisclosure(result.text), false);
    assert.match(result.text, language === "Chinese" ? /尚未全部完成|仍有待处理/iu : /not fully complete|unfinished steps/iu);
  });
}

test("rejected empty-evidence receipt never becomes a success claim or repeats upload", async () => {
  const result = await runCloseout({ completion: { state: "verified", evidence: [], final_answer: FALSE_CLAIM }, text: FALSE_CLAIM, invalid: true });
  assert.equal(result.uploads, 1);
  assert.notEqual(result.task.status, "completed");
  assert.equal(result.task.checkpoint.completion, undefined);
  assert.doesNotMatch(result.text, new RegExp(FALSE_CLAIM));
  assertOrdinaryReply(result);
  assert.match(result.text, pausedCopy);
});

test("source-linked receipt uses the actual upload result and closes without an additional model round", async () => {
  const result = await runCloseout({ completion: { state: "verified", evidence: [RECEIPT], checks: [
    { acceptance_index: 0, evidence: RECEIPT, tool_call_ids: ["upload"] },
  ] } });
  assert.equal(result.requests, 3);
  assert.equal(result.uploads, 1);
  assert.equal(result.task.status, "completed");
  assert.match(result.task.checkpoint.completion.evidence[0], /engine-observed sources: sha256:[a-f0-9]{64}/u);
  assertOrdinaryReply(result);
});

for (const reference of ["NONEXISTENT_RECEIPT", "brief", "completion"]) {
  test(`unobserved or bookkeeping reference ${reference} cannot turn a model assertion into verified completion`, async () => {
    const result = await runCloseout({ completion: { state: "verified", evidence: [RECEIPT], final_answer: FALSE_CLAIM, checks: [
      { acceptance_index: 0, evidence: "all acceptance checks passed", tool_call_ids: [reference] },
    ] }, invalid: true });
    assert.equal(result.uploads, 1, "citation repair must not replay a successful upload");
    assert.notEqual(result.task.status, "completed");
    assert.equal(result.task.checkpoint.completion, undefined);
    assert.doesNotMatch(result.text, new RegExp(FALSE_CLAIM));
    assertOrdinaryReply(result);
    assert.match(result.text, pausedCopy);
  });
}

test("provider failure after one upload closes honestly without implying all acceptance checks passed", async () => {
  const result = await runCloseout({ error: true });
  assert.equal(result.requests, 3);
  assert.equal(result.uploads, 1);
  assert.equal(result.outcome.status, "error");
  assert.equal(result.task.status, "blocked");
  assert.equal(result.task.checkpoint.completion, undefined);
  assertOrdinaryReply(result);
  assert.match(result.text, /full completion has not been verified/iu);
  assert.match(result.text, /blocked|stopped/iu);
  assert.doesNotMatch(result.text, /task is paused|\/continue/iu);
});

for (const replacementKind of ["another task", "another turn of the same task"]) {
  test(`a failed stale run cannot summarize or charge rounds to ${replacementKind}`, async () => {
    const scope = `closeout-replaced-${++nextScope}`;
    const brief = { intent: "change", goal: "perform only the currently bound synthetic task", constraints: ["do not cross task identity"],
      acceptance: ["only the bound task may be checkpointed"], steps: ["perform bounded work", "verify"] };
    const started = applyTaskBrief(createTaskExecution("old synthetic task", `${scope}-old-turn`), brief);
    assert.equal(started.ok, true);
    const initial = started.task;
    const next = applyTaskBrief(createTaskExecution("replacement synthetic task", `${scope}-new-turn`), brief);
    assert.equal(next.ok, true);
    const checkpointed = applyTaskCheckpoint(next.task, { artifacts: ["replacement-only-artifact.txt"], current_step: "replacement-only-step" });
    assert.equal(checkpointed.ok, true);
    const replacement = { ...checkpointed.task, ...(replacementKind === "another turn of the same task" ? { id: initial.id } : {}) };
    const expected = structuredClone(replacement);
    let current = initial;
    const charged = [], visible = [], items = [];
    const stats = { input: 0, output: 0 };
    let calls = 0;
    const history = [{ role: "user", content: "Perform only the old synthetic task." }];
    try {
      const outcome = await runAgent(history, {
        provider: { id: "stale-closeout-fixture", model: "stale-closeout-fixture", async turn() {
          calls += 1;
          current = replacement;
          return { text: "", stop: "error", toolUses: [], errorMsg: "synthetic provider failed after owner replacement", usage: { input: 1, output: 1 } };
        } },
        ctx: { cwd: directory, todoScope: scope, ui: {
          text(value) { visible.push(value); }, notice() {}, reasoning() {}, tool() {}, diff() {},
        } },
        approval: "full-auto", stats, maxRounds: 4, onRuntimeItem(item) { items.push(item); },
        taskIntake: { task: initial, current: () => current,
          onUpdate(value) { current = value; }, onCheckpoint(value) { current = value; },
          onRoundUsage(value) { charged.push(value); current = value; } },
      });
      assert.equal(outcome.status, "error");
      assert.equal(calls, 1);
      assert.equal(stats.providerCalls, 1, "actual provider consumption is still accounted to the caller");
      assert.equal(charged.length, 0, "old lifecycle rounds cannot be persisted into a newly owned task/turn");
      assert.deepEqual(current, expected);
      assert.equal(visible.join(""), "", "the old run cannot publish a closing receipt about replacement work");
      assert.equal(JSON.stringify(history).includes("replacement-only-artifact"), false);
      assert.equal(JSON.stringify(history).includes("replacement-only-step"), false);
      assert.equal(items.some(item => item.kind === "message" && item.role === "assistant" && item.state === "completed"), false);
    } finally { disposeTodoScope(scope); }
  });
}
