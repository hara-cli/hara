import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  RuntimeStageRecorder, WorkspaceRuntimeStageStore, parseRuntimeStageReport, projectRuntimeStageReports,
  MAX_RUNTIME_STAGE_EVENTS, MAX_RUNTIME_STAGE_REPORTS,
} from "../dist/workspace/runtime-stage-events.js";
import { currentWorkspaceResourceBinding, WorkspaceResourceStorage, workspaceStateHome } from "../dist/workspace/resource-context.js";

const temporary = [];
after(() => { for (const file of temporary) fs.rmSync(file, { recursive: true, force: true }); });
const runtime = () => ({ id: "codex", version: "0.163.0", loginSource: "host", model: "gpt-6.1-sol", effort: "medium" });
function identity(overrides = {}) {
  return { workspaceId: "ws_" + randomUUID(), resourceGeneration: randomUUID(), agentId: "ag_" + randomUUID(),
    sessionId: randomUUID(), runId: randomUUID(), attemptId: randomUUID(), historyStart: 0, ...overrides };
}
function recorder(id = identity(), metadata = runtime()) {
  let clock = 1000;
  return { value: new RuntimeStageRecorder(id, metadata, { now: () => clock }), advance: ms => { clock += ms; }, setClock: value => { clock = value; } };
}
function fixture() {
  const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-runtime-stage-"))); temporary.push(home);
  fs.chmodSync(home, 0o700);
  let revoked = false;
  const scope = { schemaVersion: 1, workspaceId: "ws_" + randomUUID(), authority: { kind: "local", localAuthorityId: randomUUID() } };
  const storage = new WorkspaceResourceStorage(home, scope, () => { if (revoked) throw new Error("synthetic authority revoked"); }); storage.initialize();
  const id = identity({ workspaceId: scope.workspaceId, resourceGeneration: storage.run(() => currentWorkspaceResourceBinding().generation) });
  const store = new WorkspaceRuntimeStageStore(storage, id.sessionId, id.agentId);
  const stateHome = storage.run(() => workspaceStateHome());
  return { home, storage, id, store, stateHome, statePath: join(stateHome, ".hara", `runtime-stages-${id.sessionId}.json`), revoke: () => { revoked = true; } };
}

test("stage sequence measures spans and distinguishes a completed-message observation from a token", () => {
  const { value, advance } = recorder();
  const spawn = value.beginEvent("spawn"); advance(10); spawn();
  const cold = value.beginEvent("cold_start"); advance(25); cold();
  const model = value.beginEvent("model_roundtrip", { call: 1 }); advance(30);
  value.mark("first_output", "native_event"); advance(5); model();
  const tool = value.beginEvent("tool_call", { call: 1, toolName: "agent_list" }); advance(7); tool();
  advance(3); value.finish("completed");
  const report = value.snapshot();
  assert.deepEqual(report.events.map(row => [row.kind, row.phase]), [
    ["spawn", "start"], ["spawn", "end"], ["cold_start", "start"], ["cold_start", "end"],
    ["model_roundtrip", "start"], ["first_output", "mark"], ["model_roundtrip", "end"],
    ["tool_call", "start"], ["tool_call", "end"], ["complete", "mark"],
  ]);
  assert.equal(report.events.find(row => row.kind === "first_token"), undefined);
  assert.equal(report.events.find(row => row.kind === "model_roundtrip" && row.phase === "end").durationMs, 35);
  assert.equal(report.events.find(row => row.kind === "tool_call" && row.phase === "end").durationMs, 7);
  assert.equal(report.durationMs, 80);
  assert.equal(report.events.at(-1).offsetMs, 80);
  assert.deepEqual(report.events.map(row => row.seq), Array.from({ length: 10 }, (_, i) => i + 1));
});

