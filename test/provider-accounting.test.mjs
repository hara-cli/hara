import { test } from "node:test";
import assert from "node:assert/strict";
import {
  permitsAutomaticUsageFailover,
  providerAccounting,
} from "../dist/providers/accounting.js";

test("accounting descriptors separate vendor subscriptions, managed Control, BYOK and local inference", () => {
  assert.deepEqual(providerAccounting("volcengine-agent-plan"), {
    authority: "provider",
    mode: "subscription",
    usageReadMethod: "provider-console",
    haraMayInferBillingFromTransportTokens: false,
    failoverPolicy: "authoritative-exhaustion-only",
  });
  assert.deepEqual(providerAccounting("hara-gateway"), {
    authority: "organization",
    mode: "managed",
    usageReadMethod: "organization-control",
    haraMayInferBillingFromTransportTokens: false,
    failoverPolicy: "authoritative-exhaustion-only",
  });
  assert.equal(providerAccounting("anthropic").mode, "provider-defined");
  assert.equal(providerAccounting("ollama").failoverPolicy, "not-applicable");
});

test("automatic quota failover requires a fresh authoritative exhaustion decision", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");
  const exhausted = {
    provider: "example",
    connectionId: "account-a",
    authority: "provider",
    source: "provider-api",
    fetchedAt: "2026-09-06T11:59:00.000Z",
    availability: "exhausted",
    authoritative: true,
    validUntil: "2026-09-06T12:05:00.000Z",
    meters: [{ id: "native", label: "Vendor allowance", unit: "vendor-credit", remaining: 0 }],
  };

  assert.equal(permitsAutomaticUsageFailover(exhausted, now), true);
  assert.equal(permitsAutomaticUsageFailover({ ...exhausted, authoritative: false }, now), false);
  assert.equal(permitsAutomaticUsageFailover({ ...exhausted, availability: "unknown" }, now), false);
  assert.equal(permitsAutomaticUsageFailover({ ...exhausted, validUntil: "2026-09-06T11:59:59.000Z" }, now), false);
  assert.equal(permitsAutomaticUsageFailover({ ...exhausted, validUntil: undefined }, now), false);
});
