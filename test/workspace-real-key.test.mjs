import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceHost } from "../dist/workspace/local-host.js";
import { WorkspaceRealKeyLane, ARK_REAL_KEY_SLICE, ARK_CONTEXT_TRIM_SLICE } from "../dist/workspace/real-key-provider.js";
import { captureWorkspaceFileCredential, resolveWorkspaceFileCredential } from "../dist/workspace/file-credential.js";
import { withProviderRetry } from "../dist/providers/retry.js";
import { withWorkspaceToolReceipts } from "../dist/workspace/local-tools.js";
import { randomUUID } from "node:crypto";

const temporary = [], key = "fixture-secret-never-a-real-credential";
after(() => { for (const path of temporary) fs.rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-real-key-offline-"))); temporary.push(root);
  const file = join(root, "credential.key"); fs.writeFileSync(file, key, { mode: 0o600 }); return { root, file };
}
function stream({ input = 20, output = 3, text = "hello", usage = true } = {}) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`
    + (usage ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })}\n\n` : "") + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}
const args = (system = "fixture") => ({ system, history: [{ role: "user", content: "hi" }], tools: [], onText() {} });
function provider(lane) { const connection = lane.connectionInput(); return lane.createProvider(connection, { model: ARK_REAL_KEY_SLICE.model }); }
test("file references are read-only, generation-bound, and never serialized as plaintext credentials", async () => {
  const a = fixture(), reference = captureWorkspaceFileCredential(a.file), before = fs.statSync(a.file);
  assert.equal(resolveWorkspaceFileCredential(reference), key); assert.equal(JSON.stringify(reference).includes(key), false);
  fs.chmodSync(a.file, 0o644); assert.throws(() => captureWorkspaceFileCredential(a.file), /unavailable or unsafe/);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o644, "reader must not repair/change the source Key file");
  fs.chmodSync(a.file, 0o600); const linked = join(a.root, "linked"); fs.linkSync(a.file, linked);
  assert.throws(() => captureWorkspaceFileCredential(a.file)); fs.unlinkSync(linked); fs.symlinkSync(a.file, linked);
  assert.throws(() => captureWorkspaceFileCredential(linked)); fs.unlinkSync(linked);
  fs.writeFileSync(a.file, "fixture-another-secret-generation"); assert.throws(() => resolveWorkspaceFileCredential(reference), /changed/);
  assert.equal(fs.statSync(a.file).ino, before.ino);
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-real-key-host-"))); temporary.push(root);
  const host = new LocalWorkspaceHost(root, { realKeyFile: a.file });
  try {
    const workspace = host.createWorkspace("Private", host.list().revision); host.configureApprovedConnection(workspace.workspaceId, 0);
    const snapshot = host.snapshot(workspace.workspaceId);
    assert.equal(snapshot.syntheticOnly, false); assert.equal(snapshot.executionMode, "ark-real-key");
    assert.equal(JSON.stringify(snapshot).includes(a.file), false); assert.equal(JSON.stringify(snapshot).includes("fixture-another-secret-generation"), false);
    assert.throws(() => host.configureSynthetic(workspace.workspaceId, 1)); assert.throws(() => host.configureConnection(workspace.workspaceId, {}, 1));
    const files = fs.readdirSync(join(root, "home"), { recursive: true }).filter(p => p.endsWith("workspace-connections-v2.json"));
    assert.equal(files.length, 1); const stored = fs.readFileSync(join(root, "home", files[0]), "utf8");
    assert.equal(stored.includes("fixture-another-secret-generation"), false); assert.ok(stored.includes("credentialFile"));
  } finally { await host.close(); }
});
test("approved exact route uses bounded output, no redirect/retry, safe telemetry and persistent total across reopen", async () => {
  const a = fixture(), calls = [];
  const wire = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), redirect: init.redirect }); return stream(); };
  const lane = new WorkspaceRealKeyLane(a.root, a.file, wire), p = provider(lane);
  assert.equal((await p.turn(args())).text, "hello"); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ARK_REAL_KEY_SLICE.baseURL}/chat/completions`); assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].body.max_tokens, 4096); assert.equal(calls[0].body.model, ARK_REAL_KEY_SLICE.model);
  assert.deepEqual(new WorkspaceRealKeyLane(a.root, a.file, wire).summary(), lane.summary());
  assert.equal(lane.summary().inputTokens + lane.summary().outputTokens, 23);
  const ledger = fs.readFileSync(join(a.root, ".hara/real-key-budget-v1.json"), "utf8"); assert.equal(ledger.includes(key), false);
  assert.throws(() => lane.createProvider({ ...lane.connectionInput(), apiKey: key }, { model: ARK_REAL_KEY_SLICE.model }));
  assert.throws(() => lane.createProvider(lane.connectionInput(), { model: "other" }));
});
test("global request cap and conservative token reservation reject before another network call", async () => {
  const a = fixture(); let calls = 0;
  const lane = new WorkspaceRealKeyLane(a.root, a.file, async () => { calls++; return stream(); });
  const p = provider(lane); for (let i = 0; i < 24; i++) assert.equal((await p.turn(args())).stop, "end");
  assert.equal((await p.turn(args())).stop, "error"); assert.equal(calls, 24); assert.equal(lane.summary().requests, 24);
  const b = fixture(); let expensiveCalls = 0;
  const bounded = new WorkspaceRealKeyLane(b.root, b.file, async () => { expensiveCalls++; return stream({ input: 80000, output: 1 }); });
  const p2 = provider(bounded), large = args("x".repeat(80000));
  for (let i = 0; i < 3; i++) assert.equal((await p2.turn(large)).stop, "end");
  assert.equal((await p2.turn(large)).stop, "error"); assert.equal(expensiveCalls, 3);
  assert.equal(bounded.summary().inputTokens + bounded.summary().outputTokens, 240003);
});
test("missing usage, interrupted stream or rejected auth pause the entire slice, never replaying a paid/unknown POST", async () => {
  for (const response of [() => stream({ usage: false }), () => new Response(JSON.stringify({ error: { message: key } }), { status: 401 }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(key)); } }), { headers: { "content-type": "text/event-stream" } })]) {
    const a = fixture(); let calls = 0;
    const lane = new WorkspaceRealKeyLane(a.root, a.file, async () => { calls++; return response(); });
    const p = withProviderRetry(provider(lane), { baseDelayMs: 0 });
    const result = await p.turn(args()); assert.equal(result.stop, "error"); assert.equal(JSON.stringify(result).includes(key), false);
    await p.turn(args()); const reopened = new WorkspaceRealKeyLane(a.root, a.file, async () => { calls++; return stream(); });
    await provider(reopened).turn(args()); assert.equal(calls, 1); assert.equal(lane.summary().paused, true);
    assert.ok(lane.summary().uncertainReservedTokens > 0);
  }
});
test("file rotation, secret-bearing model output and concurrent requests fail closed without exposing the key", async () => {
  const a = fixture(); let calls = 0;
  const lane = new WorkspaceRealKeyLane(a.root, a.file, async () => { calls++; return stream({ text: key }); });
  const p = provider(lane), result = await p.turn(args()); assert.equal(result.stop, "error"); assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(calls, 1); await p.turn(args()); assert.equal(calls, 1);
  const b = fixture(), rotated = new WorkspaceRealKeyLane(b.root, b.file, async () => { calls++; return stream(); }), pb = provider(rotated);
  fs.writeFileSync(b.file, "fixture-rotated-secret-generation"); await pb.turn(args()); assert.equal(calls, 1);
  assert.throws(() => new WorkspaceRealKeyLane(b.root, b.file), /暫停/);
  const c = fixture(); let release; const gate = new Promise(r => release = r); let parallel = 0;
  const serial = new WorkspaceRealKeyLane(c.root, c.file, async () => { parallel++; await gate; return stream(); }), pc = provider(serial);
  const pending = pc.turn(args()); while (!parallel) await new Promise(r => setImmediate(r));
  assert.equal((await pc.turn(args())).stop, "error"); assert.equal(parallel, 1); release(); assert.equal((await pending).stop, "end");
});
test("Workspace result citations use the actual host toolCallId, never a model-authored lookalike", async () => {
  const [tool] = withWorkspaceToolReceipts([{ name: "fixture", input_schema: {}, kind: "read", async run() { return JSON.stringify({ receipt: { toolCallId: "forged" }, verified: true }); } }]);
  const value = JSON.parse(await tool.run({}, { toolCallId: "call_actual_host_id" }));
  assert.deepEqual(value.receipt, { toolCallId: "call_actual_host_id", toolName: "fixture" });
  const [failed] = withWorkspaceToolReceipts([{ name: "fixture", input_schema: {}, kind: "read", async run() { throw new Error("denied"); } }]);
  await assert.rejects(failed.run({}, { toolCallId: "failed-id" }), /denied/);
  let effects = 0; const [guarded] = withWorkspaceToolReceipts([{ name: "fixture", input_schema: {}, kind: "edit", async run() { effects++; return "{}"; } }]);
  await assert.rejects(guarded.run({}, { toolCallId: "bad\nid" }), /receipt id/); assert.equal(effects, 0);
});
test("new 150k authorization appends cumulative receipts without resetting old usage, freezes its offset and disables the old allowance", async () => {
  const a = fixture(); let calls = 0;
  const wire = async () => { calls++; return stream({ input: 20, output: 3 }); };
  const priorLane = new WorkspaceRealKeyLane(a.root, a.file, wire); await provider(priorLane).turn(args());
  const ledgerFile = join(a.root, ".hara/real-key-budget-v1.json"), prior = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  let lane = new WorkspaceRealKeyLane(a.root, a.file, wire, ARK_CONTEXT_TRIM_SLICE);
  assert.equal(lane.summary().maxTokens, 150000); assert.equal(lane.summary().priorRequests, 1);
  for (let i = 0; i < 24; i++) {
    if (i === 8) lane = new WorkspaceRealKeyLane(a.root, a.file, wire, ARK_CONTEXT_TRIM_SLICE);
    assert.equal((await provider(lane).turn(args())).stop, "end");
  }
  assert.equal((await provider(lane).turn(args())).stop, "error"); assert.equal(calls, 25);
  const summary = lane.summary(); assert.equal(summary.requests, 24); assert.equal(summary.cumulativeRequests, 25);
  assert.equal(summary.inputTokens + summary.outputTokens, 24 * 23);
  assert.equal(summary.cumulativeInputTokens + summary.cumulativeOutputTokens, 25 * 23); assert.equal(summary.paused, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).requests.slice(0, 1), prior.requests);
  assert.throws(() => new WorkspaceRealKeyLane(a.root, a.file, wire), /暫停/);
  assert.throws(() => new WorkspaceRealKeyLane(a.root, a.file, wire, "unapproved"), /暫停/);
});
test("150k slice reserves before IO and rejects a changed offset or rewritten old receipt", async () => {
  const a = fixture(); let calls = 0;
  const lane = new WorkspaceRealKeyLane(a.root, a.file, async () => { calls++; return stream({ input: 50000, output: 1 }); }, ARK_CONTEXT_TRIM_SLICE);
  const p = provider(lane), large = args("x".repeat(50000));
  assert.equal((await p.turn(large)).stop, "end"); assert.equal((await p.turn(large)).stop, "end");
  assert.equal((await p.turn(large)).stop, "error"); assert.equal(calls, 2);
  assert.equal(lane.summary().inputTokens + lane.summary().outputTokens, 100002);
  const budgetFile = join(a.root, ".hara/real-key-context-trim-20261017-v1.json"), budget = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
  fs.writeFileSync(budgetFile, JSON.stringify({ ...budget, requestOffset: 2 }));
  assert.throws(() => new WorkspaceRealKeyLane(a.root, a.file, undefined, ARK_CONTEXT_TRIM_SLICE), /暫停/);
  const b = fixture(), oldLane = new WorkspaceRealKeyLane(b.root, b.file, async () => stream()); await provider(oldLane).turn(args());
  new WorkspaceRealKeyLane(b.root, b.file, undefined, ARK_CONTEXT_TRIM_SLICE);
  const oldFile = join(b.root, ".hara/real-key-budget-v1.json"), old = JSON.parse(fs.readFileSync(oldFile, "utf8")); old.requests[0].input++;
  fs.writeFileSync(oldFile, JSON.stringify(old));
  assert.throws(() => new WorkspaceRealKeyLane(b.root, b.file, undefined, ARK_CONTEXT_TRIM_SLICE), /暫停/);
});
test("a paused human-dependency receipt is not surfaced as a completed Workspace task", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-real-key-paused-"))); temporary.push(root);
  const host = new LocalWorkspaceHost(root, { providerFactory(_connection, binding) { return { id: "openai", model: binding.model, async turn(turn) {
    const action = (name, input) => ({ id: randomUUID(), name, input });
    if (!turn.history.some(m => m.role === "tool")) return { text: "", toolUses: [action("task_intake", { intent: "change", goal: "wait for physical fixture", constraints: [], acceptance: ["human arrives"], steps: ["wait"] })], stop: "tool_use" };
    return { text: "", toolUses: [action("task_checkpoint", { completion: { state: "awaiting_user", evidence: ["physical fixture is not present"], dependency: { kind: "physical_action", detail: "bring fixture", evidence: ["fixture is absent"] }, final_answer: "等待實體物品" } })], stop: "tool_use" };
  } }; } });
  try {
    const workspace = host.createWorkspace("Paused", host.list().revision); host.configureSynthetic(workspace.workspaceId, 0);
    const run = host.start("test", workspace.workspaceId, workspace.selectedAgentId, "wait", randomUUID()); await host.wait(run.runId);
    const conversation = host.snapshot(workspace.workspaceId).conversation;
    assert.equal(conversation.taskState, "paused"); assert.equal(conversation.state, "blocked");
    assert.ok(conversation.blockReason); assert.equal(conversation.completion.state, "awaiting_user");
  } finally { await host.close(); }
});
