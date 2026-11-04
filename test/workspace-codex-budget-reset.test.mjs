import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
import { codexContextLimit, nativeContextLimit } from "../dist/workspace/codex-thread.js";
import { codexThreadState } from "../dist/workspace/codex-thread.js";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { WorkspaceResourceStorage } from "../dist/workspace/resource-context.js";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const sample = (input, cached, output, lastInput = input, lastCached = cached) => ({
  total: { inputTokens: input, cachedInputTokens: cached, outputTokens: output },
  last: { inputTokens: lastInput, cachedInputTokens: lastCached, outputTokens: 20 }, modelContextWindow: 128000,
});
const nativeState = f => {
  const relative = fs.readdirSync(f.root, { recursive: true }).filter(name => /(?:^|\/)codex-thread-[a-f0-9]+\.json$/.test(name));
  assert.equal(relative.length, 1); const file = join(f.root, relative[0]);
  return { file, value: JSON.parse(fs.readFileSync(file, "utf8")) };
};
async function exchange(f, text = "List current colleagues?") { await f.send(text); return until(f.read, done); }
const resetParams = (f, view, requestId = randomUUID()) => ({ ...f.scope, agentId: f.main.agentId, requestId,
  approved: true, expectedRevision: view.conversation.revision, expectedNativeRevision: view.conversation.nativeSession.revision });

test("context configuration is independent of run allowance, leaves model headroom and rejects invalid values", () => {
  const saved = process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS;
  try {
    delete process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS; assert.equal(codexContextLimit(), 96000);
    assert.equal(nativeContextLimit({ modelContextWindow: 32000 }), 24000);
    process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS = "120000"; assert.equal(codexContextLimit(), 120000);
    assert.equal(nativeContextLimit({ modelContextWindow: 400000 }), 120000);
    for (const value of ["", "0", "1023", "1.5", "NaN", "1000001"]) {
      process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS = value; assert.throws(codexContextLimit, /must be an integer/);
    }
  } finally { if (saved === undefined) delete process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS; else process.env.HARA_CODEX_CONTEXT_LIMIT_TOKENS = saved; }
});

test("41k to 47k native totals debit only this attempt's 6k delta, with cached tokens separate and duplicate snapshots ignored", async t => {
  const first = sample(41000, 40000, 20);
  const f = await cliMcpFixture(t, "telemetry", { telemetry: [first, first] });
  let view = await exchange(f); assert.equal(view.conversation.state, "completed");
  assert.equal(view.conversation.runUsage.inputTokens, 1000);
  f.mode({ mode: "telemetry", telemetry: [sample(47000, 45000, 40, 47000, 41000), sample(47000, 45000, 40, 47000, 41000)] });
  view = await exchange(f, "List current colleagues again?");
  assert.equal(view.conversation.state, "completed");
  assert.deepEqual(view.conversation.nativeSession.lastAttempt, { input: 6000, cachedInput: 5000, output: 20 });
  assert.equal(view.conversation.runUsage.inputTokens, 1000); assert.equal(view.conversation.usage.inputTokens, 2000);
  assert.equal(view.conversation.usage.outputTokens, 40);
  assert.equal(f.native().filter(row => row.method === "thread/start").length, 1);
});

test("four native inferences totaling 147606 input do not trip 128k when 100k are cache hits", async t => {
  const f = await cliMcpFixture(t, "telemetry", { telemetry: [sample(36000, 0, 20), sample(72000, 32000, 40, 36000, 32000),
    sample(108000, 64000, 60, 36000, 32000), sample(147606, 100000, 80, 39606, 36000)] });
  const view = await exchange(f);
  assert.equal(view.conversation.state, "completed"); assert.equal(view.conversation.runUsage.inputTokens, 47606);
  assert.equal(view.conversation.runUsage.outputTokens, 80);
  assert.deepEqual(view.conversation.nativeSession.lastAttempt, { input: 147606, cachedInput: 100000, output: 80 });
  assert.equal(view.conversation.nativeSession.contextTokens, 39626); assert.equal(view.conversation.nativeSession.contextLimit, 96000);
  const started = f.native().find(row => row.method === "thread/start");
  assert.equal(started.params.config.model_auto_compact_token_limit, Number.MAX_SAFE_INTEGER);
  assert.equal(started.params.config.model_post_turn_compact_threshold_percent, 0);
});

test("context ceiling pauses with open-new-session guidance and persists across Host restart without another native turn", async t => {
  const f = await cliMcpFixture(t, "telemetry", { telemetry: [sample(97000, 96000, 20)] });
  let view = await exchange(f);
  assert.equal(view.conversation.taskState, "paused", JSON.stringify({ blockReason: view.conversation.blockReason, native: view.conversation.nativeSession, usage: view.conversation.runUsage })); assert.equal(view.conversation.nativeSession.status, "new_session_required");
  assert.match(view.conversation.blockReason, /Open a new session/); assert.equal(view.conversation.runUsage.inputTokens, 1000);
  const oldId = nativeState(f).value.threadId; await f.restart(); f.mode("list");
  view = await exchange(f, "Do not silently replace my thread.");
  assert.equal(view.conversation.taskState, "paused"); assert.equal(nativeState(f).value.threadId, oldId);
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 1);
});

