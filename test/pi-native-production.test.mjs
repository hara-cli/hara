import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodingHostBridge } from "../dist/coding/host.js";
import { piNativeModelTools, piWorkspaceToolName } from "../dist/agent-runtime/pi-native-tools.js";
import { PiNativeSessionStore } from "../dist/agent-runtime/pi-native-session.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";
import { readPiNativeChildConfig } from "../dist/agent-runtime/pi-rpc-entry.js";
import { PiRpcProcess } from "../dist/agent-runtime/pi-rpc-process.js";
import { runtimeFailureMessage } from "../dist/agent-runtime/failure-diagnostics.js";

const reply = text => ({ text, toolUses: [], stop: "end", usage: { input: 10, output: 2 } });
const budget = { maxProviderRounds: 4, maxToolCalls: 4, maxTokens: 100000, timeoutMs: 10000 };
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-pi-production-")));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
async function bridge(t, extra = {}) {
  const host = await createCodingHostBridge({ provider: { id: "frozen-hara-provider", model: "frozen-hara-model", turn: async () => reply("synthetic only") },
    tools: [], executeTool: async () => { throw new Error("No tool authority on model token"); }, assertCurrent() {}, budget,
    nativeModel: { audience: "a".repeat(64) }, ...extra });
  t.after(() => host.close());
  const config = host.provider.hara.options;
  return { host, token: config.apiKey, baseURL: config.baseURL, mcpURL: host.mcp.url };
}
function body(tools = []) { return { model: "coding", messages: [{ role: "user", content: "synthetic frozen request" }], tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: "untrusted child text", parameters: { type: "object" } } })), stream: false }; }
const call = (b, overrides = {}) => fetch(overrides.url ?? b.baseURL + "/chat/completions", { method: overrides.method ?? "POST", headers: { Authorization: "Bearer " + (overrides.token ?? b.token), "Content-Type": "application/json" }, body: overrides.method === "GET" ? undefined : JSON.stringify(overrides.body ?? body()) });

test("production Pi model gateway binds its audience, rejects model-token MCP and preserves the frozen Hara provider", async t => {
  let calls = 0;
  const b = await bridge(t, { provider: { id: "frozen", model: "actual-hara-connection", async turn(args) { calls++; assert.deepEqual(args.tools, []); return reply("Hara connection used"); } } });
  assert.equal((await call(b, { token: "foreign" })).status, 401);
  const otherAttempt = await bridge(t);
  assert.equal((await call(otherAttempt, { token: b.token })).status, 401);
  assert.equal((await call(b, { url: b.baseURL.replace("a".repeat(64), "b".repeat(64)) + "/chat/completions" })).status, 404);
  for (const method of ["POST", "GET", "DELETE"]) assert.equal((await call(b, { url: b.mcpURL, method })).status, 404);
  assert.equal(calls, 0);
  assert.equal((await call(b)).status, 200); assert.equal(calls, 1);
  await b.host.close(); await assert.rejects(call(b));
});

test("production Pi tools come from the pinned SDK and Host schemas; native batches consume budget before dispatch", async t => {
  const cwd = fixture(t), specs = piNativeModelTools(cwd, []); let charged = 0;
  assert.deepEqual(specs.map(tool => tool.name).sort(), ["bash", "edit", "read", "write"]);
  const b = await bridge(t, {
    tools: specs,
    nativeModel: { audience: "c".repeat(64), onNativeTools(calls) { charged += calls.length; } },
    budget: { ...budget, maxToolCalls: 1 },
    provider: {
      id: "frozen", model: "frozen",
      async turn(args) {
        assert.deepEqual(args.tools[0].input_schema, specs[0].input_schema);
        return { text: "", toolUses: [{ id: "read-one", name: "read", input: { path: "fixture.txt" } }], stop: "tool_use", usage: { input: 10, output: 2 } };
      },
    },
  });
  assert.equal((await call(b, { body: body(specs) })).status, 200); assert.equal(charged, 1);
  assert.equal((await call(b, { body: body(specs) })).status, 429); assert.equal(charged, 1);
  assert.equal((await call(b, { body: { ...body(), tools: [{ type: "function", function: { name: "CronCreate", parameters: {} } }] } })).status, 400);
});

test("production Pi model gateway revokes immediately while close drains a provider that ignores cancellation", async t => {
  let enter, release, closed = false;
  const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const b = await bridge(t, { provider: { id: "frozen", model: "frozen", async turn() { enter(); await blocked; return reply("late"); } } });
  const request = call(b).catch(() => null); await entered;
  const closing = b.host.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release(); await closing; await request; assert.equal(closed, true);
});

