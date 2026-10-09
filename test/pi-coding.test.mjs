import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, unlinkSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { executePiCodingAgent } from "../dist/coding/pi.js";
import { createCodingHostBridge } from "../dist/coding/host.js";
import { createCodingContinuationStore } from "../dist/coding/continuations.js";

const BUDGET = { maxProviderRounds: 6, maxToolCalls: 6, maxTokens: 200_000, timeoutMs: 10_000 };
const TOOL = { name: "read", description: "Read the authorized synthetic fixture", input_schema: {
  type: "object", properties: { fixture: { type: "string" } }, required: ["fixture"], additionalProperties: false,
} };
const done = (text = "Synthetic task complete") => ({ text, stop: "end", toolUses: [], usage: { input: 30, output: 5 } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(t, { continuations = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-pi-unit-")));
  const home = join(root, "home"), cwd = join(root, "workspace");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const signal = new AbortController(), ack = [], events = [], mailbox = [];
  let bound;
  const request = {
    id: "worker_synthetic", path: "/root/synthetic", parentPath: "/root", generation: 1,
    runtime: "pi", initialInputIds: [], task: "Initial assignment:\nRemember the synthetic marker azalea-314 and finish the fixture.",
    signal: signal.signal, controller: {}, workspace: { mode: "isolated-write", cwd, sourceCwd: cwd, writeBoundary: cwd },
    budget: { ...BUDGET }, pendingInput: async () => mailbox, reserveInput: async () => mailbox,
    acknowledgeInput: async id => { ack.push(id); }, bindProviderSession: id => { bound = id; events.push("bind"); },
    reportProgress: () => true,
  };
  const files = () => {
    const directory = join(home, ".hara", "agent-teams", "pi-workers");
    const worker = join(directory, readdirSync(directory)[0]);
    return { worker, state: join(worker, "state.json"), native: join(worker, "native.jsonl"), lease: join(worker, "lease.json"), runtime: join(worker, "runtime") };
  };
  let bridge, tools = [];
  const run = async (provider = { id: "synthetic", model: "do-not-change", turn: async () => done() }, overrides = {}, observer = {}) => executePiCodingAgent({ ...request, ...overrides }, async hostSignal => {
    events.push("host");
    assert.match(bound, /^ext_pi_[a-f0-9]{24}$/);
    const state = JSON.parse(readFileSync(files().state, "utf8"));
    const header = JSON.parse(readFileSync(files().native, "utf8").split("\n")[0]);
    assert.equal(state.providerSessionId, bound); assert.equal(header.id, state.nativeId);
    assert.equal(header.version, 3); assert.equal(lstatSync(files().native).mode & 0o777, 0o600);
    bridge = await createCodingHostBridge({ provider, tools: [TOOL], executeTool: async (name, args, toolSignal) => {
      assert.equal(name, "read"); assert.equal(args.fixture, "A"); assert.equal(toolSignal.aborted, false);
      tools.push({ name, args }); return "synthetic fixture A";
    }, assertCurrent() {}, budget: { ...BUDGET, ...(overrides.budget ?? {}) }, signal: hostSignal,
    ...(continuations ? { continuationStore: createCodingContinuationStore(home, { workerId: request.id, providerSessionId: bound, cwd, providerId: provider.id, model: provider.model }) } : {}),
    });
    return bridge;
  }, { onPiSession: id => { assert.equal(id, bound); events.push("observe"); }, ...observer }, home);
  return { root, home, cwd, request, signal, ack, events, mailbox, files, run, tools, get bound() { return bound; }, get bridge() { return bridge; } };
}

test("real Pi SDK binds a private v3 session before host/model dispatch and uses only Hara MCP tools", async t => {
  const f = fixture(t), turns = [], output = [];
  const result = await f.run({ id: "synthetic", model: "do-not-change", async turn(args) {
    turns.push(args);
    return turns.length === 1 ? { text: "Checking fixture", stop: "tool_use", toolUses: [{ id: "synthetic_call_1", name: "hara_read", input: { fixture: "A" } }],
      continuation: { type: "chat_reasoning", text: "private synthetic reasoning" }, usage: { input: 35, output: 8 } } : done();
  } }, {}, { text: text => output.push(text) });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.text, "Synthetic task complete"); assert.equal(result.model, "hara/coding");
  assert.equal(result.providerSessionId, f.bound); assert.equal(result.runtimeSessionId, undefined);
  assert.deepEqual(f.events.slice(0, 3), ["bind", "observe", "host"]);
  assert.deepEqual(output, ["Synthetic task complete"]);
  assert.deepEqual(f.tools, [{ name: "read", args: { fixture: "A" } }]);
  assert.deepEqual(turns[0].tools.map(tool => tool.name), ["hara_read"]);
  assert.equal(turns[1].history.find(message => message.role === "assistant").continuation.text, "private synthetic reasoning");
  assert.equal(result.metrics.providerRounds, 2); assert.equal(result.metrics.toolCalls, 1);
  assert.equal(lstatSync(f.files().worker).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.files().state).mode & 0o777, 0o600);
  assert.equal(readdirSync(f.files().worker).includes("lease.json"), false);
  for (const file of ["auth.json", "models.json", "models-store.json"]) assert.deepEqual(JSON.parse(readFileSync(join(f.files().runtime, file), "utf8")), {});
  assert.equal(readFileSync(f.files().native, "utf8").includes(f.bridge.provider.hara.options.apiKey), false);
  assert.equal((await fetch(f.bridge.mcp.url).catch(() => null)), null, "closed host must not retain a listening socket");
});

test("close and reopen preserve the same worker native id, Hara opaque id and model memory", async t => {
  const f = fixture(t);
  const first = await f.run(); assert.equal(first.status, "completed", JSON.stringify(first));
  const files = f.files(), state = JSON.parse(readFileSync(files.state, "utf8"));
  // The signed native JSONL remains a standard SDK v3 session, not an empty placeholder path.
  const native = SessionManager.open(files.native, files.worker, f.cwd);
  assert.equal(native.getSessionId(), state.nativeId); assert.ok(native.buildSessionContext().messages.length >= 3);
  let memory;
  const second = await f.run({ id: "synthetic", model: "same-authorized-model", async turn(args) { memory = args.history; return done("azalea-314 remembered"); } },
    { generation: 2, providerSessionId: first.providerSessionId, task: "Report the synthetic marker from the previous turn." });
  assert.equal(second.status, "completed", JSON.stringify(second)); assert.equal(second.providerSessionId, first.providerSessionId);
  assert.ok(memory.some(message => message.role === "user" && message.content.includes("azalea-314")));
  assert.equal(JSON.parse(readFileSync(files.state, "utf8")).nativeId, state.nativeId);
  assert.equal(SessionManager.open(files.native, files.worker, f.cwd).getSessionId(), state.nativeId);
});

test("initial reserved messages are not duplicated and ACK only after successful settled completion", async t => {
  const f = fixture(t);
  f.mailbox.push({ id: "initial-1", sourcePath: "/root", kind: "message", content: "azalea-314" });
  f.request.initialInputIds = ["initial-1"];
  let content;
  const result = await f.run({ id: "synthetic", model: "fixture", async turn(args) { content = args.history; return done(); } });
  assert.equal(result.status, "completed", JSON.stringify(result)); assert.deepEqual(f.ack, ["initial-1"]);
  assert.equal(content.filter(message => message.role === "user").length, 1);
  assert.equal(content[0].content, f.request.task);
});

test("pending mailbox batch stays ordered and durable, uses two SDK host rounds rather than three, and ACKs only after settlement", async t => {
  const f = fixture(t), entered = deferred(), release = deferred(), queued = deferred(), finishing = deferred(), finish = deferred();
  const turns = [];
  let mailboxPolls = 0;
  f.request.reserveInput = async () => {
    // A second nonempty pump poll can only happen after both steer() calls from the first poll settle.
    if (f.mailbox.length && ++mailboxPolls === 2) queued.resolve();
    return f.mailbox;
  };
  const operation = f.run({ id: "synthetic", model: "fixture", async turn(args) {
    turns.push(args);
    if (turns.length === 1) { entered.resolve(); await release.promise; return { text: "Checking", stop: "tool_use", toolUses: [{ id: "steer_call", name: "hara_read", input: { fixture: "A" } }], usage: { input: 20, output: 8 } }; }
    finishing.resolve(); await finish.promise;
    return done("Steered synthetic completion");
  } });
  await entered.promise;
  f.mailbox.push(
    { id: "later-1", sourcePath: "/root", kind: "message", content: "Use the first later synthetic requirement." },
    { id: "later-2", sourcePath: "/root", kind: "followup", content: "Use the second later synthetic requirement." },
  );
  await queued.promise;
  assert.deepEqual(f.ack, []); release.resolve();
  await finishing.promise;
  const expected = f.mailbox.map(delivery => `Hara mailbox ${delivery.id} (${delivery.kind}) from ${delivery.sourcePath}:\n${delivery.content}`);
  assert.deepEqual(turns[1].history.filter(message => message.role === "user").map(message => message.content), [f.request.task, ...expected]);
  const persistedUsers = readFileSync(f.files().native, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
    .filter(entry => entry.type === "message" && entry.message.role === "user").map(entry => entry.message.content);
  assert.deepEqual(persistedUsers, [f.request.task, ...expected].map(text => [{ type: "text", text }]));
  assert.deepEqual(f.ack, [], "consumed and durable messages still wait for successful settled completion");
  finish.resolve();
  const result = await operation; assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(turns.length, 2); assert.equal(result.metrics.providerRounds, 2);
  assert.deepEqual(f.ack, ["later-1", "later-2"]);
});

test("parent cancellation aborts actual SDK work, clears the ordered queued mailbox batch without ACK, and permits safe resume", async t => {
  const f = fixture(t), entered = deferred(), queued = deferred();
  let providerAborted = false, mailboxPolls = 0;
  f.request.reserveInput = async () => {
    if (f.mailbox.length && ++mailboxPolls === 2) queued.resolve();
    return f.mailbox;
  };
  const operation = f.run({ id: "synthetic", model: "fixture", async turn({ signal }) {
    entered.resolve();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => { providerAborted = true; reject(new Error("synthetic cancellation")); }, { once: true }));
    return done();
  } });
  await entered.promise;
  f.mailbox.push(
    { id: "queued-cancel-1", sourcePath: "/root", kind: "message", content: "First must not be prematurely delivered" },
    { id: "queued-cancel-2", sourcePath: "/root", kind: "followup", content: "Second must not be prematurely delivered" },
  );
  await queued.promise; f.signal.abort();
  const result = await operation;
  assert.equal(result.status, "cancelled", JSON.stringify(result)); assert.equal(providerAborted, true); assert.deepEqual(f.ack, []);
  assert.doesNotMatch(readFileSync(f.files().native, "utf8"), /Hara mailbox queued-cancel-/);
  assert.equal(readdirSync(f.files().worker).includes("lease.json"), false);
  const resumed = await f.run(undefined, { signal: new AbortController().signal, generation: 2, providerSessionId: result.providerSessionId, task: "Resume the synthetic interrupted worker." });
  assert.equal(resumed.status, "completed", JSON.stringify(resumed)); assert.equal(resumed.providerSessionId, result.providerSessionId);
});

