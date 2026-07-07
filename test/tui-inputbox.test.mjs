import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox, wrapRows } from "../dist/tui/InputBox.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const cwd = process.cwd();
const S = { sessionName: "s", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };

test("InputBox: bordered prompt box, current mode colored in the footer, no always-on ModeBar", () => {
  const status = { sessionName: "refactor-auth", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };
  const { lastFrame, unmount } = render(React.createElement(InputBox, { status, cwd, model: "glm-5", width: 64 }));
  const frame = strip(lastFrame());
  // Rounded box chrome (replaces the old ⏺/dash top & bottom rules).
  assert.ok(frame.includes("╭") && frame.includes("╰"), "rounded box borders around the prompt");
  assert.ok(frame.includes("glm-5 · suggest"), "model · approval lead the footer line (the mode lives here now)");
  // The persistent ModeBar is gone (shift+tab pops it transiently instead) — by default: no ◆ picker,
  // no other-modes list, no description eating two rows under every frame.
  assert.ok(!frame.includes("◆ suggest"), "no always-on ModeBar picker by default");
  assert.ok(!frame.includes("full-auto"), "other modes not listed persistently");
  assert.ok(!frame.includes("confirms edits"), "no persistent mode description");
  assert.ok(frame.includes("›"), "prompt arrow");
  // ctx field is present from the very first frame (ctxPct 0) — no mid-session layout pop.
  assert.ok(frame.includes("ctx 0%"), "ctx field renders from 0% (always present, no layout shift)");
  unmount();
});

test("InputBox: active mode reads from the footer + usage is formatted", () => {
  const status = { sessionName: "s", approval: "auto-edit", input: 1200, output: 340, ctxPct: 12, agents: 2 };
  const { lastFrame, unmount } = render(React.createElement(InputBox, { status, cwd, model: "glm-5", route: "gw.nanhara.tech", width: 72 }));
  const frame = strip(lastFrame());
  assert.ok(frame.includes("glm-5 · auto-edit"), "active mode shown inline in the footer");
  assert.ok(frame.includes("↑1.2k ↓340"), "token usage formatted");
  assert.ok(frame.includes("ctx 12%"), "context percent shown");
  assert.ok(frame.includes("gw.nanhara.tech"), "route host in the footer when set");
  unmount();
});

test("InputBox: carries no working/mode chrome of its own (lives in App's constant status slot)", () => {
  const status = { sessionName: "s", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };
  const { lastFrame, unmount } = render(React.createElement(InputBox, { status, cwd, model: "glm-5", width: 72 }));
  const frame = strip(lastFrame());
  assert.ok(!frame.includes("⌨ working"), "no working-hint row inside the box chrome");
  assert.ok(!frame.includes("◆ suggest"), "no mode picker inside the box chrome");
  unmount();
});

test("InputBox accepts typed text and submits on Enter", async () => {
  let submitted = null;
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5", onSubmit: (v) => (submitted = v) }));
  stdin.write("fix the null check");
  await tick();
  assert.ok(strip(lastFrame()).includes("fix the null check"), "typed text shows");
  stdin.write("\r");
  await tick();
  assert.equal(submitted, "fix the null check", "submitted on Enter");
  unmount();
});

test("InputBox backspace deletes before the cursor", async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5" }));
  stdin.write("abcd");
  await tick();
  stdin.write(""); // DEL / backspace
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("abc") && !frame.includes("abcd"), "last char removed");
  unmount();
});

test("InputBox shows an @path popup with file matches", async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5" }));
  stdin.write("@src");
  await tick(120);
  const frame = strip(lastFrame());
  assert.ok(/src/.test(frame), "shows src path candidates");
  assert.ok(frame.includes("insert") || frame.includes("select"), "popup hint shown");
  unmount();
});

test("InputBox: Ctrl+V inserts a highlighted [Image #N] token inline + tracks the file", async () => {
  let submitted = null;
  const fakeImg = { path: "/tmp/shot.png", mediaType: "image/png" };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(InputBox, {
      status: S,
      cwd,
      model: "glm-5",
      onClipboardImage: () => fakeImg,
      onSubmit: (v, images) => (submitted = { v, images }),
    }),
  );
  stdin.write("look "); // type, then paste
  await tick();
  stdin.write("\x16"); // Ctrl+V
  await tick();
  assert.ok(strip(lastFrame()).includes("[Image #1]"), "inline token shown in the input");
  stdin.write("\r");
  await tick();
  assert.ok(submitted, "submitted");
  assert.ok(submitted.v.includes("[Image #1]"), "token carried inline in the text");
  assert.deepEqual(submitted.images, [fakeImg], "attachment passed to onSubmit");
  unmount();
});

