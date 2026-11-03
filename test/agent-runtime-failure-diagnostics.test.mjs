import test from "node:test";
import assert from "node:assert/strict";
import { classifyRuntimeFailure, runtimeFailureMessage, safeRuntimeVersion, RuntimeLaunchCooldown } from "../dist/agent-runtime/failure-diagnostics.js";

const fixtures = [
  [{ code: "ENOENT" }, "not_installed"],
  [{ code: "command_not_found", stderr: "unknown model" }, "not_installed"],
  [{ code: "not_registered" }, "not_installed"],
  [{ stderr: "CLI version is too old" }, "version_incompatible"],
  [{ stderr: "unknown option --effort" }, "version_incompatible"],
  [{ stderr: "unexpected argument '--json' found" }, "version_incompatible"],
  [{ stderr: "Not logged in; please sign in" }, "runtime_auth_required"],
  [{ code: "runtime_auth_required", stderr: "401 unauthorized" }, "runtime_auth_required"],
  [{ stderr: "401 Unauthorized at PRIVATE_URL" }, "runtime_auth_rejected"],
  [{ stderr: "authentication failed" }, "runtime_auth_rejected"],
  [{ status: 401 }, "runtime_auth_rejected"],
  [{ stderr: "Cannot connect to API" }, "runtime_network"],
  [{ stderr: "failed to connect to API" }, "runtime_network"],
  [{ stderr: "ECONNREFUSED 127.0.0.1" }, "runtime_network"],
  [{ code: "ECONNRESET" }, "runtime_network"],
  [{ stderr: "proxy connection failed" }, "runtime_proxy"],
  [{ stderr: "407 proxy authentication failed" }, "runtime_proxy"],
  [{ stderr: "SOCKS connection refused" }, "runtime_proxy"],
  [{ stderr: "HTTP 407" }, "runtime_proxy"],
  [{ stderr: "unknown model PRIVATE_MODEL" }, "invalid_model"],
  [{ stderr: "unknown provider PRIVATE_PROVIDER" }, "invalid_model"],
  [{ stderr: "ModelNotFoundError" }, "invalid_model"],
  [{ stderr: "Unsupported model variant" }, "invalid_model"],
  [{ status: 429, stderr: "Your subscription does not include this model" }, "invalid_model"],
  [{ status: 402 }, "runtime_quota"],
  [{ status: 429, stderr: "insufficient quota" }, "runtime_quota"],
  [{ stderr: "余额不足" }, "runtime_quota"],
  [{ status: 429 }, "runtime_rate_limit"],
  [{ stderr: "rate limit exceeded; try later" }, "runtime_rate_limit"],
  [{ status: 403 }, "runtime_permission_denied"],
  [{ code: "EACCES" }, "runtime_permission_denied"],
  [{ signal: "SIGSEGV" }, "runtime_crashed"],
  [{ stderr: "thread main panicked at PRIVATE_PATH" }, "runtime_crashed"],
  [{ stderr: "not inside a trusted directory" }, "project_not_trusted"],
  [{ timedOut: true }, "timeout"],
  [{ code: "ETIMEDOUT" }, "timeout"],
  [{ code: "spawn_failed" }, "spawn_failed"],
  [{ code: "future_code", stderr: "401 Unauthorized" }, "runtime_auth_rejected"],
  [{ stderr: "A model said it could not find a local file" }, "runtime_failed"],
  [{ stderr: "PRIVATE_SENTINEL" }, "runtime_failed"],
];
for (const [input, expected] of fixtures) test(`runtime evidence: ${JSON.stringify(input)} => ${expected}`, () => {
  assert.equal(classifyRuntimeFailure(input), expected);
  assert(!JSON.stringify(classifyRuntimeFailure(input)).includes("PRIVATE_"));
});

test("classification never scans beyond bounded native evidence", () => {
  assert.equal(classifyRuntimeFailure({ stderr: "a".repeat(65_536) + " 401 Unauthorized" }), "runtime_failed");
  assert.equal(classifyRuntimeFailure({ stderr: "界".repeat(21_846) + " 401 Unauthorized" }), "runtime_failed");
  assert.equal(classifyRuntimeFailure({ code: "constructor", stderr: "PRIVATE" }), "runtime_failed");
});

