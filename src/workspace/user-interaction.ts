import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../security/secrets.js";
import { scanMemory } from "../memory/guard.js";
import { exact, plain, text, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceRunBinding } from "./run-binding.js";
import type { WorkspaceUsage } from "./conversations.js";

export type WorkspaceQuestionReason = "lookup_missing" | "lookup_ambiguous" | "tool_problem" | "budget_warning" | "explicit";
export interface WorkspaceUserQuestion {
  id: string; reason: WorkspaceQuestionReason; question: string; options: string[];
  taskId: string; runId: string;
}
interface State {
  revision: number; resourceBinding: WorkspaceResourceBinding; runId: string;
  prepared: boolean; answeredQuestionIds: string[]; dismissed: boolean; referenceAcknowledged: boolean; misses: number; failures: number; budgetAcknowledged: boolean;
  question: WorkspaceUserQuestion | null;
}
const LOOKUPS = new Set(["workspace_context_lookup", "workspace_memory_search", "agent_list"]);
const REASONS = ["lookup_missing", "lookup_ambiguous", "tool_problem", "budget_warning", "explicit"];
function safe(value: string, cap: number): string {
  const result = redactSensitiveText(value).text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, cap);
  return scanMemory(result).ok ? result : "Please clarify the missing context.";
}

/** A run-bound gate, independent of model instructions. The caller owns the session lease; the JSON
 * store adds cross-process CAS/identity checks. Only a real answer clears unresolved lookup counts. */