test("InputBox: pasting an image file path inserts an inline token, not the raw path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ib-"));
  const png = join(dir, "pic.png");
  writeFileSync(png, Buffer.from([1, 2, 3]));
  let submitted = null;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(InputBox, { status: S, cwd, model: "glm-5", onSubmit: (v, images) => (submitted = { v, images }) }),
  );
  stdin.write(png); // a dragged-in terminal emits the bare path
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("[Image #1]"), "path became an inline token");
  assert.ok(!frame.includes(png), "raw path not inserted as literal text");
  stdin.write("\r");
  await tick();
  assert.deepEqual(submitted.images, [{ path: png, mediaType: "image/png" }], "attachment passed on submit");
  unmount();
});

// ── wrapRows: deterministic line-wrapping (drives the multi-line prompt + cursor placement) ──
// Rows must (a) cover the whole value with no gaps/overlap, (b) each fit within `cols`, (c) prefer
// breaking on spaces, (d) keep [Image #N] tokens whole, (e) leave a place for an end-of-line cursor.

const coversExactly = (rows, value, cols) => {
  assert.equal(rows[0].start, 0, "first row starts at 0");
  assert.equal(rows[rows.length - 1].end, value.length, "last row ends at value.length");
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].start, rows[i - 1].end, "rows are contiguous");
  for (const r of rows) assert.ok(r.end - r.start <= cols || /\[Image #\d+\]/.test(value.slice(r.start, r.end)), `row within ${cols} cols (or an atomic token)`);
};

test("wrapRows: short value stays on one row", () => {
  const rows = wrapRows("hello", 20);
  assert.equal(rows.length, 1);
  coversExactly(rows, "hello", 20);
});

test("wrapRows: wraps on a space boundary, not mid-word", () => {
  const v = "alpha beta gamma delta"; // 22 chars
  const rows = wrapRows(v, 12);
  coversExactly(rows, v, 12);
  assert.ok(rows.length >= 2, "wraps to multiple rows");
  // each row (except possibly the last) should not end mid-word — it ends on/after a space
  for (let i = 0; i < rows.length - 1; i++) {
    const rowText = v.slice(rows[i].start, rows[i].end);
    assert.ok(/\s$/.test(rowText) || rows[i].end === v.length, `row ${i} breaks on whitespace: ${JSON.stringify(rowText)}`);
  }
});

test("wrapRows: a word longer than the width hard-breaks (no infinite loop)", () => {
  const v = "x".repeat(25);
  const rows = wrapRows(v, 10);
  coversExactly(rows, v, 10);
  assert.equal(rows.length, 3, "25 chars over width 10 → 3 rows (10+10+5)");
});

test("wrapRows: exactly-full content gets an empty trailing row (so the end cursor has a home)", () => {
  const v = "0123456789"; // exactly width 10
  const rows = wrapRows(v, 10);
  coversExactly(rows, v, 10);
  const last = rows[rows.length - 1];
  assert.equal(last.start, v.length, "trailing empty row starts at end");
  assert.equal(last.end, v.length, "trailing empty row is zero-length");
});

test("wrapRows: an [Image #N] token is never split across rows", () => {
  const v = "look at [Image #1] closely";
  const rows = wrapRows(v, 12);
  coversExactly(rows, v, 12);
  const tokenStart = v.indexOf("[Image #1]");
  const tokenEnd = tokenStart + "[Image #1]".length;
  // no row boundary falls strictly inside the token
  for (const r of rows) {
    assert.ok(!(r.end > tokenStart && r.end < tokenEnd), "no row ends inside the token");
    assert.ok(!(r.start > tokenStart && r.start < tokenEnd), "no row starts inside the token");
  }
});

test("InputBox: long input wraps to multiple visual rows (doesn't render on a single overflowing line)", async () => {
  const long = "this is a fairly long prompt that should wrap across more than one visual row in a narrow box";
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5", width: 40 }));
  stdin.write(long);
  await tick(80);
  const frame = strip(lastFrame());
  // all words present
  assert.ok(frame.includes("fairly long prompt") && frame.includes("visual row"), "full text rendered");
  // the prompt region spans multiple lines — count lines that carry input words
  const inputLines = frame.split("\n").filter((l) => /this|prompt|wrap|visual|narrow/.test(l));
  assert.ok(inputLines.length >= 2, `long input occupies multiple rows (saw ${inputLines.length})`);
  unmount();
});

test("InputBox: backspace over an [Image #N] token removes the token and its attachment", async () => {
  const fakeImg = { path: "/tmp/a.png", mediaType: "image/png" };
  let submitted = null;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(InputBox, { status: S, cwd, model: "glm-5", onClipboardImage: () => fakeImg, onSubmit: (v, images) => (submitted = { v, images }) }),
  );
  stdin.write("\x16"); // attach → value is "[Image #1] "
  await tick();
  assert.ok(strip(lastFrame()).includes("[Image #1]"), "token present");
  stdin.write("\x7f"); // backspace over the token (+ its trailing space) removes it whole
  await tick();
  assert.ok(!strip(lastFrame()).includes("[Image #1]"), "token removed");
  stdin.write("hi");
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(submitted.images, undefined, "attachment removed with the token");
  unmount();
});

