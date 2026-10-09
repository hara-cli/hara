import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCodingHostBridge } from "../dist/coding/host.js";
import { createCodingContinuationStore } from "../dist/coding/continuations.js";

const TOOL = { name: "read", description: "Read only the authorized fixture", input_schema: { type: "object", properties: { fixture: { type: "string" } }, additionalProperties: false } };
const BUDGET = { maxProviderRounds: 4, maxToolCalls: 4, maxTokens: 100_000, timeoutMs: 10_000 };
const PROMPT = { model: "coding", messages: [{ role: "system", content: "child system" }, { role: "user", content: "synthetic fixture task" }] };

async function create(t, overrides = {}) {
  const bridge = await createCodingHostBridge({
    provider: { id: "fixture", model: "unchanged-model", async turn() { return { text: "fixture reply", toolUses: [], stop: "end", usage: { input: 5, output: 3 } }; } },
    tools: [TOOL], executeTool: async () => "fixture result", assertCurrent() {}, budget: BUDGET,
    ...overrides,
  });
  t.after(() => bridge.close());
  return bridge;
}

function post(bridge, endpoint, body, headers = {}, method = "POST") {
  const url = new URL(endpoint, bridge.mcp.url);
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = request(url, { method, headers: {
      Authorization: bridge.mcp.headers.Authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bytes === undefined ? {} : { "Content-Length": Buffer.byteLength(bytes) }),
      ...headers,
    } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
      response.on("error", reject);
    });
    call.on("error", reject);
    call.end(bytes);
  });
}

