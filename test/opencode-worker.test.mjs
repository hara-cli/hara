import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeCodingWorkerAdapter } from "../dist/external-sessions/opencode-worker.js";
import { ExternalSessionOwnershipStore } from "../dist/external-sessions/identity.js";

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hara-opencode-worker-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree"); mkdirSync(cwd);
  const log = join(root, "calls.jsonl");
  const script = join(root, "fake-opencode.mjs");
  writeFileSync(script, `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const args = process.argv.slice(2).filter(value => value !== "--pure");
    const log = ${JSON.stringify(log)};
    const file = join(process.env.HOME, "session.json");
    const read = () => JSON.parse(readFileSync(file, "utf8"));
    const emit = (sessionID, type, part) => process.stdout.write(JSON.stringify({ sessionID, type, part }) + "\\n");
    appendFileSync(log, JSON.stringify({args, cwd:process.cwd(), home:process.env.HOME,
      database:process.env.OPENCODE_DB, config:process.env.OPENCODE_CONFIG_CONTENT,
      apiKeyPresent:Boolean(process.env.OPENAI_API_KEY), userConfig:process.env.OPENCODE_CONFIG,
      flags:{project:process.env.OPENCODE_DISABLE_PROJECT_CONFIG,plugins:process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS,skills:process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS}}) + "\\n");
    if (args.includes("--version")) process.stdout.write("1.18.32\\n");
    else if (args[0] === "import") {
      const data = JSON.parse(readFileSync(args[1], "utf8")); data.info.directory = process.cwd();
      writeFileSync(file, JSON.stringify(data)); process.stdout.write("Imported session: " + data.info.id + "\\n");
    } else if (args[0] === "export") {
      const data = read();
      if (existsSync(${JSON.stringify(join(root, "unsafe"))})) data.info.permission = [{permission:"*",pattern:"*",action:"allow"}];
      if (existsSync(${JSON.stringify(join(root, "foreign-workspace"))})) data.info.directory += "-other";
      process.stdout.write(JSON.stringify(data));
    } else if (args[0] === "run") {
      const data = read(); const native = data.info.id;
      const prompt = args.at(-1);
      if (prompt === "wait") { setInterval(() => {}, 10000); }
      else if (prompt === "foreign") emit("ses_foreign", "text", {id:"prt_foreign",text:"must not project"});
      else if (prompt === "native-tool") emit(native, "tool_use", {id:"prt_native",tool:"bash",state:{status:"completed"}});
      else {
        if (prompt === "sdk-overstated") for (let index = 0; index < 4; index++) {
          emit(native,"step_start",{id:"prt_overstated_start_"+index});
          emit(native,"tool_use",{id:"prt_overstated_tool_"+index,tool:"hara_read_file",state:{status:"completed"}});
        }
        emit(native,"step_start",{id:"prt_start"});
        emit(native,"step_start",{id:"prt_start"});
        emit(native,"tool_use",{id:"prt_tool",tool:"hara_read_file",state:{status:"completed",title:"Read source"}});
        emit(native,"step_finish",{id:"prt_finish",tokens:{input:10,output:3,reasoning:2,cache:{read:4,write:1}}});
        emit(native,"step_finish",{id:"prt_finish",tokens:{input:10,output:3,reasoning:2,cache:{read:4,write:1}}});
        emit(native,"text",{id:"prt_text",text:"Done without sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"});
        data.messages.push({info:{role:"user"},parts:[{type:"text",text:prompt}]});
        writeFileSync(file,JSON.stringify(data));
      }
    } else process.exitCode=2;
  `);
  const ownership = new ExternalSessionOwnershipStore(root);
  const metrics = [];
  let closed = 0;
  const bridge = () => ({
    model: "hara/test-model", provider: { hara: { npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "dummy" },
      models: { "test-model": { id: "test-model", limit: { context: 10000, output: 1000 } } } } },
    mcp: { type: "remote", url: "http://127.0.0.1:1/mcp" }, toolNames: ["read_file"],
    budget: { maxProviderRounds: 2, maxToolCalls: 2, maxTokens: 100, timeoutMs: 5000 },
    progress: (value) => { metrics.push(value); return true; }, close: async () => { closed++; },
  });
  const adapterOptions = { command: process.execPath, argsPrefix: [script], identityKey: Buffer.alloc(32, 8),
    identityHome: root, ownership, prepareTurn: async () => bridge(),
    env: { ...process.env, OPENAI_API_KEY: "must-not-forward", OPENCODE_CONFIG: "/untrusted/config.json" }, ...options };
  const adapter = new OpenCodeCodingWorkerAdapter(adapterOptions);
  t.after(() => adapter.close());
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { root, cwd, adapter, adapterOptions, ownership, bridge, metrics, calls, closed: () => closed };
}

const sink = (overrides = {}) => ({ text() {}, tool() {}, notice() {}, confirm: async () => false, ...overrides });

