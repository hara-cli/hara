import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPhysicalOperationDrain } from "../dist/session/operation-drain.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("physical operation drain includes nested work registered after closing begins", async () => {
  let releases = 0;
  const drain = createPhysicalOperationDrain(() => { releases += 1; });
  const outer = deferred();
  const child = deferred();

  drain.observe(outer.promise);
  drain.close();
  drain.observe(child.promise);
  outer.resolve();
  await flush();
  assert.equal(releases, 0, "settling the outer snapshot cannot release while a late child is live");
  assert.equal(drain.pendingCount(), 1);

  child.resolve();
  await flush();
  assert.equal(releases, 1);
  assert.equal(drain.pendingCount(), 0);
  drain.close();
  await flush();
  assert.equal(releases, 1, "the session lease releases exactly once");
});

test("an empty physical operation drain releases at a microtask boundary", async () => {
  let released = false;
  const drain = createPhysicalOperationDrain(() => { released = true; });
  drain.close();
  assert.equal(released, false);
  await flush();
  assert.equal(released, true);
});

test("headless auto-compaction observes the physical provider Promise", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /\{ timeoutMs: 60_000, label: "conversation compaction", signal, onProviderTurn \}/,
    "the bounded compaction call exposes its physical provider Promise",
  );
  assert.match(
    source,
    /compactConversation\(provider, history, meta, stats, signal, task, onProviderTurn\)/,
    "auto-compaction forwards the physical observer",
  );
  assert.match(
    source,
    /await maybeAutoCompact\([\s\S]*?task,\s*trackHeadlessOperation,\s*\);/,
    "headless session cleanup owns a late auto-compaction request",
  );
});
