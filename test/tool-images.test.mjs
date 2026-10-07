import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createToolImageStore, MAX_TOOL_IMAGES, readToolImageToBase64, validateToolImage,
  redactOwnedToolImageText,
} from "../dist/tools/tool-images.js";
import { collectMcpToolResult } from "../dist/mcp/client.js";
import { createOpenAIProvider, toOpenAI } from "../dist/providers/openai.js";
import { createAnthropicProvider, toAnthropic } from "../dist/providers/anthropic.js";
import { createResponsesProvider, toResponsesInput } from "../dist/providers/responses.js";
import { createProviderForTarget } from "../dist/providers/factory.js";
import { providerTurnRequirements } from "../dist/providers/connection-health.js";
import { getTool, registerTool } from "../dist/tools/registry.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_BASE64, "base64");
const inlineImage = () => ({ data: PNG_BASE64, mediaType: "image/png" });

function history(image) {
  return [
    { role: "user", content: "inspect the screenshot" },
    { role: "assistant", text: "", toolUses: [
      { id: "call-image", name: "screenshot", input: {} },
      { id: "call-text", name: "title", input: {} },
    ] },
    { role: "tool", results: [
      { id: "call-image", name: "screenshot", content: "captured", images: [image] },
      { id: "call-text", name: "title", content: "Settings" },
    ] },
  ];
}

test("tool images are bounded private snapshots and can be disposed without removing arbitrary paths", () => {
  const store = createToolImageStore();
  const image = store.add(inlineImage());
  const root = dirname(image.path);
  try {
    assert.equal(readToolImageToBase64(image), PNG_BASE64);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(root).mode & 0o777, 0o700);
      assert.equal(lstatSync(image.path).mode & 0o777, 0o600);
    }
    for (let i = 1; i < MAX_TOOL_IMAGES; i++) store.add(inlineImage());
    assert.throws(() => store.add(inlineImage()), /image limit/);
  } finally { store.dispose(); }
  assert.equal(existsSync(image.path), false);
  assert.equal(existsSync(root), false);
  assert.equal(readToolImageToBase64(image), null, "expired media cannot survive transcript replay");
  store.dispose();
  assert.throws(() => store.add(inlineImage()), /disposed/);
});

test("tool image validation rejects MIME spoofing, paths, invalid base64, huge payloads and excessive dimensions", () => {
  assert.deepEqual(validateToolImage(inlineImage()), PNG);
  assert.deepEqual(validateToolImage({ data: PNG, mediaType: "image/png" }), PNG);
  for (const invalid of [
    { data: PNG_BASE64, mediaType: "image/svg+xml" },
    { data: PNG_BASE64, mediaType: "image/jpeg" },
    { data: `data:image/png;base64,${PNG_BASE64}`, mediaType: "image/png" },
    { data: PNG_BASE64 + "\n", mediaType: "image/png" },
    { data: "/tmp/screenshot.png", mediaType: "image/png" },
    { path: "/tmp/screenshot.png", mediaType: "image/png" },
    { data: "A".repeat(4_800_004), mediaType: "image/png" },
    { data: PNG.subarray(0, 30), mediaType: "image/png" },
  ]) assert.throws(() => validateToolImage(invalid));
  const hugeDimensions = Buffer.from(PNG);
  hugeDimensions.writeUInt32BE(100_000, 16);
  assert.throws(() => validateToolImage({ data: hugeDimensions, mediaType: "image/png" }), /dimensions/);
});

test("owned image diagnostics redact data URIs, raw/truncated pixels and paths even after scoped disposal", () => {
  const store = createToolImageStore();
  const image = store.add(inlineImage());
  const text = `Keep this description. URI data:image/png;base64,${PNG_BASE64} raw ${PNG_BASE64} partial ${PNG_BASE64.slice(0, 64)} path ${image.path} file file://${image.path}`;
  try {
    const live = redactOwnedToolImageText(text);
    assert.match(live, /Keep this description/);
    assert.doesNotMatch(live, /iVBORw0KGgo|hara-tool-images|data:image\/png/);
    store.dispose();
    const scoped = store.redactText(text);
    assert.match(scoped, /Keep this description/);
    assert.doesNotMatch(scoped, /iVBORw0KGgo|hara-tool-images|data:image\/png/);
  } finally { store.dispose(); }
});

