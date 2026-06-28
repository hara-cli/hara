import { test } from "node:test";
import assert from "node:assert/strict";
import "../dist/tools/todo.js"; // register the tool
import { getTools } from "../dist/tools/registry.js";
import { currentTodos, renderTodos, onTodosChange, clearTodos } from "../dist/tools/todo.js";
import { spinnerVerb } from "../dist/agent/loop.js";

const todoTool = () => getTools().find((t) => t.name === "todo_write");

test("todo_write registers as a read-kind tool", () => {
  const t = todoTool();
  assert.ok(t, "todo_write is registered");
  assert.equal(t.kind, "read"); // never prompts, parallel-safe
});

test("todo_write stores the list + renders a checklist with progress", async () => {
  const out = await todoTool().run(
    { todos: [
      { text: "set up", status: "done" },
      { text: "build it", status: "in_progress" },
      { text: "test", status: "pending" },
    ] },
    {},
  );
  assert.match(out, /1\/3 done/);
  assert.match(out, /☑ set up/);
  assert.match(out, /▶ build it/);
  assert.match(out, /☐ test/);
  assert.equal(currentTodos().length, 3);
});

test("todo_write sanitizes a bad status → pending and drops empty text", async () => {
  await todoTool().run({ todos: [{ text: "keep", status: "bogus" }, { text: "   ", status: "done" }] }, {});
  assert.equal(currentTodos().length, 1, "empty-text item dropped");
  assert.equal(currentTodos()[0].status, "pending", "bad status coerced to pending");
});

test("renderTodos: empty list reads as cleared", () => {
  assert.match(renderTodos([]), /cleared/);
});

test("todo_write: persists activeForm verbatim (drops the field when missing)", async () => {
  await todoTool().run(
    { todos: [
      { text: "Run tests", activeForm: "Running tests", status: "in_progress" },
      { text: "Build the project", status: "pending" }, // activeForm missing on purpose
    ] },
    {},
  );
  const list = currentTodos();
  assert.equal(list[0].activeForm, "Running tests");
  assert.equal(list[1].activeForm, undefined);
});

test("onTodosChange: subscriber fires on todo_write and unsubscribe stops it", async () => {
  let calls = 0;
  let lastLen = -1;
  const unsub = onTodosChange((list) => {
    calls++;
    lastLen = list.length;
  });
  await todoTool().run({ todos: [{ text: "one", status: "pending" }] }, {});
  await todoTool().run({ todos: [{ text: "one", status: "done" }, { text: "two", status: "pending" }] }, {});
  assert.equal(calls, 2);
  assert.equal(lastLen, 2);
  unsub();
  await todoTool().run({ todos: [{ text: "x", status: "pending" }] }, {});
  assert.equal(calls, 2, "no more callbacks after unsubscribe");
});

test("clearTodos: empties the list and emits", async () => {
  await todoTool().run({ todos: [{ text: "one", status: "pending" }] }, {});
  let fired = false;
  const unsub = onTodosChange((list) => {
    if (list.length === 0) fired = true;
  });
  clearTodos();
  assert.equal(currentTodos().length, 0);
  assert.equal(fired, true);
  unsub();
});

test("spinnerVerb: uses in_progress activeForm when present", () => {
  const list = [
    { text: "Run tests", activeForm: "Running tests", status: "done" },
    { text: "Build project", activeForm: "Building project", status: "in_progress" },
    { text: "Ship", status: "pending" },
  ];
  assert.equal(spinnerVerb(list, 7), "Building project… 7s");
});

test("spinnerVerb: falls back to text when activeForm missing on the in_progress item", () => {
  const list = [{ text: "Refactor module", status: "in_progress" }];
  assert.equal(spinnerVerb(list, 3), "Refactor module… 3s");
});

test("spinnerVerb: no in_progress → generic 'working' line", () => {
  assert.equal(spinnerVerb([], 0), "working 0s");
  assert.equal(spinnerVerb([{ text: "done thing", status: "done" }], 12), "working 12s");
});
