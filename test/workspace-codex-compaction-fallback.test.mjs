import test from "node:test";
import assert from "node:assert/strict";
import { cliMcpFixture, until } from "./helpers/workspace-cli-mcp.mjs";
const done = value => ["completed", "blocked", "paused", "cancelled"].includes(value.conversation.state);
async function exchange(f, text) { await f.send(text); return until(f.read, done); }
const turns = f => f.native().filter(row => row.method === "turn/start");
test("a definite compact failure continues the same original thread without erasing original messages", async t => {
  const f = await cliMcpFixture(t, "list", { contextInput: 70000 }); const first = await exchange(f, "List colleagues BEFORE-REFUSAL");
  f.mode({ mode: "list", compactFail: true }); const second = await exchange(f, "List colleagues AFTER-REFUSAL");
  assert.equal(second.conversation.state, "completed"); assert.equal(turns(f)[0].params.threadId, turns(f)[1].params.threadId);
  assert.equal(second.conversation.contextCompactions[0].status, "failed");
  assert.deepEqual(second.conversation.history.slice(0, first.conversation.history.length), first.conversation.history);
});
test("unsupported native compact seeds a new resident thread and retains the original native identity privately", async t => {
  const f = await cliMcpFixture(t, "list", { contextInput: 70000 }); const first = await exchange(f, "List colleagues BEFORE-NEW-SEED");
  f.mode({ mode: "list", compactUnsupported: true }); const second = await exchange(f, "List colleagues AFTER-NEW-SEED");
  assert.equal(second.conversation.state, "completed"); assert.notEqual(turns(f)[0].params.threadId, turns(f)[1].params.threadId);
  assert.equal(second.conversation.contextCompactions.at(-1).method, "host-seed"); assert.equal(second.conversation.contextCompactions.at(-1).status, "completed");
  assert.deepEqual(second.conversation.history.slice(0, first.conversation.history.length), first.conversation.history);
  const fs = await import("node:fs"); const { join } = await import("node:path");
  const name = fs.readdirSync(f.root, { recursive: true }).find(name => /context-compactions-[a-f0-9-]+\.json$/.test(name));
  const ledger = JSON.parse(fs.readFileSync(join(f.root, name), "utf8")); assert.equal(ledger.entries.at(-1).priorThreadId, turns(f)[0].params.threadId);
  assert.equal(f.native().some(row => /delete|archive/.test(row.method)), false);
  await exchange(f, "List colleagues WARM-SEEDED"); assert.equal(f.native().filter(row => row.method === "thread/start").length, 2);
  assert.equal(f.native().some(row => row.method === "thread/unsubscribe"), false);
});
