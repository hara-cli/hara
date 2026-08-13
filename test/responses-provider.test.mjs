import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createResponsesProvider, toResponsesInput } from "../dist/providers/responses.js";

function listen(events) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end(); // Responses streams end with a terminal event, never data:[DONE].
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, requests, baseURL: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

function completed(output = [], usage = { input_tokens: 17, output_tokens: 9 }, sequenceNumber = 99) {
  return {
    type: "response.completed",
    sequence_number: sequenceNumber,
    response: { id: "resp_test", status: "completed", output, usage },
  };
}

test("toResponsesInput replays durable tool history and never reads images on a text-only endpoint", () => {
  const input = toResponsesInput([
    {
      role: "user",
      content: "inspect this",
      images: [{ path: "/definitely/not/read.png", mediaType: "image/png" }],
    },
    {
      role: "assistant",
      text: "I will inspect it.",
      toolUses: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }],
      continuation: {
        type: "responses_reasoning",
        items: [{
          type: "reasoning",
          id: "reason_1",
          summary: [],
          content: [{ type: "reasoning_text", text: "I should inspect the readme." }],
          status: "completed",
        }],
      },
    },
    {
      role: "tool",
      results: [{ id: "call_1", name: "read_file", content: "hello" }],
    },
  ], false);

  assert.deepEqual(input, [
    {
      role: "user",
      content: "inspect this\n\n[Image attachment omitted: this Responses endpoint accepts text only.]",
    },
    {
      type: "reasoning",
      id: "reason_1",
      summary: [],
      content: [{ type: "reasoning_text", text: "I should inspect the readme." }],
      status: "completed",
    },
    { role: "assistant", content: "I will inspect it." },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
    { type: "function_call_output", call_id: "call_1", output: "hello" },
  ]);
});

test("toResponsesInput preserves a structured image description for text-only replay", () => {
  assert.deepEqual(toResponsesInput([{
    role: "user",
    content: "inspect this",
    images: [{ path: "/definitely/not/read.png", mediaType: "image/png" }],
    imageDescription: "a red warning banner",
  }], false), [{
    role: "user",
    content: "inspect this\n\n[Attached image description]\na red warning banner",
  }]);
});

for (const deepSeekModel of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
test(`Responses transport consumes semantic SSE and function calls for ${deepSeekModel}`, async () => {
  const events = [
    { type: "response.created", sequence_number: 0, response: { id: "resp_test", status: "in_progress" } },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "reason_1", type: "reasoning", summary: [], content: [], status: "in_progress" },
    },
    { type: "response.reasoning_text.delta", sequence_number: 2, item_id: "reason_1", output_index: 0, delta: "thinking" },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: {
        id: "reason_1",
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "thinking" }],
        status: "completed",
      },
    },
    { type: "response.output_text.delta", sequence_number: 4, item_id: "msg_1", output_index: 1, delta: "Ready" },
    { type: "response.output_text.done", sequence_number: 5, item_id: "msg_1", output_index: 1, text: "Ready" },
    {
      type: "response.output_item.added",
      sequence_number: 6,
      output_index: 2,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", sequence_number: 7, item_id: "fc_1", output_index: 2, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", sequence_number: 8, item_id: "fc_1", output_index: 2, delta: '"README.md"}' },
    { type: "response.function_call_arguments.done", sequence_number: 9, item_id: "fc_1", output_index: 2, name: "read_file", arguments: '{"path":"README.md"}' },
    {
      type: "response.output_item.done",
      sequence_number: 10,
      output_index: 2,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
    },
    completed([
      {
        id: "reason_1",
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "thinking" }],
        status: "completed",
      },
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready" }] },
      { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
    ]),
  ];
  const mock = await listen(events);
  try {
    const text = [];
    const reasoning = [];
    let activity = 0;
    const provider = createResponsesProvider({
      apiKey: "test-key",
      baseURL: mock.baseURL,
      model: deepSeekModel,
      label: "deepseek",
      reasoningEffort: "high",
      reasoningStyle: "deepseek_responses",
      supportsImages: false,
    });
    const result = await provider.turn({
      system: "Be precise.",
      history: [{ role: "user", content: "Open the readme" }],
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
      onText: (delta) => text.push(delta),
      onReasoning: (delta) => reasoning.push(delta),
      onActivity: () => activity++,
    });

    assert.equal(result.text, "Ready", "terminal output recovery must not duplicate streamed text");
    assert.deepEqual(text, ["Ready"]);
    assert.deepEqual(reasoning, ["thinking"]);
    assert.deepEqual(result.toolUses, [{ id: "call_1", name: "read_file", input: { path: "README.md" } }]);
    assert.deepEqual(result.continuation, {
      type: "responses_reasoning",
      items: [{
        id: "reason_1",
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: "thinking" }],
        status: "completed",
      }],
    });
    assert.equal(result.stop, "tool_use");
    assert.deepEqual(result.usage, { input: 17, output: 9 });
    assert.equal(activity, events.length);

    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0];
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.authorization, "Bearer test-key");
    assert.equal(request.body.model, deepSeekModel);
    assert.equal(request.body.instructions, "Be precise.");
    assert.deepEqual(request.body.reasoning, { effort: "high" });
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, undefined);
    assert.equal(request.body.previous_response_id, undefined);
    assert.equal(request.body.conversation, undefined);
    assert.equal(request.body.parallel_tool_calls, undefined);
    assert.deepEqual(request.body.tools, [{
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
    }]);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
}

