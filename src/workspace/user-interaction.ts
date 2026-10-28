import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "../security/secrets.js";
import { scanMemory } from "../memory/guard.js";
import { exact, plain, text, UUID, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { WorkspaceRunBinding } from "./run-binding.js";
import type { WorkspaceUsage } from "./conversations.js";

export type WorkspaceQuestionReason = "lookup_missing" | "lookup_ambiguous" | "tool_problem" | "budget_warning" | "explicit";
/** Optional purpose of a question. rename_target: choose which existing colleague receives a requested new name. */
export type WorkspaceQuestionIntent = "rename_target";
export interface WorkspaceUserQuestion {
  id: string; reason: WorkspaceQuestionReason; question: string; options: string[];
  taskId: string; runId: string;
  header?: string; delivery?: "async"; intent?: WorkspaceQuestionIntent;
}

// Unified Workspace interaction contract (Hara-owned; modelled on a request/decision pair). Every
// user-facing pause is one request kind on one channel. permission and plan_review are always sync.
export type WorkspaceInteractionKind = "permission" | "ask_user_question" | "plan_review";
export type WorkspaceInteractionDelivery = "sync" | "async";
export type WorkspaceInteractionDismissReason = "paused" | "aborted" | "run_ended" | "superseded";
export interface WorkspaceAskUserQuestionRequest {
  requestId: string; kind: "ask_user_question"; delivery: WorkspaceInteractionDelivery;
  questions: { question: string; header?: string; options: string[] }[];
  metadata: { reason: WorkspaceQuestionReason; intent?: WorkspaceQuestionIntent; taskId: string; runId: string };
}
export interface WorkspacePermissionRequest {
  requestId: string; kind: "permission"; delivery: "sync"; action: string; summary: string; metadata: { runId: string };
}
export interface WorkspacePlanReviewRequest {
  requestId: string; kind: "plan_review"; delivery: "sync"; plan: string; metadata: { taskId: string; runId: string };
}
export type WorkspaceInteractionRequest = WorkspaceAskUserQuestionRequest | WorkspacePermissionRequest | WorkspacePlanReviewRequest;
export type WorkspaceInteractionDecision =
  | { requestId: string; kind: "ask_user_question"; dismissed: false; answers: string[] }
  | { requestId: string; kind: "permission"; dismissed: false; behavior: "allow" | "deny" }
  | { requestId: string; kind: "plan_review"; dismissed: false; behavior: "approve" | "reject" }
  | { requestId: string; kind: WorkspaceInteractionKind; dismissed: true; reason: WorkspaceInteractionDismissReason };

/** Only an ask may be delivered asynchronously; an approval is never answered "later". */
export function assertWorkspaceInteractionDelivery(kind: WorkspaceInteractionKind, delivery: WorkspaceInteractionDelivery): void {
  if (delivery === "async" && kind !== "ask_user_question") throw new Error(`${kind} interactions are always synchronous`);
}
export function workspaceAskInteraction(q: WorkspaceUserQuestion): WorkspaceAskUserQuestionRequest {
  return { requestId: q.id, kind: "ask_user_question", delivery: q.delivery ?? "sync",
    questions: [{ question: q.question, ...(q.header ? { header: q.header } : {}), options: [...q.options] }],
    metadata: { reason: q.reason, ...(q.intent ? { intent: q.intent } : {}), taskId: q.taskId, runId: q.runId } };
}
export function workspacePermissionInteraction(card: { id: string; kind: string; runId: string; draft?: { displayName?: unknown } }): WorkspacePermissionRequest {
  assertWorkspaceInteractionDelivery("permission", "sync");
  const name = typeof card.draft?.displayName === "string" ? card.draft.displayName : "";
  return { requestId: card.id, kind: "permission", delivery: "sync", action: card.kind, summary: name ? `${card.kind}: ${name}` : card.kind, metadata: { runId: card.runId } };
}
/** plan_review has a reserved slot only; no Workspace producer or resolver exists yet. */
export function workspacePlanReviewInteraction(): never {
  throw new Error("plan_review interactions are not implemented in Workspace yet");
}

export interface WorkspaceAsyncAnswer { id: string; question: string; answer: string }
type Decision = { id: string; outcome: "answered" | WorkspaceInteractionDismissReason };
interface State {
  revision: number; resourceBinding: WorkspaceResourceBinding; runId: string;
  prepared: boolean; answeredQuestionIds: string[]; dismissed: boolean; referenceAcknowledged: boolean; misses: number; failures: number; budgetAcknowledged: boolean;
  question: WorkspaceUserQuestion | null;
  asyncQuestions: WorkspaceUserQuestion[]; asyncAnswers: WorkspaceAsyncAnswer[]; decisions: Decision[];
}
const LEGACY_KEYS = ["revision", "resourceBinding", "runId", "prepared", "answeredQuestionIds", "dismissed", "referenceAcknowledged", "misses", "failures", "budgetAcknowledged", "question"];
const QUESTION_KEYS = ["id", "reason", "question", "options", "taskId", "runId"], QUESTION_OPTIONAL = ["header", "delivery", "intent"];
const OUTCOMES = ["answered", "paused", "aborted", "run_ended", "superseded"];
/** Unanswered async questions that may coexist in one run. */
export const MAX_ASYNC_QUESTIONS = 3;
// Batch admission treats roster enumeration as context work. Successful agent_list results do not
// count as missing references: enumeration has no query-specific resolved/missing evidence.
// Failed listings still enter observe()'s ordinary consecutive tool-failure counter.
const LOOKUPS = new Set(["workspace_context_lookup", "workspace_memory_search", "agent_list"]);
const REASONS = ["lookup_missing", "lookup_ambiguous", "tool_problem", "budget_warning", "explicit"];
function safe(value: string, cap: number): string {
  const result = redactSensitiveText(value).text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, cap);
  return scanMemory(result).ok ? result : "Please clarify the missing context.";
}
export function workspaceRenameTargetQuestion(newName: string, chinese: boolean): string {
  const name = safe(newName, 120);
  return chinese ? `有多位同事符合，要把哪一位改名为「${name}」？请选一位。` : `Several colleagues match. Which one should be renamed to "${name}"?`;
}

