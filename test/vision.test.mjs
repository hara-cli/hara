import { test } from "node:test";
import assert from "node:assert/strict";
import { describeImages, DESCRIBE_SYSTEM } from "../dist/vision.js";

function fakeProvider(result) {
  const calls = [];
  return {
    provider: { id: "fake", model: "fake-vl", async turn(args) { calls.push(args); return result; } },
    calls,
  };
}

test("describeImages forwards images to the vision provider and returns its (trimmed) text", async () => {
  const { provider, calls } = fakeProvider({ text: "  a red login button over a dark form  ", toolUses: [], stop: "end" });
  const images = [{ path: "/tmp/x.png", mediaType: "image/png" }];
  const out = await describeImages(provider, images);
  assert.equal(out, "a red login button over a dark form");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, DESCRIBE_SYSTEM);
  const userMsg = calls[0].history[0];
  assert.equal(userMsg.role, "user");
  assert.deepEqual(userMsg.images, images, "images forwarded to the vision turn");
});

test("describeImages throws on a provider error", async () => {
  const { provider } = fakeProvider({ text: "", toolUses: [], stop: "error", errorMsg: "boom" });
  await assert.rejects(() => describeImages(provider, [{ path: "/tmp/x.png", mediaType: "image/png" }]), /boom/);
});

test("DESCRIBE_SYSTEM instructs verbatim transcription (OCR for text-only models)", () => {
  assert.match(DESCRIBE_SYSTEM, /VERBATIM/);
});
