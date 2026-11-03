import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const starts = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
async function exchange(f, text) { await f.send(text); return until(f.read, done); }

test("foreign thread and stale turn events cannot finish or overwrite the active Codex reply", async t => {
  const f = await cliMcpFixture(t, "wrong-events"); const view = await exchange(f, "Hello.");
  assert.equal(view.conversation.state, "completed");
  assert.equal(view.conversation.usage.inputTokens, 100);
  assert.equal(view.conversation.nativeSession.status, "ready");
  assert.doesNotMatch(JSON.stringify(view.conversation.history), /FOREIGN_THREAD/);
  assert.equal(view.conversation.history.filter(row => row.role === "assistant").at(-1).text, "Scoped CLI reply");
});

test("busy Codex input is refused without a second writer and cancellation drains before a fresh resume", async t => {
  const f = await cliMcpFixture(t, "hang"), sent = await f.send("Keep working.");
  await until(async () => f.meta(), Boolean);
  await assert.rejects(f.send("A competing task."), /busy|running|draining/);
  await f.request("workspace.session.cancel", { ...f.scope, agentId: f.main.agentId, runId: sent.runId });
  await until(f.read, done); f.mode("reply");
  const view = await exchange(f, "A fresh user message after cancellation.");
  assert.equal(view.conversation.state, "completed"); assert.equal(starts(f).at(-1).method, "thread/resume");
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 2);
});