test("registered tools scrub oversized media echoes before saving recoverable continuation pages", async () => {
  const store = createToolImageStore();
  let image;
  let storedPath;
  registerTool({
    name: "fixture_large_media_echo", description: "Synthetic oversized echo", kind: "read",
    input_schema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.attachToolImage(inlineImage());
      return `Useful continuation. URI data:image/png;base64,${PNG_BASE64} raw ${PNG_BASE64} path ${image.path}\n${"safe text ".repeat(5_000)}\nTail survives.`;
    },
  });
  try {
    const preview = await getTool("fixture_large_media_echo").run({}, {
      cwd: process.cwd(), attachToolImage(input) { image = store.add(input); },
    });
    const id = preview.match(/redacted chars stored as (tr_[a-f0-9]{32});/)?.[1];
    assert.ok(id, "the large useful text still has a recoverable continuation");
    assert.doesNotMatch(preview, /iVBORw0KGgo|data:image\/png|hara-tool-images/);
    storedPath = join(homedir(), ".hara", "tool-results", `${id}.txt`);
    const retained = readFileSync(storedPath, "utf8");
    assert.match(retained, /Useful continuation/);
    assert.match(retained, /Tail survives/);
    assert.doesNotMatch(retained, /iVBORw0KGgo|data:image\/png|hara-tool-images/);
  } finally {
    store.dispose();
    if (storedPath) unlinkSync(storedPath);
  }
});

test("only live engine receipts may be read; tampering and symlink substitution fail closed", () => {
  const unrelated = mkdtempSync(join(tmpdir(), "hara-tool-image-unrelated-"));
  const target = join(unrelated, "user-file.png");
  writeFileSync(target, PNG);
  const store = createToolImageStore();
  const image = store.add(inlineImage());
  const root = dirname(image.path);
  try {
    assert.equal(readToolImageToBase64({ path: target, mediaType: "image/png" }), null);
    assert.equal(readToolImageToBase64({ ...image, mediaType: "image/jpeg" }), null);
    writeFileSync(image.path, Buffer.from("changed"));
    assert.equal(readToolImageToBase64(image), null);
    unlinkSync(image.path);
    symlinkSync(target, image.path);
    assert.equal(readToolImageToBase64(image), null);
    store.dispose();
    assert.equal(existsSync(target), true, "cleanup never touches a substituted image's target");
    assert.equal(lstatSync(image.path).isSymbolicLink(), true, "cleanup preserves unowned entries");
  } finally {
    store.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(unrelated, { recursive: true, force: true });
  }
});

test("MCP preserves structured errors and extracts media without serializing base64 or embedded resource URIs", () => {
  const store = createToolImageStore();
  const images = [];
  let errors = 0;
  try {
    const text = collectMcpToolResult({
      isError: true,
      content: [
        { type: "text", text: "permission denied" },
        { type: "image", mimeType: "image/png", data: PNG_BASE64 },
        { type: "audio", data: "sensitive-audio-base64", mimeType: "audio/mpeg" },
        { type: "resource", resource: { uri: "file:///private/credential", blob: "sensitive-blob-base64" } },
      ],
    }, { cwd: process.cwd(), markToolError() { errors++; }, attachToolImage(image) { images.push(store.add(image)); } });
    assert.match(text, /^Error: MCP tool reported a failure/);
    assert.match(text, /permission denied/);
    assert.match(text, /image attached: image\/png/);
    assert.doesNotMatch(text, /iVBOR|sensitive-|credential|file:\/\//);
    assert.equal(errors, 1);
    assert.equal(images.length, 1);
    assert.equal(readToolImageToBase64(images[0]), PNG_BASE64);
  } finally { store.dispose(); }
});

test("MCP rejection and unsupported route are explicit, bounded, and never claim pixels were inspected", () => {
  const unavailable = collectMcpToolResult({ content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }] }, { cwd: process.cwd() });
  assert.match(unavailable, /no authorized tool image route; its pixels were not inspected/);
  let errors = 0;
  let attached = 0;
  const rejected = collectMcpToolResult({ content: [
    { type: "image", mimeType: "image/png", data: "file:///secret" },
    { type: "image", mimeType: "image/svg+xml", data: PNG_BASE64 },
    ...Array.from({ length: 7 }, () => ({ type: "image", mimeType: "image/png", data: PNG_BASE64 })),
    { type: "text", text: "x".repeat(140_000) },
  ] }, { cwd: process.cwd(), attachToolImage() { attached++; }, markToolError() { errors++; } });
  assert.match(rejected, /image rejected/);
  assert.match(rejected, /count limit exceeded/);
  assert.match(rejected, /text content truncated/);
  assert.doesNotMatch(rejected, /iVBOR|file:\/\/secret/);
  assert.ok(rejected.length < 130_000);
  assert.equal(attached, 2);
  assert.ok(errors >= 2);
});

