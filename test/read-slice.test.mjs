// read_file line slicing (long-file handling): cat -n numbering, offset/limit windows, continue hints,
// long-line truncation. The pure renderer is exported from builtin.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFileSlice } from "../dist/tools/builtin.js";

const file = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("small file: whole content, numbered, no slice header", () => {
  const out = renderFileSlice(file(3));
  assert.equal(out, `     1\tline 1\n     2\tline 2\n     3\tline 3`);
});

test("trailing newline doesn't produce a phantom empty last line", () => {
  assert.ok(!renderFileSlice(file(2)).includes("     3\t"));
  // but a file WITHOUT trailing newline keeps its last line
  assert.ok(renderFileSlice("a\nb").includes("     2\tb"));
});

test("long file: default window is 300 lines + a continue hint", () => {
  const out = renderFileSlice(file(500));
  assert.ok(out.startsWith("(lines 1–300 of 500 — continue with offset:301)\n"), out.slice(0, 60));
  assert.ok(out.includes("   300\tline 300"));
  assert.ok(!out.includes("line 301"), "nothing past the window");
});

test("offset/limit read a middle slice; final slice has no continue hint", () => {
  const mid = renderFileSlice(file(100), 41, 10);
  assert.ok(mid.startsWith("(lines 41–50 of 100 — continue with offset:51)\n"));
  assert.ok(mid.includes("    41\tline 41") && mid.includes("    50\tline 50"));
  const tail = renderFileSlice(file(100), 91, 10);
  assert.ok(tail.startsWith("(lines 91–100 of 100)\n"), "no continue hint at EOF");
});

test("offset past the end: friendly message with the real line count", () => {
  assert.equal(renderFileSlice(file(5), 99), "(file has 5 lines — offset 99 is past the end)");
});

test("very long lines are truncated with a char count", () => {
  const out = renderFileSlice("x".repeat(5000) + "\nshort\n");
  assert.ok(out.includes("…[+3000 chars]"), "5000-char line capped at 2000");
  assert.ok(out.includes("     2\tshort"));
});
