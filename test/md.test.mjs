import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, makeRenderer } from "../dist/md.js";

// In a non-TTY test env the color helper is identity, so we assert the structural transforms.
test("md: header/bold/bullet/inline-code transforms", () => {
  assert.equal(renderMarkdown("## Title"), "Title");
  assert.equal(renderMarkdown("a **b** c"), "a b c");
  assert.equal(renderMarkdown("- item"), "• item");
  assert.equal(renderMarkdown("* item"), "• item");
  assert.match(renderMarkdown("use `code` here"), /use code here/);
});

test("md: code fence content is verbatim", () => {
  const out = renderMarkdown("```js\nconst x = **not bold**;\n```");
  assert.match(out, /const x = \*\*not bold\*\*;/); // untouched inside a fence
});

test("md: streaming renderer flushes complete lines + tail", () => {
  let acc = "";
  const r = makeRenderer((s) => (acc += s));
  r.push("## H");
  assert.equal(acc, ""); // no newline yet → buffered
  r.push("i\nbody");
  assert.match(acc, /Hi\n/); // header line flushed on newline
  r.end();
  assert.match(acc, /body/); // tail flushed
});
