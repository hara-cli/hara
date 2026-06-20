import { test } from "node:test";
import assert from "node:assert/strict";
import { describeImages, DESCRIBE_SYSTEM, classifyVision } from "../dist/vision.js";

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
});

test("classifyVision: genuinely unknown models → 'unknown' (ask the user)", () => {
  assert.equal(classifyVision("openai", "glm-5"), "unknown");
  assert.equal(classifyVision("openai", "some-mystery-llm-9000"), "unknown");
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

test("DESCRIBE_SYSTEM instructs verbatim transcription (OCR for text-only models)", () => {
  assert.match(DESCRIBE_SYSTEM, /VERBATIM/);
});
