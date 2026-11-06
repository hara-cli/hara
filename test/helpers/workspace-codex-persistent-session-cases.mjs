import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { cliMcpFixture, until } from "./workspace-cli-mcp.mjs";
import { codexStandingContext } from "../../dist/agent-runtime/codex-session.js";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const starts = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
async function exchange(f, text) { await f.send(text); return until(f.read, done); }
const nativeState = f => { const relative = fs.readdirSync(f.root, { recursive: true }).find(name => /(?:^|\/)codex-thread-[a-f0-9]+\.json$/.test(name));
  assert(relative); return JSON.parse(fs.readFileSync(join(f.root, relative), "utf8")); };


export function registerCases(selected) {
if (selected.includes(0)) test("standing hash covers rules, operation cards and profile while turn-only text remains fresh separately", () => {
  const base = { system: "", systemParts: [
    { id: "rules", stability: "session", content: "permit-A", digest: "a" },
    { id: "cards", stability: "session", content: "card-A", digest: "b" },
    { id: "clock", stability: "turn", content: "10:00", digest: "c" },
  ] };
  const read = (args = base, model = "model-A", effort = "low", tier = "controlled", revision = 1) =>
    codexStandingContext(args, model, effort, tier, revision);
  const original = read();
  assert.equal(original.standing.includes("10:00"), false); assert.equal(original.turnParts[0].content, "10:00");
  assert.equal(read({ ...base, systemParts: [...base.systemParts.slice(0, 2), { ...base.systemParts[2], content: "10:01" }] }).digest, original.digest);
  for (const parts of [[{ ...base.systemParts[0], content: "permit-B" }, ...base.systemParts.slice(1)],
    [base.systemParts[0], { ...base.systemParts[1], content: "card-B" }, base.systemParts[2]]])
    assert.notEqual(read({ ...base, systemParts: parts }).digest, original.digest);
  assert.equal(read(base, "model-B").digest, original.digest);
  assert.equal(read(base, "model-A", "high").digest, original.digest);
  assert.notEqual(read(base, null, "low").digest, original.digest);
  assert.notEqual(read(base, "model-A", null).digest, original.digest);
  assert.notEqual(read(base, "model-A", "low", "full-protected").digest, original.digest);
  assert.notEqual(read(base, "model-A", "low", "controlled", 2).digest, original.digest);
});

if (selected.includes(1)) test("a second governed Codex message reuses one loaded process/thread and transport with fresh immutable attempt markers", async t => {
  const f = await cliMcpFixture(t, "list", { probePreviousMarker: true });
  const first = await exchange(f, "List colleagues S3-FIRST-UNIQUE?");
  assert.equal(first.conversation.state, "completed"); const a = f.meta();
  const second = await exchange(f, "List colleagues S3-SECOND-UNIQUE?");
  assert.equal(second.conversation.state, "completed"); const b = f.meta();
  const requests = starts(f), turns = f.native().filter(row => row.method === "turn/start");
  assert.deepEqual(requests.map(row => row.method), ["thread/start"]);
  assert.equal(a.pid, b.pid); assert.equal(requests[0].pid, turns[1].pid);
  assert.equal(a.url, b.url); assert.equal(a.tokenFingerprint, b.tokenFingerprint);
  assert.notEqual(a.attemptMarkerFingerprint, b.attemptMarkerFingerprint); assert.equal(b.oldMarkerRejected, true);
  assert.equal(f.native().some(row => row.method === "thread/unsubscribe"), false);
  assert.equal(turns.length, 2); assert.match(turns[1].params.input[0].text, /S3-SECOND-UNIQUE/);
  assert.doesNotMatch(turns[1].params.input[0].text, /S3-FIRST-UNIQUE|registered codex reply|You are/);
  assert.equal("history" in turns[1].params, false);
  assert.equal(second.conversation.usage.inputTokens, 200); assert.equal(second.conversation.usage.outputTokens, 40);
  assert.equal((await fetch(a.url)).status, 401);
  await f.request("workspace.runtime.selectModel", { ...f.scope, runtimeId: "codex", modelId: "fixture-model-2", effort: "high", expectedRevision: 1 });
  assert.equal((await exchange(f, "List colleagues using the selected model?" )).conversation.state, "completed");
  const switched = starts(f).at(-1), turn = f.native().filter(row => row.method === "turn/start").at(-1);
  assert.equal(switched.method, "thread/start"); assert.equal(starts(f).length, 1); assert.equal(switched.pid, a.pid);
  assert.equal(f.meta().url, b.url, "model/effort are per-turn overrides on the same loaded contract");
  assert.equal(f.meta().model, "fixture-model-2"); assert.equal(f.meta().effort, "high");
  assert.equal(turn.params.model, "fixture-model-2"); assert.equal(turn.params.effort, "high");
});

if (selected.includes(2)) test("standing prompt changes reach the next resident turn and a compaction starts a new model-memory epoch", async t => {
  const f = await cliMcpFixture(t, "list");
  await exchange(f, "List current colleagues? First"); const first = nativeState(f);
  assert.equal(first.schemaVersion, 3); assert.match(first.standingPromptHash, /^[a-f0-9]{64}$/); assert.match(first.contextGeneration, /^[a-f0-9-]{36}$/);
  await exchange(f, "List current colleagues? Second"); const second = nativeState(f);
  assert.equal(second.standingPromptHash, first.standingPromptHash); assert.equal(second.contextGeneration, first.contextGeneration);
  assert.doesNotMatch(f.native().filter(row => row.method === "turn/start").at(-1).params.input[0].text, /Current Hara standing governance context/);
  f.mode({ mode: "list", foreignCompaction: true }); await exchange(f, "List current colleagues? Foreign event");
  assert.equal(nativeState(f).contextGeneration, first.contextGeneration, "another session cannot reset this model-memory epoch");
  f.mode("list");
  const agent = (await f.read()).agents.find(row => row.agentId === f.main.agentId);
  await f.request("workspace.agents.updatePersona", { ...f.scope, agentId: agent.agentId, configRevision: agent.configRevision,
    agentEpoch: agent.agentEpoch, input: { profile: { displayName: "New standing persona" } } });
  await exchange(f, "List current colleagues? New standing"); const switched = nativeState(f);
  assert.notEqual(switched.standingPromptHash, second.standingPromptHash); assert.equal(switched.contextGeneration, first.contextGeneration);
  assert.match(f.native().filter(row => row.method === "turn/start").at(-1).params.input[0].text, /Current Hara standing governance context/);
  f.mode({ mode: "list", emitCompaction: true }); await exchange(f, "List current colleagues? Compact"); const compacted = nativeState(f);
  assert.equal(compacted.standingPromptHash, null); assert.notEqual(compacted.contextGeneration, first.contextGeneration);
  f.mode("list"); await exchange(f, "List current colleagues? After compact");
  assert.match(f.native().filter(row => row.method === "turn/start").at(-1).params.input[0].text, /Current Hara standing governance context/);
  assert.match(nativeState(f).standingPromptHash, /^[a-f0-9]{64}$/);
});

}
