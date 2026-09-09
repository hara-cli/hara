import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, failoverAction, errorHint } from "../dist/agent/failover.js";

test("classifyError: maps message/status to a kind (incl. DashScope/GLM Chinese strings)", () => {
  assert.equal(classifyError("interrupted"), "interrupted");
  assert.equal(classifyError("Invalid API key"), "auth");
  assert.equal(classifyError("", 401), "auth");
  assert.equal(classifyError("Rate limit exceeded"), "rate_limit");
  assert.equal(classifyError("请求过于频繁"), "rate_limit");
  assert.equal(classifyError("", 429), "rate_limit");
  assert.equal(classifyError("insufficient quota for this account", 402), "quota_exhausted");
  assert.equal(classifyError("该账号积分已用尽"), "quota_exhausted");
  assert.equal(classifyError("model is not available in this region"), "region_unavailable");
  assert.equal(classifyError("provider connection circuit open", undefined, "HARA_CIRCUIT_OPEN"), "circuit_open");
  assert.equal(classifyError("service is overloaded"), "overloaded");
  assert.equal(classifyError("", 529), "overloaded");
  assert.equal(classifyError("maximum context length exceeded"), "context_overflow");
  assert.equal(classifyError("上下文长度超过限制"), "context_overflow");
  assert.equal(classifyError("socket hang up"), "timeout");
  assert.equal(classifyError("", 408), "timeout");
  assert.equal(classifyError("", 500), "transient");
  assert.equal(classifyError("weird"), "unknown");
});

test("failoverAction: fall back on recoverable kinds (fallback present + untried); never auth/interrupted; one-shot", () => {
  const ready = { hasFallback: true, triedFallback: false };
  for (const k of ["overloaded", "rate_limit", "timeout", "transient", "context_overflow", "unknown"]) {
    assert.equal(failoverAction(k, ready), "fallback", k);
  }
  assert.equal(failoverAction("auth", ready), "fail");
  assert.equal(failoverAction("interrupted", ready), "fail");
  assert.equal(failoverAction("overloaded", { hasFallback: true, triedFallback: true }), "fail"); // already tried
  assert.equal(failoverAction("overloaded", { hasFallback: false, triedFallback: false }), "fail"); // none configured
  assert.equal(failoverAction("overloaded", { hasFallback: true, triedFallback: false, replaySafe: false }), "fail");
  assert.equal(failoverAction("overloaded", { hasFallback: true, triedFallback: false, compatible: false }), "fail");
  assert.equal(failoverAction("auth", { hasFallback: true, triedFallback: false, differentConnection: true }), "fallback");
  assert.equal(failoverAction("quota_exhausted", ready), "fallback");
  assert.equal(failoverAction("region_unavailable", ready), "fallback");
  assert.equal(failoverAction("circuit_open", ready), "fallback");
});

test("errorHint: actionable hints for common kinds", () => {
  assert.match(errorHint("auth"), /key|auth/);
  assert.match(errorHint("overloaded"), /fallbackModel/);
  assert.equal(errorHint("unknown"), "");
});