test("OpenCode reserves a durable opaque worker without model dispatch and reopens its exact owned DB", async (t) => {
  const f = fixture(t);
  const admitted = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd, title: "Coding task" });
  assert.match(admitted.session.id, /^ext_opencode_[a-f0-9]{24}$/);
  assert.equal(admitted.controlMode, "managed"); assert.equal(admitted.readOnly, false);
  assert.equal(f.ownership.has(admitted.session.id), true);
  assert.ok(f.calls().every(({ args }) => args[0] === "import" || args[0] === "export"));
  assert.equal(JSON.stringify(admitted).includes(f.cwd), false);
  assert.equal(JSON.stringify(admitted).includes("ses_"), false);
  const restarted = new OpenCodeCodingWorkerAdapter(f.adapterOptions); t.after(() => restarted.close());
  const resumed = await restarted.resumeCodingSession({ agentKind: "opencode", cwd: f.cwd, providerSessionId: admitted.session.id });
  assert.equal(resumed.session.id, admitted.session.id);
  assert.equal((await restarted.list({ limit: 10 })).sessions[0].id, admitted.session.id);
  assert.equal(new Set(f.calls().map((call) => call.database)).size, 1);
  await assert.rejects(restarted.resumeCodingSession({ agentKind: "opencode", cwd: `${f.cwd}-other`, providerSessionId: admitted.session.id }), /owned/);
});

test("OpenCode workers deny native tools/config and expose only the host bridge while reporting deduplicated usage", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  const text = []; const tools = [];
  const result = await f.adapter.submit(created.session.id, "implement", sink({ text: (value) => text.push(value), tool: (name) => tools.push(name) }));
  assert.equal(result.status, "completed"); assert.doesNotMatch(result.reply, /sk-proj-/);
  assert.deepEqual(tools, ["hara_read_file"]);
  assert.deepEqual(f.metrics.at(-1), { providerRounds: 1, toolCalls: 1, inputTokens: 15, outputTokens: 5 });
  assert.deepEqual(result.metrics, f.metrics.at(-1));
  assert.equal(f.closed(), 1);
  const launch = f.calls().find(({ args }) => args[0] === "run"); const config = JSON.parse(launch.config);
  assert.equal(launch.apiKeyPresent, false); assert.equal(launch.userConfig, undefined);
  assert.deepEqual(launch.flags, { project: "1", plugins: "1", skills: "1" });
  assert.equal(config.permission["*"], "deny"); assert.equal(config.permission.hara_read_file, "allow");
  assert.ok(Object.values(config.tools).every((value) => value === false));
  assert.deepEqual(Object.keys(config.mcp), ["hara"]); assert.deepEqual(config.enabled_providers, ["hara"]);
  assert.ok(launch.args.includes("--session")); assert.ok(!launch.args.includes("--continue"));
});

test("OpenCode worker refuses a missing bridge, changed workspace, or widened native session permissions", async (t) => {
  const f = fixture(t, { prepareTurn: undefined });
  const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  await assert.rejects(f.adapter.submit(created.session.id, "must not dispatch", sink()), /bridge is unavailable/);
  const guarded = new OpenCodeCodingWorkerAdapter({ ...f.adapterOptions, prepareTurn: async () => f.bridge() }); t.after(() => guarded.close());
  writeFileSync(join(f.root, "unsafe"), "yes");
  await assert.rejects(guarded.submit(created.session.id, "must not dispatch", sink()), /unsafe/);
  rmSync(join(f.root, "unsafe")); writeFileSync(join(f.root, "foreign-workspace"), "yes");
  await assert.rejects(guarded.resumeCodingSession({ agentKind: "opencode", cwd: f.cwd, providerSessionId: created.session.id }), /unsafe/);
  assert.equal(f.calls().some(({ args }) => args[0] === "run"), false);
});

test("OpenCode worker never projects foreign sessions or native-tool execution as successful", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  const texts = []; const tools = [];
  for (const prompt of ["foreign", "native-tool"]) {
    const result = await f.adapter.submit(created.session.id, prompt, sink({ text: (value) => texts.push(value), tool: (name) => tools.push(name) }));
    assert.equal(result.status, "failed");
  }
  assert.deepEqual(texts, []); assert.deepEqual(tools, []);
});

test("OpenCode worker cancellation during bridge setup prevents a late model dispatch and closes its bridge", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  let release; let entered;
  const setup = new Promise((resolve) => { entered = resolve; });
  f.adapterOptions.prepareTurn = async () => { entered(); return await new Promise((resolve) => { release = resolve; }); };
  const controller = new AbortController();
  const turn = f.adapter.submit(created.session.id, "wait", sink({ signal: controller.signal }));
  await setup; controller.abort(); release(f.bridge());
  assert.equal((await turn).status, "interrupted");
  assert.equal(f.calls().some(({ args }) => args[0] === "run"), false); assert.equal(f.closed(), 1);
});

test("direct OpenCode worker interruption revokes the host bridge signal before setup returns", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  let release; let entered; let bridgeSignal;
  const setup = new Promise((resolve) => { entered = resolve; });
  f.adapterOptions.prepareTurn = async (_input, hostSink) => {
    bridgeSignal = hostSink.signal; entered(); return await new Promise((resolve) => { release = resolve; });
  };
  const turn = f.adapter.submit(created.session.id, "wait", sink());
  await setup; await f.adapter.interrupt(created.session.id);
  assert.equal(bridgeSignal.aborted, true); release(f.bridge());
  assert.equal((await turn).status, "interrupted");
  assert.equal(f.calls().some(({ args }) => args[0] === "run"), false);
});