test("provider errors and empty assistant replies are never successful settled completions", async t => {
  for (const mode of ["error", "empty"]) {
    const f = fixture(t);
    f.mailbox.push({ id: "must-stay-pending", sourcePath: "/root", kind: "message", content: "already represented" });
    f.request.initialInputIds = ["must-stay-pending"];
    const result = await f.run({ id: "synthetic", model: "fixture", async turn() {
      if (mode === "error") throw new Error("synthetic upstream failure sk-do-not-disclose");
      return done("");
    } });
    assert.notEqual(result.status, "completed", JSON.stringify(result)); assert.deepEqual(f.ack, []);
    assert.doesNotMatch(JSON.stringify(result), /sk-do-not-disclose/);
  }
});

test("invalid bound id, changed cwd/version, missing state/native and valid-JSON tampering fail closed before model dispatch", async t => {
  for (const mode of ["id", "cwd", "version", "native-missing", "state-missing", "truncated", "injected", "header"]) {
    const f = fixture(t), first = await f.run(); assert.equal(first.status, "completed", JSON.stringify(first));
    const files = f.files(), overrides = { generation: 2, providerSessionId: first.providerSessionId };
    if (mode === "id") overrides.providerSessionId = "ext_pi_000000000000000000000000";
    if (mode === "cwd") { const other = join(f.root, "other"); mkdirSync(other); overrides.workspace = { ...f.request.workspace, cwd: other, writeBoundary: other }; }
    if (mode === "version") { const state = JSON.parse(readFileSync(files.state, "utf8")); state.engineVersion = "0.0.0"; writeFileSync(files.state, JSON.stringify(state)); }
    if (mode === "native-missing") unlinkSync(files.native);
    if (mode === "state-missing") unlinkSync(files.state);
    if (mode === "truncated") writeFileSync(files.native, readFileSync(files.native, "utf8").slice(0, -1));
    if (mode === "injected") { const lines = readFileSync(files.native, "utf8").trimEnd().split("\n"); const row = JSON.parse(lines.at(-1)); row.message.content = [{ type: "text", text: "valid JSON malicious context injection" }]; lines[lines.length - 1] = JSON.stringify(row); writeFileSync(files.native, lines.join("\n") + "\n"); }
    if (mode === "header") { const lines = readFileSync(files.native, "utf8").trimEnd().split("\n"); const row = JSON.parse(lines[0]); row.id = "foreign-native-id"; lines[0] = JSON.stringify(row); writeFileSync(files.native, lines.join("\n") + "\n"); }
    const calls = f.events.filter(value => value === "host").length;
    const result = await f.run(undefined, overrides);
    assert.equal(result.status, "error", mode + ": " + JSON.stringify(result));
    assert.equal(f.events.filter(value => value === "host").length, calls, mode);
  }
});