test("provider converters send native image parts with complete tool-call relationships", () => {
  const store = createToolImageStore();
  try {
    const image = store.add(inlineImage());
    const conversation = history(image);
    const anthropic = toAnthropic(conversation);
    const toolResults = anthropic.at(-1).content;
    assert.deepEqual(toolResults.map((item) => item.tool_use_id), ["call-image", "call-text"]);
    assert.equal(toolResults[0].content[1].type, "image");
    assert.equal(toolResults[0].content[1].source.data, PNG_BASE64);
    const chat = toOpenAI("system", conversation);
    assert.deepEqual(chat.filter((item) => item.role === "tool").map((item) => item.tool_call_id), ["call-image", "call-text"]);
    assert.equal(chat.at(-2).role, "tool");
    assert.equal(chat.at(-1).role, "user");
    assert.match(chat.at(-1).content[0].text, /screenshot \(call call-image\)/);
    assert.equal(chat.at(-1).content[1].image_url.url, `data:image/png;base64,${PNG_BASE64}`);
    const responses = toResponsesInput(conversation);
    assert.deepEqual(responses.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["call-image", "call-text"]);
    assert.equal(responses.at(-2).type, "function_call_output");
    assert.equal(responses.at(-1).content[1].type, "input_image");
    assert.equal(responses.at(-1).content[1].image_url, `data:image/png;base64,${PNG_BASE64}`);
    assert.equal(conversation.at(-1).results[0].content, "captured", "serialization never mutates durable text");
  } finally { store.dispose(); }
});

test("text-only and forged/expired image converters explicitly report uninspected pixels", () => {
  const store = createToolImageStore();
  const image = store.add(inlineImage());
  try {
    for (const converted of [
      toAnthropic(history(image), false),
      toOpenAI("system", history(image), "none", false),
      toResponsesInput(history(image), false),
    ]) {
      const wire = JSON.stringify(converted);
      assert.match(wire, /does not accept images; its pixels were not inspected/);
      assert.doesNotMatch(wire, /iVBOR|image_url|input_image/);
    }
    const forged = { path: "/must/not/read.png", mediaType: "image/png" };
    for (const convert of [(h) => toAnthropic(h), (h) => toOpenAI("system", h), (h) => toResponsesInput(h)]) {
      assert.match(JSON.stringify(convert(history(forged))), /unavailable or no longer trusted/);
      store.dispose();
      assert.match(JSON.stringify(convert(history(image))), /unavailable or no longer trusted/);
    }
  } finally { store.dispose(); }
});

test("native tool-media capability follows the existing route capability and explicit host overrides", async () => {
  const key = "synthetic-test-key";
  assert.equal(createOpenAIProvider({ apiKey: key, model: "opaque-model" }).supportsToolImages, false);
  assert.equal(createResponsesProvider({ apiKey: key, model: "opaque-model" }).supportsToolImages, false);
  assert.equal(createOpenAIProvider({ apiKey: key, model: "gpt-4o" }).supportsToolImages, true);
  assert.equal(createResponsesProvider({ apiKey: key, model: "qwen3.7-max" }).supportsToolImages, false);
  assert.equal(createAnthropicProvider({ apiKey: key, model: "claude-test", supportsImages: false }).supportsToolImages, false);
  const target = {
    provider: "token-plan", apiKey: key, model: "qwen3.7-max",
    baseURL: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  };
  assert.equal((await createProviderForTarget(target)).supportsToolImages, false);
  assert.equal((await createProviderForTarget({ ...target, model: "qwen3.8-max" })).supportsToolImages, true);
  assert.equal((await createProviderForTarget({ ...target, model: "opaque-model" })).supportsToolImages, false);
  assert.equal((await createProviderForTarget({ ...target, model: "opaque-model" }, undefined, { supportsImages: true })).supportsToolImages, true);
  assert.equal(providerTurnRequirements(history({ path: "/not-read.png", mediaType: "image/png" }), []).imageInput, true);
});

test("provider transport requests carry image bytes as image blocks using an in-memory mock only", async () => {
  const store = createToolImageStore();
  try {
    const image = store.add(inlineImage());
    for (const transport of ["openai", "responses", "anthropic"]) {
      let body;
      const fetchMock = async (_url, init) => {
        body = JSON.parse(init.body);
        if (transport === "openai") return new Response(
          'data: {"choices":[{"delta":{"content":"observed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
        if (transport === "responses") return new Response(
          'event: response.completed\ndata: {"type":"response.completed","sequence_number":0,"response":{"id":"resp_test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
      };
      const options = { apiKey: "synthetic-test-key", model: "gpt-4o", supportsImages: true, fetch: fetchMock };
      const provider = transport === "openai" ? createOpenAIProvider(options)
        : transport === "responses" ? createResponsesProvider(options)
          : createAnthropicProvider({ ...options, model: "claude-test", reasoningEffort: "off" });
      const result = await provider.turn({ system: "test", history: history(image), tools: [], onText() {} });
      assert.notEqual(result.stop, "error", result.errorMsg);
      assert.ok(body);
      const parts = transport === "responses" ? body.input.at(-1).content
        : transport === "openai" ? body.messages.at(-1).content
          : body.messages.at(-1).content[0].content;
      assert.equal(parts[1].type, transport === "openai" ? "image_url" : transport === "responses" ? "input_image" : "image");
      assert.doesNotMatch(JSON.stringify(body), /hara-tool-images|snapshot\.png/);
    }
  } finally { store.dispose(); }
});
