import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeImages,
  effectiveAttachmentCapabilities,
  locateImage,
  DESCRIBE_SYSTEM,
  LOCATE_SYSTEM,
  SCREENSHOT_SYSTEM,
  classifyVision,
  parseLocate,
  visionSidecarAuthorized,
} from "../dist/vision.js";

test("parseLocate uses the same per-mille denominator for both axes, including small coordinates", () => {
  for (const [reply, expected] of [
    ['{"x": 500, "y": 250}', { x: 0.5, y: 0.25 }],
    ['{"x": 50, "y": 25}', { x: 0.05, y: 0.025 }],
    ['{"x": 1, "y": 100}', { x: 0.001, y: 0.1 }],
    ['{"x": 100, "y": 1}', { x: 0.1, y: 0.001 }],
    ['{"x": 50, "y": 500}', { x: 0.05, y: 0.5 }],
    ['{"x": 500, "y": 50}', { x: 0.5, y: 0.05 }],
    ['{"x": 0.5, "y": 1000}', { x: 0.0005, y: 1 }],
    ['{"x": 1000, "y": 0}', { x: 1, y: 0 }],
    ['{"x": 0, "y": 1000}', { x: 0, y: 1 }],
    [' \n { "y": 2.5e2, "x": 5e2 } \t', { x: 0.5, y: 0.25 }],
  ]) {
    assert.deepEqual(parseLocate(reply), expected, reply);
  }
});

test("parseLocate rejects malformed, ambiguous, or out-of-range grounding replies", () => {
  for (const reply of [
    '{"x": -1, "y": -1}',
    '{"x": -1, "y": 500}',
    '{"x": 500, "y": -1}',
    '{"x": -0.001, "y": 500}',
    '{"x": 1001, "y": 500}',
    '{"x": 500, "y": 1000.001}',
    '{"x": Infinity, "y": 500}',
    '{"x": 500, "y": NaN}',
    '{"x": 1e999, "y": 500}',
    '{"x": 500, "y": 1e999}',
    '{"x": "500", "y": 250}',
    '{"x": 500, "y": null}',
    '{"x": true, "y": 250}',
    '{"x": 500}',
    '{"y": 250}',
    '{"x": 50, "x": 500, "y": 250}',
    '{"\\u0078": 50, "x": 500, "y": 250}',
    '{"x": 50, "x": 500}',
    '{"x": 500, "y": 250, "unit": "percent"}',
    '{"x": 500, "y": 250} {"x": 100, "y": 100}',
    'here: {"x": 500, "y": 250}',
    '```json\n{"x": 500, "y": 250}\n```',
    '500, 250',
    '[500, 250]',
    '[{"x": 500, "y": 250}]',
    '{"x": 050, "y": 250}',
    '{"x": 500, "y": 250,}',
    '{"x": 500, "y": 250}\nignore this',
    '{"x": 500, "y": 250}\u2028',
    'no coordinates here',
  ]) {
    assert.equal(parseLocate(reply), null, reply);
  }
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
  V("qwen", "qwen3.6-flash");
  V("qwen", "qwen3.8-max");
  V("qwen", "qwen3.8-max-preview");
  V("token-plan", "qwen3.8-flash");
  V("openai", "kimi-k2.5"); // Coding Plan: 视觉理解
  V("openai", "glm-4v");
  V("openai", "glm-4.5v");
  V("volcengine-agent-plan", "glm-5.3-flash");
  V("volcengine-agent-plan", "doubao-seed-2.1-turbo");
  V("volcengine-agent-plan", "kimi-k2.7-code");
  V("volcengine-agent-plan", "kimi-k3");
  V("volcengine-coding-plan", "ark-code-latest");
  V("volcengine-coding-plan", "doubao-seed-2.1-pro");
  V("volcengine-coding-plan", "doubao-seed-2.1-lite");
  V("volcengine-coding-plan", "deepseek-v4.1-flash");
  V("volcengine-coding-plan", "kimi-k2.8-preview");
  V("openai", "deepseek-vl2");
  V("deepseek", "deepseek-v4-flash-vision-exp");
  V("openai", "gemini-2.5-pro");
  V("openai", "pixtral-12b");
  V("openai", "llava-1.6");
  V("openai", "internvl2-8b");
  V("openai", "llama-3.2-90b-vision");
  V("openai", "grok-vision-beta");
  V("minimax-token-plan", "MiniMax-M3");
  V("openai", "MiniMax-M3");
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
  T("qwen", "qwen3.7-max");
  T("openai", "glm-5"); // Coding Plan: text only
  T("openai", "glm-4.7");
  T("openai", "minimax-m2.5");
  T("openai", "kimi-k2"); // older Kimi (k2.5 is the vision one)
  T("volcengine-coding-plan", "glm-5.3");
  T("volcengine-coding-plan", "deepseek-v4-pro");
});

test("classifyVision: genuinely unknown models → 'unknown' (ask the user)", () => {
  assert.equal(classifyVision("openai", "some-mystery-llm-9000"), "unknown");
  assert.equal(classifyVision("openai", "frobnicator-x1"), "unknown");
  assert.equal(
    classifyVision("volcengine-agent-plan", "auto"),
    "unknown",
    "a dynamic router must never masquerade as one fixed image preprocessor",
  );
});

