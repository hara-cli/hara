import { test } from "node:test";
import assert from "node:assert/strict";
import { describeImages, locateImage, DESCRIBE_SYSTEM, SCREENSHOT_SYSTEM, classifyVision, parseLocate } from "../dist/vision.js";

test("parseLocate: grounding coords (per-mille / percent / fraction) → 0..1 fractions", () => {
  assert.deepEqual(parseLocate('{"x": 500, "y": 250}'), { x: 0.5, y: 0.25 }); // per-mille
  assert.deepEqual(parseLocate('{"x": 50, "y": 25}'), { x: 0.5, y: 0.25 }); // percent
  assert.deepEqual(parseLocate('here: {"x":1000,"y":0}'), { x: 1, y: 0 }); // edges, prose around it
  assert.equal(parseLocate('{"x": -1, "y": -1}'), null, "not-found sentinel → null");
  assert.equal(parseLocate("no coordinates here"), null);
});

test("classifyVision: vision-capable families → 'vision'", () => {
  const V = (p, m) => assert.equal(classifyVision(p, m), "vision", `${p}/${m}`);
  V("anthropic", "claude-opus-4-8");
  V("anthropic", "claude-haiku-4-5");
  V("openai", "gpt-4o");
  V("openai", "gpt-4o-mini");
  V("openai", "gpt-4-turbo");
  V("qwen", "qwen-vl-max");
  V("qwen", "qwen2.5-vl-7b-instruct");
  V("qwen", "qwen3-vl-plus");
  V("qwen", "qvq-72b-preview");
  V("qwen", "qwen3.7-plus"); // Coding Plan: 视觉理解 (verified live)
  V("qwen", "qwen3.6-plus");
  V("qwen", "qwen3.5-plus");
  V("openai", "kimi-k2.5"); // Coding Plan: 视觉理解
  V("openai", "glm-4v");
  V("openai", "glm-4.5v");
  V("openai", "deepseek-vl2");
  V("openai", "gemini-2.5-pro");
  V("openai", "pixtral-12b");
  V("openai", "llava-1.6");
  V("openai", "internvl2-8b");
  V("openai", "llama-3.2-90b-vision");
  V("openai", "grok-vision-beta");
});

test("classifyVision: text-only families → 'text'", () => {
  const T = (p, m) => assert.equal(classifyVision(p, m), "text", `${p}/${m}`);
  T("qwen", "qwen3-coder-plus");
  T("qwen", "qwen-plus");
  T("qwen", "qwen-max");
  T("openai", "deepseek-chat");
  T("openai", "deepseek-v3");
  T("openai", "deepseek-r1");
  T("openai", "gpt-3.5-turbo");
  T("openai", "gpt-4");
  T("openai", "gemma-2-9b");
  T("openai", "mistral-large-latest");
  T("openai", "kimi-k2");
  T("openai", "llama-3.1-70b");
  T("openai", "glm-4-flash");
  T("openai", "glm-4.6");
  T("qwen", "qwen3-max-2026-01-23"); // Coding Plan: text only (no 视觉理解)
  T("qwen", "qwen3-coder-next");
  T("openai", "glm-5"); // Coding Plan: text only
  T("openai", "glm-4.7");
  T("openai", "minimax-m2.5");
  T("openai", "kimi-k2"); // older Kimi (k2.5 is the vision one)
});

test("classifyVision: genuinely unknown models → 'unknown' (ask the user)", () => {
  assert.equal(classifyVision("openai", "some-mystery-llm-9000"), "unknown");
  assert.equal(classifyVision("openai", "frobnicator-x1"), "unknown");
});

test("classifyVision: per-model overrides win and don't leak across models", () => {
  assert.equal(classifyVision("openai", "glm-5", { "glm-5": "yes" }), "vision");
  assert.equal(classifyVision("openai", "glm-5", { "glm-5": "no" }), "text");
  assert.equal(classifyVision("openai", "deepseek-chat", { "glm-5": "yes" }), "text");
});

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

test("vision calls hard-stop a provider that ignores cancellation", async () => {
  const provider = { id: "stuck", model: "stuck-vl", turn: () => new Promise(() => {}) };
  const image = { path: "/tmp/x.png", mediaType: "image/png" };
  await assert.rejects(() => describeImages(provider, [image], { timeoutMs: 25 }), /image description timed out/);
  assert.equal(await locateImage(provider, image, "Login", { timeoutMs: 25 }), null);
});

test("DESCRIBE_SYSTEM instructs verbatim transcription (OCR for text-only models)", () => {
  assert.match(DESCRIBE_SYSTEM, /VERBATIM/);
});

test("describeImages: system override + focus hint (task-aware screenshots)", async () => {
  const { provider, calls } = fakeProvider({ text: "Login button at top-right ~(900,40)", toolUses: [], stop: "end" });
  const out = await describeImages(provider, [{ path: "/tmp/s.png", mediaType: "image/png" }], {
    system: SCREENSHOT_SYSTEM,
    hint: "the Login button",
  });
  assert.match(out, /Login button/);
  assert.equal(calls[0].system, SCREENSHOT_SYSTEM, "uses the screenshot-tuned prompt, not the generic one");
  assert.match(calls[0].history[0].content, /Focus especially on: the Login button/);
});

test("SCREENSHOT_SYSTEM is action-oriented (interactive elements + positions)", () => {
  assert.match(SCREENSHOT_SYSTEM, /INTERACTIVE/);
  assert.match(SCREENSHOT_SYSTEM, /pixel|location|position/i);
});
