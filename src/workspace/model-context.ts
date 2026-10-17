import type { NeutralMsg, ToolResult } from "../providers/types.js";
import type { TaskExecution } from "../session/task.js";
import { closedWorkspaceHistory } from "./conversations.js";
import { historyChars } from "../agent/context-budget.js";

export const WORKSPACE_CONTEXT_LIMITS = Object.freeze({ toolChars: 8000, agedToolChars: 2000, briefChars: 2000,
  wakeChars: 8000, wakeItemChars: 1600, summaryChars: 2000, compactAt: 0.72, recentShare: 0.18 });
export interface WorkspaceContextStats { compacted: boolean; originalChars: number; recentChars: number; summaryChars: number;
  toolMaxChars: number; agedToolMaxChars: number }
type Retain = (result: ToolResult) => string;
export function boundWorkspaceText(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = " …[bounded preview; consult retained full receipt]… ";
  if (max <= marker.length + 2) return text.slice(0, Math.max(0, max));
  const room = max - marker.length;
  let head = Math.floor(room * 0.8), tail = room - head;
  if (/[\uD800-\uDBFF]/.test(text[head - 1] ?? "")) head--;
  if (/[\uDC00-\uDFFF]/.test(text[text.length - tail] ?? "")) tail--;
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}
export function workspaceWakeBrief(task: Pick<TaskExecution, "objective" | "brief" | "checkpoint" | "decisions">, retain?: Retain): string {
  const values = [task.objective, task.brief ?? null, task.checkpoint ?? null, task.decisions ?? []];
  const reference = values.some(value => JSON.stringify(value).length > WORKSPACE_CONTEXT_LIMITS.wakeItemChars)
    ? retain?.({ id: "task-context", name: "task_context", content: JSON.stringify(values) }) : undefined;
  const items = values.map((value, i) => `${["Objective", "Accepted brief", "Checkpoint hint", "Retained human decisions"][i]}: ${boundWorkspaceText(JSON.stringify(value), WORKSPACE_CONTEXT_LIMITS.wakeItemChars)}`);
  return "# Understanding → execution boundary\n"
    + "Before side effects accept task_intake with intent/goal/constraints/acceptance/steps; combine it with the first action when known. Keep read-only requests read-only. The accepted brief is binding; changed scope needs new intake.\n"
    + "Keep checkpoints concise. Finish in one dedicated task_checkpoint response (optionally todo_write), with completion.state verified, one check per acceptance index, actual observed tool_call_ids, and final_answer. Awaiting_user requires a typed evidenced human-only dependency. A preview/cache/old receipt is not fresh proof; re-observe state after recovery. Never repeat side effects to repair citations.\n"
    + items.join("\n") + (reference ? `\nFull task data: ${reference}; page its id with workspace_receipt_read. Omitted text does not remove a constraint or grant authority.` : "");
}
function resultPreview(result: ToolResult, cap: number, retain?: Retain): string {
  const error = result.isError || result.content.startsWith("Error:");
  if (!error && result.content.length <= cap) return result.content;
  const file = retain?.(result), reference = file ? ` Full receipt: ${file}; use workspace_receipt_read.` : " Full output remains in the durable transcript.";
  if (error) return `Error receipt ${result.name}/${result.id}: ${result.content.replace(/[\r\n\t]+/g, " ").slice(0, 180)}.${reference}`;
  const head = cap === WORKSPACE_CONTEXT_LIMITS.toolChars ? 4000 : 1400, tail = cap === WORKSPACE_CONTEXT_LIMITS.toolChars ? 1000 : 200;
  return result.content.slice(0, head) + `\n[bounded ${result.content.length}-character output;${reference}]\n` + result.content.slice(-tail);
}

/** A request view, NOT another transcript or a completion-evidence source. The Host pins an
 * attempt boundary before appending its user message. Identity/roster remain in the stable system
 * tier, the current task/checkpoint in the engine turn tier, and only this attempt's working
 * messages travel here. On recovery the checkpoint is a hint: state must be observed again.
 * Never strip provider-owned reasoning from a retained tool chain or split use/result pairs. */