test("diagnostic summary projects exactly the eight allowlisted fields and never forwards arbitrary input", () => {
  const input = { runtime: "codex", kind: "runtime_auth_rejected", version: "codex-cli 0.163.0", loginSource: "host",
    homeMatchesAccount: false, elapsedMs: 1234.9, retryAtMs: 1700000000000, consecutiveFailures: 2,
    token: "PRIVATE_TOKEN", prompt: "PRIVATE_PROMPT", stderr: "401 PRIVATE_STDERR", HOME: "/PRIVATE_HOME", model: "PRIVATE_MODEL" };
  const text = runtimeFailureMessage(input);
  assert(text.startsWith("hara_runtime_failure_v1="));
  const body = JSON.parse(text.slice("hara_runtime_failure_v1=".length));
  assert.deepEqual(Object.keys(body).sort(), ["runtime", "kind", "version", "loginSource", "homeMatchesAccount", "elapsedMs", "retryAtMs", "consecutiveFailures"].sort());
  assert.deepEqual(body, { runtime: "codex", kind: "runtime_auth_rejected", version: "0.163.0", loginSource: "host", homeMatchesAccount: false,
    elapsedMs: 1234, retryAtMs: 1700000000000, consecutiveFailures: 2 });
  assert(!text.includes("PRIVATE"));
});

test("untrusted versions and malformed summary values become unknown or bounded values", () => {
  for (const version of ["PRIVATE_VERSION 1.2.3", "1.2.3?token=PRIVATE", "1.2.3\nPRIVATE", "1.2.3-alpha-PRIVATE", { toString() { throw new Error("must not coerce"); } }]) {
    assert.equal(safeRuntimeVersion(version), null);
    assert(!runtimeFailureMessage({ runtime: "claude", kind: "PRIVATE_KIND", version, loginSource: "PRIVATE_SOURCE", homeMatchesAccount: "PRIVATE_HOME",
      elapsedMs: Infinity, retryAtMs: NaN, consecutiveFailures: -50 }).includes("PRIVATE"));
  }
  assert.equal(safeRuntimeVersion("2.1.14 (Claude Code)"), "2.1.14");
  assert.equal(safeRuntimeVersion("opencode 1.0.2"), "1.0.2");
  const unknown = JSON.parse(runtimeFailureMessage({ runtime: "opencode", kind: "runtime_failed", version: null, loginSource: "unknown", homeMatchesAccount: null,
    elapsedMs: 999999, retryAtMs: Number.MAX_VALUE, consecutiveFailures: 999999 }).split("=", 2)[1]);
  assert.equal(unknown.elapsedMs, 600000);
  assert.equal(unknown.retryAtMs, 8640000000000000);
  assert.equal(unknown.consecutiveFailures, 1000);
  assert.equal(unknown.homeMatchesAccount, null);
  assert.throws(() => runtimeFailureMessage({ runtime: "PRIVATE_RUNTIME" }), { message: "Invalid diagnostic runtime" });
});

test("consecutive early failures use a bounded exponential cooldown without extending on reads", () => {
  const guard = new RuntimeLaunchCooldown();
  let now = 10000;
  assert.equal(guard.blocked(now), null);
  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
    guard.failed("spawn_failed", 12, now);
    const first = guard.blocked(now);
    assert.deepEqual(first, { kind: "spawn_failed", retryAtMs: now + delay, consecutiveFailures: index + 1 });
    first.retryAtMs = 0;
    assert.equal(guard.blocked(now + 1).retryAtMs, now + delay, "callers cannot mutate the fence");
    assert.equal(guard.blocked(now + delay - 1).retryAtMs, now + delay);
    assert.equal(guard.blocked(now + delay), null);
    now += delay;
  }
});

test("success and progressed long-running failures reset the early startup streak; scopes stay separate", () => {
  const one = new RuntimeLaunchCooldown(), other = new RuntimeLaunchCooldown();
  one.failed("runtime_auth_rejected", 10, 10000);
  assert.equal(other.blocked(10000), null);
  one.succeeded();
  assert.equal(one.blocked(10000), null);
  one.failed("runtime_network", 20, 10000);
  assert.equal(one.blocked(10000).consecutiveFailures, 1);
  one.failed("runtime_network", 15001, 10010);
  assert.equal(one.blocked(10010), null);
  one.failed("runtime_network", 15000, 10020);
  assert.equal(one.blocked(10020).consecutiveFailures, 1);
  one.failed("runtime_failed", NaN, 10030);
  assert.equal(one.blocked(10030), null);
});
