// The progress-aware waits used by the C3/C13, RPC clients and native-resume fixtures still fail a stalled run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { awaitProgressSignal, createJsonRpcRequester, untilObserved } from "./helpers/observable-wait.mjs";
import { until } from "./helpers/workspace-cli-mcp.mjs";

test("untilObserved: a stalled signature fails after the idle window, not the total window", async () => {
  const started = Date.now();
  await assert.rejects(untilObserved(() => false, { label: "T", progress: () => "same", idleMs: 150, maxMs: 5000, intervalMs: 10 }),
    /T observable state deadline: no observable progress for 150ms/);
  assert.ok(Date.now() - started < 2000, "a hang is reported promptly");
});

test("untilObserved: a run that keeps changing is bounded by maxMs", async () => {
  let n = 0;
  await assert.rejects(untilObserved(() => false, { label: "T", progress: () => String(n++), idleMs: 150, maxMs: 300, intervalMs: 10 }),
    /still progressing after 300ms/);
});

test("untilObserved: progress extends the window and the ready value is returned", async () => {
  let n = 0;
  const value = await untilObserved(() => (++n >= 30 ? { done: n } : null), { label: "T", progress: () => String(n), idleMs: 100, maxMs: 5000, intervalMs: 10 });
  assert.deepEqual(value, { done: 30 }); // ~300 ms total, longer than idleMs, accepted because it progressed
});

test("untilObserved without progress keeps the original fixed window", async () => {
  await assert.rejects(untilObserved(() => false, { label: "T", idleMs: 100, intervalMs: 10 }), /^Error: T observable state deadline$/);
});

test("workspace-cli-mcp until: progressOf counts from the last change; without it the fixed window holds", async () => {
  const stalled = Date.now();
  await assert.rejects(until(async () => ({ v: 1 }), () => false, 120, value => String(value.v)), /bounded MCP fixture condition was not observed/);
  assert.ok(Date.now() - stalled < 2000, "a stalled signature fails after the idle window, not the 100 s cap");
  let n = 0;
  assert.deepEqual(await until(async () => ({ v: ++n }), value => value.v >= 6, 120, value => String(value.v)), { v: 6 });
  await assert.rejects(until(async () => ({ v: 1 }), () => false, 120), /bounded MCP fixture condition was not observed/);
});

test("createJsonRpcRequester: real stall fails fast at idleMs while server notifications extend up to maxMs", async () => {
  const socket = new EventEmitter();
  socket.send = () => {};
  const request = createJsonRpcRequester(socket, { idleMs: 120, maxMs: 450, tickMs: 25, errorText: method => `stalled:${method}` });

  const stalledAt = Date.now();
  await assert.rejects(request("workspace.stalled"), /^Error: stalled:workspace\.stalled$/);
  assert.ok(Date.now() - stalledAt < 1000, "real RPC stall fails promptly at idleMs");

  const progressP = request("workspace.slow");
  const pulse = setInterval(() => socket.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "workspace.changed", params: {} })), 40);
  await new Promise(resolve => setTimeout(resolve, 220));
  clearInterval(pulse);
  socket.emit("message", JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }));
  assert.deepEqual(await progressP, { ok: true });

  const capped = request("workspace.forever");
  const forever = setInterval(() => socket.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "workspace.assistant.preview", params: {} })), 40);
  try {
    await assert.rejects(capped, /^Error: stalled:workspace\.forever$/);
  } finally {
    clearInterval(forever);
  }
});

test("awaitProgressSignal: synchronous event-loop stall does not count as server inactivity", async () => {
  const result = await awaitProgressSignal(({ resolve }) => {
    setTimeout(() => {
      const end = Date.now() + 180;
      while (Date.now() < end) { /* simulate synchronous host event-loop block > idleMs */ }
      setImmediate(() => resolve("survived-loop-stall"));
    }, 10);
  }, { idleMs: 80, maxMs: 2000, tickMs: 25 });
  assert.equal(result, "survived-loop-stall");
});
