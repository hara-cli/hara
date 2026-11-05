import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
const done = value => ["completed", "blocked", "paused", "cancelled"].includes(value.conversation.state);
test("cancel during an accepted compact never starts or replays the pending user turn", async t => {
  const f = await cliMcpFixture(t, "list", { contextInput: 18000 }); await f.send("List colleagues BEFORE-CANCEL"); const first = await until(f.read, done);
  f.mode({ mode: "list", compactHang: true }); const sent = await f.send("List colleagues CANCEL-PENDING");
  await until(async () => f.native(), rows => rows.some(row => row.method === "thread/compact/start"));
  await f.request("workspace.session.cancel", { ...f.scope, agentId: f.main.agentId, runId: sent.runId }); const cancelled = await until(f.read, done);
  assert.equal(f.native().filter(row => row.method === "turn/start").length, 1);
  assert.deepEqual(cancelled.conversation.history.slice(0, first.conversation.history.length), first.conversation.history);
  assert.equal(cancelled.conversation.contextCompactions[0].status, "running");
});
