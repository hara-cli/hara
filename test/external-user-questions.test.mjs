import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerAdapter } from "../dist/external-sessions/codex.js";
import { ClaudeAgentSdkAdapter } from "../dist/external-sessions/claude.js";
import { JsonlRpcClient } from "../dist/external-sessions/process.js";
import { normalizeExternalUserQuestions, validateExternalUserAnswers } from "../dist/external-sessions/questions.js";

const choices = { questions: [{ id: "choice", header: "Runtime", question: "Which runtime?",
  options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }] };
const adapterOptions = { command: process.execPath, haraVersion: "0.0.0-test", identityKey: Buffer.alloc(32, 1) };
const sink = (overrides = {}) => ({ text() {}, tool() {}, notice() {},
  confirm: async () => { throw new Error("a user question must not call permission confirmation"); }, ...overrides });
const answerCodex = (request, output = sink(), signal = new AbortController().signal) => {
  // Pure protocol unit test; the private dispatcher is invoked without spawning a CLI or model.
  const adapter = new CodexAppServerAdapter(adapterOptions);
  return adapter.answerServerRequest({ method: "item/tool/requestUserInput", params: request }, output, signal);
};

test("Codex questions never choose the first option through old confirmation or absent askUser", async () => {
  assert.deepEqual(await answerCodex(choices), { answers: {} });
  assert.deepEqual(await answerCodex(choices, sink({ askUser: async () => ({}) })), { answers: {} });
  assert.deepEqual(await answerCodex(choices, sink({ askUser: async () => { throw new Error("disconnected"); } })), { answers: {} });
});

test("Codex returns the user's selected option, never the first, and supports the legacy native method name", async () => {
  let observed;
  const output = sink({ askUser: async (request) => { observed = request; return { choice: { answers: ["B"] } }; } });
  assert.deepEqual(await answerCodex(choices, output), { answers: { choice: { answers: ["B"] } } });
  assert.deepEqual(observed, choices);
  const adapter = new CodexAppServerAdapter(adapterOptions);
  assert.deepEqual(await adapter.answerServerRequest({ method: "tool/requestUserInput", params: choices }, output, new AbortController().signal),
    { answers: { choice: { answers: ["B"] } } });
});

test("secret, credential-soliciting, malformed and cancelled Codex questions return empty without projection", async () => {
  let called = 0;
  const notices = [];
  const output = sink({ askUser: async () => { called++; return { choice: { answers: ["A"] } }; }, notice: (text) => notices.push(text) });
  for (const request of [
    { questions: [{ ...choices.questions[0], isSecret: true }] },
    { questions: [{ id: "key", question: "Paste your API key here" }] },
    ...["What is your password?", "Your API key?", "What is your authentication token?", "What is your private key?",
      "你的登录密码是什么", "您的登錄密碼是什麼？", "请输入验证码", "請輸入驗證碼"].map((question) => ({ questions: [
      { id: "key", question, header: "Auth", options: [{ label: "Custom", description: "Enter an answer" }], isOther: true },
    ] })),
    { questions: [{ ...choices.questions[0], options: [{ label: "A" }, { label: "A" }] }] },
    { questions: [{ ...choices.questions[0], id: "__proto__" }] },
  ]) assert.deepEqual(await answerCodex(request, output), { answers: {} });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await answerCodex(choices, output, controller.signal), { answers: {} });
  assert.equal(called, 0);
  assert.doesNotMatch(JSON.stringify(notices), /Paste your API key/);
  const late = new AbortController();
  assert.deepEqual(await answerCodex(choices, sink({ askUser: async () => {
    late.abort(); return { choice: { answers: ["B"] } };
  } }), late.signal), { answers: {} });
});

