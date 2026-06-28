// todo_write — an inline task checklist the agent maintains during a turn (like codex's update_plan /
// Claude Code's TodoWrite). Keeps the model organized on multi-step work and shows the user live progress.
// In-memory, replace-whole-list semantics; kind:"read" so it never prompts and is safe to call freely.
import { registerTool } from "./registry.js";

export type TodoStatus = "pending" | "in_progress" | "done";
export interface Todo {
  text: string;
  status: TodoStatus;
  /** Present-continuous verb phrase shown while this item is in_progress (e.g. "updating tests").
   *  Optional — the model is asked to provide it; if missing, the UI/spinner falls back to `text`. */
  activeForm?: string;
}

let todos: Todo[] = [];
/** The current checklist (latest todo_write wins) — for a TUI/statusline to render. */
export function currentTodos(): Todo[] {
  return todos;
}

// Tiny pub/sub so the TUI can re-render reactively when the agent updates the list (instead of polling).
type Listener = (list: Todo[]) => void;
const listeners = new Set<Listener>();
/** Subscribe to checklist changes. Returns an unsubscribe fn. */
export function onTodosChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function emit(): void {
  for (const fn of listeners) {
    try {
      fn(todos);
    } catch {
      /* listeners must not break the tool */
    }
  }
}
/** Reset between sessions/turns if a runner wants a clean slate (not used by the tool itself). */
export function clearTodos(): void {
  todos = [];
  emit();
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
    "Maintain a short task checklist for the CURRENT work. Pass the FULL list each call (it replaces the previous). " +
    "Each item has `text` (imperative, e.g. 'Run tests') AND `activeForm` (present-continuous, e.g. 'Running tests') — " +
    "the UI shows activeForm while the item is in_progress. Exactly ONE item should be in_progress at a time; flip " +
    "items to 'done' as you finish; add items you discover. " +
    "\n\n## Use this tool when" +
    "\n  - the task takes 3+ distinct steps (refactor across files, new feature, multi-file fix, migrations)" +
    "\n  - the user gave you a numbered/comma-separated list of things to do" +
    "\n  - you discover mid-work that scope grew past a single edit" +
    "\n  - the user explicitly asks for a plan/checklist" +
    "\n\n## Skip this tool when" +
    "\n  - reading one file or answering one question" +
    "\n  - running one shell command and reporting output" +
    "\n  - a single straight-line edit to one location" +
    "\n  - pure conversation / explanation" +
    "\n\n## Examples — use it" +
    "\n  user: \"add a dark-mode toggle and run tests\" → 4-5 items (component, state, styles, tests)" +
    "\n  user: \"rename getCwd to getCurrentWorkingDirectory across the project\" → one item per file after grepping" +
    "\n  user: \"implement registration, catalog, cart, checkout\" → break each feature into 2-3 sub-items" +
    "\n  user: \"optimize this slow React app\" → one item per identified bottleneck" +
    "\n\n## Examples — skip it" +
    "\n  user: \"how do I print 'hello' in python?\" → answer directly" +
    "\n  user: \"what does git status do?\" → explain" +
    "\n  user: \"add a comment to calculateTotal\" → one edit, no plan needed" +
    "\n  user: \"run npm install\" → one exec, report output" +
    "\n\n## After updating the list" +
    "\nBriefly say what changed in one short line (e.g. \"marked 2 done, starting on tests\"); do NOT repeat the full " +
    "checklist back to the user — the UI already renders it live.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "the full checklist, in order",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "the task, a short imperative phrase (e.g. 'Run tests')" },
            activeForm: {
              type: "string",
              description: "present-continuous form shown while in_progress (e.g. 'Running tests'). Always provide.",
            },
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
      .map((t: { text?: unknown; status?: unknown; activeForm?: unknown }) => {
        const text = String(t?.text ?? "").trim();
        const status = (["pending", "in_progress", "done"].includes(t?.status as string) ? t!.status : "pending") as TodoStatus;
        const activeFormRaw = typeof t?.activeForm === "string" ? t.activeForm.trim() : "";
        const item: Todo = { text, status };
        if (activeFormRaw) item.activeForm = activeFormRaw;
        return item;
      })
      .filter((t: Todo) => t.text);
    emit();
    return renderTodos(todos);
  },
});
