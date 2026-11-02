import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const starts = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
async function exchange(f, text) { await f.send(text); return until(f.read, done); }

test("a second governed Codex message reuses one process/thread, rotates the endpoint, and sends only new input", async t => {
  const f = await cliMcpFixture(t, "reply");
  const first = await exchange(f, "Remember S3-FIRST-UNIQUE; reply briefly.");
  assert.equal(first.conversation.state, "completed"); const a = f.meta();
  const second = await exchange(f, "S3-SECOND-UNIQUE; continue.");
  assert.equal(second.conversation.state, "completed"); const b = f.meta();
  const requests = starts(f), turns = f.native().filter(row => row.method === "turn/start");
  assert.deepEqual(requests.map(row => row.method), ["thread/start", "thread/resume"]);
  assert.equal(a.pid, b.pid); assert.equal(requests[0].pid, requests[1].pid);
  assert.notEqual(a.url, b.url); assert.equal(a.tokenFingerprint, b.tokenFingerprint);
  assert.equal(turns.length, 2); assert.match(turns[1].params.input[0].text, /S3-SECOND-UNIQUE/);
  assert.doesNotMatch(turns[1].params.input[0].text, /S3-FIRST-UNIQUE|registered codex reply|You are/);
  assert.equal(requests[1].params.excludeTurns, true); assert.equal("history" in requests[1].params, false);
  assert.equal(second.conversation.usage.inputTokens, 200); assert.equal(second.conversation.usage.outputTokens, 40);
  await assert.rejects(fetch(a.url));
  await f.request("workspace.runtime.selectModel", { ...f.scope, runtimeId: "codex", modelId: "fixture-model-2", effort: "high", expectedRevision: 1 });
  assert.equal((await exchange(f, "Use the newly selected model." )).conversation.state, "completed");
  const switched = starts(f).at(-1), turn = f.native().filter(row => row.method === "turn/start").at(-1);
  assert.equal(switched.method, "thread/resume"); assert.equal(switched.pid, a.pid);
  assert.equal(switched.params.model, "fixture-model-2"); assert.equal(switched.params.config.model_reasoning_effort, "high");
  assert.equal(turn.params.model, "fixture-model-2"); assert.equal(turn.params.effort, "high");
});
