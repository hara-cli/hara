import test from "node:test";
import assert from "node:assert/strict";
import { readAgentRuntimeUsage } from "../dist/agent-runtime/usage.js";

const now = Date.parse("2026-10-29T12:00:00Z");
const role = (runtimeId, agentRef = "global:coder") => ({ spaceId: "personal", agentRef, runtimeId });
const account = (runtimeId, connectionId, agentRef = "global:coder") => ({ spaceId: "personal", agentRef, runtimeId, connectionId });
const window = (runtimeId, connectionId, availability, scope) => ({ runtimeId, connectionId, availability, scope,
  authority: "native-account-window", fetchedAt: "2026-10-29T11:59:00Z", validUntil: "2026-10-29T12:05:00Z" });

test("same provider connections and external runtime windows remain independent", () => {
  const windows = [window("pi", "provider-account-a", "exhausted", "hara-pi"),
    window("pi", "provider-account-b", "available", "hara-pi"),
    window("codex", "provider-account-a", "available", "external-runtime")];
  assert.equal(readAgentRuntimeUsage(role("pi"), account("pi", "provider-account-a"), windows, now).availability, "exhausted");
  assert.equal(readAgentRuntimeUsage(role("pi"), account("pi", "provider-account-b"), windows, now).availability, "available");
  assert.equal(readAgentRuntimeUsage(role("codex"), account("codex", "provider-account-a"), windows, now).availability, "available");
  const reverse = [window("pi", "provider-account-a", "available", "hara-pi"),
    window("codex", "provider-account-a", "exhausted", "external-runtime")];
  assert.equal(readAgentRuntimeUsage(role("pi"), account("pi", "provider-account-a"), reverse, now).availability, "available");
  assert.equal(readAgentRuntimeUsage(role("codex"), account("codex", "provider-account-a"), reverse, now).availability, "exhausted");
});

test("unknown never becomes available through a missing, stale or wrong-role window", () => {
  const fresh = window("claude", "account-c", "available", "external-runtime");
  for (const [bound, windows] of [
    [undefined, [fresh]],
    [account("claude", "account-c", "global:other"), [fresh]],
    [account("claude", "account-c"), [{ ...fresh, validUntil: "2026-10-29T11:59:59Z" }]],
    [account("claude", "account-c"), [fresh, fresh]],
    [account("claude", "account-c"), [{ ...fresh, scope: "hara-pi" }]],
  ]) {
    const view = readAgentRuntimeUsage(role("claude"), bound, windows, now);
    assert.equal(view.availability, "unknown"); assert.equal(view.fresh, false);
  }
});

test("a runtime window has no scheduler-wide points or shared balance", () => {
  const view = readAgentRuntimeUsage(role("opencode"), account("opencode", "account-d"),
    [window("opencode", "account-d", "available", "external-runtime")], now);
  assert.deepEqual(Object.keys(view).sort(), ["authority", "availability", "connectionId", "fetchedAt", "fresh", "resetAt", "runtimeId", "scope"]);
});
