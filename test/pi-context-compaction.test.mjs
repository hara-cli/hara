import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { PiRpcProcess } from "../dist/agent-runtime/pi-rpc-process.js";
function fixture(t, extra = {}) {
  const requests = [], child = new EventEmitter(), controller = new AbortController();
  let state = { model: { provider: "hara", id: "coding" }, autoCompactionEnabled: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...extra.state };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, new Writable({ write(_data, _encoding, callback) { callback(); } })];
  child.stdin = new Writable({ write(data, _encoding, callback) {
    const message = JSON.parse(data); requests.push(message);
    queueMicrotask(() => {
      const value = message.type === "get_state" ? state : message.type === "get_session_stats" ? { contextUsage: { tokens: 35000 } }
        : { summary: "OPAQUE_NATIVE_SUMMARY", firstKeptEntryId: "kept", tokensBefore: 35000, estimatedTokensAfter: 4500 };
      child.stdout.write(JSON.stringify({ id: message.id, type: "response", command: message.type, success: !(extra.refused && message.type === "compact"), data: value }) + "\n");
    }); callback();
  } });
  const rpc = new PiRpcProcess({ command: "synthetic-only", args: [], env: {}, cwd: process.cwd(), timeoutMs: 1000,
    signal: controller.signal, onFrame() {}, onAccepted() {}, boundary: { spawn() { return { child, ready: Promise.resolve() }; }, async drain() { child.emit("close"); } } });
  t.after(() => rpc.close());
  return { rpc, requests, setState(next) { state = { ...state, ...next }; }, controller };
}
test("Pi manual compact checks idle before the SDK can abort a run and exports only bounded receipt metadata", async t => {
  const f = fixture(t); assert.equal(await f.rpc.contextTokens(), 35000);
  const receipt = await f.rpc.compact("Reference facts only");
  assert.deepEqual(receipt, { tokensBefore: 35000, estimatedTokensAfter: 4500 }); assert.equal(JSON.stringify(receipt).includes("OPAQUE"), false);
  assert.deepEqual(f.requests.map(row => row.type), ["get_session_stats", "get_state", "compact", "get_state"]);
});
test("Pi refuses native compact during streaming, another compact, a pending queue or changed model authority", async t => {
  for (const state of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }, { autoCompactionEnabled: true }, { model: { provider: "foreign", id: "coding" } }]) {
    const f = fixture(t, { state }); await assert.rejects(f.rpc.compact("reference only")); assert.equal(f.requests.some(row => row.type === "compact"), false);
  }
});
test("Pi compact refusal never issues a second summary call or a user prompt", async t => {
  const f = fixture(t, { refused: true }); await assert.rejects(f.rpc.compact("reference only"), /command refused/);
  assert.deepEqual(f.requests.map(row => row.type), ["get_state", "compact"]);
});
