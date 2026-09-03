import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_COMPACT_PCT,
  AUTO_COMPACT_HISTORY_CHAR_CAP,
  AUTO_COMPACT_TOKEN_CAP,
  autoCompactTokenCap,
  shouldAutoCompact,
  shouldAutoCompactHistoryChars,
  shouldAutoCompactTokens,
} from "../dist/agent/compact.js";

test("autoCompactTokenCap accepts a positive finite override and rejects trigger-every-turn values", () => {
  assert.equal(autoCompactTokenCap("120000"), 120_000);
  assert.equal(autoCompactTokenCap(50.9), 50);
  for (const value of [undefined, "", "nope", 0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(autoCompactTokenCap(value), AUTO_COMPACT_TOKEN_CAP);
  }
});

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

test("shouldAutoCompactTokens: absolute cap fires on huge-window models where 85% is unreachable", () => {
  // A 1M-window session at 300k tokens is only 30% of window (%-trigger silent) but well past the cap.
  assert.equal(shouldAutoCompactTokens(300_000, 10, true), true, "over the 200k cap → compact");
  assert.equal(shouldAutoCompactTokens(AUTO_COMPACT_TOKEN_CAP, 4, true), true, "exactly at the cap");
  assert.equal(shouldAutoCompactTokens(AUTO_COMPACT_TOKEN_CAP - 1, 10, true), false, "just under the cap");
  assert.equal(shouldAutoCompactTokens(300_000, 10, false), false, "disabled (opt-out) wins");
  assert.equal(shouldAutoCompactTokens(300_000, 2, true), false, "too little history to bother");
  assert.equal(shouldAutoCompactTokens(120_000, 10, true, 100_000), true, "custom (lower) cap honored");
});

test("shouldAutoCompactHistoryChars: failed tool rounds still trigger proactive compaction", () => {
  assert.equal(shouldAutoCompactHistoryChars(AUTO_COMPACT_HISTORY_CHAR_CAP, 4, true), true);
  assert.equal(shouldAutoCompactHistoryChars(862_000, 12, true), true);
  assert.equal(shouldAutoCompactHistoryChars(AUTO_COMPACT_HISTORY_CHAR_CAP - 1, 12, true), false);
  assert.equal(shouldAutoCompactHistoryChars(862_000, 2, true), false);
  assert.equal(shouldAutoCompactHistoryChars(862_000, 12, false), false);
});
