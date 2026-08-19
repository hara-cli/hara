import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  overrideProviderTarget,
  resolveByokProviderTarget,
  resolveGatewayModel,
} from "../dist/providers/target.js";
import { createProviderForTarget } from "../dist/providers/factory.js";

const personalConfig = {
  provider: "openai",
  apiKey: "personal-openai-key",
  model: "personal-model",
  baseURL: "https://personal.example/v1",
  approval: "suggest",
  sandbox: "off",
  theme: "dark",
  evolve: "off",
  assetCapture: "off",
  computerUse: "off",
  computerApps: [],
  modelVision: {},
  embedProvider: "local",
  guardian: "on",
  hooks: {},
  notify: "off",
  runTimeoutMs: 30 * 60_000,
  maxAgentRounds: 64,
  vimMode: false,
  autoCompact: true,
  fileCheckpoints: true,
  updateCheck: true,
  mcpServers: {},
  cwd: "/tmp/project",
};

test("named BYOK profile is the routing source of truth over personal/global config", () => {
  const target = resolveByokProviderTarget(
    personalConfig,
    {
      id: "work",
      kind: "byok",
      provider: "deepseek",
      apiKey: "work-only-key",
      baseURL: "https://work.example/v1",
      defaultModel: "work-model",
    },
    false,
    {},
  );
  assert.deepEqual(target, {
    provider: "deepseek",
    apiKey: "work-only-key",
    baseURL: "https://work.example/v1",
    model: "work-model",
  });
});

test("explicit runtime environment can override a named profile without replaying the personal key", () => {
  const target = resolveByokProviderTarget(
    personalConfig,
    {
      id: "work",
      kind: "byok",
      provider: "deepseek",
      apiKey: "work-only-key",
      baseURL: "https://work.example/v1",
      defaultModel: "work-model",
    },
    false,
    {
      HARA_API_KEY: "one-shot-key",
      HARA_BASE_URL: "https://one-shot.example/v1",
      HARA_MODEL: "one-shot-model",
    },
  );
  assert.equal(target.provider, "deepseek");
  assert.equal(target.apiKey, "one-shot-key");
  assert.equal(target.baseURL, "https://one-shot.example/v1");
  assert.equal(target.model, "one-shot-model");
  assert.notEqual(target.apiKey, personalConfig.apiKey);
});

test("HARA_PROVIDER override never replays the named profile's vendor-specific route", () => {
  const target = resolveByokProviderTarget(
    personalConfig,
    {
      id: "work",
      kind: "byok",
      provider: "deepseek",
      apiKey: "deepseek-only-key",
      baseURL: "https://api.deepseek.com",
      defaultModel: "deepseek-chat",
    },
    false,
    { HARA_PROVIDER: "ollama" },
  );
  assert.deepEqual(target, {
    provider: "ollama",
    apiKey: undefined,
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen3",
  });
});

test("personal and explicit sidecar targets still use merged config", () => {
  const personal = resolveByokProviderTarget(
    personalConfig,
    { id: "personal", kind: "byok", provider: "anthropic", defaultModel: "old-model" },
    false,
    {},
  );
  assert.equal(personal.provider, "openai");
  assert.equal(personal.apiKey, "personal-openai-key");
  assert.equal(personal.model, "personal-model");

  const sidecar = resolveByokProviderTarget(
    { ...personalConfig, provider: "glm", apiKey: "sidecar-key", model: "vision", baseURL: "https://vision.example/v1" },
    { id: "work", kind: "byok", provider: "deepseek", apiKey: "work-only-key", defaultModel: "work-model" },
    true,
    {},
  );
  assert.equal(sidecar.provider, "glm");
  assert.equal(sidecar.apiKey, "sidecar-key");
  assert.equal(sidecar.model, "vision");
});

test("legacy Qwen/OpenAI profiles on the exact Token Plan endpoint canonicalize without losing their saved key", () => {
  const target = resolveByokProviderTarget(
    personalConfig,
    {
      id: "token-plan-old",
      kind: "byok",
      provider: "qwen",
      apiKey: "subscription-key",
      baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      defaultModel: "glm-5",
    },
    false,
    {},
  );
  assert.deepEqual(target, {
    provider: "token-plan",
    apiKey: "subscription-key",
    baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "glm-5",
  });
});

