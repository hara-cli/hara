import test from "node:test";
import assert from "node:assert/strict";
import {
  ComposerHistory,
  moveCursorLine,
  nextGraphemeIndex,
  previousGraphemeIndex,
  previousWordIndex,
} from "../dist/tui/input-history.js";

const draft = (value, pastes = []) => ({ value, attachments: [], pastes });

test("ComposerHistory walks older/newer entries and restores the unsent draft", () => {
  const history = new ComposerHistory(10, 1000);
  history.record(draft("first"));
  history.record(draft("second"));

  assert.equal(history.older(draft("unfinished")).value, "second");
  assert.equal(history.older(draft("ignored while browsing")).value, "first");
  assert.equal(history.older(draft("still ignored")).value, "first", "oldest entry is a stable boundary");
  assert.equal(history.newer().value, "second");
  assert.equal(history.newer().value, "unfinished", "Down past newest restores the original draft");
  assert.equal(history.browsing, false);
});

test("ComposerHistory bounds retained paste data", () => {
  const history = new ComposerHistory(10, 8);
  history.record(draft("one"));
  history.record(draft("two"));
  history.record(draft("three"));
  assert.equal(history.length, 2, "old entries are trimmed to the total character budget");

  history.record(draft("x", ["z".repeat(100)]));
  assert.equal(history.length, 2, "an entry larger than the whole budget is not retained");
});

test("cursor helpers keep emoji graphemes intact and find shell word boundaries", () => {
  const family = "👨‍👩‍👧‍👦";
  const value = `A${family}B`;
  const afterFamily = 1 + family.length;
  assert.equal(previousGraphemeIndex(value, afterFamily), 1, "Backspace removes the whole ZWJ emoji");
  assert.equal(nextGraphemeIndex(value, 1), afterFamily, "Right arrow crosses the whole emoji");
  assert.equal(previousWordIndex("alpha  世界", "alpha  世界".length), 7, "Ctrl+W finds a Unicode word start");
});

test("moveCursorLine preserves the nearest column across uneven logical lines", () => {
  const value = "abcd\nx\n123456";
  assert.equal(moveCursorLine(value, 3, 1), 6, "moving to a short line clamps at its end");
  assert.equal(moveCursorLine(value, 6, 1), 8, "moving down from column one keeps column one");
  assert.equal(moveCursorLine(value, 10, -1), 6, "moving up clamps to the prior short line");
});
