import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit, maxParallel } from "../dist/concurrency.js";

test("mapLimit: never exceeds the limit, but does run several in parallel, results in order", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapLimit(items, 5, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.ok(peak <= 5, `peak concurrency ${peak} must be <= 5`);
  assert.ok(peak >= 2, "and it genuinely parallelized (not serialized)");
  assert.deepEqual(out, items.map((n) => n * 2), "results preserve input order");
});

test("mapLimit: empty input + limit larger than the item count", async () => {
  assert.deepEqual(await mapLimit([], 5, async () => 1), []);
  assert.deepEqual(await mapLimit([1, 2, 3], 10, async (n) => n + 1), [2, 3, 4]);
});

test("maxParallel: default 8, HARA_MAX_CONCURRENCY override, invalid → default", () => {
  const prev = process.env.HARA_MAX_CONCURRENCY;
  try {
    delete process.env.HARA_MAX_CONCURRENCY;
    assert.equal(maxParallel(), 8);
    process.env.HARA_MAX_CONCURRENCY = "3";
    assert.equal(maxParallel(), 3);
    process.env.HARA_MAX_CONCURRENCY = "0";
    assert.equal(maxParallel(), 8, "0 is invalid → default");
    process.env.HARA_MAX_CONCURRENCY = "nope";
    assert.equal(maxParallel(), 8);
  } finally {
    if (prev === undefined) delete process.env.HARA_MAX_CONCURRENCY;
    else process.env.HARA_MAX_CONCURRENCY = prev;
  }
});