test("OpenCode worker budget denial aborts the turn without projecting late output", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  f.adapterOptions.prepareTurn = async () => ({ ...f.bridge(), progress: () => false });
  const text = []; const result = await f.adapter.submit(created.session.id, "implement", sink({ text: (value) => text.push(value) }));
  assert.equal(result.status, "failed"); assert.match(result.error, /budget/); assert.deepEqual(text, []);
});

test("OpenCode SDK rounds/tools/usage above budget never override lower authoritative live host counters", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  const host = { providerRounds: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1 }; const callbacks = [];
  f.adapterOptions.prepareTurn = async () => ({ ...f.bridge(),
    budget: { maxProviderRounds: 1, maxToolCalls: 1, maxTokens: 3, timeoutMs: 5000 },
    get metrics() { return { ...host }; }, progress: (value) => { callbacks.push(value); return true; },
  });
  const result = await f.adapter.submit(created.session.id, "sdk-overstated", sink());
  assert.equal(result.status, "completed"); assert.deepEqual(result.metrics, host);
  assert.ok(callbacks.length > 5); assert.ok(callbacks.every((value) => JSON.stringify(value) === JSON.stringify(host)));
});

for (const [key, value] of [["providerRounds", 3], ["toolCalls", 3], ["inputTokens", 101]]) {
  test(`OpenCode authoritative host ${key} over budget is refused even when SDK reports less`, async (t) => {
    const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
    const host = { providerRounds: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 }; let reads = 0;
    f.adapterOptions.prepareTurn = async () => ({ ...f.bridge(), get metrics() {
      // The initial snapshot admits dispatch; the next SDK event observes the real host limit.
      if (++reads > 1) host[key] = value; return { ...host };
    } });
    const text = []; const result = await f.adapter.submit(created.session.id, "implement", sink({ text: (value) => text.push(value) }));
    assert.equal(result.status, "failed"); assert.match(result.error, /budget/u);
    assert.deepEqual(result.metrics, host); assert.deepEqual(text, []);
  });
}

test("invalid live host counters fail closed instead of falling back to SDK usage", async (t) => {
  const f = fixture(t); const created = await f.adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  for (const metrics of [undefined, { providerRounds: NaN, toolCalls: 0, inputTokens: 0, outputTokens: 0 }]) {
    f.adapterOptions.prepareTurn = async () => ({ ...f.bridge(), get metrics() { return metrics; } });
    await assert.rejects(f.adapter.submit(created.session.id, "must not dispatch", sink()), /invalid execution counters/u);
  }
  assert.equal(f.calls().some(({ args }) => args[0] === "run"), false);
});

test("OpenCode worker does not adopt arbitrary provider history as an owned coding task", async (t) => {
  const f = fixture(t); let claimed = 0;
  const history = { id: "opencode", list: async () => ({ sessions: [] }), inspect: async () => ({}), resume: async () => { claimed++; return {}; } };
  const adapter = new OpenCodeCodingWorkerAdapter({ ...f.adapterOptions, history }); t.after(() => adapter.close());
  await assert.rejects(adapter.resumeCodingSession({ agentKind: "opencode", cwd: f.cwd, providerSessionId: `ext_opencode_${"f".repeat(24)}` }), /not owned/);
  assert.equal(claimed, 0);
});

test("OpenCode worker pagination retains provider history after a full worker page", async (t) => {
  const f = fixture(t); let opened = 0;
  const historyId = `ext_opencode_${"f".repeat(24)}`;
  const adapter = new OpenCodeCodingWorkerAdapter({ ...f.adapterOptions, history: {
    id: "opencode", inspect: async () => ({}), list: async () => ({ sessions: [{ id: historyId, sourceId: "opencode" }] }),
    resumeInTerminal: async (sessionId) => { opened++; return { sessionId, sourceId: "opencode", code: 0, signal: null }; },
  } }); t.after(() => adapter.close());
  const created = await adapter.createCodingSession({ agentKind: "opencode", cwd: f.cwd });
  const first = await adapter.list({ limit: 1 }); assert.equal(first.sessions[0].id, created.session.id); assert.ok(first.nextCursor);
  const second = await adapter.list({ limit: 1, cursor: first.nextCursor }); assert.equal(second.sessions[0].id, historyId);
  await assert.rejects(adapter.resumeInTerminal(created.session.id), /guarded Hara task/);
  await adapter.resumeInTerminal(historyId); assert.equal(opened, 1);
});

test("OpenCode worker rejects unknown durable index versions", (t) => {
  const f = fixture(t);
  const index = join(f.root, ".hara", "external-sessions", "opencode-workers", "index.json");
  writeFileSync(index, JSON.stringify({ version: 2, ids: [] }), { mode: 0o600 });
  assert.throws(() => new OpenCodeCodingWorkerAdapter(f.adapterOptions), /index is invalid/);
});
