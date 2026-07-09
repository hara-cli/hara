// Tool-call assembly (the fix for the glm-5/qwen "stuck in a loop, args not passed" bug). The key case:
// non-empty arguments that don't parse = the model was CUT OFF mid tool-call (output-length limit on a
// big write_file) — must surface as an error, NOT be silently swallowed into {} (which loops forever).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleToolCalls } from "../dist/providers/openai.js";

test("valid JSON args → parsed input, no error", () => {
  const r = assembleToolCalls([{ id: "t1", name: "write_file", args: '{"path":"a.txt","content":"hi"}' }], "tool_calls");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.toolUses, [{ id: "t1", name: "write_file", input: { path: "a.txt", content: "hi" } }]);
});

test("empty args (a no-param tool call) → input {}, no error", () => {
  const r = assembleToolCalls([{ id: "t1", name: "list_files", args: "" }], "tool_calls");
  assert.equal(r.error, undefined);
  assert.deepEqual(r.toolUses[0].input, {});
});

test("TRUNCATED args (non-empty, unparseable) → error, NO tool run (breaks the loop)", () => {
  // e.g. write_file's content ran past max_tokens: the JSON is cut off.
  const r = assembleToolCalls([{ id: "t1", name: "write_file", args: '{"path":"hex.json","content":"{\\"1\\":' }], "length");
  assert.deepEqual(r.toolUses, [], "no tool is executed with truncated/empty args");
  assert.match(r.error, /output-length limit/);
  assert.match(r.error, /smaller parts/);
});

test("malformed args on a non-length finish → still an error (not a silent {})", () => {
  const r = assembleToolCalls([{ id: "t1", name: "bash", args: "not json at all" }], "stop");
  assert.deepEqual(r.toolUses, []);
  assert.match(r.error, /malformed tool-call arguments/);
});

test("entries missing id or name are dropped", () => {
  const r = assembleToolCalls([
    { id: "", name: "write_file", args: "{}" },
    { id: "t2", name: "", args: "{}" },
    { id: "t3", name: "bash", args: '{"command":"ls"}' },
  ], "tool_calls");
  assert.equal(r.toolUses.length, 1);
  assert.equal(r.toolUses[0].id, "t3");
});
