import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeActionWithTypeSafe,
  parseTypeSafeActionJudgment,
} from "../dist/decision/typesafe.js";

test("parseTypeSafeActionJudgment keeps confident choices and reviews every low-confidence hard decision", () => {
  assert.deepEqual(
    parseTypeSafeActionJudgment({
      answers: {
        action_guard: {
          choice: "allow",
          confidence: 0.91,
          probabilities: { allow: 0.91, review: 0.07, block: 0.02 },
        },
      },
    }, "jev-test"),
    {
      choice: "allow",
      decision: "allow",
      confidence: 0.91,
      probabilities: { allow: 0.91, review: 0.07, block: 0.02 },
      model: "jev-test",
    },
  );
  assert.equal(parseTypeSafeActionJudgment({
    answers: { action_guard: { choice: "allow", confidence: 0.42 } },
  }).decision, "review");
  assert.equal(parseTypeSafeActionJudgment({
    answers: { action_guard: { choice: "block", confidence: 0.42 } },
  }).decision, "review");
  assert.equal(parseTypeSafeActionJudgment({
    answers: { action_guard: { choice: "block", confidence: 0.42 } },
  }).choice, "block");
  assert.equal(parseTypeSafeActionJudgment({
    model: "jev-1.13.0",
    answers: { action_guard: { choice: "allow", confidence: 0.91 } },
  }, "jev-latest").model, "jev-1.13.0");
  assert.throws(
    () => parseTypeSafeActionJudgment({ answers: { action_guard: { choice: "maybe" } } }),
    /unknown choice/u,
  );
});

test("judgeActionWithTypeSafe sends one structured, bounded and secret-redacted request", async () => {
  let capturedUrl = "";
  let capturedInit;
  const fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        action_guard: {
          choice: "review",
          confidence: 0.74,
          probabilities: { allow: 0.18, review: 0.74, block: 0.08 },
        },
      },
      usage: { input_tokens: 321, output_tokens: 24 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const judgment = await judgeActionWithTypeSafe(
    {
      mode: "shadow",
      apiKey: "typesafe-test-key",
      baseURL: "https://decision.example/custom/",
      model: "jev-pinned",
    },
    {
      task: "Send a short test reply",
      tool: "channel_message",
      category: "external_communication",
      classifierReason: "external communication",
      detail: "operation=send channel=weixin message=apiKey=sk-secretsecret",
    },
    { fetch },
  );
  assert.equal(capturedUrl, "https://decision.example/custom/v1/systemone");
  assert.equal(capturedInit.headers.authorization, "Bearer typesafe-test-key");
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, "jev-pinned");
  assert.equal(body.state.action.tool, "channel_message");
  assert.equal(body.state.action.category, "external_communication");
  assert.doesNotMatch(body.state.action.detail, /sk-secretsecret/u);
  assert.equal(Object.keys(body.questions).length, 1, "all action judgment stays in one Jev request");
  assert.equal(judgment.decision, "review");
  assert.equal(judgment.choice, "review");
  assert.equal(judgment.confidence, 0.74);
  assert.deepEqual(judgment.probabilities, { allow: 0.18, review: 0.74, block: 0.08 });
  assert.equal(judgment.model, "jev-1.13.0");
  assert.equal(typeof judgment.elapsedMs, "number");
  assert.deepEqual(judgment.usage, { inputTokens: 321, outputTokens: 24 });
});

test("judgeActionWithTypeSafe never sends without an explicit credential", async () => {
  let calls = 0;
  await assert.rejects(
    () => judgeActionWithTypeSafe(
      { mode: "shadow" },
      { task: "x", tool: "computer", category: "computer_action", classifierReason: "x", detail: "x" },
      { fetch: async () => { calls += 1; return new Response("{}"); } },
    ),
    /key is not configured/u,
  );
  assert.equal(calls, 0);
});

test("judgeActionWithTypeSafe rejects remote plaintext endpoints before sending credentials", async () => {
  let calls = 0;
  await assert.rejects(
    () => judgeActionWithTypeSafe(
      { mode: "shadow", apiKey: "must-not-leak", baseURL: "http://decision.example" },
      { task: "x", tool: "computer", category: "computer_action", classifierReason: "x", detail: "x" },
      { fetch: async () => { calls += 1; return new Response("{}"); } },
    ),
    /must use HTTPS except on loopback/u,
  );
  assert.equal(calls, 0);
});
