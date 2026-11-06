import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFailureTracker } from "../dist/agent-runtime/failure-tracker.js";
import { createRegisteredCliMcpTurn } from "../dist/agent-runtime/registered-cli-mcp.js";
test("an immediate cached resume-timeout retry retains its recoverable native pause without a native submission", async () => {
  const installer = { failureContext: () => ({ runtime: "codex", version: "0.163.0", loginSource: "host", homeMatchesAccount: true }) };
  const tracker = runtimeFailureTracker(installer, "codex", "agent", "same-route", { env: {}, loginSource: "host" }, "conversation");
  tracker.failed("timeout", 11000, undefined, { rpcMethod: "thread/resume", rpcTimeoutMs: 10000 });
  assert(tracker.blocked());
  const controller = new AbortController(); let calls = 0;
  const turn = createRegisteredCliMcpTurn({ model: "fixture", signal: controller.signal, assertCurrent() {},
    async createEndpoint() { return { url: "http://127.0.0.1:1", env: {}, close: async () => {} }; },
    async launch() { calls++; return { ok: false, code: null, timedOut: false, stdout: "", ...tracker.blockedNativeResult() }; } });
  try {
    const result = await turn.turn({ system: "fixture", history: [{ role: "user", content: "retry" }], tools: [], signal: controller.signal });
    assert.equal(result.errorMetadata.code, "native_resume_timeout");
    assert.equal(calls, 1, "only the local admission callback ran; no native process or user turn was submitted");
    assert.match(result.errorMsg, /thread\/resume/);
    tracker.succeeded(); assert.equal(tracker.blocked(), null); assert.equal(tracker.blockedNativeResult(), null);
    tracker.failed("timeout", 10, undefined, { rpcMethod: "turn/start", rpcTimeoutMs: 10000 });
    assert.equal(tracker.blockedNativeResult().nativeRpc.rpcMethod, "turn/start", "other RPC timeouts are not relabeled as resume");
  } finally { await turn.close(); }
});

test("cooldown expiry cannot split a blocked result from its native resume category", t => {
  let reads = 0;
  t.mock.method(Date, "now", () => 1000);
  const installer = { failureContext: () => ({ runtime: "codex", version: "0.163.0", loginSource: "host", homeMatchesAccount: true }) };
  const tracker = runtimeFailureTracker(installer, "codex", "agent", "route", { env: {}, loginSource: "host" }, "expiry");
  tracker.failed("timeout", 11000, undefined, { rpcMethod: "thread/resume", rpcTimeoutMs: 10000 });
  t.mock.method(Date, "now", () => ++reads === 1 ? 1999 : 2000);
  const held = tracker.blockedNativeResult();
  assert.equal(reads, 1, "one clock snapshot controls both admission and metadata");
  assert.equal(held.nativeFailureKind, "timeout");
  assert.equal(held.nativeRpc.rpcMethod, "thread/resume");
  assert.match(held.runtimeFailure, /thread\/resume/);
  assert.equal(tracker.blockedNativeResult(), null, "a request admitted after expiry launches normally");
});