test("local targets discard flat and environment cloud credentials", () => {
  const target = resolveByokProviderTarget(
    {
      ...personalConfig,
      provider: "ollama",
      apiKey: "stale-cloud-key",
      model: "qwen3",
      baseURL: "http://127.0.0.1:11434/v1",
    },
    {
      id: "personal",
      kind: "byok",
      provider: "ollama",
      apiKey: "another-stale-key",
      defaultModel: "qwen3",
    },
    false,
    { HARA_API_KEY: "environment-cloud-key" },
  );
  assert.equal(target.provider, "ollama");
  assert.equal(target.apiKey, undefined);
});

test("an explicit session model override preserves a named profile's key and endpoint", () => {
  const base = resolveByokProviderTarget(
    personalConfig,
    {
      id: "work",
      kind: "byok",
      provider: "deepseek",
      apiKey: "work-only-key",
      baseURL: "https://work.example/v1",
      defaultModel: "work-default",
    },
    false,
    {},
  );
  assert.deepEqual(overrideProviderTarget(base, { model: "work-session-model" }), {
    provider: "deepseek",
    apiKey: "work-only-key",
    baseURL: "https://work.example/v1",
    model: "work-session-model",
  });
});

test("gateway profile model wins over the Personal/global model unless HARA_MODEL is explicit", () => {
  const gateway = {
    id: "organization",
    kind: "gateway",
    gatewayUrl: "https://gateway.example",
    deviceToken: "device-token",
    defaultModel: "organization-model",
  };
  assert.equal(resolveGatewayModel(personalConfig, gateway, {}), "organization-model");
  assert.equal(
    resolveGatewayModel(personalConfig, gateway, { HARA_MODEL: "one-shot-gateway-model" }),
    "one-shot-gateway-model",
  );
  assert.equal(
    resolveGatewayModel(personalConfig, gateway, {}, "session-selected-model"),
    "session-selected-model",
  );
});

test("local provider factory omits Authorization on the wire", async () => {
  let authorization;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"id":"local-1","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      "",
      'data: {"id":"local-1","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = await createProviderForTarget({
      provider: "ollama",
      model: "local",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    assert.ok(provider);
    const result = await provider.turn({
      system: "reply ok",
      history: [{ role: "user", content: "ok" }],
      tools: [],
      onText: () => {},
    });
    assert.equal(result.stop, "end");
    assert.equal(authorization, undefined);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("managed DeepSeek V4 gateway sends the selected native thinking controls on the wire", async () => {
  let authorization;
  let requestBody;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'data: {"id":"managed-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        "",
        'data: {"id":"managed-1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = await createProviderForTarget({
      provider: "hara-gateway",
      apiKey: "scoped-device-token",
      model: "deepseek-v4-pro",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }, "max");
    assert.ok(provider);
    const result = await provider.turn({
      system: "reply ok",
      history: [{ role: "user", content: "ok" }],
      tools: [],
      onText: () => {},
    });
    assert.equal(result.stop, "end");
    assert.equal(authorization, "Bearer scoped-device-token");
    assert.equal(requestBody.model, "deepseek-v4-pro");
    assert.deepEqual(requestBody.thinking, { type: "enabled" });
    assert.equal(requestBody.reasoning_effort, "max");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("managed DeepSeek gateway preserves reasoning across a tool-call continuation", async () => {
  const requestBodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestBodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestBodies.length === 1) {
        response.end([
          'data: {"id":"managed-tool","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I should inspect the file.","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}',
          "",
          'data: {"id":"managed-tool","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"));
        return;
      }
      response.end([
        'data: {"id":"managed-done","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}',
        "",
        'data: {"id":"managed-done","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = await createProviderForTarget({
      provider: "hara-gateway",
      apiKey: "scoped-device-token",
      model: "deepseek-v4-flash",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }, "high");
    assert.ok(provider);
    const first = await provider.turn({
      system: "inspect",
      history: [{ role: "user", content: "inspect README" }],
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
      onText: () => {},
    });
    assert.equal(first.stop, "tool_use");
    assert.deepEqual(first.continuation, { type: "chat_reasoning", text: "I should inspect the file." });

    const second = await provider.turn({
      system: "inspect",
      history: [
        { role: "user", content: "inspect README" },
        { role: "assistant", text: first.text, toolUses: first.toolUses, continuation: first.continuation },
        { role: "tool", results: [{ id: "call-1", name: "read_file", content: "hello" }] },
      ],
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
      onText: () => {},
    });
    assert.equal(second.stop, "end");
    assert.equal(requestBodies[1].messages[2].reasoning_content, "I should inspect the file.");
    assert.equal(requestBodies[1].messages[2].tool_calls[0].id, "call-1");
  } finally {
    server.close();
    await once(server, "close");
  }
});