export function workspaceTaskProjection(history: NeutralMsg[], start: number, options: {
  usedTokens?: number; maxTokens?: number; task?: TaskExecution; retain?: Retain;
} = {}): { history: NeutralMsg[]; stats: WorkspaceContextStats } {
  if (!Number.isSafeInteger(start) || start < 0 || start >= history.length || history[start]?.role !== "user") {
    throw new Error("Workspace model context boundary changed; full history retained");
  }
  const current = history.slice(start);
  if (closedWorkspaceHistory(current).length !== current.length) throw new Error("Workspace model context contains an open tool batch");
  const tools = current.flatMap((message, index) => message.role === "tool" ? [index] : []);
  const fullResults = new Map<ToolResult, ToolResult>();
  const snapshot = structuredClone(current).map((message, index): NeutralMsg => message.role !== "tool" ? message : {
    ...message, results: message.results.map(result => {
      const preview = { ...result, content: resultPreview(result,
        index <= (tools.at(-3) ?? -1) ? WORKSPACE_CONTEXT_LIMITS.agedToolChars : WORKSPACE_CONTEXT_LIMITS.toolChars, options.retain) };
      fullResults.set(preview, result); return preview;
    }) });
  const originalChars = historyChars(snapshot), compacted = !!options.maxTokens && Number(options.usedTokens) >= options.maxTokens! * WORKSPACE_CONTEXT_LIMITS.compactAt;
  let view = snapshot, summaryChars = 0, recentChars = originalChars;
  if (compacted && snapshot.length > 3) {
    // Keep whole tool-use/result units; retained provider-owned continuation stays byte-for-byte exact.
    const units: NeutralMsg[][] = [];
    for (let i = 0; i < snapshot.length; i++) { const message = snapshot[i]!;
      units.push(message.role === "assistant" && message.toolUses.length ? [message, snapshot[++i]!] : [message]); }
    const recent: NeutralMsg[][] = []; let chars = 0;
    while (units.length && chars < originalChars * WORKSPACE_CONTEXT_LIMITS.recentShare) { const unit = units.pop()!; recent.unshift(unit); chars += historyChars(unit); }
    if (units.length) {
      const dropped = units.flat(), receipts = dropped.flatMap(message => message.role === "tool" ? message.results : []);
      const lines = receipts.slice(-6).map(result => `${result.isError ? "error" : "observation"}: ${result.name}/${result.id}; ${options.retain?.(fullResults.get(result) ?? result) ?? "full transcript retained"}`);
      const summary = boundWorkspaceText("<workspace-compact-summary>\nReference only; completion still requires the run-local evidence ledger.\n"
        + `Goal: ${(options.task?.brief?.goal ?? options.task?.objective ?? "Continue the frozen task").slice(0, 400)}\n`
        + `Next: ${(options.task?.checkpoint?.nextStep ?? "Use the current task checkpoint; verify before closing").slice(0, 180)}\n`
        + lines.join("\n") + "\n</workspace-compact-summary>", WORKSPACE_CONTEXT_LIMITS.summaryChars);
      view = [{ role: "user", content: summary }, ...recent.flat()]; summaryChars = summary.length; recentChars = chars;
    }
  }
  const projectedTools = view.flatMap(message => message.role === "tool" ? [message] : []);
  return { history: view, stats: { compacted: summaryChars > 0, originalChars, recentChars, summaryChars,
    toolMaxChars: Math.max(0, ...projectedTools.flatMap(message => message.results.map(result => result.content.length))),
    agedToolMaxChars: Math.max(0, ...projectedTools.slice(0, -2).flatMap(message => message.results.map(result => result.content.length))) } };
}
export function workspaceTaskHistory(history: NeutralMsg[], start: number): NeutralMsg[] { return workspaceTaskProjection(history, start).history; }
