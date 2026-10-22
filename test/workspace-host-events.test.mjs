import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { waitForHostApproval } from "./fixtures/host-approval.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const events = new EventEmitter(), completion = deferred(); let card, reads = 0, starts = 0;
  const options = { events, read: () => { reads++; return card; }, start: () => { starts++; return { runId: "synthetic-run" }; }, wait: () => completion.promise };
  return { options, events, completion, publish: value => { card = value; events.emit("change"); }, get reads() { return reads; }, get starts() { return starts; } };
}
test("Host approval listener precedes synchronous start notification and defers state reads", async () => {
  const f = fixture(); let starting = false;
  f.options.start = () => { starting = true; f.publish({ id: "card" }); starting = false; return { runId: "sync-run" }; };
  f.options.read = () => { assert.equal(starting, false); return { id: "card" }; };
  const result = await waitForHostApproval(f.options);
  assert.equal(result.job.runId, "sync-run"); assert.equal(result.card.id, "card"); assert.equal(f.events.listenerCount("change"), 0);
});
test("deferred Host work waits for events without clock polling or resubmission", async () => {
  const f = fixture(), pending = waitForHostApproval(f.options);
  await Promise.resolve(); const initial = f.reads;
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(f.reads, initial); assert.equal(f.starts, 1);
  f.publish({ id: "late-card" }); const result = await pending;
  assert.equal(result.card.id, "late-card"); assert.equal(f.events.listenerCount("change"), 0);
});
test("terminal run without approval and failed state reads reject rather than hang", async () => {
  const f = fixture(), pending = waitForHostApproval(f.options); f.completion.resolve();
  await assert.rejects(pending, /ended before publishing/); assert.equal(f.events.listenerCount("change"), 0);
  const broken = fixture(); broken.options.read = () => { throw new Error("synthetic state error"); };
  await assert.rejects(waitForHostApproval(broken.options), /synthetic state error/);
  assert.equal(broken.events.listenerCount("change"), 0);
});
test("original test cancellation removes listeners and cannot restart or approve work", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(new Error("test ended"));
  await assert.rejects(waitForHostApproval({ ...f.options, signal: controller.signal }), /test ended/); assert.equal(f.starts, 0);
  const active = fixture(), abort = new AbortController(), pending = waitForHostApproval({ ...active.options, signal: abort.signal });
  abort.abort(new Error("original deadline")); await assert.rejects(pending, /original deadline/);
  assert.equal(active.events.listenerCount("change"), 0); const reads = active.reads;
  active.publish({ id: "ignored" }); await Promise.resolve(); assert.equal(active.reads, reads);
});
