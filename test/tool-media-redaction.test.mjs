import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.HARA_TOOL_MEDIA_TEST_BUILD_ROOT;
const moduleUrl = (path) => buildRoot ? pathToFileURL(join(resolve(buildRoot), path)).href : new URL(`../dist/${path}`, import.meta.url).href;
const { registerToolMediaRedaction, removeToolMediaRedaction, toolMediaRedaction, redactOwnedToolImageValue } = await import(moduleUrl("security/tool-media-redaction.js"));
const pixels = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("deep media projection redacts nested strings, JSON escaping, object keys and values without mutating the input", () => {
  const path = '/private/tmp/capture "quoted" \\ image.png';
  const input = { nested: [{ pixels, path }], body: JSON.stringify({ pixels, path }), [path]: pixels };
  registerToolMediaRedaction("synthetic-redaction", toolMediaRedaction(pixels, path));
  try {
    const result = redactOwnedToolImageValue(input);
    assert.equal(result.redacted, true);
    assert.notStrictEqual(result.value, input);
    assert.equal(input.nested[0].pixels, pixels);
    assert.equal(input.nested[0].path, path);
    assert.doesNotMatch(JSON.stringify(result.value), /iVBORw0KGgo|capture|quoted|image\.png/);
    assert.match(JSON.stringify(result.value), /tool image (?:data|path) omitted/);
  } finally { removeToolMediaRedaction("synthetic-redaction"); }
});

test("clean opaque values keep original identity and do not get JSON-normalized", () => {
  const value = { type: "responses_reasoning", items: [{ encrypted_content: "ordinary-opaque-value", optional: undefined }] };
  registerToolMediaRedaction("synthetic-redaction", toolMediaRedaction(pixels, "/private/tmp/owned.png"));
  try {
    assert.deepEqual(redactOwnedToolImageValue(value), { value, redacted: false });
    assert.strictEqual(redactOwnedToolImageValue(value).value, value);
    assert.equal(Object.hasOwn(value.items[0], "optional"), true);
  } finally { removeToolMediaRedaction("synthetic-redaction"); }
});

test("without a live owner the helper does not change arbitrary data arguments", () => {
  const value = { data: `data:image/png;base64,${pixels}` };
  assert.strictEqual(redactOwnedToolImageValue(value).value, value);
  assert.equal(redactOwnedToolImageValue(value).redacted, false);
});
