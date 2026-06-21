import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyDone, NOTIFY_MODES } from "../dist/notify.js";

// capture what notifyDone writes to the terminal (the BEL) without touching the real notification center
function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = "";
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

test("off → never rings, whatever the elapsed", () => {
  assert.equal(captureStderr(() => notifyDone("off", { message: "x", elapsedMs: 999999 })), "");
});

test("bell → rings the terminal BEL once the turn ran long enough", () => {
  assert.ok(captureStderr(() => notifyDone("bell", { message: "x", elapsedMs: 20000 })).includes("\x07"));
});

test("bell → stays quiet for a quick turn (below the 8s default)", () => {
  assert.equal(captureStderr(() => notifyDone("bell", { message: "x", elapsedMs: 1000 })), "");
});

test("minMs threshold is configurable", () => {
  assert.ok(captureStderr(() => notifyDone("bell", { message: "x", elapsedMs: 500, minMs: 100 })).includes("\x07"));
  assert.equal(captureStderr(() => notifyDone("bell", { message: "x", elapsedMs: 50, minMs: 100 })), "");
});

test("system → also gated by elapsed (quick turn fires nothing — no OS notification, no bell)", () => {
  // below threshold: returns before any spawn, so the test never pops a real notification
  assert.equal(captureStderr(() => notifyDone("system", { message: "x", elapsedMs: 100 })), "");
});

test("NOTIFY_MODES lists the three modes", () => {
  assert.deepEqual(NOTIFY_MODES, ["off", "bell", "system"]);
});
