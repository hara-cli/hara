import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantTextSanitizer, sanitizeAssistantText } from "../dist/agent/assistant-text.js";

test("assistant text sanitizer removes orphan reasoning tags split across stream chunks", () => {
  const sanitizer = new AssistantTextSanitizer();
  const output = [
    sanitizer.push("第一段\n</thi"),
    sanitizer.push("nk>\n最终答案"),
    sanitizer.finish(),
  ].join("");

  assert.equal(output, "第一段\n\n最终答案");
  assert.equal(sanitizer.text, output);
  assert.doesNotMatch(output, /think/i);
});

test("assistant text sanitizer suppresses complete private blocks, including nested and split tags", () => {
  const sanitizer = new AssistantTextSanitizer();
  const output = [
    sanitizer.push("<thi"),
    sanitizer.push("nk>private one\n<thinking>private two</thinking>"),
    sanitizer.push("</think>公开答案"),
    sanitizer.finish(),
  ].join("");

  assert.equal(output, "公开答案");
  assert.doesNotMatch(output, /private|think/i);
});

test("assistant text sanitizer removes repeated orphan closing tags after a private block", () => {
  assert.equal(
    sanitizeAssistantText("<think>private</think></think>\n</thinking>\n公开答案"),
    "\n\n公开答案",
  );
});

test("assistant text sanitizer preserves inline documentation and drops a truncated boundary tag", () => {
  assert.equal(
    sanitizeAssistantText("Use `<think>` literally in this inline example."),
    "Use `<think>` literally in this inline example.",
  );
  assert.equal(sanitizeAssistantText("answer\n</think"), "answer\n");
});