// ── Long-paste folding: big pastes become [Paste #N +L lines] tokens (never flood or auto-submit) ──

test("InputBox: a multi-line paste inserts as real multi-line text (visible, editable) — never auto-submits", async () => {
  let submitted = null;
  const big = Array.from({ length: 12 }, (_, i) => `paste line ${i + 1}`).join("\n");
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5", onSubmit: (v) => (submitted = v) }));
  stdin.write(big); // one chunk, 12 lines — the old path submitted "paste line 1"; now it inserts as text
  await tick();
  const frame = strip(lastFrame());
  assert.equal(submitted, null, "nothing auto-submitted on a pasted newline");
  assert.ok(frame.includes("paste line 1") && frame.includes("paste line 12"), "shown as real multi-line text, not a token");
  assert.equal(submitted, null, "nothing auto-submitted");
  stdin.write(" please summarize");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(submitted.includes("paste line 1") && submitted.includes("paste line 12"), "full multi-line text sent on Enter");
  assert.ok(submitted.includes("please summarize"), "typed text preserved after the paste");
  unmount();
});

test("InputBox: an ENORMOUS paste (>8000 chars) folds to a token; backspace removes it whole", async () => {
  let submitted = null;
  const huge = Array.from({ length: 300 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n"); // ~10k chars
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5", onSubmit: (v) => (submitted = v) }));
  stdin.write(huge);
  await tick();
  assert.ok(strip(lastFrame()).includes("[Paste #1 "), "an enormous dump folds to a token (safety valve)");
  stdin.write("\x7f"); // backspace → whole token gone
  await tick();
  assert.ok(!strip(lastFrame()).includes("[Paste #1"), "token removed whole");
  stdin.write("hi");
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(submitted, "hi", "no stale paste text leaked into the submission");
  unmount();
});

test("InputBox: a SHORT multi-line paste (1-2 newlines, <600 chars) folds — does NOT auto-submit (the bug)", async () => {
  let submitted = null;
  const short = "第一行\n第二行"; // 1 newline, well under 600 chars — the old path submitted "第一行" here
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5", onSubmit: (v) => (submitted = v) }));
  stdin.write(short);
  await tick();
  assert.equal(submitted, null, "a pasted newline no longer sends the message");
  const f = strip(lastFrame());
  assert.ok(f.includes("第一行") && f.includes("第二行"), "shown as real multi-line text (not a token)");
  assert.ok(!f.includes("[Paste"), "no fold token for a normal multi-line paste");
  stdin.write("\r"); // NOW a real Enter sends
  await tick();
  assert.ok(submitted && submitted.includes("第一行") && submitted.includes("第二行"), "Enter sends the full expanded text");
  unmount();
});

test("InputBox: a lone newline in the input stream = Enter (submits the current value)", async () => {
  let submitted = null;
  const { stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, model: "glm-5", onSubmit: (v) => (submitted = v) }));
  stdin.write("hello");
  await tick();
  stdin.write("\r"); // some terminals deliver Enter via the input string, not key.return
  await tick();
  assert.equal(submitted, "hello", "lone newline still submits");
  unmount();
});