/** A run-bound gate, independent of model instructions. The caller owns the session lease; the JSON
 * store adds cross-process CAS/identity checks. Only a real answer clears unresolved lookup counts. */
export class WorkspaceUserInteraction {
  private readonly state: WorkspaceJsonState<State>;
  private lookupBatch = false;
  constructor(storage: WorkspaceResourceStorage, private readonly binding: Readonly<WorkspaceRunBinding>,
    private readonly taskId: string, private readonly chinese: boolean) {
    const validQuestion = (q: unknown, delivery: "sync" | "async"): boolean => plain(q)
      && Object.keys(q).every(key => QUESTION_KEYS.includes(key) || QUESTION_OPTIONAL.includes(key)) && QUESTION_KEYS.every(key => Object.hasOwn(q, key))
      && typeof q.id === "string" && UUID.test(q.id) && REASONS.includes(String(q.reason)) && text(q.question, 800)
      && q.taskId === taskId && q.runId === binding.runId && Array.isArray(q.options) && q.options.length <= 8 && q.options.every(item => text(item, 300))
      && (q.header === undefined || text(q.header, 120)) && (q.intent === undefined || q.intent === "rename_target")
      && (delivery === "async" ? q.delivery === "async" : q.delivery === undefined);
    this.state = new WorkspaceJsonState(storage, `interaction-${binding.runId}.json`, raw => {
      // Pre-interaction-v2 files lack the async/decision fields; read them as empty, write the full shape.
      const value = plain(raw) && exact(raw, LEGACY_KEYS) ? { ...raw, asyncQuestions: [], asyncAnswers: [], decisions: [] } : raw;
      if (!plain(value) || !exact(value, [...LEGACY_KEYS, "asyncQuestions", "asyncAnswers", "decisions"])
        || !Array.isArray(value.asyncQuestions) || value.asyncQuestions.length > MAX_ASYNC_QUESTIONS || !value.asyncQuestions.every(q => validQuestion(q, "async"))
        || !Array.isArray(value.asyncAnswers) || value.asyncAnswers.length > MAX_ASYNC_QUESTIONS
        || !value.asyncAnswers.every(row => plain(row) && exact(row, ["id", "question", "answer"]) && typeof row.id === "string" && UUID.test(row.id) && text(row.question, 800) && text(row.answer, 2000))
        || !Array.isArray(value.decisions) || value.decisions.length > 64
        || !value.decisions.every(row => plain(row) && exact(row, ["id", "outcome"]) && typeof row.id === "string" && UUID.test(row.id) && OUTCOMES.includes(String(row.outcome)))
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || value.runId !== binding.runId
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Array.isArray(value.answeredQuestionIds) || value.answeredQuestionIds.length > 64
        || !value.answeredQuestionIds.every(id => typeof id === "string" && UUID.test(id))
        || new Set(value.answeredQuestionIds).size !== value.answeredQuestionIds.length
        || typeof value.dismissed !== "boolean" || typeof value.prepared !== "boolean" || typeof value.referenceAcknowledged !== "boolean" || typeof value.budgetAcknowledged !== "boolean"
        || !Number.isSafeInteger(value.misses) || Number(value.misses) < 0 || Number(value.misses) > 2
        || !Number.isSafeInteger(value.failures) || Number(value.failures) < 0 || Number(value.failures) > 2) throw new Error("invalid Workspace interaction state; execution refused");
      if (value.question !== null && !validQuestion(value.question, "sync")) throw new Error("invalid Workspace pending question; execution refused");
      return value as unknown as State;
    }, () => ({ revision: 0, resourceBinding: this.state.binding(), runId: binding.runId,
      prepared: false, answeredQuestionIds: [], dismissed: false, referenceAcknowledged: false, misses: 0, failures: 0, budgetAcknowledged: false, question: null,
      asyncQuestions: [], asyncAnswers: [], decisions: [] }));
  }
  question(): WorkspaceUserQuestion | null { const s = this.state.read(); return s.dismissed ? null : s.question; }
  retainedQuestion(): WorkspaceUserQuestion | null { return this.state.read().question; }
  /** Every visible ask on the unified channel: the blocking sync question first, then async cards. */
  pendingInteractions(): WorkspaceAskUserQuestionRequest[] {
    const s = this.state.read();
    return [...(s.question && !s.dismissed ? [s.question] : []), ...s.asyncQuestions].map(workspaceAskInteraction);
  }
  /** The recorded resolution of a request, or null while it is still open/unknown. */
  decision(requestId: string): { requestId: string; dismissed: false } | { requestId: string; dismissed: true; reason: WorkspaceInteractionDismissReason } | null {
    const row = [...this.state.read().decisions].reverse().find(item => item.id === requestId);
    if (!row) return null;
    return row.outcome === "answered" ? { requestId, dismissed: false } : { requestId, dismissed: true, reason: row.outcome };
  }
  isDismissed(): boolean { return this.state.read().dismissed; }
  /** Hide the sync card without answering it. The question stays retained: a continuation reopens it. */
  dismiss(reason: Extract<WorkspaceInteractionDismissReason, "paused" | "aborted"> = "paused"): void {
    const s = this.state.read();
    if (!s.dismissed && s.question) this.state.update(s.revision, value => ({ ...value, dismissed: true, decisions: [...value.decisions, { id: s.question!.id, outcome: reason }].slice(-64) }));
    else if (!s.dismissed) this.state.update(s.revision, value => ({ ...value, dismissed: true }));
  }
  /** Post a non-blocking ask. Work that does not depend on the answer may continue. */
  requestAsync(question: string, options: string[] = [], header?: string): WorkspaceUserQuestion {
    const s = this.state.read();
    if (!s.prepared) throw new Error("Workspace context preflight has not completed");
    if (s.asyncQuestions.length >= MAX_ASYNC_QUESTIONS) throw new Error(`At most ${MAX_ASYNC_QUESTIONS} async questions may wait at once; continue without asking again`);
    const label = header ? safe(header, 120) : "";
    const q: WorkspaceUserQuestion = { id: randomUUID(), reason: "explicit", question: safe(question, 800),
      options: options.slice(0, 8).map(option => safe(option, 300)).filter(Boolean), taskId: this.taskId, runId: this.binding.runId,
      ...(label ? { header: label } : {}), delivery: "async" };
    this.state.update(s.revision, value => ({ ...value, asyncQuestions: [...value.asyncQuestions, q] })); return q;
  }
  /** Record a user's answer to a still-open async question; it is delivered at the next model boundary. */
  answerAsync(questionId: string, answer: string): void {
    const s = this.state.read(), q = s.asyncQuestions.find(item => item.id === questionId);
    if (!q) throw new Error("Workspace async question was answered, dismissed or expired; refresh before answering");
    const value = redactSensitiveText(answer).text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 2000);
    if (!value) throw new Error("Workspace async answer is empty");
    this.state.update(s.revision, current => ({ ...current, asyncQuestions: current.asyncQuestions.filter(item => item.id !== questionId),
      asyncAnswers: [...current.asyncAnswers, { id: questionId, question: q.question, answer: value }],
      decisions: [...current.decisions, { id: questionId, outcome: "answered" as const }].slice(-64) }));
  }
  /** Take answers that arrived since the last model boundary (each is delivered once). */
  drainAsyncAnswers(): WorkspaceAsyncAnswer[] {
    const s = this.state.read(); if (!s.asyncAnswers.length) return [];
    this.state.update(s.revision, value => ({ ...value, asyncAnswers: [] })); return s.asyncAnswers;
  }
  /** Run end: close every unanswered async card as dismissed (never as a user skip). */
  closeAsync(reason: Extract<WorkspaceInteractionDismissReason, "run_ended" | "aborted">): number {
    const s = this.state.read();
    if (!s.asyncQuestions.length && !s.asyncAnswers.length) return 0;
    this.state.update(s.revision, value => ({ ...value, asyncQuestions: [], asyncAnswers: [],
      decisions: [...value.decisions, ...value.asyncQuestions.map(q => ({ id: q.id, outcome: reason }))].slice(-64) }));
    return s.asyncQuestions.length;
  }
  reconcile(decisions: readonly { callId: string }[] = []): void {
    const question = this.question();
    if (question && decisions.some(decision => decision.callId === question.id)) this.answer(question.id);
  }
  hasReferenceAnswer(): boolean { return this.state.read().referenceAcknowledged; }
  prepared(): void { const s = this.state.read(); this.state.update(s.revision, value => ({ ...value, prepared: true })); }
  /** Open the one sync ask. An existing gate question (lookup/tool/budget) is never replaced; a newer
   * different explicit ask supersedes an unanswered explicit one, whose card is then closed as dismissed. */
  request(reason: WorkspaceQuestionReason, question?: string, options: string[] = [],
    meta: { header?: string; intent?: WorkspaceQuestionIntent } = {}): WorkspaceUserQuestion {
    const s = this.state.read();
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
    const label = meta.header ? safe(meta.header, 120) : "";
    const q: WorkspaceUserQuestion = { id: randomUUID(), reason, question: safe(question ?? copy[reason], 800),
      options: options.slice(0, 8).map(option => safe(option, 300)).filter(Boolean), taskId: this.taskId, runId: this.binding.runId,
      ...(label ? { header: label } : {}), ...(meta.intent ? { intent: meta.intent } : {}) };
    const old = s.question;
    if (old && (old.reason !== "explicit" || reason !== "explicit"
      || (old.question === q.question && JSON.stringify(old.options) === JSON.stringify(q.options)))) return old;
    this.state.update(s.revision, value => ({ ...value, question: q, dismissed: false,
      decisions: old ? [...value.decisions, { id: old.id, outcome: "superseded" as const }].slice(-64) : value.decisions }));
    return q;
  }
  answer(questionId: string): void {
    const s = this.state.read();
    if (s.answeredQuestionIds.includes(questionId)) return;
    if (!s.question || s.question.id !== questionId) throw new Error("Workspace question changed; refresh before answering");
    const referenceAnswer = ["lookup_missing", "lookup_ambiguous"].includes(s.question.reason);
    const reason = s.question.reason;
    this.state.update(s.revision, value => ({ ...value, question: null, answeredQuestionIds: [...value.answeredQuestionIds, questionId].slice(-64), dismissed: false,
      decisions: [...value.decisions, { id: questionId, outcome: "answered" as const }].slice(-64),
      misses: referenceAnswer ? 0 : value.misses, failures: reason === "tool_problem" ? 0 : value.failures,
      referenceAcknowledged: value.referenceAcknowledged || referenceAnswer,
      budgetAcknowledged: value.budgetAcknowledged || reason === "budget_warning" }));
  }
  check(usage: Readonly<WorkspaceUsage>, elapsedMs: number): WorkspaceUserQuestion | null {
    const s = this.state.read();
    if (s.question) {
      // A continuation may revisit a deliberately paused question. Reopen its display so the
      // retained question gates dispatch again; this is not an answer or a counter reset.
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
        // A rename whose current colleague matches several people is a choice card, then agent_rename.
        const renameTo = typeof parsed.renameTo === "string" ? parsed.renameTo : "";
        this.request("lookup_ambiguous", renameTo ? workspaceRenameTargetQuestion(renameTo, this.chinese) : undefined, candidates,
          renameTo ? { intent: "rename_target" } : {}); return;
      }
      lookupMissing = name === "workspace_read" ? parsed.exists === false
        // rename_new_name: the user-supplied new display name is not an unresolved reference.
        : failed || (name === "workspace_context_lookup" ? parsed.status !== "resolved" && parsed.status !== "rename_new_name"
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
