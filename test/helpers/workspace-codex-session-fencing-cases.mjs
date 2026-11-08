// All workspace-codex-session-fencing cases. Thin test files register disjoint partitions so each stays well under the unchanged
// 120s per-file deadline on hosted Intel (target <= 60s per file). A case that is not listed in exactly one
// partition fails registration, so no case can be silently dropped.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./workspace-cli-mcp.mjs";
export const PARTITIONS = Object.freeze({
  "workspace-codex-session-fencing.test.mjs": Object.freeze([
    "a delayed event from the previous turn cannot change the next turn's answer or usage",
    "unknown native thread status is refused before any model turn or tool endpoint can execute",
  ]),
  "workspace-codex-session-fencing-busy.test.mjs": Object.freeze([
    "busy Codex input is refused without a second writer and cancellation drains before a fresh resume",
    "foreign thread and stale turn events cannot finish or overwrite the active Codex reply",
  ]),
});
const ASSIGNED = new Map(Object.entries(PARTITIONS).flatMap(([file, cases]) => cases.map(name => [name, file])));
if (ASSIGNED.size !== Object.values(PARTITIONS).flat().length) throw new Error("a case is listed in more than one partition");
export async function registerCases(file) {
  if (!Object.hasOwn(PARTITIONS, file)) throw new Error(`unknown partition ${file}`);
  const test = (name, ...rest) => {
    if (!ASSIGNED.has(name)) throw new Error(`case is not assigned to a partition: ${name}`);
    return ASSIGNED.get(name) === file ? nodeTest(name, ...rest) : undefined;
  };

const done = view => ["completed", "blocked", "paused", "cancelled"].includes(view.conversation.state);
const starts = f => f.native().filter(row => ["thread/start", "thread/resume"].includes(row.method));
async function exchange(f, text) { await f.send(text); return until(f.read, done); }

test("foreign thread and stale turn events cannot finish or overwrite the active Codex reply", async t => {
  const f = await cliMcpFixture(t, "wrong-events"); const view = await exchange(f, "List current colleagues?");
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
  await until(f.read, done); f.mode("list");
  const view = await exchange(f, "List current colleagues after cancellation?");
  assert.equal(view.conversation.state, "completed"); assert.equal(starts(f).at(-1).method, "thread/resume");
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 2);
});

test("unknown native thread status is refused before any model turn or tool endpoint can execute", async t => {
  const f = await cliMcpFixture(t, "list", { threadStatus: "futureRunning" });
  const view = await exchange(f, "List current colleagues?");
  assert.equal(view.conversation.state, "blocked");
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 0);
  assert.equal(f.native().filter(row => row.method === "thread/start").length, 1);
});

test("a delayed event from the previous turn cannot change the next turn's answer or usage", async t => {
  const f = await cliMcpFixture(t, "list");
  await exchange(f, "List current colleagues? First turn"); f.mode("wrong-events");
  const view = await exchange(f, "List current colleagues? Second turn");
  assert.equal(view.conversation.state, "completed", view.conversation.blockReason);
  assert.equal(view.conversation.usage.inputTokens, 200);
  assert.equal(view.conversation.history.filter(row => row.role === "assistant").at(-1).text, "Scoped CLI reply");
  assert.doesNotMatch(JSON.stringify(view.conversation.history), /FOREIGN_THREAD/);
});
}
