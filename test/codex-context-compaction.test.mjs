import test from "node:test";
import assert from "node:assert/strict";
import { CodexContextCompaction } from "../dist/agent-runtime/context-compaction.js";
import { ExternalJsonlRpcRequestError } from "../dist/external-sessions/process.js";
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(extra = {}) {
  const controller = new AbortController(), calls = [], usage = [];
  const op = new CodexContextCompaction({ threadId: "original-thread", signal: controller.signal, assertCurrent() {}, activity() {}, usage: row => usage.push(row), ...extra });
  const client = { async call(method, params) { calls.push({ method, params }); return {}; } };
  const event = (method, values = {}) => op.observe(method, { threadId: "original-thread", turnId: "compact-turn", ...values });
  const begin = () => event("turn/started", { turn: { id: "compact-turn", status: "inProgress" } });
  const item = method => event(method, { item: { id: "compact-item", type: "contextCompaction" } });
  const end = status => event("turn/completed", { turn: { id: "compact-turn", status } });
  return { controller, op, calls, client, event, begin, item, end, usage };
}
test("ACK and foreign events are not completion; one scoped compact item plus a completed turn is required", async () => {
  const f = fixture(), run = f.op.run(f.client); let ended = false; void run.then(() => { ended = true; });
  await tick(); assert.equal(ended, false); f.begin();
  f.event("thread/compacted", { threadId: "foreign" }); f.event("turn/completed", { turn: { id: "foreign-turn", status: "completed" } });
  await tick(); assert.equal(ended, false);
  f.item("item/started"); f.event("thread/tokenUsage/updated", { tokenUsage: { total: {} } }); f.item("item/completed");
  await tick(); assert.equal(ended, false); f.end("completed"); await run;
  assert.deepEqual(f.calls, [{ method: "thread/compact/start", params: { threadId: "original-thread" } }]); assert.equal(f.usage.length, 1);
});
test("the deprecated notification is accepted only inside its matching native turn", async () => {
  const f = fixture(), run = f.op.run(f.client); await tick(); f.begin(); f.event("thread/compacted"); f.end("completed"); await run;
});
test("unsupported and definitely refused requests are distinguished from unknown transport outcomes", async () => {
  for (const [code, outcome] of [[-32601, "unsupported"], [-32000, "refused"]]) {
    const f = fixture(); await assert.rejects(f.op.run({ async call() { throw new ExternalJsonlRpcRequestError(code); } }), error => error.outcome === outcome);
  }
  const f = fixture(); await assert.rejects(f.op.run({ async call() { throw new Error("private transport details"); } }), error => error.outcome === "unknown" && !error.message.includes("private"));
});
test("a partial compaction, invalid completion or unexpected tool cannot permit fallback/replay", async () => {
  for (const failure of ["partial", "no-item", "tool"]) {
    const f = fixture(), run = f.op.run(f.client); const refused = assert.rejects(run, error => error.outcome === "unknown");
    await tick(); f.begin();
    if (failure === "partial") { f.item("item/started"); f.item("item/completed"); f.end("failed"); }
    else if (failure === "tool") f.event("item/started", { item: { id: "bad", type: "commandExecution" } });
    else f.end("completed");
    await refused;
  }
});
test("a failed turn without any compacted context permits the original thread to remain usable", async () => {
  const f = fixture(), run = f.op.run(f.client), refused = assert.rejects(run, error => error.outcome === "refused");
  await tick(); f.begin(); f.end("failed"); await refused;
});
test("timeout and abort are bounded unknown outcomes and retain controlled RPC diagnostics", async () => {
  const f = fixture({ timeoutMs: 20 });
  await assert.rejects(f.op.run(f.client), error => error.outcome === "unknown" && error.cause.rpc.rpcMethod === "thread/compact/start" && error.cause.runtimeFailureKind === "timeout");
  const g = fixture(), run = g.op.run(g.client), aborted = assert.rejects(run, error => error.outcome === "unknown");
  await tick(); g.controller.abort(); await aborted;
  const h = fixture(); h.controller.abort(); await assert.rejects(h.op.run(h.client)); assert.equal(h.calls.length, 0);
});
test("conflicting ACK errors after native acceptance remain unknown and cannot fall back", async () => {
  const f = fixture(); await assert.rejects(f.op.run({ async call() {
    f.begin(); f.item("item/started"); f.item("item/completed"); throw new ExternalJsonlRpcRequestError(-32000);
  } }), error => error.outcome === "unknown");
});
