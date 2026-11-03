import { createHash } from "node:crypto";
import { answerQuestionObjective, conversationalAnswerObjective } from "./governance-c-lite.js";
import type { NeutralMsg, ToolResult } from "../providers/types.js";
import type { TaskExecution } from "../session/task.js";
import type { ToolEffect } from "../tools/registry.js";

/** Exact Workspace tools whose implementation only observes run-scoped state or safe project bytes.
 * A kind:read label alone is insufficient: channel_peer_wake, task state and external tools are excluded. */
export const READONLY_ANSWER_TOOLS = new Set([
  "agent_list", "workspace_read", "workspace_verify", "workspace_context_lookup",
  "workspace_memory_search", "workspace_receipt_read", "workspace_skill", "channel_sync",
]);
const REFERENCE = /receipt-([a-f0-9]{64})\.json/gu;
const CHANGE_WORD = /(?:创建|建立|新增|添加|写入|修改|编辑|删除|移除|重命名|发送|委派|安排|定时|执行|部署|安装|更新|保存|同步|推送|合并|生成|设置|关闭|开启|create|add|write|edit|change|delete|remove|rename|send|delegate|schedule|execute|deploy|install|update|save|sync|push|merge|generate|set up|turn on|turn off)/iu;

/** User-owned objective is a conservative second authority, never the model's brief alone. */
export function readOnlyAnswerObjective(objective: string): boolean {
  const value = objective.trim();
  return value.length > 0 && value.length <= 2000 && !CHANGE_WORD.test(value) && answerQuestionObjective(value);
}

interface Observation { id: string; name: string; digest: string }
export class ReadOnlyAnswerTrace {
  private readonly observed: Observation[] = [];
  private readonly neededReceipts = new Set<string>();
  private readonly resolvedReceipts = new Set<string>();
  private readonly pageEnds = new Map<string, number>();
  private unsafe = false;

  /** Inspect only the bounded model view and engine wake instructions; never trust model prose. */
  observeModelView(system: string, history: readonly NeutralMsg[]): void {
    // A resumed/compacted attempt cannot erase an earlier non-read call from this decision.
    if (history.some(row => row.role === "assistant" && row.toolUses.some(call =>
      call.name !== "task_intake" && !READONLY_ANSWER_TOOLS.has(call.name)))) this.unsafe = true;
    const visible = [system, ...history.map(row => row.role === "tool"
      ? row.results.map(result => result.content).join("\n") : row.role === "user" ? row.content : "")].join("\n");
    if (visible.includes("<workspace-compact-summary>")) this.unsafe = true;
    for (const match of visible.matchAll(REFERENCE)) {
      if (!this.resolvedReceipts.has(match[1]!)) this.neededReceipts.add(match[1]!);
    }
  }

  observe(name: string, id: string, effect: ToolEffect | undefined, result: ToolResult, denied: boolean): void {
    if (name === "task_intake") {
      if (denied || result.isError === true || result.content.startsWith("Error:")) this.unsafe = true;
      return;
    }
    if (!READONLY_ANSWER_TOOLS.has(name) || (effect !== "read" && effect !== "state")
      || denied || result.isError === true || result.content.startsWith("Error:")) {
      this.unsafe = true; return;
    }
    if (!id || id.length > 240 || this.observed.some(item => item.id === id)) { this.unsafe = true; return; }
    if (name === "workspace_receipt_read") {
      try {
        const page = JSON.parse(result.content) as { file?: unknown; offset?: unknown; nextOffset?: unknown; totalChars?: unknown; content?: unknown };
        const match = typeof page.file === "string" ? /^receipt-([a-f0-9]{64})\.json$/u.exec(page.file) : null;
        if (!match || !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.totalChars)
          || typeof page.content !== "string" || page.content.length > 1000
          || (page.nextOffset !== null && !Number.isSafeInteger(page.nextOffset))) throw new Error("invalid page");
        const key = match[1]!, offset = Number(page.offset), total = Number(page.totalChars);
        const end = offset + page.content.length;
        if (offset !== (this.pageEnds.get(key) ?? 0) || end > total
          || page.nextOffset !== (end < total ? end : null)) throw new Error("noncontiguous page");
        this.pageEnds.set(key, end);
        if (end === total) { this.resolvedReceipts.add(key); this.neededReceipts.delete(key); }
      } catch { this.unsafe = true; return; }
    }
    this.observed.push({ id, name, digest: createHash("sha256").update(result.content).digest("hex") });
  }

  evidence(task: TaskExecution | undefined, pendingInteraction: boolean, hasPendingSteering: boolean,
    incompleteTodo: boolean, conversation?: { answer: string; noTools: boolean }): string[] | null {
    if (!task || task.status !== "running" || task.brief?.intent !== "answer"
      || !readOnlyAnswerObjective(task.objective) || task.decisions?.length || task.steering?.length
      || task.checkpoint?.completion?.state === "awaiting_user"
      || pendingInteraction || hasPendingSteering || incompleteTodo || this.unsafe
      || this.neededReceipts.size || this.observed.length > 12) return null;
    // A working read receipt cannot turn a wholly redacted/punctuation-only reply into an answer.
    // Numeric fact answers remain valid; the narrower tool-free identity path still needs text.
    if (conversation && !/[\p{L}\p{N}]/u.test(conversation.answer)) return null;
    if (!this.observed.some(item => item.name !== "workspace_receipt_read" && item.name !== "workspace_skill")) {
      if (this.observed.length || !conversation?.noTools || !conversation.answer.trim() || !/\p{L}/u.test(conversation.answer) || !conversationalAnswerObjective(task.objective)) return null;
      // An all-redacted bearer or punctuation is not an answer and must never verify the task.
      return [`conversational-answer result_sha256=${createHash("sha256").update(conversation.answer).digest("hex")}`];
    }
    return this.observed.map(item => `${item.name} tool_call_id=${item.id} result_sha256=${item.digest}`);
  }
}
