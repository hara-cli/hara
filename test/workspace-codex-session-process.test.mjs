import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);

test("an observed native token overage blocks the run and records the actual usage without another inference", async t => {
  const f = await cliMcpFixture(t, "over-budget"); await f.send("List current colleagues?");
  const view = await until(f.read, done);
  assert.equal(view.conversation.state, "blocked");
  assert.equal(view.conversation.usage.inputTokens, 300000);
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 1);
});

test("a failed native process rotates its bearer before the next explicitly admitted message resumes the thread", async t => {
  const f = await cliMcpFixture(t, "crash"); await f.send("First task.");
  assert.equal((await until(f.read, done)).conversation.state, "blocked"); const first = f.meta();
  f.mode("list"); await f.send("List current colleagues after the process failure?");
  assert.equal((await until(f.read, done)).conversation.state, "completed"); const second = f.meta();
  assert.notEqual(first.pid, second.pid); assert.notEqual(first.tokenFingerprint, second.tokenFingerprint);
  assert.equal(f.native().filter(row => row.method === "thread/start").length, 1);
  assert.equal(f.native().filter(row => row.method === "thread/resume").length, 1);
});
