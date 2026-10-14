import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCodingHostBridge } from "../dist/coding/host.js";
import { createHostBoundPiSession } from "../dist/agent-runtime/pi-session.js";
import { AgentRuntimeRegistry } from "../dist/agent-runtime/registry.js";

const budget = { maxProviderRounds: 4, maxToolCalls: 4, maxTokens: 10000, timeoutMs: 10000 };
const reply = (text) => ({ text, toolUses: [], stop: "end", usage: { input: 10, output: 2 } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tool = { name: "choose_reply", description: "Ask the synthetic host for an explicitly authorized reply", input_schema: {
  type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false,
} };

async function fixture(t, { tools = [], executeTool = async () => { throw new Error("no tool authority"); }, turn } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-pi-host-")));
  const home = join(root, "home"), cwd = join(root, "ordinary-chat"); mkdirSync(home); mkdirSync(cwd);
  const controller = new AbortController(); const calls = []; const events = []; const owned = [];
  const bridge = await createCodingHostBridge({ provider: { id: "synthetic", model: "same-authorized-fixture", async turn(args) {
    calls.push(args); return turn ? turn(args, calls.length) : reply("你好，Hara 在这里。");
  } }, tools, executeTool, assertCurrent() {}, budget, signal: controller.signal });
  let client;
  const customTools = [];
  if (tools.length) {
    client = new Client({ name: "synthetic-pi-host", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcp.url), { requestInit: { headers: bridge.mcp.headers } }));
    for (const spec of tools) customTools.push({ name: `hara_${spec.name}`, label: spec.name, description: spec.description,
      parameters: spec.input_schema, executionMode: "sequential", async execute(_id, args, signal) {
        const result = await client.callTool({ name: spec.name, arguments: args }, undefined, { signal });
        if (result.isError) throw new Error("synthetic host refused the tool");
        return { content: result.content, details: {} };
      } });
  }
  const manager = SessionManager.inMemory(cwd);
  const input = { home, cwd, subdirs: ["agent-runtime", "pi-probe"], bridge, budget, manager, tools: customTools,
    system: "You are Hara, a friendly personal assistant. Use only host-authorized tools. Synthetic durable fact: azalea-314.", signal: controller.signal };
  const create = async (overrides = {}) => {
    const handle = await createHostBoundPiSession({ ...input, ...overrides }); owned.push(handle);
    handle.session.subscribe((event) => { if (event.type === "message_end" || event.type === "agent_settled") events.push(event); });
    return handle;
  };
  t.after(async () => {
    controller.abort();
    for (const handle of owned) { await handle.session.abort().catch(() => {}); await handle.session.waitForIdle().catch(() => {}); handle.dispose(); }
    await client?.close(); await bridge.close(); rmSync(root, { recursive: true, force: true });
  });
  return { home, cwd, controller, bridge, manager, input, calls, events, create };
}

test("real Pi SDK performs an ordinary chat through one Hara model call, with no ambient tools or second planner", async (t) => {
  const f = await fixture(t); const handle = await f.create();
  assert.deepEqual(handle.session.getActiveToolNames(), []);
  await handle.session.prompt("hello", { expandPromptTemplates: false, source: "rpc" }); await handle.session.waitForIdle();
  assert.equal(f.calls.length, 1); assert.equal(f.bridge.metrics.providerRounds, 1);
  assert.ok(f.calls[0].system.includes("friendly personal assistant"));
  assert.ok(f.calls[0].history.some((message) => message.role === "user" && message.content === "hello"));
  assert.deepEqual(f.calls[0].tools, []);
  assert.ok(f.events.some((event) => event.type === "agent_settled" && !event.aborted));
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    assert.deepEqual(JSON.parse(readFileSync(join(f.home, ".hara", "agent-runtime", "pi-probe", name), "utf8")), {});
  }
  assert.equal(new AgentRuntimeRegistry().options().find((option) => option.id === "pi").available, false,
    "a tested SDK primitive does not automatically register a governed main-Agent Driver");
});

