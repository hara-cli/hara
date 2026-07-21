import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaTypeFor, imagePathFromPaste, imageToBase64 } from "../dist/images.js";
import { toOpenAI } from "../dist/providers/openai.js";
import { toAnthropic } from "../dist/providers/anthropic.js";

const dir = mkdtempSync(join(tmpdir(), "hara-img-"));
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const png = join(dir, "shot.png");
writeFileSync(png, PNG_BYTES);
const txt = join(dir, "note.txt");
writeFileSync(txt, "hello");
const spaced = join(dir, "my pic.png");
writeFileSync(spaced, Buffer.from([1, 2, 3]));

test("mediaTypeFor maps extensions; null for non-images", () => {
  assert.equal(mediaTypeFor("a.png"), "image/png");
  assert.equal(mediaTypeFor("A.JPG"), "image/jpeg");
  assert.equal(mediaTypeFor("a.jpeg"), "image/jpeg");
  assert.equal(mediaTypeFor("a.webp"), "image/webp");
  assert.equal(mediaTypeFor("a.txt"), null);
  assert.equal(mediaTypeFor("noext"), null);
});

test("imagePathFromPaste: plain / quoted / file:// / escaped-space; rejects non-image, missing, multiline, prose", () => {
  assert.deepEqual(imagePathFromPaste(png), { path: png, mediaType: "image/png" });
  assert.deepEqual(imagePathFromPaste(`"${png}"`), { path: png, mediaType: "image/png" });
  assert.deepEqual(imagePathFromPaste(`'${png}'`), { path: png, mediaType: "image/png" });
  assert.deepEqual(imagePathFromPaste(`file://${png}`), { path: png, mediaType: "image/png" });
  assert.deepEqual(imagePathFromPaste(spaced.replace(" ", "\\ ")), { path: spaced, mediaType: "image/png" });
  assert.equal(imagePathFromPaste(txt), null); // exists but not an image extension
  assert.equal(imagePathFromPaste(join(dir, "nope.png")), null); // image ext but missing
  assert.equal(imagePathFromPaste(`${png}\nmore`), null); // multiline never a path
  assert.equal(imagePathFromPaste("just some typed text"), null);
});

test("imageToBase64 round-trips; null when missing", () => {
  assert.equal(imageToBase64(png), PNG_BYTES.toString("base64"));
  assert.equal(imageToBase64(join(dir, "missing.png")), null);
});

test("toAnthropic builds a base64 image block for a user turn carrying images", () => {
  const msgs = toAnthropic([{ role: "user", content: "what is this?", images: [{ path: png, mediaType: "image/png" }] }]);
  assert.equal(msgs.length, 1);
  const content = msgs[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");
  assert.equal(content[1].source.type, "base64");
  assert.equal(content[1].source.media_type, "image/png");
  assert.equal(content[1].source.data, PNG_BYTES.toString("base64"));
});

test("toAnthropic: plain user turn stays a string (no regression)", () => {
  const msgs = toAnthropic([{ role: "user", content: "hi" }]);
  assert.equal(msgs[0].content, "hi");
});

test("toOpenAI builds an image_url data URL part for a user turn carrying images", () => {
  const msgs = toOpenAI("sys", [{ role: "user", content: "see this", images: [{ path: png, mediaType: "image/png" }] }]);
  const user = msgs[1]; // msgs[0] is the system message
  assert.equal(user.role, "user");
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[0].type, "text");
  assert.equal(user.content[1].type, "image_url");
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/);
});

test("toOpenAI: plain user turn stays a string (no regression)", () => {
  const msgs = toOpenAI("sys", [{ role: "user", content: "hi" }]);
  assert.equal(msgs[1].content, "hi");
});

test("toOpenAI omits empty assistant history unless it carries tool calls", () => {
  const msgs = toOpenAI("sys", [
    { role: "user", content: "hi" },
    { role: "assistant", text: "   ", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ id: "call-1", name: "read_file", input: { path: "README.md" } }] },
  ]);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[2], {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call-1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    }],
  });
});