function sessionFixture(t) {
  const root = fixture(t), storage = new WorkspaceResourceStorage(root, { schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() } });
  storage.initialize();
  const binding = { runId: randomUUID(), scope: storage.scope, agent: { agentId: "synthetic-agent" }, connection: { model: "frozen" } };
  const history = [{ role: "user", content: "synthetic task" }];
  return { root, storage, binding, history };
}

test("Host-private Pi session receipts refuse accepted/outcome-unknown recovery rather than replaying", t => {
  const f = sessionFixture(t), first = new PiNativeSessionStore(f.storage, f.binding, f.history);
  t.after(() => rmSync(first.root, { recursive: true, force: true })); first.accepted();
  assert.throws(() => new PiNativeSessionStore(f.storage, f.binding, f.history), /no prompt was replayed/);
});

test("Host-private Pi session receipts resume only idle same-binding same-history files and reject tampering", t => {
  const f = sessionFixture(t), first = new PiNativeSessionStore(f.storage, f.binding, f.history);
  t.after(() => rmSync(first.root, { recursive: true, force: true }));
  const file = join(first.root, "agent/sessions/fixture.jsonl"); writeFileSync(file, "synthetic session contents\n");
  first.accepted(); first.finished(file, f.history);
  const resumed = new PiNativeSessionStore(f.storage, f.binding, f.history);
  assert.equal(resumed.resumed, true); assert.equal(resumed.root, first.root); assert.equal(resumed.sessionFile, file);
  resumed.accepted(); resumed.finished(file, f.history);
  assert.throws(() => new PiNativeSessionStore(f.storage, { ...f.binding, connection: { model: "foreign" } }, f.history), /no prompt was replayed/);
  assert.throws(() => new PiNativeSessionStore(f.storage, f.binding, [{ role: "user", content: "changed history" }]), /no prompt was replayed/);
  writeFileSync(file, "changed outside the original attempt\n");
  assert.throws(() => new PiNativeSessionStore(f.storage, f.binding, f.history), /no prompt was replayed/);
});

test("Pi scheduling names cannot become native tools and long Workspace tool aliases remain deterministic", () => {
  assert.equal(piWorkspaceToolName("schedule_workspace_task"), "mcp__hara__schedule_workspace_task");
  assert.equal(piWorkspaceToolName("a".repeat(64)).length, 64); assert.equal(piWorkspaceToolName("a".repeat(64)), piWorkspaceToolName("a".repeat(64)));
  assert.notEqual(piWorkspaceToolName("a".repeat(64)), piWorkspaceToolName("b".repeat(64)));
  assert.throws(() => piWorkspaceToolName("../CronCreate"), /Invalid/);
});

test("Pi RPC transport refuses pre-cancelled launch before invoking the shared process boundary", () => {
  let spawns = 0;
  assert.throws(() => new PiRpcProcess({ command: process.execPath, args: [], env: {}, cwd: process.cwd(), timeoutMs: 1000, signal: AbortSignal.abort(), onFrame() {}, onAccepted() {},
    boundary: { spawn() { spawns++; throw new Error("must not start"); }, async drain() {} } }), /interrupted/);
  assert.equal(spawns, 0);
});

test("Pi failure metadata uses the shared allowlist without exposing a credential or native session", () => {
  const failure = runtimeFailureMessage({ runtime: "pi", version: "1.5.0", loginSource: "isolated", homeMatchesAccount: false, kind: "runtime_network", elapsedMs: 20 });
  assert.equal(JSON.parse(failure.slice(failure.indexOf("=") + 1)).runtime, "pi");
  assert.equal(failure.includes("Bearer"), false);
});

test("repeated MCP close waits for the same physical native launch after cancellation", async t => {
  const { createRegisteredCliMcpTurn } = await import("../dist/agent-runtime/registered-cli-mcp.js");
  let entered, release, closed = false;
  const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const native = createRegisteredCliMcpTurn({ signal: controller.signal, jsonEvents: false, assertCurrent() {}, async launch() { entered(); await held; return { ok: true, stdout: "settled", code: 0, timedOut: false }; } });
  t.after(() => { release(); return native.close(); });
  const turn = native.turn({ system: "synthetic", history: [{ role: "user", content: "wait" }], tools: [], signal: controller.signal, onText() {} });
  await started; controller.abort();
  const closing = native.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release(); await closing; await turn; assert.equal(closed, true);
});