test("first-token requires a measured source, is emitted once, and missing spans remain unknown", () => {
  const { value, advance } = recorder();
  assert.throws(() => value.mark("first_token", "host"), /Invalid Runtime stage/);
  advance(5); value.mark("first_token", "provider_stream"); advance(7); value.mark("first_token", "provider_stream");
  assert.equal(value.snapshot().events.filter(row => row.kind === "first_token").length, 1);
  assert.equal(value.snapshot().durationMs, null);
  assert.equal(value.snapshot().events.find(row => row.kind === "spawn"), undefined);
  value.mark("first_output", "host");
  assert.equal(value.snapshot().events.find(row => row.kind === "first_output").source, "host");
  value.finish("blocked");
  assert.equal(value.snapshot().state, "blocked");
  assert.equal(value.snapshot().events.at(-1).outcome, "error");
});

test("cancellation retains an unclosed tool as missing and ignores every late callback", () => {
  const { value, advance } = recorder();
  const tool = value.beginEvent("tool_call", { call: 1, toolName: "workspace_read" }); advance(50);
  value.finish("cancelled");
  const ended = value.snapshot(); advance(900); tool("completed"); value.mark("first_token"); value.setRuntime({ model: "changed-model" }); value.finish("completed");
  assert.deepEqual(value.snapshot(), ended);
  assert.equal(ended.events.some(row => row.kind === "tool_call" && row.phase === "end"), false);
  assert.equal(ended.events.at(-1).outcome, "cancelled");
  assert.equal(ended.durationMs, 50);
  const detached = value.snapshot(); detached.runtime.model = "mutated"; detached.events.length = 0;
  assert.deepEqual(value.snapshot(), ended, "snapshots cannot mutate the recorder");
});

test("event capacity reserves complete and counts omitted observations without retrying first-token marks", () => {
  const { value, advance } = recorder();
  for (let call = 1; call <= 200; call++) { const done = value.beginEvent("model_roundtrip", { call }); advance(1); done(); }
  for (let i = 0; i < 20; i++) value.mark("first_token", "native_event");
  value.finish("completed");
  const report = value.snapshot();
  assert.equal(report.events.length, MAX_RUNTIME_STAGE_EVENTS);
  assert.equal(report.events.at(-1).kind, "complete");
  assert.equal(report.droppedEvents, 146);
  assert.equal(report.events.at(-1).seq, 402);
  assert.equal(report.events.some(row => row.kind === "first_token"), false, "a dropped token observation is not silently fabricated");
  assert.ok(report.events.every((row, index, rows) => !index || row.seq > rows[index - 1].seq));
});

test("a backwards observation clock cannot produce negative or decreasing durations", () => {
  const { value, advance, setClock } = recorder();
  advance(20); const end = value.beginEvent("spawn"); setClock(900); end(); value.finish("completed");
  assert.deepEqual(value.snapshot().events.map(row => row.offsetMs), [20, 20, 20]);
  assert.equal(value.snapshot().events[1].durationMs, 0);
});

test("metadata projection never keeps free text, token-shaped models, URLs, credentials, paths or extra fields", () => {
  const secret = "sk-synthetic-api-secret-do-not-store";
  const { value } = recorder(identity(), { ...runtime(), version: "0.163.0 Bearer synthetic-secret", model: secret,
    effort: "Bearer private", prompt: "PRIVATE PROMPT", env: { TOKEN: secret }, reply: "PRIVATE REPLY" });
  value.setRuntime({ model: "https://private.example/user?token=secret", loginSource: "nonsense", effort: "sk-synthetic-secret" });
  value.finish("error", "Bearer synthetic-credential");
  const report = value.snapshot(), serialized = JSON.stringify(report);
  assert.equal(report.runtime.version, null); assert.equal(report.runtime.model, null); assert.equal(report.runtime.effort, null);
  assert.equal(report.runtime.loginSource, "unknown"); assert.equal(report.errorKind, "runtime_failed");
  for (const marker of [secret, "PRIVATE PROMPT", "PRIVATE REPLY", "Bearer", "TOKEN", "private.example", "prompt", "reply", "env"])
    assert.equal(serialized.includes(marker), false, marker);
  assert.throws(() => new RuntimeStageRecorder(identity({ workspaceId: "Bearer secret" }), runtime()), /Invalid Runtime stage/);
  assert.throws(() => new RuntimeStageRecorder({ ...identity(), prompt: secret }, runtime()), /Invalid Runtime stage/);
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const { value: known } = recorder(identity(), { ...runtime(), effort }); assert.equal(known.snapshot().runtime.effort, effort);
  }
  const { value: unknown } = recorder(identity(), { ...runtime(), effort: "future-effort" });
  assert.equal(unknown.snapshot().runtime.effort, null);
});