test("credential architecture questions and native null-option free forms remain usable", async () => {
  for (const question of ["Where should the API key be configured?", "Which password hashing algorithm?"]) {
    assert.ok(normalizeExternalUserQuestions({ questions: [{ id: "architecture", question }] }));
  }
  assert.equal(normalizeExternalUserQuestions({ questions: [{ ...choices.questions[0],
    options: [{ label: "A", description: null }] }] }), null, "native option descriptions are strings, not nullable");
  const request = { threadId: "bound-thread", turnId: "bound-turn", itemId: "native-item", questions: [
    { id: "free", header: "Title", question: "What title should be used?", isOther: true, isSecret: false, options: null },
  ] };
  const adapter = new CodexAppServerAdapter(adapterOptions);
  let called = 0;
  const output = sink({ askUser: async (normalized) => {
    called++;
    assert.equal(normalized.questions[0].options, undefined);
    return { free: { answers: ["Chosen title"] } };
  } });
  const binding = { threadId: "bound-thread", nativeTurnReady: Promise.resolve("bound-turn") };
  assert.deepEqual(await adapter.answerServerRequest({ method: "item/tool/requestUserInput", params: request }, output,
    new AbortController().signal, binding), { answers: { free: { answers: ["Chosen title"] } } });
  for (const params of [{ ...request, threadId: "other-thread" }, { ...request, turnId: "old-turn" }]) {
    assert.deepEqual(await adapter.answerServerRequest({ method: "item/tool/requestUserInput", params }, output,
      new AbortController().signal, binding), { answers: {} });
  }
  assert.equal(called, 1, "cross-thread/native-turn questions are never projected");
});

test("multiple questions retain explicit custom and multi-select answers without invented defaults", () => {
  const request = normalizeExternalUserQuestions({ questions: [
    ...choices.questions,
    { id: "custom", question: "Choose a title", options: [{ label: "Default" }], isOther: true },
    { id: "many", question: "Which checks?", options: [{ label: "Build" }, { label: "Test" }], multiSelect: true },
    { id: "free", question: "Describe the result" },
  ] });
  assert.ok(request);
  const answers = { choice: { answers: ["B"] }, custom: { answers: ["My title"] },
    many: { answers: ["Build", "Test"] }, free: { answers: ["Keep it small"] } };
  assert.deepEqual(validateExternalUserAnswers(request, answers), answers);
  assert.deepEqual(validateExternalUserAnswers(request, { choice: { answers: [] } }), { choice: { answers: [] } });
  for (const invalid of [
    { choice: { answers: ["C"] } }, { choice: { answers: ["A", "B"] } },
    { missing: { answers: ["B"] } }, { many: { answers: ["Test", "Test"] } },
    { free: { answers: ["apiKey=sk-123456789012345678901234567890"] } },
    { choice: { answers: ["B"], allow: true } },
  ]) assert.equal(validateExternalUserAnswers(request, invalid), undefined);
});

test("invalid answers from a custom Codex sink safely close rather than selecting a fallback", async () => {
  assert.deepEqual(await answerCodex(choices, sink({ askUser: async () => ({ choice: { answers: ["C"] } }) })), { answers: {} });
});

test("Codex malformed turn/start releases a same-chunk native question and interruption closes a pending form", async () => {
  const originalStart = JsonlRpcClient.start;
  try {
    for (const started of [null, {}, { turn: null }, { turn: { id: "" } }, { turn: { id: "  " } }, { turn: { id: 7 } }]) {
      let asked = 0;
      let options;
      let resolveAnswer;
      const answer = new Promise((resolve) => { resolveAnswer = resolve; });
      const client = {
        notify() {},
        close() { options.onClose(new Error("fixture closed")); },
        async call(method) {
          if (method === "initialize") return {};
          if (method === "thread/resume") return { thread: { status: { type: "idle" } } };
          if (method === "turn/start") {
            // Mirrors a native request parsed before the turn/start await continuation runs.
            options.onServerRequest({ method: "item/tool/requestUserInput", params: {
              ...choices, threadId: "bound-thread", turnId: "bound-turn",
            } }, resolveAnswer, () => assert.fail("input request must fail closed with empty answers"));
            return started;
          }
          throw new Error(`unexpected fixture method ${method}`);
        },
      };
      JsonlRpcClient.start = (value) => { options = value; return client; };
      const adapter = new CodexAppServerAdapter(adapterOptions);
      adapter.appServerArgs = async () => ["app-server"];
      adapter.refs.set("fixture-session", { nativeId: "bound-thread", owned: true, live: false,
        info: { id: "fixture-session", state: "idle" } });
      await assert.rejects(adapter.submit("fixture-session", "continue", sink({ askUser: async () => {
        asked++; return { choice: { answers: ["B"] } };
      } })), /did not expose a valid started turn/);
      assert.deepEqual(await answer, { answers: {} });
      assert.equal(asked, 0);
      assert.equal(adapter.running.size, 0);
      assert.equal(adapter.refs.get("fixture-session").info.state, "error", "late input cleanup cannot restore a failed turn to working");
    }

    let options;
    let questionReady;
    let resolveAnswer;
    const ready = new Promise((resolve) => { questionReady = resolve; });
    const answer = new Promise((resolve) => { resolveAnswer = resolve; });
    const client = {
      notify() {},
      close() { options.onClose(new Error("fixture closed")); },
      async call(method) {
        if (method === "initialize" || method === "turn/interrupt") return {};
        if (method === "thread/resume") return { thread: { status: { type: "idle" } } };
        if (method === "turn/start") {
          options.onServerRequest({ method: "item/tool/requestUserInput", params: {
            ...choices, threadId: "bound-thread", turnId: "bound-turn",
          } }, resolveAnswer, () => assert.fail("input request must cancel with empty answers"));
          return { turn: { id: "bound-turn" } };
        }
        throw new Error(`unexpected fixture method ${method}`);
      },
    };
    JsonlRpcClient.start = (value) => { options = value; return client; };
    const adapter = new CodexAppServerAdapter(adapterOptions);
    adapter.appServerArgs = async () => ["app-server"];
    adapter.refs.set("fixture-session", { nativeId: "bound-thread", owned: true, live: false,
      info: { id: "fixture-session", state: "idle" } });
    const turn = adapter.submit("fixture-session", "continue", sink({ askUser: async (_request, signal) => {
      questionReady();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
    } }));
    await ready;
    await adapter.interrupt("fixture-session");
    assert.equal((await turn).status, "interrupted");
    assert.deepEqual(await answer, { answers: {} });
    assert.equal(adapter.running.size, 0);
  } finally {
    JsonlRpcClient.start = originalStart;
  }
});

