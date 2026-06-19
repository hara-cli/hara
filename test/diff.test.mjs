import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDiff } from "../dist/diff.js";

test("renderDiff: identical content → empty", () => {
  assert.equal(renderDiff("f.ts", "same\nlines", "same\nlines"), "");
});

test("renderDiff: shows -old / +new with the path header", () => {
  const d = renderDiff("f.ts", "a\nb\nc", "a\nB\nc");
  assert.match(d, /◇ f\.ts/);
  assert.match(d, /- b/);
  assert.match(d, /\+ B/);
  assert.match(d, /\+1/); // 1 add in the summary
  assert.match(d, /-1/); // 1 delete
});

test("renderDiff: new file → all additions", () => {
  const d = renderDiff("new.ts", "", "x\ny");
  assert.match(d, /\+ x/);
  assert.match(d, /\+ y/);
});

test("renderDiff: oversized files fall back to a summary", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const d = renderDiff("big.ts", big, big + "\nextra");
  assert.match(d, /too large to diff/);
});
