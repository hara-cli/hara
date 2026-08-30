import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THROTTLE_STALE_MS,
  retryAfterMs,
  throttleNotice,
  throttleSignal,
} from "../dist/network/throttle-signal.js";

const withClock = (fn) => {
  let t = 1_000_000;
  throttleSignal._setClock(() => t);
  throttleSignal.clear();
  try { fn((ms) => { t += ms; }); } finally {
    throttleSignal.clear();
    throttleSignal._setClock(() => Date.now());
  }
};

test("only quota decisions count as throttling", () => {
  withClock(() => {
    for (const status of [400, 401, 404, 500, 502]) {
      throttleSignal.hit(status);
      assert.equal(throttleSignal.current, null, `${status} is a fault, not a rate limit`);
    }
    throttleSignal.hit(429);
    assert.equal(throttleSignal.current.status, 429);
  });
});

test("repeated hits are one episode with a rising attempt count", () => {
  withClock((advance) => {
    throttleSignal.hit(429);
    advance(800);
    throttleSignal.hit(429);
    advance(1600);
    throttleSignal.hit(429);
    assert.equal(throttleSignal.current.attempts, 3, "the SDK's silent retries, as the user feels them");
    // A response that got through means the cause is gone.
    throttleSignal.clear();
    assert.equal(throttleSignal.current, null);
  });
});

test("a throttle expires instead of blaming an unrelated later turn", () => {
  withClock((advance) => {
    throttleSignal.hit(429);
    advance(THROTTLE_STALE_MS + 1);
    assert.equal(throttleSignal.current, null, "stale cause must not stick to the next turn");
    throttleSignal.hit(429);
    assert.equal(throttleSignal.current.attempts, 1, "a new episode restarts the count");
  });
});

test("Retry-After is read as seconds or as a date, and ignored when absent", () => {
  const from = Date.parse("2026-08-30T00:00:00Z");
  assert.equal(retryAfterMs("30", from), 30_000);
  assert.equal(retryAfterMs("Sun, 30 Aug 2026 00:00:45 GMT", from), 45_000);
  assert.equal(retryAfterMs(undefined, from), undefined);
  assert.equal(retryAfterMs("later", from), undefined);
  assert.equal(retryAfterMs("Sun, 30 Aug 2020 00:00:00 GMT", from), undefined, "a past date is not a wait");
});

test("the notice names the cause the spinner cannot", () => {
  assert.equal(throttleNotice(null), undefined);
  assert.match(throttleNotice({ attempts: 2, status: 429, at: 0 }), /rate-limited by the provider · retrying \(2\)/);
  assert.match(throttleNotice({ attempts: 1, status: 529, at: 0 }), /overloaded/);
  assert.match(throttleNotice({ attempts: 1, status: 429, retryAfterMs: 4_200, at: 0 }), /asked to wait 5s/);
});
