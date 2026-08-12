import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createProviderForTarget } from "../dist/providers/factory.js";

const OFFICIAL_DEEPSEEK_BASE = "https://api.deepseek.com";
const PROXY_ENV_KEYS = [
  "HARA_MODEL_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
];

function clearProxyEnvironment() {
  const previous = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function rewriteDeepSeekTo(localBaseURL, nativeFetch) {
  return async (input, init) => {
    const source = input instanceof Request ? input.url : String(input);
    const url = new URL(source);
    assert.equal(url.hostname, "api.deepseek.com");
    return nativeFetch(`${localBaseURL}${url.pathname}${url.search}`, init);
  };
}

test("official DeepSeek V4 Pro factory uses Responses and preserves explicit off via Chat", async (t) => {
  const restoreEnvironment = clearProxyEnvironment();
  let requestPath;
  let requestBody;
  const server = createServer((request, response) => {
    requestPath = request.url;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (request.url === "/responses") {
        response.end(
          "event: response.output_text.delta\n"
          + 'data: {"type":"response.output_text.delta","sequence_number":0,"item_id":"msg_1","output_index":0,"delta":"ok"}\n\n'
          + "event: response.completed\n"
          + 'data: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_pro","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        );
        return;
      }
      response.end([
        'data: {"id":"chat_pro","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
        "",
        'data: {"id":"chat_pro","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = rewriteDeepSeekTo(`http://127.0.0.1:${address.port}`, originalFetch);
  try {
    await t.test("high uses Responses reasoning", async () => {
      const provider = await createProviderForTarget({
        provider: "deepseek",
        apiKey: "synthetic-deepseek-key",
        model: "deepseek-v4-pro",
        baseURL: OFFICIAL_DEEPSEEK_BASE,
      }, "high");
      assert.ok(provider);
      const result = await provider.turn({
        system: "reply ok",
        history: [{ role: "user", content: "ok" }],
        tools: [],
        onText: () => {},
      });
      assert.equal(result.stop, "end", result.errorMsg);
      assert.equal(requestPath, "/responses");
      assert.equal(requestBody.model, "deepseek-v4-pro");
      assert.deepEqual(requestBody.reasoning, { effort: "high" });
      assert.equal(requestBody.previous_response_id, undefined);
      assert.equal(requestBody.store, undefined);
    });

    await t.test("off uses Chat thinking.disabled", async () => {
      const provider = await createProviderForTarget({
        provider: "deepseek",
        apiKey: "synthetic-deepseek-key",
        model: "deepseek-v4-pro",
        baseURL: OFFICIAL_DEEPSEEK_BASE,
      }, "off");
      assert.ok(provider);
      const result = await provider.turn({
        system: "reply ok",
        history: [{ role: "user", content: "ok" }],
        tools: [],
        onText: () => {},
      });
      assert.equal(result.stop, "end", result.errorMsg);
      assert.equal(requestPath, "/chat/completions");
      assert.deepEqual(requestBody.thinking, { type: "disabled" });
      assert.equal(requestBody.reasoning_effort, undefined);
    });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
    server.close();
    await once(server, "close");
  }
});
