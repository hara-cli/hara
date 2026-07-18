// todo_write — an inline task checklist the agent maintains during a turn (like codex's update_plan /
// Claude Code's TodoWrite). Keeps the model organized on multi-step work and shows the user live progress.
// In-memory, replace-whole-list semantics; approval-safe but serialized because it mutates shared run state.
import { registerTool } from "./registry.js";

export type TodoStatus = "pending" | "in_progress" | "done";
export interface Todo {
  text: string;
  status: TodoStatus;
  /** Present-continuous verb phrase shown while this item is in_progress (e.g. "updating tests").
   *  Optional — the model is asked to provide it; if missing, the UI/spinner falls back to `text`. */
  activeForm?: string;
  /** Items (by text) that must be done before this one can start — soft ordering hint, not enforced. */
  blockedBy?: string[];
  /** Who's on it, when work is delegated (a role/agent name) — display + handoff hint. */
  owner?: string;
}

const DEFAULT_SCOPE = "default";
const stores = new Map<string, Todo[]>([[DEFAULT_SCOPE, []]]);

function scopeKey(scope?: string): string {
  return scope?.trim() || DEFAULT_SCOPE;
}

function scopedTodos(scope?: string): Todo[] {
  return stores.get(scopeKey(scope)) ?? [];
}

/** Snapshot for persistence (session meta) — a defensive copy. */
export function serializeTodos(scope?: string): Todo[] {
  return scopedTodos(scope).map((t) => ({ ...t, ...(t.blockedBy ? { blockedBy: [...t.blockedBy] } : {}) }));
}

/** Restore a persisted checklist (session resume) — replaces the selected run's list and notifies its UI. */
export function restoreTodos(list: Todo[] | undefined, scope?: string): void {
  const key = scopeKey(scope);
  const next = (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .map((t) => ({
      text: t.text,
      status: (["pending", "in_progress", "done"].includes(t.status) ? t.status : "pending") as TodoStatus,
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
      ...(Array.isArray(t.blockedBy) && t.blockedBy.length ? { blockedBy: t.blockedBy.map(String) } : {}),
      ...(t.owner ? { owner: t.owner } : {}),
    }));
  stores.set(key, next);
  emit(key);
}

/** The current checklist (latest todo_write wins) — for a TUI/statusline to render. */
export function currentTodos(scope?: string): Todo[] {
  return scopedTodos(scope);
}

// Tiny pub/sub so the TUI can re-render reactively when the agent updates the list (instead of polling).
type Listener = (list: Todo[]) => void;
const listeners = new Map<string, Set<Listener>>();
/** Subscribe to checklist changes. Returns an unsubscribe fn. */
export function onTodosChange(fn: Listener, scope?: string): () => void {
  const key = scopeKey(scope);
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(fn);
  listeners.set(key, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(key);
  };
}
function emit(scope: string): void {
  const list = scopedTodos(scope);
  for (const fn of listeners.get(scope) ?? []) {
    try {
      fn(list);
    } catch {
      /* listeners must not break the tool */
    }
  }
}
/** Reset between sessions/turns if a runner wants a clean slate (not used by the tool itself). */
export function clearTodos(scope?: string): void {
  const key = scopeKey(scope);
  stores.set(key, []);
  emit(key);
}

/** Drop an ephemeral run's state entirely (used by completed sub-agents and deleted serve sessions). */
export function disposeTodoScope(scope: string): void {
  const key = scopeKey(scope);
  if (key === DEFAULT_SCOPE) {
    clearTodos();
    return;
  }
  stores.delete(key);
  listeners.delete(key);
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
            blockedBy: { type: "array", items: { type: "string" }, description: "texts of items that must finish first (optional ordering hint)" },
            owner: { type: "string", description: "who's on it when delegated (role/agent name) — optional" },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["todos"],
  },
  kind: "read", // state/display only: never prompts; input-level traits keep replacement writes serial
  classify: () => ({ effect: "state", concurrencySafe: false }),
  async run(input, ctx) {
    const scope = scopeKey(ctx.todoScope);
    const raw = Array.isArray(input.todos) ? input.todos : [];
    const todos = raw
      .map((t: { text?: unknown; status?: unknown; activeForm?: unknown; blockedBy?: unknown; owner?: unknown }) => {
        const text = String(t?.text ?? "").trim();
        const status = (["pending", "in_progress", "done"].includes(t?.status as string) ? t!.status : "pending") as TodoStatus;
        const activeFormRaw = typeof t?.activeForm === "string" ? t.activeForm.trim() : "";
        const item: Todo = { text, status };
        if (activeFormRaw) item.activeForm = activeFormRaw;
        if (Array.isArray(t?.blockedBy) && t.blockedBy.length) item.blockedBy = t.blockedBy.map(String);
        if (typeof t?.owner === "string" && t.owner.trim()) item.owner = t.owner.trim();
        return item;
      })
      .filter((t: Todo) => t.text);
    stores.set(scope, todos);
    emit(scope);
    return renderTodos(todos);
  },
});