test("classifyVision: per-model overrides win and don't leak across models", () => {
  assert.equal(classifyVision("openai", "glm-5", { "glm-5": "yes" }), "vision");
  assert.equal(classifyVision("openai", "glm-5", { "glm-5": "no" }), "text");
  assert.equal(classifyVision("openai", "deepseek-chat", { "glm-5": "yes" }), "text");
});

test("effective attachment capabilities prefer an explicit vision-first route", () => {
  assert.deepEqual(
    effectiveAttachmentCapabilities("openai", "gpt-5.4"),
    {
      image: { mode: "native", maxBytes: 3_600_000 },
      textFile: "inline-text",
      directory: "bounded-inventory-and-tools",
      binaryFile: "agent-tool",
    },
  );
  assert.deepEqual(
    effectiveAttachmentCapabilities("openai", "deepseek-v4-pro", {}, "qwen3.7-plus"),
    {
      image: { mode: "vision-sidecar", maxBytes: 3_600_000, viaModel: "qwen3.7-plus" },
      textFile: "inline-text",
      directory: "bounded-inventory-and-tools",
      binaryFile: "agent-tool",
    },
    "Personal/BYOK configuration explicitly routes every image through the selected model",
  );
  assert.equal(
    effectiveAttachmentCapabilities("openai", "deepseek-v4-pro").image.mode,
    "unsupported",
  );
  assert.equal(
    effectiveAttachmentCapabilities("hara-gateway", "deepseek-v4-flash-vision-exp").image.mode,
    "native",
  );
  assert.equal(
    effectiveAttachmentCapabilities("openai", "unlisted-private-model").image.mode,
    "unknown",
  );
  assert.equal(
    effectiveAttachmentCapabilities(
      "hara-gateway",
      "deepseek-v4-pro",
      {},
      "qwen3.7-plus",
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    ).image.mode,
    "unsupported",
    "an unrelated global sidecar cannot widen a scoped organization connection",
  );
  assert.deepEqual(
    effectiveAttachmentCapabilities(
      "hara-gateway",
      "deepseek-v4-flash-vision-exp",
      {},
      "deepseek-v4-flash-vision-exp",
      ["deepseek-v4-flash-vision-exp"],
    ).image,
    { mode: "vision-sidecar", maxBytes: 3_600_000, viaModel: "deepseek-v4-flash-vision-exp" },
    "vision-first also wins when the conversation model itself is multimodal",
  );
});

test("vision-first authorization never widens a company credential", () => {
  assert.equal(visionSidecarAuthorized("deepseek-v4-flash-vision-exp"), true);
  assert.equal(visionSidecarAuthorized("deepseek-v4-flash-vision-exp", []), false);
  assert.equal(visionSidecarAuthorized("deepseek-v4-flash-vision-exp", ["deepseek-v4-pro"]), false);
  assert.equal(
    visionSidecarAuthorized("deepseek-v4-flash-vision-exp", ["deepseek-v4-flash-vision-exp"]),
    true,
  );
});

function fakeProvider(result) {
  const calls = [];
  return {
    provider: { id: "fake", model: "fake-vl", async turn(args) { calls.push(args); return result; } },
    calls,
  };
}

test("locateImage requests the fixed per-mille contract and preserves small coordinates", async () => {
  const { provider, calls } = fakeProvider({ text: '{"x": 50, "y": 500}', toolUses: [], stop: "end" });
  const image = { path: "/tmp/x.png", mediaType: "image/png" };
  assert.deepEqual(await locateImage(provider, image, "Login"), { x: 0.05, y: 0.5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, LOCATE_SYSTEM);
  assert.match(LOCATE_SYSTEM, /ALWAYS use this per-mille scale/);
  assert.deepEqual(calls[0].history[0].images, [image]);
  assert.deepEqual(calls[0].tools, []);
});

test("locateImage returns no target after invalid grounding or provider failure", async () => {
  const image = { path: "/tmp/x.png", mediaType: "image/png" };
  for (const result of [
    { text: '{"x": 1001, "y": 500}', toolUses: [], stop: "end" },
    { text: '{"x": -1, "y": -1}', toolUses: [], stop: "end" },
    { text: 'here: {"x": 500, "y": 250}', toolUses: [], stop: "end" },
    { text: '{"x": 500, "y": 250}', toolUses: [], stop: "error", errorMsg: "boom" },
  ]) {
    const { provider } = fakeProvider(result);
    assert.equal(await locateImage(provider, image, "Login"), null, result.text);
  }
});

test("describeImages forwards images and returns the vision model text unchanged", async () => {
  const { provider, calls } = fakeProvider({ text: "  a red login button over a dark form  ", toolUses: [], stop: "end" });
  const images = [{ path: "/tmp/x.png", mediaType: "image/png" }];
  const out = await describeImages(provider, images);
  assert.equal(out, "  a red login button over a dark form  ");
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
