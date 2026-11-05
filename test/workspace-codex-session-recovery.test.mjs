import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const starts = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
async function exchange(f, text) { await f.send(text); return until(f.read, done); }

test("Host restart resumes the saved Codex thread in a new process without replaying the prior message", async t => {
  const f = await cliMcpFixture(t, "list");
  await exchange(f, "List current colleagues? S3-BEFORE-RESTART"); const first = f.meta();
  f.mode("usage-reset"); await f.restart();
  const view = await exchange(f, "List current colleagues again? S3-AFTER-RESTART");
  assert.equal(view.conversation.state, "completed"); const resumed = starts(f).at(-1);
  assert.equal(resumed.method, "thread/resume"); assert.notEqual(first.pid, resumed.pid);
  assert.notEqual(first.tokenFingerprint, f.meta().tokenFingerprint);
  assert.equal(view.conversation.usage.inputTokens, 200); assert.equal(view.conversation.usage.outputTokens, 40);
  assert.doesNotMatch(f.native().filter(row => row.method === "turn/start").at(-1).params.input[0].text, /S3-BEFORE-RESTART/);
});

test("resume failure preserves history, reports explicit failure, and never starts a replacement thread or exec", async t => {
  const f = await cliMcpFixture(t, "list"); await exchange(f, "List current colleagues?");
  f.mode("resume-fail"); await f.restart();
  const view = await exchange(f, "List current colleagues again?");
  assert.equal(view.conversation.state, "blocked");
  assert.equal(starts(f).filter(row => row.method === "thread/start").length, 1);
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 1);
  assert.equal(view.conversation.nativeSession.status, "recovery_needed");
  assert.match(view.conversation.blockReason, /hara_runtime_failure_v1=/);
  assert.doesNotMatch(view.conversation.blockReason, /PRIVATE_ACCOUNT_DETAIL/);
});
