import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSessionMarkdown } from "../dist/export.js";

const data = {
  meta: { id: "abc12345", cwd: "/p", provider: "qwen", model: "glm-5", title: "fix the bug", createdAt: "2026-06-22T00:00:00Z", updatedAt: "2026-06-22T01:00:00Z" },
  history: [
    { role: "user", content: "fix the null check in foo.ts" },
    { role: "assistant", text: "I'll read it.", toolUses: [{ id: "t1", name: "read_file", input: { path: "foo.ts" } }] },
    { role: "tool", results: [{ id: "t1", name: "read_file", content: "line1\nline2", isError: false }] },
    { role: "assistant", text: "Fixed.", toolUses: [] },
  ],
};

test("renderSessionMarkdown: header + you/hara turns + tool-use + collapsible result", () => {
  const md = renderSessionMarkdown(data);
  assert.match(md, /# fix the bug/);
  assert.match(md, /\*\*model\*\* qwen:glm-5/);
  assert.match(md, /## 🧑 You\n\nfix the null check in foo\.ts/);
  assert.match(md, /## 🤖 hara/);
  assert.match(md, /🔧 `read_file`/);
  assert.match(md, /<details><summary>↳ read_file<\/summary>/);
  assert.match(md, /line1\nline2/);
  assert.match(md, /Fixed\./);
});

test("renderSessionMarkdown: empty title → id; error result is marked; empty content skipped", () => {
  const md = renderSessionMarkdown({
    meta: { id: "xyz789", cwd: ".", provider: "p", model: "m", title: "", createdAt: "t", updatedAt: "t" },
    history: [
      { role: "user", content: "   " }, // blank → no You block
      { role: "tool", results: [{ id: "e", name: "bash", content: "boom", isError: true }] },
    ],
  });
  assert.match(md, /# xyz789/, "falls back to the id when untitled");
  assert.match(md, /↳ bash \(error\)/);
  assert.ok(!/## 🧑 You/.test(md), "a blank user message produces no You block");
});
