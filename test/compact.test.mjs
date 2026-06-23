import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoCompact, AUTO_COMPACT_PCT } from "../dist/agent/compact.js";

test("shouldAutoCompact: fires only when enabled + history substantial + context over threshold", () => {
  assert.equal(shouldAutoCompact(90, 10, true), true);
  assert.equal(shouldAutoCompact(90, 10, false), false); // disabled (opt-out)
  assert.equal(shouldAutoCompact(50, 10, true), false); // well under threshold
  assert.equal(shouldAutoCompact(90, 2, true), false); // too little history to bother
  assert.equal(shouldAutoCompact(AUTO_COMPACT_PCT, 4, true), true); // exactly at threshold + min history
  assert.equal(shouldAutoCompact(AUTO_COMPACT_PCT - 1, 4, true), false); // just under
  assert.equal(shouldAutoCompact(94, 4, true, 95), false); // under a custom higher threshold
  assert.equal(shouldAutoCompact(96, 4, true, 95), true); // custom threshold reached
});