test("Responses transport treats incomplete and missing terminal events as errors", async (t) => {
  await t.test("incomplete", async () => {
    const mock = await listen([{
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        id: "resp_short",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: { input_tokens: 3, output_tokens: 32 },
      },
    }]);
    try {
      const result = await createResponsesProvider({
        apiKey: "test-key",
        baseURL: mock.baseURL,
        model: "deepseek-v4-flash",
      }).turn({ system: "test", history: [], tools: [], onText() {} });
      assert.equal(result.stop, "error");
      assert.match(result.errorMsg, /incomplete \(max_output_tokens\)/i);
      assert.deepEqual(result.usage, { input: 3, output: 32 });
    } finally {
      await new Promise((resolve) => mock.server.close(resolve));
    }
  });

  await t.test("no terminal event", async () => {
    const mock = await listen([{
      type: "response.output_text.delta",
      sequence_number: 0,
      item_id: "msg_1",
      delta: "partial",
    }]);
    try {
      const result = await createResponsesProvider({
        apiKey: "test-key",
        baseURL: mock.baseURL,
        model: "test-model",
      }).turn({ system: "test", history: [], tools: [], onText() {} });
      assert.equal(result.stop, "error");
      assert.match(result.errorMsg, /ended before response\.completed/i);
    } finally {
      await new Promise((resolve) => mock.server.close(resolve));
    }
  });
});

test("Responses transport preserves usage and redacts server diagnostics on failed terminal events", async () => {
  const apiKey = "opaque-provider-key-ce81";
  const mock = await listen([{
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: "resp_failed",
      status: "failed",
      error: { message: `tool choice is unsupported; Authorization: Bearer ${apiKey}` },
      output: [],
      usage: { input_tokens: 11, output_tokens: 2 },
    },
  }]);
  try {
    const result = await createResponsesProvider({
      apiKey,
      baseURL: mock.baseURL,
      model: "deepseek-v4-pro",
    }).turn({ system: "test", history: [], tools: [], onText() {} });
    assert.equal(result.stop, "error");
    assert.equal(result.errorMsg, "tool choice is unsupported; Authorization: Bearer ***");
    assert.doesNotMatch(result.errorMsg, /ce81|opaque-provider-key/);
    assert.deepEqual(result.usage, { input: 11, output: 2 });
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }
});

test("Responses transport fails closed on a regressing sequence number", async () => {
  const mock = await listen([
    { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, delta: "unsafe" },
    { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", output_index: 0, delta: " duplicate" },
    completed([], { input_tokens: 2, output_tokens: 2 }, 3),
  ]);
  try {
    const result = await createResponsesProvider({
      apiKey: "test-key",
      baseURL: mock.baseURL,
      model: "deepseek-v4-pro",
    }).turn({ system: "test", history: [], tools: [], onText() {} });
    assert.equal(result.stop, "error");
    assert.match(result.errorMsg, /sequence_number/i);
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }
});

test("Responses transport fails closed when output arrives after a terminal event", async () => {
  const mock = await listen([
    completed([], { input_tokens: 1, output_tokens: 0 }, 0),
    { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", output_index: 0, delta: "late" },
  ]);
  try {
    const emitted = [];
    const result = await createResponsesProvider({
      apiKey: "test-key",
      baseURL: mock.baseURL,
      model: "deepseek-v4-pro",
    }).turn({ system: "test", history: [], tools: [], onText: (delta) => emitted.push(delta) });
    assert.equal(result.stop, "error");
    assert.match(result.errorMsg, /after response\.completed/i);
    assert.deepEqual(emitted, [], "late output is rejected before it reaches the UI");
  } finally {
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
