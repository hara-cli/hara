import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installResizeRepaint } from "../dist/tui/run.js";

test("resize repaint clears before Ink only when terminal width changes", () => {
  class FakeOutput extends EventEmitter {
    columns = 104;
    rows = 48;
  }

  const out = new FakeOutput();
  const events = [];
  // runTui installs after render(), so Ink's resize listener already exists.
  out.on("resize", () => events.push("ink"));
  const remove = installResizeRepaint(out, { clear: () => events.push("clear") });

  out.rows = 40;
  out.emit("resize");
  assert.deepEqual(events, ["ink"], "height-only drag must not erase the idle prompt");

  events.length = 0;
  out.columns = 120;
  out.emit("resize");
  assert.deepEqual(events, ["clear", "ink"], "width clear must run before Ink's repaint");

  events.length = 0;
  out.emit("resize");
  assert.deepEqual(events, ["ink"], "duplicate resize at the same width does not clear");

  remove();
  events.length = 0;
  out.columns = 100;
  out.emit("resize");
  assert.deepEqual(events, ["ink"], "cleanup removes the companion listener");
});