test("wire validation rejects unknown keys, forged terminal claims and non-monotonic event identity", () => {
  const { value, advance } = recorder(); const end = value.beginEvent("spawn"); advance(2); end(); value.finish("completed");
  const good = value.snapshot(); assert.deepEqual(parseRuntimeStageReport(good), good);
  for (const mutate of [
    row => { row.prompt = "secret"; }, row => { row.runtime.url = "https://private.example"; },
    row => { row.events[1].seq = row.events[0].seq; }, row => { row.events[1].offsetMs = -1; },
    row => { row.events.at(-1).outcome = "cancelled"; }, row => { row.durationMs++; },
    row => { row.state = "running"; }, row => { row.events[0].message = "secret"; },
  ]) { const poisoned = structuredClone(good); mutate(poisoned); assert.throws(() => parseRuntimeStageReport(poisoned), /Invalid Runtime stage/); }
});

test("store binds every report to the exact resource generation, agent and conversation", () => {
  const f = fixture(), { value } = recorder(f.id); value.finish("completed");
  const report = value.snapshot(); f.store.save(report);
  for (const patch of [{ workspaceId: "ws_" + randomUUID() }, { resourceGeneration: randomUUID() },
    { agentId: "ag_" + randomUUID() }, { sessionId: randomUUID() }]) {
    assert.throws(() => f.store.save({ ...report, ...patch }), /Invalid Runtime stage/);
  }
  const foreign = new WorkspaceRuntimeStageStore(f.storage, f.id.sessionId, "ag_" + randomUUID());
  assert.throws(() => foreign.list(), /Invalid Runtime stage/);
  assert.equal(f.store.list().length, 1);
});

test("recording has no implicit disk writes; explicit saves retain immutable event prefixes and closed states", () => {
  const f = fixture(), { value, advance } = recorder(f.id);
  const end = value.beginEvent("model_roundtrip", { call: 1 }); advance(3);
  assert.equal(fs.existsSync(f.statePath), false);
  f.store.save(value.snapshot()); const before = fs.readFileSync(f.statePath, "utf8");
  f.store.save(value.snapshot()); assert.equal(fs.readFileSync(f.statePath, "utf8"), before, "unchanged saves do not advance revision");
  const changed = value.snapshot(); changed.events[0].call = 2;
  assert.throws(() => f.store.save(changed), /Invalid Runtime stage/);
  end(); value.finish("completed"); f.store.save(value.snapshot());
  const closed = fs.readFileSync(f.statePath, "utf8");
  const reopened = value.snapshot(); reopened.state = "running"; reopened.durationMs = null; reopened.events.pop();
  assert.throws(() => f.store.save(reopened), /Invalid Runtime stage/);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), closed);
});

test("history remains bounded by attempt rather than unbounded model or token event counts", () => {
  const f = fixture();
  for (let i = 0; i < MAX_RUNTIME_STAGE_REPORTS + 4; i++) {
    const { value } = recorder({ ...f.id, attemptId: randomUUID(), historyStart: i }); value.finish("completed"); f.store.save(value.snapshot());
  }
  const reports = f.store.list(); assert.equal(reports.length, MAX_RUNTIME_STAGE_REPORTS);
  assert.equal(reports[0].historyStart, 4); assert.equal(reports.at(-1).historyStart, MAX_RUNTIME_STAGE_REPORTS + 3);
});

test("reopened running attempts project incomplete without inventing completion or rewriting stored provenance", () => {
  const f = fixture(), { value } = recorder(f.id); value.beginEvent("model_roundtrip", { call: 1 }); f.store.save(value.snapshot());
  assert.equal(projectRuntimeStageReports(f.store.list(), new Set())[0].state, "incomplete");
  assert.equal(projectRuntimeStageReports(f.store.list(), new Set([f.id.attemptId]))[0].state, "running");
  assert.equal(f.store.list()[0].state, "running");
  const exported = f.store.export(f.id.attemptId), report = JSON.parse(fs.readFileSync(exported.path, "utf8"));
  assert.equal(report.state, "incomplete"); assert.equal(report.durationMs, null);
  assert.equal(report.events.some(row => row.kind === "complete"), false);
  const active = f.store.export(f.id.attemptId, { active: true });
  assert.equal(JSON.parse(fs.readFileSync(active.path, "utf8")).state, "running");
});

