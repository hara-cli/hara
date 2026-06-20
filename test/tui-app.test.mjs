import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../dist/tui/App.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 70) => new Promise((r) => setTimeout(r, ms));
const status = { sessionName: "demo", approval: "suggest", input: 0, output: 0, ctxPct: 0, agents: 0 };

test("App runs a turn: user line in, streamed assistant reply out, status bar pinned below", async () => {
  const onSubmit = async (line, h) => {
    h.sink.assistantDelta("Hello, ");
    h.sink.assistantDelta("world.");
    h.sink.usage(120, 24);
    await tick(200); // keep the live region visible long enough to sample
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("say hi");
  await tick();
  stdin.write("\r"); // submit → turn runs
  await tick(80); // sample mid-turn (within onSubmit's 200ms window)
  const mid = strip(lastFrame());
  assert.ok(mid.includes("Hello, world."), "streamed assistant text visible during the turn");
  assert.ok(mid.includes("⏺ demo"), "status bar stays pinned below the live output");
  await tick(200); // let the turn finish and commit
  unmount();
});

test("App header shows the vision routing line at init (describer display)", async () => {
  const header = { version: "9.9.9", model: "qwen:glm-5", cwd: "/x", vision: "glm-5 is text-only → images read by qwen3.7-plus" };
  const { lastFrame, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), header, onSubmit: async () => {} }),
  );
  await tick();
  const frame = strip(lastFrame());
  assert.ok(frame.includes("👁"), "vision indicator shown in the header");
  assert.ok(frame.includes("images read by qwen3.7-plus"), "describer routing shown at init");
  unmount();
});

test("App shows a tool-approval confirm and resolves on 'y'", async () => {
  let granted = null;
  const onSubmit = async (line, h) => {
    granted = await h.confirm("⚠ bash rm -rf build — run?");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("clean");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("rm -rf build"), "confirm question shown");
  assert.ok(strip(lastFrame()).includes("Type a task"), "input box stays visible during confirm (not hidden)");
  stdin.write("y");
  await tick(80);
  assert.equal(granted, true, "confirm resolved true on y");
  unmount();
});

test("App confirm is a selectable list: ↓ then Enter picks 'don't ask again' → always", async () => {
  let reply = null;
  const onSubmit = async (line, h) => {
    reply = await h.confirm("⚠ bash rm -rf build — run?");
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("clean");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("❯ Yes"), "Yes is selected by default");
  stdin.write("\x1b[B"); // ↓
  await tick();
  stdin.write("\r"); // Enter
  await tick(80);
  assert.equal(reply, "always", "↓ + Enter selects the don't-ask-again option");
  unmount();
});

test("App select (plan-proceed): ↓↓ + Enter picks the third option", async () => {
  let choice = null;
  const onSubmit = async (line, h) => {
    choice = await h.select("hara has a plan — proceed?", [
      { label: "Yes, and auto-apply edits", value: "auto-edit" },
      { label: "Yes, approve each edit", value: "suggest" },
      { label: "No, keep planning  (esc)", value: "no" },
    ]);
  };
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { initialStatus: status, model: "glm-5", cwd: process.cwd(), onSubmit }),
  );
  await tick();
  stdin.write("go");
  await tick();
  stdin.write("\r");
  await tick();
  assert.ok(strip(lastFrame()).includes("❯ Yes, and auto-apply edits"), "first option selected by default");
  stdin.write("\x1b[B");
  await tick();
  stdin.write("\x1b[B");
  await tick();
  stdin.write("\r");
  await tick(80);
  assert.equal(choice, "no", "↓↓ + Enter selects the third option");
  unmount();
});
