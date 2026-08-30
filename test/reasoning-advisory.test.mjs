import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createResponsesProvider } from "../dist/providers/responses.js";
import { resetReasoningSupport } from "../dist/providers/reasoning-fallback.js";

/** A strict endpoint: it rejects the thinking field by name, and only answers once it is gone. */
function strictEndpoint() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push(body);
      if (body && "enable_thinking" in body) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Unknown parameter: 'enable_thinking'." } }));
        return;
      }
      const event = {
        type: "response.completed",
        sequence_number: 0,
        response: {
          id: "resp_test",
          status: "completed",
          output: [{ type: "message", id: "msg_1", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

const provider = (mock, extra) => createResponsesProvider({
  apiKey: "test-key",
  baseURL: mock.baseURL,
  model: "qwen3.7-plus",
  reasoningEffort: "off",
  reasoningStyle: "alibaba_responses",
  ...extra,
});

const turn = (p) => p.turn({ system: "t", history: [{ role: "user", content: "classify" }], tools: [], onText() {} });

test("an engine-chosen level is dropped and retried when the endpoint rejects it by name", async () => {
  resetReasoningSupport();
  const mock = await strictEndpoint();
  try {
    const result = await turn(provider(mock, { reasoningAdvisory: true }));
    assert.equal(result.stop, "end", "the automation completes instead of failing on a rejected optimization");
    assert.equal(result.text, "ok");
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0].enable_thinking, false);
    assert.equal("enable_thinking" in mock.requests[1], false);

    // The route is remembered, so the next turn skips the rejected field entirely — one round trip.
    const again = await turn(provider(mock, { reasoningAdvisory: true }));
    assert.equal(again.stop, "end");
    assert.equal(mock.requests.length, 3);
    assert.equal("enable_thinking" in mock.requests[2], false);
  } finally {
    resetReasoningSupport();
    await new Promise((resolve) => mock.server.close(resolve));
  }
});

test("an explicit level fails visibly rather than silently restoring the provider default", async () => {
  resetReasoningSupport();
  const mock = await strictEndpoint();
  try {
    const result = await turn(provider(mock, {})); // no reasoningAdvisory → a user/rule contract
    assert.equal(result.stop, "error");
    assert.equal(mock.requests.length, 1, "no speculative retry behind the user's back");
    assert.equal(mock.requests[0].enable_thinking, false);
  } finally {
    resetReasoningSupport();
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
