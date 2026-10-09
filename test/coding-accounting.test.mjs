import test from "node:test";
import assert from "node:assert/strict";
import { createCodingUsageAccumulator } from "../dist/coding/accounting.js";

const counters = (inputTokens, outputTokens, providerRounds) => ({
  inputTokens, outputTokens, providerRounds, totalTokens: inputTokens + outputTokens, toolCalls: 0,
});

test("final cancelled input is reconciled without counting prior progress twice", () => {
  const parent = { input: 5, output: 3, providerCalls: 2 };
  const account = createCodingUsageAccumulator(parent);
  account(counters(0, 0, 1));
  account(counters(95, 0, 1)); // cancellation adds the dispatched input estimate after the last callback
  account(counters(95, 0, 1));
  assert.deepEqual(parent, { input: 100, output: 3, providerCalls: 3 });
});

test("stale progress never resets the high-water mark or double counts later usage", () => {
  const parent = { input: 0, output: 0 };
  const account = createCodingUsageAccumulator(parent);
  account(counters(10, 2, 1));
  account(counters(0, 0, 0));
  account(counters(20, 4, 2));
  assert.deepEqual(parent, { input: 20, output: 4, providerCalls: 2 });
});

test("independent concurrent workers each contribute only their own deltas", () => {
  const parent = { input: 7, output: 8 };
  const first = createCodingUsageAccumulator(parent), second = createCodingUsageAccumulator(parent);
  first(counters(10, 2, 1)); second(counters(15, 3, 2)); first(counters(20, 4, 2));
  assert.deepEqual(parent, { input: 42, output: 15, providerCalls: 4 });
});

test("invalid host counters cannot corrupt parent statistics", () => {
  for (const value of [-1, NaN, Infinity, 1.5]) {
    const parent = { input: 0, output: 0 };
    assert.throws(() => createCodingUsageAccumulator(parent)(counters(value, 0, 0)), /invalid coding usage/);
    assert.deepEqual(parent, { input: 0, output: 0 });
  }
});