test("symlink and hardlink session substitutions are refused without modifying the foreign target", async t => {
  for (const mode of ["symlink", "hardlink"]) {
    const f = fixture(t), first = await f.run(); assert.equal(first.status, "completed", JSON.stringify(first));
    const files = f.files(), foreign = join(f.root, "foreign.jsonl"), text = readFileSync(files.native, "utf8");
    writeFileSync(foreign, text, { mode: 0o600 }); unlinkSync(files.native);
    if (mode === "symlink") symlinkSync(foreign, files.native); else linkSync(foreign, files.native);
    const result = await f.run(undefined, { providerSessionId: first.providerSessionId, generation: 2 });
    assert.equal(result.status, "error", JSON.stringify(result)); assert.equal(readFileSync(foreign, "utf8"), text);
  }
});

test("simultaneous same-worker execution is rejected while its durable lease is held", async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const first = f.run({ id: "synthetic", model: "fixture", async turn() { entered.resolve(); await release.promise; return done(); } });
  await entered.promise;
  const second = await f.run(undefined, { generation: 2, providerSessionId: f.bound });
  assert.equal(second.status, "error", JSON.stringify(second));
  release.resolve(); assert.equal((await first).status, "completed");
  assert.equal(f.events.filter(value => value === "host").length, 1);
});

