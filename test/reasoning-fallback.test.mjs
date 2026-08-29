import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReasoningParams,
  classifyReasoningRejection,
  reasoningRouteKey,
  reasoningUnsupported,
  resetReasoningSupport,
  sendWithReasoningFallback,
} from "../dist/providers/reasoning-fallback.js";

const rejection = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

test("classifies only rejections attributable to the parameters we sent", () => {
  const sent = ["enable_thinking"];
  // The endpoint names our field → attributable.
  assert.equal(classifyReasoningRejection(rejection("Unknown parameter: 'enable_thinking'."), sent), "named");
  // It rejects an unnamed extra field → worth one retry, but not worth remembering.
  assert.equal(classifyReasoningRejection(rejection("Unsupported parameter in request body"), sent), "generic");
  assert.equal(classifyReasoningRejection(rejection("不支持的参数"), sent), "generic");
  // A real 400 about something else must surface as itself.
  assert.equal(classifyReasoningRejection(rejection("model `qwen9` does not exist"), sent), null);
  assert.equal(classifyReasoningRejection(rejection("input too long"), sent), null);
  // Server-side failures are never ours, whatever they say.
  assert.equal(classifyReasoningRejection(rejection("unknown parameter", 503), sent), null);
  // Nothing of ours in the body → nothing to attribute.
  assert.equal(classifyReasoningRejection(rejection("Unknown parameter: 'reasoning'."), []), null);
  // The nested Responses shape names the field on the error object rather than the message.
  assert.equal(
    classifyReasoningRejection(rejection("Invalid request", 400, { error: { param: "reasoning" } }), ["reasoning"]),
    "named",
  );
});

test("a named rejection retries without the reasoning keys and remembers the route", async () => {
  resetReasoningSupport();
  const route = reasoningRouteKey("token-plan", "https://example.invalid/v1", "qwen3.7-plus", "alibaba_responses");
  const params = { model: "qwen3.7-plus", input: "hi" };
  const keys = applyReasoningParams(params, { enable_thinking: false }, route);
  assert.deepEqual(keys, ["enable_thinking"]);
  assert.equal(params.enable_thinking, false);

  const bodies = [];
  const result = await sendWithReasoningFallback(route, params, keys, async (body) => {
    bodies.push(body);
    if ("enable_thinking" in body) throw rejection("Unknown parameter: 'enable_thinking'.");
    return "ok";
  }, { allowRemoval: true });

  assert.equal(result, "ok");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].model, "qwen3.7-plus"); // the retry is the same request minus the optimization
  assert.equal("enable_thinking" in bodies[1], false);

  // The route is remembered, so the next turn never pays for the rejected round trip again.
  assert.equal(reasoningUnsupported(route), true);
  const next = { model: "qwen3.7-plus" };
  assert.deepEqual(applyReasoningParams(next, { enable_thinking: false }, route), []);
  assert.equal("enable_thinking" in next, false);
  resetReasoningSupport();
});

test("an explicit reasoning choice fails visibly instead of retrying with the provider default", async () => {
  resetReasoningSupport();
  const route = reasoningRouteKey("token-plan", "https://example.invalid/v1", "qwen3.7-plus", "alibaba_responses");
  const params = { model: "qwen3.7-plus" };
  const keys = applyReasoningParams(params, { enable_thinking: false }, route);
  let calls = 0;
  await assert.rejects(
    sendWithReasoningFallback(route, params, keys, async () => {
      calls += 1;
      throw rejection("Unknown parameter: 'enable_thinking'.");
    }),
    /enable_thinking/,
  );
  assert.equal(calls, 1);
  assert.equal(reasoningUnsupported(route), false, "a failed explicit choice is not remembered as permission to omit it");
  resetReasoningSupport();
});

test("an unattributable failure is rethrown untouched and never marks the route", async () => {
  resetReasoningSupport();
  const route = reasoningRouteKey("openai", undefined, "gpt-5", "reasoning_object");
  const params = {};
  const keys = applyReasoningParams(params, { reasoning: { effort: "low" } }, route);
  let calls = 0;
  await assert.rejects(
    sendWithReasoningFallback(route, params, keys, async () => {
      calls += 1;
      throw rejection("insufficient_quota: check your plan", 400);
    }),
    /insufficient_quota/,
  );
  assert.equal(calls, 1); // no speculative retry on an error that is not ours
  assert.equal(reasoningUnsupported(route), false);
  resetReasoningSupport();
});

test("a generic rejection retries once but does not poison the route memory", async () => {
  resetReasoningSupport();
  const route = reasoningRouteKey("custom", "https://strict.invalid/v1", "m", "reasoning_effort");
  const params = { model: "m" };
  const keys = applyReasoningParams(params, { reasoning_effort: "minimal" }, route);
  let calls = 0;
  const result = await sendWithReasoningFallback(route, params, keys, async (body) => {
    calls += 1;
    if ("reasoning_effort" in body) throw rejection("Unrecognized field in request");
    return "ok";
  }, { allowRemoval: true });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(reasoningUnsupported(route), false); // the offending field may have been someone else's
  resetReasoningSupport();
});
