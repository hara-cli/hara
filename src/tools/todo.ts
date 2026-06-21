// todo_write — an inline task checklist the agent maintains during a turn (like codex's update_plan /
// Claude Code's TodoWrite). Keeps the model organized on multi-step work and shows the user live progress.
// In-memory, replace-whole-list semantics; kind:"read" so it never prompts and is safe to call freely.
import { registerTool } from "./registry.js";

export type TodoStatus = "pending" | "in_progress" | "done";
export interface Todo {
  text: string;
  status: TodoStatus;
}

let todos: Todo[] = [];
/** The current checklist (latest todo_write wins) — for a TUI/statusline to render. */
export function currentTodos(): Todo[] {
  return todos;
}

const MARK: Record<TodoStatus, string> = { pending: "☐", in_progress: "▶", done: "☑" };

export function renderTodos(list: Todo[]): string {
  if (!list.length) return "(todo list cleared)";
  const done = list.filter((t) => t.status === "done").length;
  return `Todos (${done}/${list.length} done):\n` + list.map((t) => `  ${MARK[t.status]} ${t.text}`).join("\n");
}

registerTool({
  name: "todo_write",
  description:
    "Maintain a short task checklist for the CURRENT work. Use it to plan a multi-step task up front, then " +
    "update it as you go: keep exactly one item 'in_progress', flip items to 'done' as you finish, add items " +
    "you discover. Pass the FULL list each call (it replaces the previous). Skip it for trivial one-step tasks.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "the full checklist, in order",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "the task, a short imperative phrase" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["todos"],
  },
  kind: "read", // pure state + display: never prompts, parallel-safe
  async run(input) {
    const raw = Array.isArray(input.todos) ? input.todos : [];
    todos = raw
      .map((t: { text?: unknown; status?: unknown }) => ({
        text: String(t?.text ?? "").trim(),
        status: (["pending", "in_progress", "done"].includes(t?.status as string) ? t!.status : "pending") as TodoStatus,
      }))
      .filter((t: Todo) => t.text);
    return renderTodos(todos);
  },
});
