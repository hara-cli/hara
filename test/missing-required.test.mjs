// Defensive parameter gate — models can drop required tool parameters outright (observed:
// qwen3.7-plus sending write_file without path/content and retrying the same broken call forever).
// missingRequired names exactly what's absent so the loop rejects with a precise, actionable error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingRequired } from "../dist/tools/registry.js";

const tool = (required) => ({
  name: "t",
  description: "",
  input_schema: { type: "object", properties: {}, required },
  run: async () => "",
});

test("missingRequired: flags absent/null, tolerates empty string and extra keys", () => {
  const t = tool(["path", "content"]);
  assert.deepEqual(missingRequired(t, {}), ["path", "content"], "all missing");
  assert.deepEqual(missingRequired(t, { path: "a.txt" }), ["content"], "one missing");
  assert.deepEqual(missingRequired(t, { path: "a.txt", content: null }), ["content"], "null counts as missing");
  assert.deepEqual(missingRequired(t, { path: "a.txt", content: "" }), [], "empty string is a legitimate value");
  assert.deepEqual(missingRequired(t, { path: "a.txt", content: "x", extra: 1 }), [], "extras ignored");
  assert.deepEqual(missingRequired(t, undefined), ["path", "content"], "non-object input");
  assert.deepEqual(missingRequired(tool(undefined), {}), [], "no required list → nothing to flag");
});