test("deadline and revoked progress stop SDK work without claiming completion", async t => {
  const f = fixture(t), entered = deferred();
  const result = await f.run({ id: "synthetic", model: "fixture", async turn({ signal }) {
    entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true })); return done();
  } }, { budget: { ...BUDGET, timeoutMs: 250 } });
  assert.equal(result.status, "halted", JSON.stringify(result)); assert.equal(readdirSync(f.files().worker).includes("lease.json"), false);
  const g = fixture(t); let calls = 0;
  const revoked = await g.run({ id: "synthetic", model: "fixture", async turn() { calls += 1; return done(); } }, { reportProgress: () => false });
  assert.equal(revoked.status, "halted", JSON.stringify(revoked)); assert.equal(calls, 0);
});

test("real Pi recovery restores Responses reasoning across reconstructed host bridges", async t => {
  const f = fixture(t, { continuations: true }); let calls = 0;
  const continuation = { type: "responses_reasoning", items: [{ type: "reasoning", id: "reason_cross_generation", summary: [], encrypted_content: "synthetic-encrypted-cross-generation" }] };
  const first = await f.run({ id: "synthetic", model: "same-authorized-model", async turn() {
    calls += 1;
    return calls === 1 ? { text: "Checking", stop: "tool_use", toolUses: [{ id: "cross_generation_call", name: "hara_read", input: { fixture: "A" } }], continuation, usage: { input: 20, output: 5 } } : done();
  } });
  assert.equal(first.status, "completed", JSON.stringify(first));
  let restored;
  const second = await f.run({ id: "synthetic", model: "same-authorized-model", async turn(args) {
    restored = args.history.find(message => message.role === "assistant" && message.toolUses.length)?.continuation;
    return done("Resumed reasoning successfully");
  } }, { generation: 2, providerSessionId: first.providerSessionId, task: "Continue the prior synthetic task." });
  assert.equal(second.status, "completed", JSON.stringify(second)); assert.deepEqual(restored, continuation);
});

test("Pi cancellation local assistant audit entries do not poison strict continuation-store recovery", async t => {
  const f = fixture(t, { continuations: true }), entered = deferred();
  const firstRun = f.run({ id: "synthetic", model: "same-authorized-model", async turn({ signal }) {
    entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true })); return done();
  } });
  await entered.promise; f.signal.abort();
  const first = await firstRun; assert.equal(first.status, "cancelled", JSON.stringify(first));
  assert.match(readFileSync(f.files().native, "utf8"), /"stopReason":"aborted"/);
  const second = await f.run({ id: "synthetic", model: "same-authorized-model", async turn(args) {
    assert.equal(args.history.filter(message => message.role === "assistant").length, 0, "SDK error/aborted records are explicitly omitted from the wire history");
    return done("Cancelled worker safely resumed");
  } }, { generation: 2, providerSessionId: first.providerSessionId, signal: new AbortController().signal, task: "Resume this synthetic cancelled task." });
  assert.equal(second.status, "completed", JSON.stringify(second));
});