export class WorkspaceUserInteraction {
  private readonly state: WorkspaceJsonState<State>;
  private lookupBatch = false;
  constructor(storage: WorkspaceResourceStorage, private readonly binding: Readonly<WorkspaceRunBinding>,
    private readonly taskId: string, private readonly chinese: boolean) {
    this.state = new WorkspaceJsonState(storage, `interaction-${binding.runId}.json`, value => {
      if (!plain(value) || !exact(value, ["revision", "resourceBinding", "runId", "prepared", "answeredQuestionIds", "dismissed", "referenceAcknowledged", "misses", "failures", "budgetAcknowledged", "question"])
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || value.runId !== binding.runId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.answeredQuestionIds) || value.answeredQuestionIds.length > 64
        || !value.answeredQuestionIds.every(id => typeof id === "string" && UUID.test(id))
        || new Set(value.answeredQuestionIds).size !== value.answeredQuestionIds.length
        || typeof value.dismissed !== "boolean" || typeof value.prepared !== "boolean" || typeof value.referenceAcknowledged !== "boolean" || typeof value.budgetAcknowledged !== "boolean"
        || !Number.isSafeInteger(value.misses) || Number(value.misses) < 0 || Number(value.misses) > 2
        || !Number.isSafeInteger(value.failures) || Number(value.failures) < 0 || Number(value.failures) > 2) throw new Error("invalid Workspace interaction state; execution refused");
      const q = value.question;
      if (q !== null && (!plain(q) || !exact(q, ["id", "reason", "question", "options", "taskId", "runId"])
        || typeof q.id !== "string" || !UUID.test(q.id) || !REASONS.includes(String(q.reason)) || !text(q.question, 800)
        || q.taskId !== taskId || q.runId !== binding.runId || !Array.isArray(q.options) || q.options.length > 8
        || !q.options.every(item => text(item, 300)))) throw new Error("invalid Workspace pending question; execution refused");
      return value as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), runId: binding.runId,
      prepared: false, answeredQuestionIds: [], dismissed: false, referenceAcknowledged: false, misses: 0, failures: 0, budgetAcknowledged: false, question: null }));
  }
  question(): WorkspaceUserQuestion | null { const s = this.state.read(); return s.dismissed ? null : s.question; }
  retainedQuestion(): WorkspaceUserQuestion | null { return this.state.read().question; }
  isDismissed(): boolean { return this.state.read().dismissed; }
  dismiss(): void { const s = this.state.read(); if (!s.dismissed) this.state.update(s.revision, value => ({ ...value, dismissed: true })); }
  reconcile(decisions: readonly { callId: string }[] = []): void {
    const question = this.question();
    if (question && decisions.some(decision => decision.callId === question.id)) this.answer(question.id);
  }
  hasReferenceAnswer(): boolean { return this.state.read().referenceAcknowledged; }
  prepared(): void { const s = this.state.read(); this.state.update(s.revision, value => ({ ...value, prepared: true })); }
  request(reason: WorkspaceQuestionReason, question?: string, options: string[] = []): WorkspaceUserQuestion {
    const s = this.state.read(); if (s.question) return s.question;
    const copy = this.chinese ? {
      lookup_missing: "两次查找仍未确认目标。你指的是哪位同事或哪项内容？请补充名字、原名或位置。",
      lookup_ambiguous: "找到了多个可能的对象。你指的是哪一个？",
      tool_problem: "当前步骤连续遇到问题，进度已保留。你希望先处理哪个卡点，或补充什么信息？",
      budget_warning: "本次任务快到预算上限，已保留当前位置。是否在原剩余额度内继续？回答不会重置预算。",
      explicit: "请补充继续当前步骤所需的信息。",
    } : {
      lookup_missing: "Two lookups did not identify the target. Which colleague or item do you mean? Please provide its name, former name or location.",
      lookup_ambiguous: "Several evidenced matches remain. Which one do you mean?",
      tool_problem: "This step failed twice. Progress is saved. What should be corrected or clarified before continuing?",
      budget_warning: "This task is near its budget limit. Continue from the saved point within the original remaining allowance? Your answer will not reset the budget.",
      explicit: "Please provide the information needed to continue this step.",
    };
    const q: WorkspaceUserQuestion = { id: randomUUID(), reason, question: safe(question ?? copy[reason], 800),
      options: options.slice(0, 8).map(option => safe(option, 300)).filter(Boolean), taskId: this.taskId, runId: this.binding.runId };
    this.state.update(s.revision, value => ({ ...value, question: q })); return q;
  }
  answer(questionId: string): void {
    const s = this.state.read();
    if (s.answeredQuestionIds.includes(questionId)) return;
    if (!s.question || s.question.id !== questionId) throw new Error("Workspace question changed; refresh before answering");
    this.state.update(s.revision, value => ({ ...value, question: null, answeredQuestionIds: [...value.answeredQuestionIds, questionId].slice(-64), dismissed: false, misses: 0, failures: 0,
      referenceAcknowledged: value.referenceAcknowledged || ["lookup_missing", "lookup_ambiguous"].includes(s.question!.reason),
      budgetAcknowledged: value.budgetAcknowledged || s.question!.reason === "budget_warning" }));
  }
  check(usage: Readonly<WorkspaceUsage>, elapsedMs: number): WorkspaceUserQuestion | null {
    const s = this.state.read();
    if (s.question) {
      if (s.dismissed) this.state.update(s.revision, value => ({ ...value, dismissed: false }));
      return s.question;
    }
    if (!s.prepared) throw new Error("Workspace context preflight has not completed");
    const b = this.binding.budget;
    if (!s.budgetAcknowledged && (usage.modelCalls >= Math.ceil(b.maxRounds * 0.8)
      || usage.toolCalls >= Math.ceil(b.maxToolCalls * 0.8)
      || usage.inputTokens + usage.outputTokens >= Math.ceil(b.maxTokens * 0.8)
      || elapsedMs >= b.timeoutMs * 0.8)) return this.request("budget_warning");
    return null;
  }
  beginBatch(names: readonly string[]): void { this.lookupBatch = names.some(name => LOOKUPS.has(name)); }
  admit(name: string): void {
    if (this.retainedQuestion()) throw new Error("Workspace is waiting for the user's answer; no action was dispatched");
    if (this.lookupBatch && !LOOKUPS.has(name) && name !== "ask_user") throw new Error("Resolve context in a separate lookup batch before executing other tools");
  }
  observe(name: string, result: unknown, failed: boolean): void {
    let lookupMissing = false;
    if (name === "workspace_context_lookup" || name === "workspace_memory_search" || name === "workspace_read") {
      let parsed: Record<string, unknown> = {};
      try { const value: unknown = JSON.parse(typeof result === "string" ? result : ""); if (plain(value)) parsed = value; } catch { /* A malformed lookup is not proof of resolution. */ }
      if (parsed.status === "ambiguous") {
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates.filter(plain)
          .map(row => typeof row.label === "string" ? row.label : typeof row.name === "string" ? row.name : "").filter(Boolean) : [];
        this.request("lookup_ambiguous", undefined, candidates); return;
      }
      lookupMissing = name === "workspace_read" ? parsed.exists === false
        : failed || (name === "workspace_context_lookup" ? parsed.status !== "resolved"
          : !Array.isArray(parsed.hits) || parsed.hits.length === 0);
    }
    if (!failed && !lookupMissing) {
      const s = this.state.read();
      if (s.failures && !s.question) this.state.update(s.revision, value => ({ ...value, failures: 0 }));
      return;
    }
    const s = this.state.read(); if (s.question) return;
    const next = this.state.update(s.revision, value => ({ ...value, misses: Math.min(2, value.misses + Number(lookupMissing)),
      failures: Math.min(2, value.failures + Number(failed)) }));
    if (next.misses >= 2) this.request("lookup_missing");
    else if (next.failures >= 2) this.request("tool_problem");
  }
}