test("Claude SDK answers use full question text rather than header, and permit native Other input", async () => {
  const adapter = new ClaudeAgentSdkAdapter(adapterOptions);
  const handler = adapter.permissionHandler(sink({ askUser: async () => ({ 0: { answers: ["B"] } }) }));
  const input = { questions: [{ header: "Runtime", question: "Which runtime?", options: choices.questions[0].options }] };
  assert.deepEqual(await handler("AskUserQuestion", input, { signal: new AbortController().signal }), {
    behavior: "allow", updatedInput: { ...input, answers: { "Which runtime?": "B" } },
  });
  const custom = await adapter.permissionHandler(sink({ askUser: async () => ({ 0: { answers: ["My own runtime"] } }) }))(
    "AskUserQuestion", input, { signal: new AbortController().signal });
  assert.equal(custom.updatedInput.answers["Which runtime?"], "My own runtime");
  for (const output of [sink(), sink({ askUser: async () => ({}) }), sink({ askUser: async () => ({ 0: { answers: ["A", "B"] } }) })]) {
    const result = await adapter.permissionHandler(output)("AskUserQuestion", input, { signal: new AbortController().signal });
    assert.equal(result.behavior, "deny");
    assert.equal(result.updatedInput, undefined);
  }
});

test("Claude complete multi-question answers retain native multi-select format and reject ambiguous keys", async () => {
  const adapter = new ClaudeAgentSdkAdapter(adapterOptions);
  const input = { questions: [
    { header: "Runtime", question: "Which runtime?", options: choices.questions[0].options },
    { header: "Checks", question: "Which checks?", options: [{ label: "Build", description: "Compile" },
      { label: "Test", description: "Verify" }], multiSelect: true },
  ] };
  const complete = { 0: { answers: ["B"] }, 1: { answers: ["Build", "Test"] } };
  assert.deepEqual(await adapter.permissionHandler(sink({ askUser: async () => complete }))(
    "AskUserQuestion", input, { signal: new AbortController().signal }), {
    behavior: "allow", updatedInput: { ...input, answers: { "Which runtime?": "B", "Which checks?": "Build, Test" } },
  });
  let projected = 0;
  const output = sink({ askUser: async () => { projected++; return complete; } });
  for (const questions of [
    [input.questions[0], { ...input.questions[0], header: "Duplicate" }],
    [{ ...input.questions[0], question: "__proto__" }],
    [{ ...input.questions[0], question: "constructor" }],
    [{ ...input.questions[0], question: "prototype" }],
  ]) assert.equal((await adapter.permissionHandler(output)("AskUserQuestion", { questions },
    { signal: new AbortController().signal })).behavior, "deny");
  assert.equal(projected, 0, "duplicate/prototype native keys are never projected");
  assert.equal((await adapter.permissionHandler(sink({ askUser: async () => ({ 0: { answers: ["B"] } }) }))(
    "AskUserQuestion", input, { signal: new AbortController().signal })).behavior, "deny", "partial Claude form is not approval");
});