test("resume-failed recovery requires explicit reset; audit, history and usage survive, nonce replay does not reset twice", async t => {
  const f = await cliMcpFixture(t, "list"); await exchange(f, "List current colleagues? Retain this history.");
  f.mode("resume-fail"); let view = await exchange(f, "List current colleagues again?");
  assert.equal(view.conversation.nativeSession.status, "recovery_needed");
  const prior = nativeState(f).value, before = structuredClone(view.conversation), params = resetParams(f, view);
  await assert.rejects(f.request("workspace.session.new", { ...params, approved: false }), /approval/);
  await assert.rejects(f.request("workspace.session.new", { ...params, expectedGeneration: randomUUID() }), /generation/);
  await assert.rejects(f.request("workspace.session.new", { ...params, expectedNativeRevision: params.expectedNativeRevision - 1 }), /changed/);
  await assert.rejects(f.request("workspace.session.new", { ...params, actorId: "spoofed" }), /fields/);
  const result = await f.request("workspace.session.new", params); assert.equal(result.duplicate, false);
  assert.equal((await f.request("workspace.session.new", params)).duplicate, true);
  const after = nativeState(f).value;
  assert.equal(after.threadId, null); assert.equal(after.resets.length, 1);
  assert.equal(after.resets[0].oldThreadId, prior.threadId); assert.match(after.resets[0].actorId, /^owner_/);
  assert.ok(Number.isFinite(Date.parse(after.resets[0].at)));
  view = await f.read(); assert.deepEqual(view.conversation.history, before.history); assert.deepEqual(view.conversation.usage, before.usage);
  assert.equal(f.native().filter(row => row.method === "thread/start").length, 1);
  await f.restart(); f.mode("list"); view = await exchange(f, "List current colleagues in a fresh native context?");
  assert.equal(view.conversation.state, "completed"); assert.notEqual(nativeState(f).value.threadId, prior.threadId);
  assert.equal(f.native().filter(row => row.method === "thread/start").length, 2);
});

test("reset rejects busy/draining turns without interrupting them or clearing their thread", async t => {
  const f = await cliMcpFixture(t, "hang"); await f.send("Keep running."); await until(async () => f.meta(), Boolean);
  const view = await f.read(), oldId = nativeState(f).value.threadId;
  await assert.rejects(f.request("workspace.session.new", resetParams(f, view)), /running|draining/);
  assert.equal(nativeState(f).value.threadId, oldId);
  await f.request("workspace.session.cancel", { ...f.scope, agentId: f.main.agentId, runId: view.conversation.runId });
  await until(f.read, done);
});

test("legacy saved counters migrate without granting cache credit from an unknown historical watermark", async t => {
  const f = await cliMcpFixture(t, "telemetry", { telemetry: [sample(41000, 40000, 20)] }); await exchange(f);
  const saved = nativeState(f), legacy = { ...saved.value, schemaVersion: 1 };
  for (const key of ["cachedInput", "contextTokens", "modelContextWindow", "lastAttempt", "resets"]) delete legacy[key];
  fs.writeFileSync(saved.file, JSON.stringify(legacy)); await f.restart();
  f.mode({ mode: "telemetry", telemetry: [sample(47000, 45000, 40, 47000, 41000)] });
  const view = await exchange(f, "List current colleagues after migration?"); assert.equal(view.conversation.state, "completed");
  assert.deepEqual(view.conversation.nativeSession.lastAttempt, { input: 6000, cachedInput: 0, output: 20 });
  assert.equal(view.conversation.runUsage.inputTokens, 6000); assert.equal(nativeState(f).value.schemaVersion, 2);
});

test("invalid native state union, unknown fields and unsupported old schema are refused without rewriting history", async t => {
  const f = await cliMcpFixture(t, "list"); await exchange(f);
  const saved = nativeState(f), original = fs.readFileSync(saved.file, "utf8");
  const home = join(f.workspaceRoot, "home"), catalog = new LocalWorkspaceCatalog(home), row = catalog.read().workspaces.find(item => item.scope.workspaceId === f.scope.workspaceId);
  assert(row); const storage = new WorkspaceResourceStorage(home, row.scope); storage.initialize();
  const state = codexThreadState(storage, f.main.agentId, f.main.agentId.slice(3));
  for (const altered of [{ ...saved.value, phase: "running" }, { ...saved.value, futureCapability: true }, { ...saved.value, schemaVersion: 0 }]) {
    fs.writeFileSync(saved.file, JSON.stringify(altered) + "\n");
    assert.throws(() => state.read(), /binding is invalid/);
    assert.deepEqual(JSON.parse(fs.readFileSync(saved.file, "utf8")), altered, "unsupported state remains untouched for recovery");
  }
  fs.writeFileSync(saved.file, original); assert.equal(state.read().threadId, saved.value.threadId);
});