test("local export is a verified private new JSON file with only the metadata whitelist", () => {
  const f = fixture(), { value } = recorder(f.id); const end = value.beginEvent("tool_call", { call: 1, toolName: "agent_list" }); end();
  value.finish("error", "runtime_network"); f.store.save(value.snapshot());
  const first = f.store.export(f.id.attemptId), second = f.store.export(f.id.attemptId);
  assert.notEqual(first.path, second.path); assert.equal(first.fileName, basename(first.path));
  assert.match(first.fileName, /^runtime-feedback-[a-f0-9-]{36}\.json$/);
  const bytes = fs.readFileSync(first.path), data = JSON.parse(bytes);
  assert.equal(first.bytes, bytes.length); assert.equal(first.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(data, value.snapshot()); assert.equal(first.sha256, second.sha256);
  for (const field of ["path", "prompt", "reply", "content", "inputTokens", "outputTokens", "token", "credentials", "env"])
    assert.equal(Object.hasOwn(data, field), false, field);
  assert.equal(bytes.toString().includes(f.home), false);
  if (process.platform !== "win32") { assert.equal(fs.statSync(first.path).mode & 0o777, 0o600); assert.equal(fs.statSync(join(f.stateHome, ".hara", "runtime-diagnostics")).mode & 0o777, 0o700); }
  assert.throws(() => f.store.export(randomUUID()), /unavailable in this conversation/);
  assert.throws(() => f.store.export(f.id.attemptId, { path: "/tmp/arbitrary.json" }), /Invalid Runtime stage/);
});

test("corrupt or extended persisted metadata is preserved and cannot become a newly sanitized export", () => {
  const f = fixture(), { value } = recorder(f.id); f.store.save(value.snapshot());
  const bad = fs.readFileSync(f.statePath, "utf8").replace('"reports":[', '"reports":["PRIVATE CONTENT",');
  fs.writeFileSync(f.statePath, bad, { mode: 0o600 });
  assert.throws(() => f.store.list(), /Invalid Runtime stage/);
  assert.throws(() => f.store.save(value.snapshot()), /Invalid Runtime stage/);
  assert.throws(() => f.store.export(f.id.attemptId), /Invalid Runtime stage/);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), bad);
});

test("revoked resource authority and changed generation refuse both saved reports and exports", () => {
  const f = fixture(), { value } = recorder(f.id); f.store.save(value.snapshot()); f.revoke();
  for (const operation of [() => f.store.list(), () => f.store.save(value.snapshot()), () => f.store.export(f.id.attemptId)])
    assert.throws(operation, /synthetic authority revoked/);
  const other = fixture(), { value: otherValue } = recorder(other.id); other.store.save(otherValue.snapshot());
  const scopePath = join(other.home, ".hara", "workspace-data", "v1", other.storage.scopeKey, "scope.json");
  const marker = JSON.parse(fs.readFileSync(scopePath, "utf8")); fs.writeFileSync(scopePath, JSON.stringify({ ...marker, generation: randomUUID() }) + "\n", { mode: 0o600 });
  assert.throws(() => other.store.export(other.id.attemptId), /scope marker changed/);
});

test("a linked diagnostic output directory cannot redirect the export into a foreign tree", () => {
  const f = fixture(), { value } = recorder(f.id); value.finish("completed"); f.store.save(value.snapshot());
  const elsewhere = fs.mkdtempSync(join(tmpdir(), "hara-runtime-stage-foreign-")); temporary.push(elsewhere); fs.chmodSync(elsewhere, 0o700);
  fs.symlinkSync(elsewhere, join(f.stateHome, ".hara", "runtime-diagnostics"));
  assert.throws(() => f.store.export(f.id.attemptId));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
