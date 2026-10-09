import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalSessionRegistry, UnavailableOpenCodeAdapter } from "../dist/external-sessions/registry.js";
import { CodexAppServerAdapter } from "../dist/external-sessions/codex.js";
import { ClaudeAgentSdkAdapter } from "../dist/external-sessions/claude.js";
import { OpenCodeRuntimeAdapter } from "../dist/external-sessions/opencode.js";
import { OpenCodeCodingWorkerAdapter } from "../dist/external-sessions/opencode-worker.js";
import { ExternalSessionOwnershipStore } from "../dist/external-sessions/identity.js";
import { JsonlRpcClient } from "../dist/external-sessions/process.js";

const id = `ext_codex_${"a".repeat(24)}`;
const info = { id, sourceId: "codex", state: "idle" };
const admitted = { session: info, messages: [], readOnly: false, controlMode: "managed" };
const output = (overrides = {}) => ({ text() {}, tool() {}, notice() {}, confirm: async () => false, ...overrides });
const privateTree = (t) => {
  const root = mkdtempSync(join(tmpdir(), "hara-coding-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "worktree"); mkdirSync(cwd); return { root, cwd: realpathSync(cwd) };
};

test("Core worker admission validates the canonical worktree/provider and never creates on failed resume", async (t) => {
  const { cwd } = privateTree(t); const calls = [];
  const adapter = { id: "codex", list: async () => ({ sessions: [info] }),
    createCodingSession: async (input) => { calls.push(["create", input]); return admitted; },
    resumeCodingSession: async (input) => { calls.push(["resume", input]); return admitted; } };
  const registry = new ExternalSessionRegistry({ haraVersion: "test", adapters: [adapter] });
  await registry.createCodingSession({ agentKind: "codex", cwd });
  await registry.resumeCodingSession({ agentKind: "codex", cwd, providerSessionId: id });
  assert.equal(calls[0][1].cwd, cwd); assert.equal(calls[1][1].providerSessionId, id);
  await assert.rejects(registry.resumeCodingSession({ agentKind: "claude", cwd, providerSessionId: id }), /does not match/);
  await assert.rejects(registry.createCodingSession({ agentKind: "codex", cwd: "relative" }), /absolute/);
  await assert.rejects(registry.createCodingSession({ agentKind: "codex", cwd: join(cwd, "gone") }), /no longer available/);
  adapter.list = async () => ({ sessions: [] });
  await assert.rejects(registry.resumeCodingSession({ agentKind: "codex", cwd, providerSessionId: id }), /no longer available/);
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
});

test("Core admits structured OpenCode workers but never Pi through the external provider allowlist", async (t) => {
  const { cwd } = privateTree(t);
  const opencodeId = `ext_opencode_${"e".repeat(24)}`; const calls = [];
  const result = { ...admitted, session: { ...info, id: opencodeId, sourceId: "opencode" } };
  const adapter = { id: "opencode", list: async () => ({ sessions: [result.session] }),
    createCodingSession: async (input) => { calls.push(["create", input]); return result; },
    resumeCodingSession: async (input) => { calls.push(["resume", input]); return result; } };
  const registry = new ExternalSessionRegistry({ haraVersion: "test", adapters: [adapter] });
  await registry.createCodingSession({ agentKind: "opencode", cwd });
  await registry.resumeCodingSession({ agentKind: "opencode", cwd, providerSessionId: opencodeId });
  assert.deepEqual(calls.map(([kind]) => kind), ["create", "resume"]);
  assert.equal(calls[0][1].agentKind, "opencode");
  await assert.rejects(registry.createCodingSession({ agentKind: "pi", cwd }), /provider/);
});

test("default OpenCode registry composes owned workers with provider history and passes the worker lifecycle signal to its host factory", async (t) => {
  const { root, cwd } = privateTree(t);
  const registry = new ExternalSessionRegistry({ haraVersion: "test", identityHome: root, identityKey: Buffer.alloc(32, 7),
    opencode: { command: process.execPath, env: {} } });
  t.after(() => registry.close());
  const adapter = registry.adapters.get("opencode");
  assert.ok(adapter instanceof OpenCodeCodingWorkerAdapter);
  assert.ok(adapter.options.history instanceof OpenCodeRuntimeAdapter);
  const controller = new AbortController(); const marker = { marker: true };
  assert.equal(await adapter.options.prepareTurn({}, output({ signal: controller.signal,
    prepareCodingHost: async (signal) => { assert.equal(signal, controller.signal); return marker; },
  })), marker);
  await assert.rejects(adapter.options.prepareTurn({}, output({ signal: controller.signal })), /unavailable/);
  controller.abort();
  await assert.rejects(adapter.options.prepareTurn({}, output({ signal: controller.signal,
    prepareCodingHost: async () => assert.fail("no host startup after cancellation"),
  })), /unavailable/);
  for (const agentKind of ["opencode", "pi"]) {
    await assert.rejects(registry.createSession({ sourceId: "runtime", agentKind, cwd }), /agent kind/);
  }
});

test("missing bundled OpenCode is a non-executing unavailable adapter without breaking other providers", async (t) => {
  const { root, cwd } = privateTree(t); let spawns = 0;
  const registry = new ExternalSessionRegistry({ haraVersion: "test", identityHome: root, identityKey: Buffer.alloc(32, 7),
    opencode: { env: { HARA_CODE_RUNTIME_PATH: "not-an-absolute-sidecar" },
      spawnProcess: () => { spawns++; assert.fail("unavailable runtime must never spawn"); } } });
  t.after(() => registry.close());
  const adapter = registry.adapters.get("opencode"); assert.ok(adapter instanceof UnavailableOpenCodeAdapter);
  assert.ok(registry.adapters.get("codex") instanceof CodexAppServerAdapter);
  assert.ok(registry.adapters.get("claude") instanceof ClaudeAgentSdkAdapter);
  const source = await adapter.inspect();
  assert.equal(source.state, "not_installed"); assert.equal(source.installed, false); assert.equal(source.available, false);
  assert.match(source.remediation, /optional dependencies enabled/u);
  assert.ok(Object.values(source.capabilities).every((value) => value === false));
  await assert.rejects(registry.createCodingSession({ agentKind: "opencode", cwd }), /optional dependencies enabled/u);
  await assert.rejects(registry.submit(`ext_opencode_${"a".repeat(24)}`, "task", output()), /optional dependencies enabled/u);
  assert.equal(spawns, 0);
});

test("the registry reserves one writer before asynchronous dispatch and terminal handoff", async (t) => {
  const { cwd } = privateTree(t); let finish; let dispatched = 0; let opened = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const adapter = { id: "codex", list: async () => ({ sessions: [info] }),
    submit: async () => { dispatched++; return pending; },
    resumeCodingSession: async () => admitted,
    resumeInTerminal: async () => { opened++; return { sessionId: id, sourceId: "codex", code: 0, signal: null }; } };
  const registry = new ExternalSessionRegistry({ haraVersion: "test", adapters: [adapter] });
  const turn = registry.submit(id, "first", output());
  await assert.rejects(registry.submit(id, "second", output()), /writer/);
  await assert.rejects(registry.resumeInTerminal(id), /writer/);
  await assert.rejects(registry.resumeCodingSession({ agentKind: "codex", cwd, providerSessionId: id }), /writer/);
  finish({ sessionId: id, turnId: "turn", status: "completed", reply: "done" }); await turn;
  await registry.resumeInTerminal(id); assert.equal(dispatched, 1); assert.equal(opened, 1);
});

function rpcProcess(calls, respond) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)); calls.push(request);
    if (request.id !== undefined) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: respond(request) })}\n`));
    done();
  } });
  child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; }; return child;
}

test("Codex worker creation is persistent, user-reviewed and workspace-write, with opaque ownership", async (t) => {
  const { root, cwd } = privateTree(t); const calls = [];
  const ownership = new ExternalSessionOwnershipStore(root);
  const adapter = new CodexAppServerAdapter({ command: process.execPath, haraVersion: "test", identityKey: Buffer.alloc(32, 3),
    ownership, managedDaemon: false, spawnProcess: () => rpcProcess(calls, (request) => request.method === "thread/start"
      ? { thread: { id: "native-worker", cwd, status: { type: "idle" }, ephemeral: false } } : {}) });
  adapter.appServerArgs = async () => ["app-server", "--stdio"];
  const created = await adapter.createCodingSession({ agentKind: "codex", cwd });
  assert.match(created.session.id, /^ext_codex_[a-f0-9]{24}$/); assert.notEqual(created.session.id, "native-worker");
  assert.equal(ownership.has(created.session.id), true);
  const params = calls.find((request) => request.method === "thread/start").params;
  assert.equal(params.approvalPolicy, "on-request"); assert.equal(params.approvalsReviewer, "user");
  assert.equal(params.sandbox, "workspace-write"); assert.equal(params.ephemeral, false); assert.equal(params.cwd, cwd);
  assert.equal((await adapter.resumeCodingSession({ agentKind: "codex", cwd, providerSessionId: created.session.id })).session.id, created.session.id);
  await assert.rejects(adapter.resumeCodingSession({ agentKind: "codex", cwd: `${cwd}-other`, providerSessionId: created.session.id }), /owned/);
  adapter.refs.get(created.session.id).owned = false;
  await assert.rejects(adapter.resumeCodingSession({ agentKind: "codex", cwd, providerSessionId: created.session.id }), /owned/);
});

test("Codex structured worker refuses active native turns and binds permission requests to the native turn", async (t) => {
  const { cwd } = privateTree(t); const original = JsonlRpcClient.start;
  t.after(() => { JsonlRpcClient.start = original; });
  let options; let active = true; let approved = 0; const calls = [];
  const adapter = new CodexAppServerAdapter({ command: process.execPath, haraVersion: "test", identityKey: Buffer.alloc(32, 3) });
  adapter.appServerArgs = async () => ["app-server"];
  adapter.refs.set(id, { nativeId: "native", cwd, owned: true, live: false, codingWorkspace: cwd, info });
  JsonlRpcClient.start = (value) => { options = value; return { notify() {}, close() { options.onClose(new Error("closed")); },
    async call(method, params) {
      calls.push([method, params]);
      if (method === "thread/resume") return { thread: { id: "native", cwd, status: active ? { type: "active", activeFlags: [] } : { type: "idle" } } };
      if (method === "turn/start") {
        queueMicrotask(() => options.onNotification("turn/completed", { threadId: "native", turn: { id: "native-turn", status: "completed" } }));
        return { turn: { id: "native-turn" } };
      }
      return {};
    } }; };
  await assert.rejects(adapter.submit(id, "change", output()), /active native turn/);
  assert.equal(calls.some(([method]) => method === "turn/start"), false);
  active = false; await adapter.submit(id, "change", output());
  assert.equal(calls.find(([method]) => method === "thread/resume")[1].approvalPolicy, "on-request");
  const binding = { threadId: "native", nativeTurnReady: Promise.resolve("native-turn") };
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    assert.deepEqual(await adapter.answerServerRequest({ method, params: { threadId: "other", turnId: "native-turn" } },
      output({ confirm: async () => { approved++; return true; } }), new AbortController().signal, binding), { decision: "decline" });
    assert.deepEqual(await adapter.answerServerRequest({ method, params: { threadId: "native", turnId: "native-turn" } },
      output({ confirm: async () => { approved++; return true; } }), new AbortController().signal, binding), { decision: "accept" });
  }
  assert.equal(approved, 2);
});

test("Codex coding-worker notifications reject foreign or missing native bindings, including same-chunk completion", async (t) => {
  const { cwd } = privateTree(t); const original = JsonlRpcClient.start;
  t.after(() => { JsonlRpcClient.start = original; });
  let options; const texts = []; const tools = [];
  const adapter = new CodexAppServerAdapter({ command: process.execPath, haraVersion: "test", identityKey: Buffer.alloc(32, 3) });
  adapter.appServerArgs = async () => ["app-server"];
  adapter.refs.set(id, { nativeId: "native", cwd, owned: true, live: false, codingWorkspace: cwd, info });
  JsonlRpcClient.start = (value) => { options = value; return { notify() {}, close() { options.onClose(new Error("closed")); },
    async call(method) {
      if (method === "thread/resume") return { thread: { id: "native", cwd, status: { type: "idle" } } };
      if (method === "turn/start") {
        for (const binding of [{ threadId: "foreign", turnId: "native-turn" }, { threadId: "native", turnId: "foreign" }, {}]) {
          options.onNotification("item/agentMessage/delta", { ...binding, delta: "must not project" });
          options.onNotification("item/completed", { ...binding, item: { type: "commandExecution", command: "must not project" } });
          options.onNotification("turn/completed", { threadId: binding.threadId, turn: { id: binding.turnId, status: "failed" } });
        }
        options.onNotification("item/agentMessage/delta", { threadId: "native", turnId: "native-turn", delta: "bound output" });
        options.onNotification("turn/completed", { threadId: "native", turn: { id: "native-turn", status: "completed" } });
        return { turn: { id: "native-turn" } };
      }
      return {};
    } }; };
  const result = await adapter.submit(id, "change", output({ text: (text) => texts.push(text), tool: (name) => tools.push(name) }));
  assert.equal(result.status, "completed"); assert.equal(result.reply, "bound output");
  assert.deepEqual(texts, ["bound output"]); assert.deepEqual(tools, []);
});

const claudeFixture = (cwd, overrides = {}) => {
  const calls = []; let native;
  const sdk = {
    listSessions: async () => [], getSessionMessages: async () => [],
    getSessionInfo: async () => ({ sessionId: native, cwd, summary: "", lastModified: 1 }),
    query(input) {
      calls.push(input); native = input.options.sessionId ?? input.options.resume;
      const handle = (async function* () { yield { type: "result", subtype: "success", session_id: native, result: "done" }; })();
      handle.close = () => {}; return handle;
    }, ...overrides,
  };
  const adapter = new ClaudeAgentSdkAdapter({ command: process.execPath, identityKey: Buffer.alloc(32, 4), sdk,
    authenticationStatus: async () => "authenticated" });
  return { adapter, sdk, calls };
};

test("Claude creates with the exact reserved UUID then resumes it with default permissions and exact cwd", async (t) => {
  const { cwd } = privateTree(t); const { adapter, calls } = claudeFixture(cwd);
  const created = await adapter.createCodingSession({ agentKind: "claude", cwd });
  await adapter.submit(created.session.id, "first", output());
  assert.match(calls[0].options.sessionId, /^[a-f0-9-]{36}$/); assert.equal(calls[0].options.resume, undefined);
  assert.equal(calls[0].options.permissionMode, "default"); assert.equal(calls[0].options.cwd, cwd);
  await adapter.resumeCodingSession({ agentKind: "claude", cwd, providerSessionId: created.session.id });
  await adapter.submit(created.session.id, "next", output());
  assert.equal(calls[1].options.resume, calls[0].options.sessionId); assert.equal(calls[1].options.sessionId, undefined);
  await assert.rejects(adapter.resumeCodingSession({ agentKind: "claude", cwd: `${cwd}-other`, providerSessionId: created.session.id }), /owned/);
  adapter.refs.get(created.session.id).owned = false;
  await assert.rejects(adapter.resumeCodingSession({ agentKind: "claude", cwd, providerSessionId: created.session.id }), /owned/);
});

test("Claude worker never adopts a different native session or workspace on continuation", async (t) => {
  const { cwd } = privateTree(t); const { adapter, sdk } = claudeFixture(cwd);
  const created = await adapter.createCodingSession({ agentKind: "claude", cwd });
  const native = adapter.refs.get(created.session.id).nativeId;
  for (const metadata of [{ sessionId: "different", cwd }, { sessionId: native, cwd: `${cwd}-other` }, undefined]) {
    sdk.getSessionInfo = async () => metadata;
    await assert.rejects(adapter.resumeCodingSession({ agentKind: "claude", cwd, providerSessionId: created.session.id }), /original coding session/);
  }
  sdk.query = () => { const handle = (async function* () { yield { type: "result", session_id: "wrong", subtype: "success", result: "must not project" }; })(); handle.close = () => {}; return handle; };
  let text = ""; const result = await adapter.submit(created.session.id, "first", output({ text: (value) => { text += value; } }));
  assert.equal(result.status, "failed"); assert.equal(text, "");
});

test("Claude cancellation during authentication setup never dispatches a late query", async (t) => {
  const { cwd } = privateTree(t); const { adapter, calls } = claudeFixture(cwd);
  const created = await adapter.createCodingSession({ agentKind: "claude", cwd });
  const controller = new AbortController(); let release;
  adapter.options.authenticationStatus = () => new Promise((resolve) => { release = resolve; });
  const turn = adapter.submit(created.session.id, "cancel", output({ signal: controller.signal }));
  controller.abort(); release("authenticated");
  await assert.rejects(turn, /cancelled before dispatch/); assert.equal(calls.length, 0);
});

test("Claude string-prompt turns do not pretend a finite streamInput call is a safe in-flight queue", async (t) => {
  const { cwd } = privateTree(t); const { adapter } = claudeFixture(cwd);
  const created = await adapter.createCodingSession({ agentKind: "claude", cwd });
  const registry = new ExternalSessionRegistry({ haraVersion: "test", adapters: [adapter] });
  assert.equal(adapter.steer, undefined);
  await assert.rejects(registry.steer(created.session.id, "do not silently drop"), /does not support steering/);
});