test("Pi MCP cannot commit done while its native process is still active", async t => {
  const { createRegisteredCliMcpTurn } = await import("../dist/agent-runtime/registered-cli-mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const signal = new AbortController().signal;
  const native = createRegisteredCliMcpTurn({ signal, jsonEvents: false, deferNativeCompletion: true, assertCurrent() {}, async launch(endpoint) {
    const client = new Client({ name: "synthetic-pi", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: "Bearer " + endpoint.env.HARA_WORKSPACE_MCP_TOKEN } } }));
      const result = await client.callTool({ name: "task_checkpoint", arguments: { done: true } });
      assert.equal(result.isError, true); assert.match(result.content[0].text, /protected process tree drains/);
      return { ok: true, stdout: "settled", code: 0, timedOut: false };
    } finally { await client.close(); }
  } });
  t.after(() => native.close());
  const result = await native.turn({ system: "synthetic", history: [{ role: "user", content: "finish" }], signal, onText() {},
    tools: [{ name: "task_checkpoint", description: "Host completion", input_schema: { type: "object", properties: { done: { type: "boolean" } } } }] });
  assert.equal(result.stop, "end"); assert.equal(result.toolUses.length, 0);
});

test("the production bundled Pi RPC entry executes native tools and Hara MCP using the common process boundary", async t => {
  if (process.platform !== "darwin") return t.skip("macOS Seatbelt is required");
  const { existsSync } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const { spawn } = await import("node:child_process");
  const common = process.env.HARA_PI_TEST_PROCESS_BOUNDARY ?? new URL("../dist/agent-runtime/process-boundary.js", import.meta.url).pathname;
  if (!existsSync(common)) return t.skip("final shared process boundary not delivered");
  const { RuntimeProcessBoundary, RUNTIME_GUARD_SCRIPT } = await import(pathToFileURL(common).href);
  const { createWorkspaceMcpEndpoint } = await import("../dist/agent-runtime/registered-cli-mcp.js");
  const { piNativeLauncher } = await import("../dist/agent-runtime/pi-full.js");
  const root = fixture(t), work = join(root, "work"); mkdirSync(work);
  for (const dir of ["home", "home/.hara", "agent", "agent/sessions", "agent/tmp"]) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const sentinel = "synthetic-upstream-key-" + randomUUID(); writeFileSync(join(root, "home/.hara/connection.json"), sentinel);
  const tool = { name: "choose_fixture", description: "Synthetic Host decision", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } };
  // A production resource loader must ignore both user and project discovery traps.
  for (const base of [join(root, "home/.pi/agent"), join(work, ".pi")]) {
    mkdirSync(join(base, "extensions"), { recursive: true });
    const trap = join(base, "extensions/trap.mjs");
    writeFileSync(trap, 'import {writeFileSync} from "node:fs"; writeFileSync(' + JSON.stringify(join(work,"unexpected-global-resource")) + ',"loaded"); export default function () {}');
    writeFileSync(join(base, "settings.json"), JSON.stringify({ extensions: [trap], packages: [], hooks: { session_start: "touch unexpected-global-resource" }, mcpServers: { foreign: { command: "touch", args: ["unexpected-global-resource"] } } }));
  }
  const backgroundScript = 'const {spawn}=require("node:child_process"),fs=require("node:fs");const child=spawn(process.execPath,["-e","setTimeout(()=>{},5000)"],{detached:true,stdio:"ignore"});child.unref();fs.writeFileSync("background.json",JSON.stringify({pid:child.pid}));fs.writeFileSync("env.json",JSON.stringify({env:process.env,argv:process.argv}));setTimeout(()=>{},350);';
  let confirmations = 0, calls = 0;
  const endpoint = await createWorkspaceMcpEndpoint({ signal: new AbortController().signal, assertCurrent() {}, tools: () => [tool], async call() {
    confirmations++; return { id: "fixture", name: tool.name, content: "Host declined the synthetic mutation", isError: true };
  } }); t.after(() => endpoint.close());
  const specs = piNativeModelTools(work, [tool]);
  const b = await bridge(t, { tools: specs, budget: { ...budget, maxProviderRounds: 8, maxToolCalls: 8 },
    provider: { id: "actual-hara-connection", model: "frozen-fixture-model", async turn(args) {
      calls++;
      assert.equal(args.tools.some(tool => /cron|schedulewakeup|foreign/i.test(tool.name)), false);
      if (calls === 1) return { text: "", toolUses: [{ id: "native-write", name: "write", input: { path: "proof.txt", content: "native effect" } }], stop: "tool_use" };
      if (calls === 2) return { text: "", toolUses: [{ id: "native-bash", name: "bash", input: { command: 'if cat "$HOME/.hara/connection.json" >/dev/null 2>&1; then exit 9; fi; node -e \'' + backgroundScript + '\'; printf fixture-ok', timeout: 5 } }], stop: "tool_use" };
      if (calls === 3) return { text: "", toolUses: [{ id: "hara-choice", name: piWorkspaceToolName(tool.name), input: { question: "approve?" } }], stop: "tool_use" };
      assert.ok(args.history.some(message => message.role === "tool" && message.results.some(result => result.content.includes("Host declined"))));
      return reply("native production entry verified");
    } } });
  for (const name of ["auth.json", "models.json", "models-store.json"]) writeFileSync(join(root, "agent", name), "{}\n", { mode: 0o600 });
  const config = { schemaVersion: 1, sdkVersion: "1.5.0", root, cwd: work, system: "Synthetic Hara native entry test", model: { baseURL: b.baseURL, token: b.token },
    mcp: { url: endpoint.url, token: endpoint.env.HARA_WORKSPACE_MCP_TOKEN, tools: [tool] }, sessionFile: null };

  const q = JSON.stringify;
  const profile = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${q(work)}) (subpath ${q(join(root,"agent/sessions"))}) (subpath ${q(join(root,"agent/tmp"))}) (subpath ${q(join(root,"agent/auth.json.lock"))}) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))\n(deny file-read-data (subpath ${q(join(root,"home/.hara"))}))\n(deny file-write* (subpath ${q(join(root,"home/.hara"))}))\n(deny file-link)\n`;
  const launch = piNativeLauncher(), env = { HOME: join(root, "home"), USERPROFILE: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1", PATH: process.execPath.slice(0,process.execPath.lastIndexOf("/")) + ":/usr/bin:/bin", TMPDIR: join(root,"agent/tmp") };
  const startRpc = configuration => {
    const lifecycle = new RuntimeProcessBoundary(); lifecycle.markWrapped();
    const rpc = new PiRpcProcess({ ...launch, env, configuration, cwd: work, timeoutMs: 15000, signal: new AbortController().signal, onFrame() {}, onAccepted() {},
    boundary: { spawn() {
      const child = spawn("/bin/sh", ["-c", RUNTIME_GUARD_SCRIPT, "hara-native-guard", "/usr/bin/sandbox-exec", "-p", profile, launch.command, ...launch.args], { cwd: work, env, detached: true, stdio: ["pipe","pipe","pipe","pipe"] });
      return { child, ready: lifecycle.own(child, true) };
    }, async drain() { await lifecycle.drain(false); } } });
    t.after(async () => { await rpc.close(); await lifecycle.close(); }); return rpc;
  };
  const rpc = startRpc(config);
  await rpc.state(); const result = await rpc.prompt("Run the fixed synthetic native steps and respect the Host denial.");
  assert.equal(result.text, "native production entry verified"); assert.equal(confirmations, 1); assert.equal(calls, 4);
  assert.equal(readFileSync(join(work,"proof.txt"),"utf8"),"native effect");
  assert.equal(existsSync(join(work,"unexpected-global-resource")),false);
  const {execFileSync} = await import("node:child_process");
  const pid = JSON.parse(readFileSync(join(work,"background.json"),"utf8")).pid;
  const live = () => { try { return !execFileSync("/bin/ps",["-p",String(pid),"-o","stat="],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim().startsWith("Z"); } catch { return false; } };
  assert.equal(live(),true); await rpc.close(); assert.equal(live(),false);
  await endpoint.close();
  const resumedEndpoint = await createWorkspaceMcpEndpoint({ signal: new AbortController().signal, assertCurrent() {}, tools: () => [tool],
    async call() { throw new Error("A resumed idle session must not repeat the previous Hara mutation"); } }); t.after(() => resumedEndpoint.close());
  const resumed = startRpc({...config,sessionFile:result.state.sessionFile,mcp:{...config.mcp,url:resumedEndpoint.url,token:resumedEndpoint.env.HARA_WORKSPACE_MCP_TOKEN}});
  const state = await resumed.state(); assert.equal(state.sessionId,result.state.sessionId);
  const again = await resumed.prompt("A new human continuation: do not repeat previous tools.");
  assert.equal(again.state.sessionId,result.state.sessionId); assert.equal(calls,5); assert.equal(confirmations,1);
  await resumed.close();
  assert.equal(readFileSync(join(work,"env.json"),"utf8").includes(sentinel),false);
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    const text = readFileSync(join(root,"agent",name),"utf8");
    assert.equal(text.includes(sentinel),false); assert.equal(text.includes(b.token),false);
    assert.equal(text.includes(config.mcp.token),false);
  }
});


test("native Pi gateway restores Host-private opaque continuations across an idle gateway replacement", async t => {
  const { createCodingContinuationStore } = await import("../dist/coding/continuations.js");
  const root = fixture(t), home = join(root, "home"), cwd = join(root, "work"); mkdirSync(home); mkdirSync(cwd);
  const scope = { workerId: "pi-native-fixture", providerSessionId: "ext_pi_" + "1".repeat(24), cwd,
    providerId: "frozen", model: "frozen", connectionRuntimeKey: "4".repeat(64) };
  const opaque = { type: "responses_reasoning", items: [{ type: "reasoning", id: "opaque-reason", summary: [], encrypted_content: "synthetic-host-private-opaque-state" }] };
  const specs = piNativeModelTools(cwd, []);
  const first = await bridge(t, { tools: specs, continuationStore: createCodingContinuationStore(home, scope), provider: { id: "frozen", model: "frozen", async turn() {
    return { text: "", toolUses: [{ id: "native-read", name: "read", input: { path: "fixture.txt" } }], continuation: opaque, stop: "tool_use" };
  } } });
  const request = body(specs), response = await call(first, { body: request }); assert.equal(response.status, 200);
  const wire = await response.json(); assert.equal(JSON.stringify(wire).includes(opaque.items[0].encrypted_content), false);
  await first.host.close();
  let restored = false;
  const second = await bridge(t, { tools: specs, continuationStore: createCodingContinuationStore(home, scope), provider: { id: "frozen", model: "frozen", async turn(args) {
    restored = JSON.stringify(args.history.find(message => message.role === "assistant")?.continuation) === JSON.stringify(opaque);
    return reply("resumed");
  } } });
  request.messages.push(wire.choices[0].message, { role: "tool", tool_call_id: "native-read", content: "synthetic read result" });
  assert.equal((await call(second, { body: request })).status, 200); assert.equal(restored, true);
});

test("frozen Workspace proxy is request-local, survives async work and keeps loopback direct", async t => {
  const { createModelFetch, withWorkspaceModelProxy } = await import("../dist/network/model-fetch.js");
  const { createServer } = await import("node:http"); const { connect } = await import("node:net");
  const sockets = new Set(); const track = socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); };
  const upstream = createServer((_req, res) => { res.end("model-fixture"); }), proxy = createServer();
  for (const server of [upstream, proxy]) server.on("connection", track);
  let tunnels = 0;
  proxy.on("connect", (req, client, head) => {
    tunnels++; assert.equal(req.url, "model.fixture.invalid:80");
    const target = connect(upstream.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) target.write(head); client.pipe(target); target.pipe(client);
    }); track(target); target.on("error", () => client.destroy()); client.on("error", () => target.destroy());
  });
  await Promise.all([new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve)), new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve))]);
  const originalFetch = globalThis.fetch; let outside = 0;
  globalThis.fetch = async (input, init) => String(input).startsWith("http://outside.fixture.invalid") ? (outside++, new Response("outside-direct")) : originalFetch(input, init);
  t.after(async () => { globalThis.fetch = originalFetch; for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });
  const modelFetch = createModelFetch(undefined, { platform: "linux", env: { NO_PROXY: "*" } });
  const proxyUrl = "http://127.0.0.1:" + proxy.address().port;
  let release; const held = new Promise(resolve => { release = resolve; });
  const routed = withWorkspaceModelProxy(proxyUrl, async () => { await held; return (await modelFetch("http://model.fixture.invalid/model")).text(); });
  assert.equal(await (await modelFetch("http://outside.fixture.invalid/model")).text(), "outside-direct");
  assert.equal(await withWorkspaceModelProxy(proxyUrl, () => withWorkspaceModelProxy(null, async () => (await modelFetch("http://outside.fixture.invalid/nested")).text())), "outside-direct");
  assert.equal(await withWorkspaceModelProxy(proxyUrl, async () => (await modelFetch("http://127.0.0.1:" + upstream.address().port)).text()), "model-fixture");
  release(); assert.equal(await routed, "model-fixture"); assert.equal(tunnels, 1); assert.equal(outside, 2);
});
