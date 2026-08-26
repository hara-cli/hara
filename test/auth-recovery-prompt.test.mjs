import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/agent/loop.ts", import.meta.url), "utf8");

test("agent contract presents expired authentication as a resumable sign-in pause", () => {
  assert.match(source, /"Sign in again" \/ "需要重新登录"/);
  assert.match(source, /task is safely paused/);
  assert.match(source, /check the previously blocked capability before resuming business actions/);
  assert.match(source, /registered trusted capability/);
  assert.match(source, /never from model-authored prose/);
});