test("explicit SDK context reconstruction retains the same synthetic chat memory without reading ambient history", async (t) => {
  const f = await fixture(t); const first = await f.create();
  await first.session.prompt("Remember my synthetic marker azalea-314.", { expandPromptTemplates: false, source: "rpc" }); await first.session.waitForIdle();
  const manager = SessionManager.inMemory(f.cwd, { id: f.manager.getSessionId() }, f.manager.getEntries()); first.dispose();
  const second = await f.create({ manager });
  await second.session.prompt("What was my marker?", { expandPromptTemplates: false, source: "rpc" }); await second.session.waitForIdle();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].history.some((message) => message.role === "user" && message.content.includes("Remember my synthetic marker azalea-314")));
  assert.equal(manager.getSessionId(), f.manager.getSessionId());
});

test("real Pi SDK waits for the host tool decision and cannot execute an additional tool or model turn early", async (t) => {
  const entered = deferred(), choice = deferred(); let executed = 0;
  const f = await fixture(t, { tools: [tool], executeTool: async (name, args) => {
    executed++; assert.equal(name, "choose_reply"); assert.equal(args.question, "A or B?"); entered.resolve();
    return choice.promise;
  }, turn: async (args, count) => count === 1 ? { text: "", toolUses: [{ id: "choice-1", name: "hara_choose_reply", input: { question: "A or B?" } }],
    stop: "tool_use", usage: { input: 10, output: 2 } } : reply("You chose B.") });
  const handle = await f.create(); const operation = handle.session.prompt("Ask me which answer to use.", { expandPromptTemplates: false, source: "rpc" });
  await entered.promise; assert.equal(f.calls.length, 1); assert.equal(executed, 1); assert.equal(f.bridge.metrics.toolCalls, 1);
  assert.deepEqual(handle.session.getActiveToolNames(), ["hara_choose_reply"]);
  choice.resolve("B"); await operation; await handle.session.waitForIdle();
  assert.equal(f.calls.length, 2); assert.equal(executed, 1);
  assert.ok(f.calls[1].history.some((message) => message.role === "tool" && message.results.some((result) => result.content === "B")));
});

test("cancelling a real Pi model call aborts the host request and never reports a successful settled turn", async (t) => {
  const entered = deferred(); let aborted = false;
  const f = await fixture(t, { turn: async ({ signal }) => {
    entered.resolve(); await new Promise((resolve, reject) => {
      const stop = () => { aborted = true; reject(new Error("synthetic cancellation")); };
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    }); return reply("must not finish");
  } });
  const handle = await f.create(); const operation = handle.session.prompt("Wait for a synthetic cancellation.", { expandPromptTemplates: false, source: "rpc" });
  await entered.promise; f.controller.abort(); await operation; await handle.session.waitForIdle();
  assert.equal(aborted, true); assert.equal(f.calls.length, 1);
  assert.equal(f.events.some((event) => event.type === "message_end" && event.message.role === "assistant"
    && event.message.content.some((part) => part.type === "text" && part.text === "must not finish")), false);
});

test("the SDK constructor refuses foreign endpoints, widened budgets/tools and pre-cancelled work before a model request", async (t) => {
  const f = await fixture(t);
  const foreign = { ...f.bridge, provider: { hara: { ...f.bridge.provider.hara, options: { ...f.bridge.provider.hara.options, baseURL: "https://example.invalid/v1" } } } };
  await assert.rejects(f.create({ bridge: foreign }), /bridge is invalid/);
  await assert.rejects(f.create({ budget: { ...budget, maxProviderRounds: 1 } }), /budget is invalid/);
  await assert.rejects(f.create({ tools: [{ name: "bash" }] }), /whitelist/);
  await assert.rejects(f.create({ signal: AbortSignal.abort() }), /cancelled/);
  assert.equal(f.calls.length, 0);
});
