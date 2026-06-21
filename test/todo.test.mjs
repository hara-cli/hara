import { test } from "node:test";
import assert from "node:assert/strict";
import "../dist/tools/todo.js"; // register the tool
import { getTools } from "../dist/tools/registry.js";
import { currentTodos, renderTodos } from "../dist/tools/todo.js";

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