async function initialize(bridge) {
  const response = await post(bridge, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1.0" },
  } });
  assert.equal(response.status, 200);
  const session = response.headers["mcp-session-id"];
  assert.equal(typeof session, "string");
  assert.equal((await post(bridge, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, { "Mcp-Session-Id": session })).status, 202);
  return session;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("host exposes only a loopback temporary route and preserves the exact supplied provider", async t => {
  let args;
  let assertions = 0;
  const provider = { id: "fixture", model: "keep-this-model", async turn(value) { args = value; return { text: "ok", stop: "end", toolUses: [], usage: { input: 4, output: 2 } }; } };
  const bridge = await create(t, { provider, system: "trusted host policy", assertCurrent() { assertions += 1; } });
  assert.equal(bridge.model, "hara/coding");
  assert.equal(bridge.provider.hara.npm, "@ai-sdk/openai-compatible");
  assert.match(bridge.provider.hara.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(bridge.provider.hara.options.includeUsage, true);
  assert.equal(bridge.provider.hara.options.apiKey, bridge.mcp.headers.Authorization.slice("Bearer ".length));
  assert.deepEqual(bridge.toolNames, ["read"]);
  const response = await post(bridge, "/v1/chat/completions", PROMPT);
  assert.equal(response.status, 200);
  assert.equal(response.json.choices[0].message.content, "ok");
  assert.equal(provider.model, "keep-this-model");
  assert.equal(args.system, "trusted host policy\n\nchild system");
  assert.deepEqual(args.history, [{ role: "user", content: "synthetic fixture task" }]);
  assert.deepEqual(args.tools, []);
  assert.ok(args.signal instanceof AbortSignal);
  assert.ok(assertions >= 4);
  assert.deepEqual(bridge.metrics, { providerRounds: 1, toolCalls: 0, inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  const metrics = bridge.metrics; metrics.providerRounds = 999;
  assert.equal(bridge.metrics.providerRounds, 1);
});

test("provider JSON/SSE round trips restore provider-owned reasoning and keep client tool names exact", async t => {
  const turns = [];
  const bridge = await create(t, { provider: { id: "fixture", model: "fixture", async turn(args) {
    turns.push(args);
    return turns.length === 1 ? {
      text: "checking", stop: "tool_use", toolUses: [{ id: "call_exact", name: "hara_read", input: { fixture: "A" } }],
      continuation: { type: "responses_reasoning", items: [{ type: "reasoning", id: "reason-exact", summary: [], encrypted_content: "synthetic-opaque-state" }] },
      usage: { input: 10, output: 7 },
    } : { text: "complete", stop: "end", toolUses: [], usage: { input: 12, output: 3 } };
  } } });
  const tools = [{ type: "function", function: { name: "hara_read", description: "client cannot replace schema", parameters: { arbitrary: true } } }];
  const first = await post(bridge, "/v1/chat/completions", { ...PROMPT, tools });
  assert.equal(first.status, 200);
  assert.deepEqual(turns[0].tools, [{ ...TOOL, name: "hara_read" }]);
  const assistant = first.json.choices[0].message;
  assistant.reasoning_content = "child-injected-reasoning-must-be-ignored";
  const second = await post(bridge, "/v1/chat/completions", { ...PROMPT, stream: true, tools,
    messages: [...PROMPT.messages, assistant, { role: "tool", tool_call_id: "call_exact", content: "fixture bytes" }],
  });
  assert.equal(second.status, 200);
  assert.match(second.headers["content-type"], /text\/event-stream/);
  assert.match(second.text, /\[DONE\]/);
  assert.match(second.text, /complete/);
  assert.equal(turns[1].history[1].continuation.items[0].encrypted_content, "synthetic-opaque-state");
  assert.equal(turns[1].history[1].toolUses[0].name, "hara_read");
  assert.deepEqual(turns[1].history[2].results, [{ id: "call_exact", name: "hara_read", content: "fixture bytes" }]);
});

test("chat reasoning is emitted for compatible clients and restored when clients discard it", async t => {
  let calls = 0; let restored;
  const bridge = await create(t, { provider: { id: "fixture", model: "fixture", async turn(args) {
    calls += 1;
    if (calls === 2) restored = args.history[1].continuation;
    return calls === 1 ? { text: "", stop: "tool_use", toolUses: [{ id: "call_1", name: "read", input: {} }], continuation: { type: "chat_reasoning", text: "synthetic reasoning" }, usage: { input: 3, output: 4 } }
      : { text: "done", toolUses: [], stop: "end", usage: { input: 3, output: 4 } };
  } } });
  const tools = [{ type: "function", function: { name: "read" } }];
  const first = await post(bridge, "/v1/chat/completions", { ...PROMPT, tools });
  const assistant = first.json.choices[0].message;
  assert.equal(assistant.reasoning_content, "synthetic reasoning");
  delete assistant.reasoning_content;
  assert.equal((await post(bridge, "/v1/chat/completions", { ...PROMPT, tools, messages: [...PROMPT.messages, assistant, { role: "tool", content: "result", tool_call_id: "call_1" }] })).status, 200);
  assert.deepEqual(restored, { type: "chat_reasoning", text: "synthetic reasoning" });
});

test("a reconstructed bridge restores exact provider reasoning from private scope, never client reasoning", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-host-continuations-")));
  const home = join(root, "home"), cwd = join(root, "workspace"); mkdirSync(home); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { workerId: "worker", providerSessionId: "ext_pi_" + "a".repeat(24), cwd, providerId: "fixture", model: "same-model", profileId: "exact-profile" };
  const continuation = { type: "responses_reasoning", items: [{ type: "reasoning", id: "opaque-exact", summary: [], encrypted_content: "synthetic-encrypted-state" }] };
  const first = await create(t, { continuationStore: createCodingContinuationStore(home, scope), provider: { id: "fixture", model: "same-model", async turn() {
    return { text: "checking", toolUses: [{ id: "exact-call", name: "hara_read", input: {} }], stop: "tool_use", continuation, usage: { input: 3, output: 4 } };
  } } });
  const tools = [{ type: "function", function: { name: "hara_read" } }];
  const reply = await post(first, "/v1/chat/completions", { ...PROMPT, tools }); assert.equal(reply.status, 200);
  await first.close();
  let restored;
  const second = await create(t, { continuationStore: createCodingContinuationStore(home, scope), provider: { id: "fixture", model: "same-model", async turn(args) {
    restored = args.history[1].continuation; return { text: "complete", toolUses: [], stop: "end", usage: { input: 3, output: 4 } };
  } } });
  const assistant = { ...reply.json.choices[0].message, reasoning_content: "forged child reasoning" };
  const payload = { ...PROMPT, tools, messages: [...PROMPT.messages, assistant, { role: "tool", content: "fixture", tool_call_id: "exact-call" }] };
  const resumed = await post(second, "/v1/chat/completions", payload); assert.equal(resumed.status, 200);
  assert.deepEqual(restored, continuation);
  await second.close();
  let foreignCalls = 0;
  const foreign = await create(t, { continuationStore: createCodingContinuationStore(home, { ...scope, profileId: "other-profile" }), provider: { id: "fixture", model: "same-model", async turn() {
    foreignCalls += 1; return { text: "must not run", toolUses: [], stop: "end" };
  } } });
  const refused = await post(foreign, "/v1/chat/completions", payload).catch(() => null);
  assert.ok(refused === null || refused.status === 409); assert.equal(foreignCalls, 0);
});

test("tampered private continuation state revokes the bridge before a resumed provider operation", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-host-continuation-tamper-")));
  const home = join(root, "home"), cwd = join(root, "workspace"); mkdirSync(home); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { workerId: "worker", providerSessionId: "ext_pi_" + "b".repeat(24), cwd, providerId: "fixture", model: "same-model" };
  const first = await create(t, { continuationStore: createCodingContinuationStore(home, scope) });
  const reply = await post(first, "/v1/chat/completions", PROMPT); assert.equal(reply.status, 200); await first.close();
  const directory = join(home, ".hara", "agent-teams", "coding-continuations");
  const file = join(directory, readdirSync(directory)[0], "state.json");
  const resumedStore = createCodingContinuationStore(home, scope);
  const state = JSON.parse(readFileSync(file, "utf8")); state.entries[0].continuation = { type: "chat_reasoning", text: "injected" }; writeFileSync(file, JSON.stringify(state));
  let calls = 0;
  const second = await create(t, { continuationStore: resumedStore, provider: { id: "fixture", model: "same-model", async turn() { calls += 1; return { text: "never", stop: "end", toolUses: [] }; } } });
  const response = await post(second, "/v1/chat/completions", { ...PROMPT, messages: [...PROMPT.messages, reply.json.choices[0].message, { role: "user", content: "next" }] }).catch(() => null);
  assert.ok(response === null || response.status === 409); assert.equal(calls, 0);
});

test("unsupported model, tools, roles, images, identifiers and endpoints never dispatch the provider", async t => {
  let calls = 0;
  const bridge = await create(t, { provider: { id: "fixture", model: "fixture", async turn() { calls += 1; throw new Error("must not run"); } } });
  for (const payload of [
    { ...PROMPT, model: "other-model" }, { ...PROMPT, model: " coding" },
    { ...PROMPT, tools: [{ type: "function", function: { name: "bash" } }] },
    { ...PROMPT, tool_choice: "none", tools: [{ type: "function", function: { name: "bash" } }] },
    { ...PROMPT, messages: [{ role: "developer", content: "unsupported" }] },
    { ...PROMPT, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///synthetic" } }] }] },
    { ...PROMPT, messages: [...PROMPT.messages, { role: "tool", content: "result", tool_call_id: "foreign" }] },
    { ...PROMPT, tools: [{ type: "function", function: { name: "read " } }] },
    { ...PROMPT, apiKey: "synthetic-secret" },
  ]) assert.equal((await post(bridge, "/v1/chat/completions", payload)).status, 400);
  assert.equal((await post(bridge, "/v1/chat/completions?model=coding", PROMPT)).status, 404);
  assert.equal((await post(bridge, "/v1/chat/completions", undefined, {}, "GET")).status, 405);
  assert.equal(calls, 0);
});

test("authorization, host/origin and payload size are enforced before provider access", async t => {
  let calls = 0;
  const bridge = await create(t, { provider: { id: "fixture", model: "fixture", async turn() { calls += 1; throw new Error("must not run"); } } });
  assert.equal((await post(bridge, "/v1/chat/completions", PROMPT, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post(bridge, "/v1/chat/completions", PROMPT, { Host: "attacker.invalid" })).status, 403);
  assert.equal((await post(bridge, "/v1/chat/completions", PROMPT, { Origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await post(bridge, "/v1/chat/completions", "x".repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await post(bridge, "/v1/chat/completions", PROMPT, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(bridge, "/v1/chat/completions", "{bad")).status, 400);
  assert.equal(calls, 0);
});

test("the official MCP SDK initializes, lists and calls only host-whitelisted tools", async t => {
  const seen = [];
  const bridge = await create(t, { executeTool: async (name, input, signal) => { seen.push({ name, input, aborted: signal.aborted }); return { content: "synthetic result", isError: false }; } });
  const client = new Client({ name: "fixture", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.mcp.url), { requestInit: { headers: bridge.mcp.headers } });
  await client.connect(transport);
  t.after(() => client.close());
  const list = await client.listTools();
  assert.deepEqual(list.tools, [{ name: "read", description: TOOL.description, inputSchema: TOOL.input_schema }]);
  assert.deepEqual(await client.callTool({ name: "read", arguments: { fixture: "A" } }), { content: [{ type: "text", text: "synthetic result" }], isError: false });
  assert.deepEqual(seen, [{ name: "read", input: { fixture: "A" }, aborted: false }]);
  assert.equal(bridge.metrics.toolCalls, 1);
});

test("MCP rejects foreign sessions, exact-name aliases, unknown methods and terminated sessions", async t => {
  let calls = 0;
  const bridge = await create(t, { executeTool: async () => { calls += 1; return "ok"; } });
  const session = await initialize(bridge);
  const headers = { "Mcp-Session-Id": session };
  const list = { jsonrpc: "2.0", id: 3, method: "tools/list" };
  assert.equal((await post(bridge, "/mcp", list, { "Mcp-Session-Id": "foreign" })).status, 404);
  assert.equal((await post(bridge, "/mcp", list)).status, 404);
  for (const name of ["bash", "read ", "hara_read"]) assert.equal((await post(bridge, "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: {} } }, headers)).status, 400);
  assert.equal((await post(bridge, "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read", arguments: { credential: "synthetic-secret" } } }, headers)).status, 400);
  assert.equal((await post(bridge, "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read", arguments: { fixture: 123 } } }, headers)).status, 400);
  const unsupported = await post(bridge, "/mcp", { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "file:///synthetic" } }, headers);
  assert.equal(unsupported.status, 400);
  assert.deepEqual(unsupported.json, { jsonrpc: "2.0", id: 5, error: { code: -32601, message: "unsupported_mcp_method" } });
  assert.equal(calls, 0);
  assert.equal((await post(bridge, "/mcp", undefined, headers, "DELETE")).status, 200);
  assert.equal((await post(bridge, "/mcp", list, headers)).status, 404);
});

test("provider dispatch is single-flight and MCP tool callbacks are serialized", async t => {
  const providerEntered = deferred(); const providerRelease = deferred();
  const toolEntered = deferred(); const toolRelease = deferred();
  let providers = 0; let activeTools = 0; let peakTools = 0; let toolCalls = 0;
  const bridge = await create(t, {
    provider: { id: "fixture", model: "fixture", async turn() { providers += 1; providerEntered.resolve(); await providerRelease.promise; return { text: "ok", toolUses: [], stop: "end", usage: { input: 1, output: 1 } }; } },
    executeTool: async () => { toolCalls += 1; activeTools += 1; peakTools = Math.max(peakTools, activeTools); toolEntered.resolve(); await toolRelease.promise; activeTools -= 1; return "ok"; },
  });
  const first = post(bridge, "/v1/chat/completions", PROMPT);
  await providerEntered.promise;
  assert.equal((await post(bridge, "/v1/chat/completions", PROMPT)).status, 429);
  providerRelease.resolve();
  assert.equal((await first).status, 200);
  assert.equal(providers, 1);
  const session = await initialize(bridge);
  const call = id => post(bridge, "/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "read", arguments: {} } }, { "Mcp-Session-Id": session });
  const firstTool = call(2);
  await toolEntered.promise;
  const secondTool = call(3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(toolCalls, 1);
  toolRelease.resolve();
  assert.deepEqual((await Promise.all([firstTool, secondTool])).map(value => value.status), [200, 200]);
  assert.equal(peakTools, 1);
});

test("round/tool/token budgets are checked before dispatch and after provider usage", async t => {
  const round = await create(t, { budget: { ...BUDGET, maxProviderRounds: 1, maxToolCalls: 1 } });
  assert.equal((await post(round, "/v1/chat/completions", PROMPT)).status, 200);
  assert.equal((await post(round, "/v1/chat/completions", PROMPT)).status, 429);
  const session = await initialize(round);
  const call = () => post(round, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read" } }, { "Mcp-Session-Id": session });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
  let calls = 0;
  const before = await create(t, { budget: { ...BUDGET, maxTokens: 1 }, provider: { id: "fixture", model: "fixture", async turn() { calls += 1; throw new Error("must not run"); } } });
  assert.equal((await post(before, "/v1/chat/completions", PROMPT)).status, 429);
  assert.equal(calls, 0);
  const after = await create(t, { budget: { ...BUDGET, maxTokens: 1000 }, provider: { id: "fixture", model: "fixture", async turn() { calls += 1; return { text: "must not deliver", toolUses: [], stop: "end", usage: { input: 900, output: 200 } }; } } });
  const over = await post(after, "/v1/chat/completions", PROMPT).catch(() => null);
  assert.ok(over === null || over.status !== 200);
  assert.equal(after.metrics.totalTokens, 1100);
  assert.equal(calls, 1);
});

test("identity revocation, external cancellation, timeout and close abort in-flight providers", async t => {
  for (const kind of ["identity", "external", "timeout", "close"]) {
    const entered = deferred(); const released = deferred();
    const signal = new AbortController();
    let providerSignal; let revoked = false;
    const bridge = await create(t, {
      signal: signal.signal, budget: { ...BUDGET, timeoutMs: kind === "timeout" ? 60 : 10_000 },
      assertCurrent() { if (revoked) throw new Error("synthetic-private-binding-detail"); },
      provider: { id: "fixture", model: "fixture", async turn(args) {
        providerSignal = args.signal; entered.resolve();
        if (kind === "identity") { revoked = true; return { text: "must not deliver", toolUses: [], stop: "end", usage: { input: 1, output: 1 } }; }
        await released.promise;
        return { text: "must not deliver", toolUses: [], stop: "end", usage: { input: 1, output: 1 } };
      } },
    });
    const operation = post(bridge, "/v1/chat/completions", PROMPT).catch(() => null);
    await entered.promise;
    if (kind === "external") signal.abort();
    if (kind === "close") await bridge.close();
    const response = await operation;
    assert.ok(response === null || response.status !== 200, kind);
    assert.equal(providerSignal.aborted, true, kind);
    assert.ok(!response || !response.text.includes("synthetic-private-binding-detail"));
    released.resolve();
    await bridge.close();
    await assert.rejects(post(bridge, "/v1/chat/completions", PROMPT));
  }
});

test("provider errors are redacted and host progress can revoke a turn before dispatch", async t => {
  const failed = await create(t, { provider: { id: "fixture", model: "fixture", async turn() { throw new Error("synthetic-secret-key-and-private-url"); } } });
  const response = await post(failed, "/v1/chat/completions", PROMPT);
  assert.equal(response.status, 500);
  assert.ok(!response.text.includes("synthetic-secret"));
  assert.ok(failed.metrics.inputTokens > 0, "failed model requests still consume a conservative input budget");
  let calls = 0;
  const revoked = await create(t, {
    onProgress: () => false,
    provider: { id: "fixture", model: "fixture", async turn() { calls += 1; throw new Error("must not run"); } },
  });
  const result = await post(revoked, "/v1/chat/completions", PROMPT).catch(() => null);
  assert.ok(result === null || result.status !== 200);
  assert.equal(calls, 0);
});

test("cancelled provider tail accounting is synchronous and never re-enters the progress authorization gate", { timeout: 5000 }, async t => {
  for (const kind of ["external", "timeout", "close"]) {
    const entered = deferred(); const accounted = deferred();
    const controller = new AbortController();
    const usage = []; const progress = [];
    let providerSignal;
    const bridge = await create(t, {
      signal: controller.signal, budget: { ...BUDGET, timeoutMs: kind === "timeout" ? 60 : 10_000 },
      onUsage(metrics) {
        usage.push({ ...metrics });
        if (metrics.inputTokens > 0) accounted.resolve();
        metrics.inputTokens = 999_999; // The observer must receive a copy, never counter authority.
      },
      onProgress(metrics) { progress.push(metrics); return true; },
      provider: { id: "fixture", model: "fixture", async turn({ signal }) {
        providerSignal = signal; entered.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("synthetic cancelled operation")), { once: true });
        });
      } },
    });
    const operation = post(bridge, "/v1/chat/completions", PROMPT).catch(() => null);
    await entered.promise;
    const authorizationCalls = progress.length;
    if (kind === "external") controller.abort();
    if (kind === "close") await bridge.close();
    await accounted.promise;
    // This observation does not depend on a worker's later finally or a completed HTTP reply.
    assert.equal(providerSignal.aborted, true, kind);
    assert.ok(bridge.metrics.inputTokens > 0 && bridge.metrics.inputTokens < 999_999, kind);
    assert.deepEqual(usage.at(-1), bridge.metrics, kind);
    assert.equal(progress.length, authorizationCalls, "cancelled tail accounting cannot authorize another operation");
    assert.equal(progress.at(-1).inputTokens, 0, kind);
    await operation;
    await bridge.close();
    await assert.rejects(post(bridge, "/v1/chat/completions", PROMPT));
  }
});

test("a failing usage observer revokes dispatch and never exposes its private exception", async t => {
  let calls = 0;
  const bridge = await create(t, {
    onUsage() { throw new Error("synthetic-private-accounting-detail"); },
    provider: { id: "fixture", model: "fixture", async turn() { calls += 1; return { text: "must not dispatch", toolUses: [], stop: "end" }; } },
  });
  const response = await post(bridge, "/v1/chat/completions", PROMPT).catch(() => null);
  assert.equal(calls, 0);
  assert.ok(response === null || response.status !== 200);
  assert.ok(!response || !response.text.includes("synthetic-private-accounting-detail"));
});

test("SSE tool calls include exact IDs, usage and the final terminator", async t => {
  const bridge = await create(t, { provider: { id: "fixture", model: "fixture", async turn() {
    return { text: "", toolUses: [{ id: "call_Exact-1", name: "hara_read", input: { fixture: "A" } }], stop: "tool_use", continuation: { type: "chat_reasoning", text: "synthetic-reasoning" }, usage: { input: 4, output: 5 } };
  } } });
  const response = await post(bridge, "/v1/chat/completions", { ...PROMPT, stream: true, tools: [{ type: "function", function: { name: "hara_read" } }] });
  assert.equal(response.status, 200);
  const frames = response.text.split("\n\n").filter(value => value.startsWith("data: ")).map(value => value.slice(6));
  assert.equal(frames.at(-1), "[DONE]");
  const parsed = frames.slice(0, -1).map(value => JSON.parse(value));
  assert.equal(parsed[0].choices[0].delta.reasoning_content, "synthetic-reasoning");
  assert.deepEqual(parsed[1].choices[0].delta.tool_calls, [{ index: 0, id: "call_Exact-1", type: "function", function: { name: "hara_read", arguments: '{"fixture":"A"}' } }]);
  assert.equal(parsed[2].choices[0].finish_reason, "tool_calls");
  assert.deepEqual(parsed[3].usage, { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });
});

test("an organization policy version change refuses dispatch instead of refreshing authorization", async t => {
  let calls = 0;
  const bridge = await create(t, {
    organizationPolicyVersion: 1,
    provider: { id: "fixture", model: "fixture", async prepareTurn() { return { organizationPolicyVersion: 2 }; }, async turn() { calls += 1; throw new Error("must not run"); } },
  });
  const response = await post(bridge, "/v1/chat/completions", PROMPT).catch(() => null);
  assert.ok(response === null || response.status !== 200);
  assert.equal(calls, 0);
});

test("close cancels an active tool callback and never starts a queued side effect", async t => {
  const entered = deferred(); const released = deferred();
  let calls = 0; let toolSignal;
  const bridge = await create(t, { executeTool: async (_name, _input, signal) => {
    calls += 1; toolSignal = signal; entered.resolve(); await released.promise; return "done";
  } });
  const session = await initialize(bridge);
  const call = id => post(bridge, "/mcp", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "read" } }, { "Mcp-Session-Id": session }).catch(() => null);
  const first = call(2); await entered.promise;
  const second = call(3); await new Promise(resolve => setImmediate(resolve));
  await bridge.close();
  assert.equal(toolSignal.aborted, true);
  released.resolve();
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
