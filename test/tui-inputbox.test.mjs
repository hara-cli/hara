import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../dist/tui/InputBox.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const cwd = process.cwd();
const S = { sessionName: "s", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };

test("InputBox: session in top border, modes in the ModeBar, usage in the bottom border", () => {
  const status = { sessionName: "refactor-auth", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };
  const { lastFrame, unmount } = render(React.createElement(InputBox, { status, cwd, width: 64 }));
  const frame = strip(lastFrame());
  assert.ok(frame.includes("⏺ refactor-auth"), "session name in top border");
  assert.ok(frame.includes("◆ suggest"), "active mode marked in the ModeBar");
  assert.ok(frame.includes("auto-edit") && frame.includes("full-auto"), "other modes listed");
  assert.ok(frame.includes("confirms edits"), "active-mode description shown");
  assert.ok(frame.includes("⛁ idle"), "idle concurrency in bottom border");
  assert.ok(frame.includes("›"), "prompt arrow");
  unmount();
});

test("InputBox highlights the active mode (auto-edit) + formats usage", () => {
  const status = { sessionName: "s", approval: "auto-edit", input: 1200, output: 340, ctxPct: 12, agents: 2 };
  const { lastFrame, unmount } = render(React.createElement(InputBox, { status, cwd, width: 72 }));
  const frame = strip(lastFrame());
  assert.ok(frame.includes("◆ auto-edit"), "auto-edit marked active");
  assert.ok(frame.includes("↑1.2k ↓340"), "token usage formatted");
  assert.ok(frame.includes("ctx 12%"), "context percent shown");
  assert.ok(frame.includes("⛁2"), "concurrent agents");
  unmount();
});

test("InputBox accepts typed text and submits on Enter", async () => {
  let submitted = null;
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd, onSubmit: (v) => (submitted = v) }));
  stdin.write("fix the null check");
  await tick();
  assert.ok(strip(lastFrame()).includes("fix the null check"), "typed text shows");
  stdin.write("\r");
  await tick();
  assert.equal(submitted, "fix the null check", "submitted on Enter");
  unmount();
});

test("InputBox backspace deletes before the cursor", async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd }));
  stdin.write("abcd");
  await tick();
  stdin.write(""); // DEL / backspace
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("abc") && !frame.includes("abcd"), "last char removed");
  unmount();
});

test("InputBox shows an @path popup with file matches", async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(InputBox, { status: S, cwd }));
  stdin.write("@src");
  await tick(120);
  const frame = strip(lastFrame());
  assert.ok(/src/.test(frame), "shows src path candidates");
  assert.ok(frame.includes("insert") || frame.includes("select"), "popup hint shown");
  unmount();
});

test("InputBox: Ctrl+V attaches a clipboard image as a chip (clean input), image-only submit", async () => {
  let submitted = null;
  const fakeImg = { path: "/tmp/shot.png", mediaType: "image/png" };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(InputBox, {
      status: S,
      cwd,
      onClipboardImage: () => fakeImg,
      onSubmit: (v, images) => (submitted = { v, images }),
    }),
  );
  stdin.write("\x16"); // Ctrl+V
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("🖼 image 1"), "image chip shown below the box");
  assert.ok(!frame.includes("[Image #1]"), "no inline placeholder token pollutes the input");
  stdin.write("\r"); // submit with no text — just the image
  await tick();
  assert.ok(submitted, "submitted on Enter even with empty text");
  assert.equal(submitted.v.trim(), "", "input text stays clean");
  assert.deepEqual(submitted.images, [fakeImg], "attachment passed to onSubmit");
  unmount();
});

test("InputBox: pasting/dragging an image file path attaches it as a chip, not literal text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-ib-"));
  const png = join(dir, "pic.png");
  writeFileSync(png, Buffer.from([1, 2, 3]));
  let submitted = null;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(InputBox, { status: S, cwd, onSubmit: (v, images) => (submitted = { v, images }) }),
  );
  stdin.write(png); // a dragged-in terminal emits the bare path
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("🖼 image 1"), "path became an attachment chip");
  assert.ok(!frame.includes(png), "raw path not inserted as literal text");
  stdin.write("\r");
  await tick();
  assert.deepEqual(submitted.images, [{ path: png, mediaType: "image/png" }], "attachment passed on submit");
  unmount();
});

test("InputBox: backspace on empty input removes the last image chip", async () => {
  const fakeImg = { path: "/tmp/a.png", mediaType: "image/png" };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(InputBox, { status: S, cwd, onClipboardImage: () => fakeImg }),
  );
  stdin.write("\x16"); // attach one
  await tick();
  assert.ok(strip(lastFrame()).includes("🖼 image 1"), "chip present");
  stdin.write("\x7f"); // backspace (DEL) on empty input
  await tick();
  assert.ok(!strip(lastFrame()).includes("🖼 image 1"), "chip removed");
  unmount();
});
