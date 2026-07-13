// system-reminder injection (à la Claude Code's Ie1/WD5 event layer): event-driven context the model
// should see on its NEXT call, injected as ONE `<system-reminder>`-wrapped user message. It rides the
// provider history only — the UI transcript never renders it, so the user isn't bothered while the
// model stays synchronized with system state (todo staleness today; file-change/diagnostic events can
// plug in later via pushReminder).
//
// Claude Code's disclaimer is preserved: the model is told the context may be irrelevant, so an
// injected nudge never derails an unrelated task.

const DEFAULT_SCOPE = "default";
const queues = new Map<string, string[]>();

function scopeKey(scope?: string): string {
  return scope?.trim() || DEFAULT_SCOPE;
}

/** Queue a reminder for injection before the next model call (main loop only — quiet/sub-agent runs
 *  neither push nor drain, so a parallel fan-out can't steal the main conversation's reminders). */
export function pushReminder(text: string, scope?: string): void {
  const t = text.trim();
  if (!t) return;
  const key = scopeKey(scope);
  const queue = queues.get(key) ?? [];
  queue.push(t);
  queues.set(key, queue);
}

/** Take everything queued (FIFO), clearing the queue. */
export function drainReminders(scope?: string): string[] {
  const key = scopeKey(scope);
  const queue = queues.get(key);
  if (!queue?.length) return [];
  queues.delete(key);
  return queue;
}

/** Drop an ephemeral session's pending reminders without exposing them to another run. */
export function disposeReminderScope(scope: string): void {
  queues.delete(scopeKey(scope));
}

/** Merge queued reminders into the single injected message. */
export function wrapReminders(items: string[]): string {
  return (
    "<system-reminder>\n" +
    items.join("\n\n") +
    "\n\nThis context may or may not be relevant to your task — do not respond to it directly; ignore it unless it is relevant.\n" +
    "</system-reminder>"
  );
}

/** How many tool rounds a checklist may sit untouched (with unfinished items) before the model gets an
 *  attention refresh. Reset on every todo_write; re-arms after firing so it nags at most once per N. */
export const TODO_STALE_ROUNDS = 5;

/** Prefix for a message the user sent MID-TASK (type-ahead steering). Carries the triage contract
 *  inline (self-contained even for role-overridden runs): the model — not the engine — is the
 *  scheduler, and the todo list is the task queue (codex/Claude-Code's model too: neither ships an
 *  engine-level priority scheduler; classification is exactly what the LLM is best at). */
export const INTERJECT_PREFIX =
  "[Sent while you were working on the above — TRIAGE before continuing: " +
  "a refinement/correction of the current task → fold it in now; " +
  "a NEW independent task → todo_write it onto the queue, acknowledge in one line, continue the current task; " +
  "URGENT (a bug, \"stop\", \"this first\") → finish the current step safely (no half-done edits), " +
  "todo_write the re-plan (current task → pending, this → in_progress), and switch to it immediately.]";

/** Parallel fan-outs at/above this size get a synthesis nudge (CC's KN5 synthesizer, hara-shaped:
 *  instead of a dedicated merger agent, the MAIN model is reminded to merge before acting). */
export const SYNTHESIS_MIN_AGENTS = 3;

/** The synthesis nudge: N independent reports just landed — reconcile before acting. */
export function synthesisReminder(n: number): string {
  return (
    `You just received ${n} parallel agent reports. Before acting, SYNTHESIZE them into one coherent ` +
    "picture: reconcile overlaps and conflicts explicitly (say which report wins and why), note anything " +
    "only one report saw, and state the merged conclusion. Don't act on a single report in isolation."
  );
}

/** The staleness nudge: re-show the authoritative list + ask for a status pass. */
export function todoStaleReminder(renderedTodos: string): string {
  return (
    `Your todo list has not been updated in a while. Current state:\n\n${renderedTodos}\n\n` +
    "If you have completed or started items, update them with todo_write now (statuses drive the user's progress view). " +
    "If the list no longer matches the work, rewrite it."
  );
}
