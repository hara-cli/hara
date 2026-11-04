import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFailureTracker } from "../dist/agent-runtime/failure-tracker.js";

const context = { env: { HOME: "/PRIVATE_HOME" }, loginSource: "host" };
const installer = () => ({ failureContext(runtime) { return { runtime, version: "1.2.3", loginSource: "host", homeMatchesAccount: false }; } });
const read = message => JSON.parse(message.slice("hara_runtime_failure_v1=".length));
test("cooldown survives per-turn registries but stays within installer, colleague, runtime and route", () => {
  const a = installer(), b = installer();
  const first = runtimeFailureTracker(a, "codex", "agent-1", "route-1", context);
  assert.equal(first.blocked(), null);
  const failed = read(first.failed("runtime_auth_rejected", 10));
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(failed.kind, "runtime_auth_rejected");
  assert(!JSON.stringify(failed).includes("PRIVATE_HOME"));
  const repeated = runtimeFailureTracker(a, "codex", "agent-1", "route-1", context);
  const held = read(repeated.blocked());
  assert.equal(held.retryAtMs, failed.retryAtMs, "a blocked click cannot extend the window");
  for (const [owner, runtime, agent, route] of [[b, "codex", "agent-1", "route-1"], [a, "codex", "agent-2", "route-1"],
    [a, "claude", "agent-1", "route-1"], [a, "codex", "agent-1", "route-2"]]) {
    assert.equal(runtimeFailureTracker(owner, runtime, agent, route, context).blocked(), null);
  }
  const changed = runtimeFailureTracker(a, "codex", "agent-1", "route-2", context);
  changed.failed("spawn_failed", 5); changed.succeeded();
  assert.equal(changed.blocked(), null, "a successful launch clears failure state");
  assert.equal(read(changed.failed("runtime_network", 16000)).retryAtMs, 0, "long-running failures do not become startup cooldowns");
});


test("restore RPC metadata is route-owned, closed, available during cooldown and cleared on success or a different failure", () => {
  const tracker = runtimeFailureTracker(installer(), "codex", "agent", "route", context);
  const rpc = { rpcMethod: "thread/resume", rpcTimeoutMs: 10000, prompt: "PRIVATE" };
  assert.equal(read(tracker.failed("timeout", 10000, undefined, rpc)).rpcMethod, "thread/resume");
  assert.equal(read(tracker.blocked()).rpcTimeoutMs, 10000);
  assert.doesNotMatch(tracker.blocked(), /PRIVATE/);
  tracker.succeeded();
  assert.equal(read(tracker.failed("runtime_failed", 1)).rpcMethod, undefined);
  assert.equal(read(tracker.failed("timeout", 1, undefined, { rpcMethod: "PRIVATE_METHOD", rpcTimeoutMs: 10000 })).rpcMethod, undefined);
});
