import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../dist/agent/loop.js";
import { createOpenAIProvider } from "../dist/providers/openai.js";

function sse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-chat",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

test("chat requests keep a byte-stable system prompt and an append-only prefix across tool rounds", async () => {
  const bodies = [];
  const responses = [
    () => sse([
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "fixture_read", arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
    ]),
    () => sse([chunk({ role: "assistant", content: "all good" }), chunk({}, "stop")]),
  ];
  const provider = createOpenAIProvider({
    apiKey: "fixture-key",
    baseURL: "http://127.0.0.1:9/v1",
    model: "fixture-chat",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return responses[Math.min(bodies.length - 1, responses.length - 1)]();
    },
  });
  const history = [{ role: "user", content: "check the fixture" }];
  const outcome = await runAgent(history, {
    provider,
    ctx: { cwd: process.cwd() },
    approval: "full-auto",
    confirm: async () => true,
    quiet: true,
    extraTools: [{
      name: "fixture_read",
      description: "test-only read",
      input_schema: { type: "object", properties: {} },
      kind: "read",
      async run() { return "fixture value"; },
    }],
  });

  assert.equal(outcome.status, "completed", outcome.error);
  assert.equal(bodies.length, 2);
  const [first, second] = bodies.map((body) => body.messages);
  assert.equal(first[0].role, "system");
  assert.equal(second[0].content, first[0].content, "a clock tick must not rewrite the cached system prefix");
  assert.doesNotMatch(first[0].content, /Runtime date and time/);
  for (const messages of [first, second]) {
    assert.equal(messages.at(-1).role, "user");
    assert.match(messages.at(-1).content, /^<system-reminder>\n# Engine turn context\n[\s\S]*Runtime date and time/);
  }
  // Everything before the first request's trailing context is resent unchanged, in place: the provider's
  // prefix cache can cover the whole earlier conversation instead of stopping at the system prompt.
  assert.deepEqual(second.slice(0, first.length - 1), first.slice(0, -1));
  assert.equal(second.length, first.length + 2, "only the tool round was appended behind the cached prefix");
  assert.equal(
    history.some((message) => message.role === "user" && message.content.includes("# Engine turn context")),
    false,
  );
});
