import type { NativeWorkspaceEvidence } from "../agent-runtime/execution-policy.js";
import { createHash } from "node:crypto";
import type { TaskBriefInput, TaskExecution } from "../session/task.js";
import type { ToolResult } from "../providers/types.js";

// Mutation signals stay on the original user request, before question/presentation normalization.
// Like route.ts, include CJK action words without relying on whitespace word boundaries.
const CHANGE = /(?:创建|創建|建立|新建|新增|添加|写入|寫入|修改|编辑|編輯|删除|刪除|移除|重命名|重新命名|发送|發送|委派|安排|定时|定時|执行|執行|部署|安装|安裝|更新|保存|儲存|存储|存儲|同步|推送|合并|合併|生成|设置|設置|設定|关闭|關閉|开启|開啟|修复|修復|实现|實現|开发|開發|编写|編寫|重构|重構|优化|優化|发布|發佈|回滚|回滾|迁移|遷移|导入|導入|导出|導出|匯出|建(?:立)?(?:\s*(?:一|两|兩|几|幾|[0-9]+)?[个個位])?\s*(?:新(?:的)?\s*)?(?:bot|agent|同事|机器人|機器人)|create|add|write|edit|change|delete|remove|rename|send|delegate|schedule|execute|deploy|install|update|save|sync|push|merge|generate|set up|turn on|turn off)/iu;

export function changeTaskObjective(objective: string): boolean { return CHANGE.test(objective); }
const QUESTION = /[?？]|^(?:\s*(?:list|show|read|describe|explain|what|who|which|how|tell me|find|search|列出|查看|读取|说明|解释|告诉我|查找|搜索|有哪些|是什么|谁是))/iu;
// Presentation-only prefixes do not change task authority. Keep mutation detection on the original request.
const ANSWER_PREFIX = /^(?:请|請)?(?:用|以)(?:(?:简体|繁体|簡體|繁體)?中文)?(?:一句话|一句話)?(?:回答|回复|回覆)?[：:，,\s]*/u;
const CJK_ANSWER = /^(?:请|請)?(?:简单|簡單)?(?:介绍|介紹|简述|簡述|请问|請問|什么|甚麼|如何|为什么|為什麼|怎样|怎樣|怎么|怎麼|多少|是否|能否)|^(?:你|您|这|這)(?:是|能|会|會|可以)|^(?:你好|您好|嗨|早上好|晚上好|晚安)(?:[，,。.！!\s]|$)/u;
const MULTI_OUTCOME = /(?:并且|同时|另外|以及|之后还|然后再|和|and also|also|then|plus|[,，、;；])/iu;
// A comma in a short answer/greeting is not itself another task step. This guard is effort-only;
// simple-change completion keeps its stricter MULTI_OUTCOME check above.
const MULTI_STEP_ANSWER = /(?:并且|同時|同时|另外|以及|之后还|之後還|然后|然後|接着|接著|and also|also|then|plus|(?:^|\n)\s*\d+[.)、])/iu;
const SHORT_CHAT = /^(?:(?:hello|hi|hey)(?:\s+there)?|good\s+(?:morning|afternoon|evening|night)|thanks|thank\s+you(?:\s+(?:very much|so much))?|ok(?:ay)?|谢谢|謝謝|好的|早安|晚安)[。.！!?？\s]*$/iu;
const SHORT_INTRO = /^(?:(?:hello|hi|hey)[,\s]+)?(?:我是|我叫|my name is|i(?: am|'m))\s*[\p{L}\p{N}][\p{L}\p{N} _'-]{0,39}[。.！!?？\s]*$/iu;
// A request to investigate remains work even if the user phrases it as a question. This affects
// effort only; it does not change the engine's completion/side-effect authority classification.
const INVESTIGATE_REQUEST = /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:investigate|debug|diagnose|inspect|audit)\b|^(?:调查|調查|排查|诊断|診斷|审计|審計)/iu;


/** Direct engine completion is limited to one stated outcome; richer tasks use explicit checks. */
export function simpleChangeObjective(objective: string): boolean {
  const text = objective.trim();
  return text.length > 0 && text.length <= 400 && CHANGE.test(text) && !MULTI_OUTCOME.test(text);
}

/** Presentation prefixes never add action authority. */
export function answerQuestionText(objective: string): string {
  return objective.trim().replace(/^(?:你好|您好|嗨)[，,\s]+/u, "").replace(ANSWER_PREFIX, "")
    .replace(/^(?:(?:请问|請問|请|請|麻烦|麻煩|烦请|煩請|帮我|幫我|please)\s*)+/iu, "").trim();
}
/** Tool-free closeout is limited to greetings and the assistant's own identity/capabilities. */
export function conversationalAnswerObjective(objective: string): boolean {
  if (CHANGE.test(objective)) return false;
  const value = answerQuestionText(objective);
  return /^(?:(?:请|請)?(?:简单|簡單)?(?:自我介绍|自我介紹|(?:介绍|介紹)(?:一下)?(?:你自己|自己|你|您))|(?:你|您)(?:是(?:谁|誰|什么助手|什麼助手)|叫什么(?:名字)?|叫什麼(?:名字)?|能做(?:什么|什麼)|可以做(?:什么|什麼))|你好|您好|嗨|hello|hi|(?:please\s+)?(?:introduce yourself|who are you|what(?:'s| is) your name))[。.！!?？\s]*$/iu.test(value);
}
/** The user supplied the entire reply; this is an echo, never proof of external facts. */
export function requestedReplyText(objective: string): string | null {
  if (objective.length > 2000 || changeTaskObjective(objective)) return null;
  const match = /^(?:(?:请|請|please)\s*)?(?:(?:直接|只需|只|仅|僅|just|only)\s*)?(?:回答|回复|回覆|reply|respond|say)\s*[：:]?\s*(?:“([^”\r\n]{1,160})”|「([^」\r\n]{1,160})」|『([^』\r\n]{1,160})』|"([^"\r\n]{1,160})"|'([^'\r\n]{1,160})')/iu.exec(objective.trim());
  if (!match) return null;
  const text = match.slice(1).find(value => value !== undefined)?.trim();
  const suffix = objective.trim().slice(match[0].length);
  // Only presentation/termination instructions may follow the quote; another question/work item is not an echo.
  const rest = suffix.replace(/(?:这是|這是)?(?:无需|無需)工具的(?:简单|簡單)?(?:问候|問候)/gu, "")
    .replace(/(?:请|請)?(?:不要|勿)调用任何工具|(?:请|請)?(?:不要|勿)調用任何工具/gu, "")
    .replace(/(?:回复|回覆|回答)后结束|(?:回复|回覆|回答)後結束|即可/gu, "")
    .replace(/[。.!！,，;；\s]/gu, "");
  return text && rest.length === 0 ? text : null;
}

export function answerQuestionObjective(objective: string): boolean {
  const question = answerQuestionText(objective);
  return QUESTION.test(question) || CJK_ANSWER.test(question) || SHORT_CHAT.test(question) || SHORT_INTRO.test(question)
    || conversationalAnswerObjective(objective) || requestedReplyText(objective) !== null;
}

/** Deterministic Host intent from the original user objective, before any model response. */
export function taskObjectiveIntent(objective: string): TaskBriefInput["intent"] {
  return CHANGE.test(objective) ? "change" : answerQuestionObjective(objective) ? "answer" : "investigate";
}

/** The same Host classification, bounded to one short outcome for automatic reasoning. */
export function simpleAnswerObjective(objective: string): boolean {
  return taskObjectiveIntent(objective) === "answer" && !INVESTIGATE_REQUEST.test(answerQuestionText(objective))
    && (conversationalAnswerObjective(objective)
    || requestedReplyText(objective) !== null || objective.trim().length <= 400 && !MULTI_STEP_ANSWER.test(objective));
}

/** User wording supplies authority; the first model response supplies only a bounded execution hint. */
export function engineTaskBrief(task: TaskExecution, firstReply: { text: string; toolUses: readonly { name: string }[] }): TaskBriefInput {
  const objective = task.objective.trim();
  const intent = taskObjectiveIntent(objective);
  const firstTool = firstReply.toolUses.find(item => item.name !== "task_intake")?.name;
  return {
    intent,
    goal: objective.slice(0, 1000),
    constraints: [`Authorized scope: ${objective.slice(0, 800)}`, "Preserve unrelated user work and the Workspace safety boundary."],
    acceptance: [intent === "change" ? "The requested change has a verified operation receipt." : "The result is supported by observed evidence."],
    steps: [firstTool ? `Begin with ${firstTool}; verify the outcome.` : "Inspect the request and verify the outcome."],
  };
}

interface Observed { id: string; name: string; digest: string; value: Record<string, unknown> }
/** Only host-owned structured results can close a Workspace change. Model prose is never evidence. */
export class WorkspaceChangeTrace {
  private observations: Observed[] = [];
  private unsafe = false;

  observe(result: ToolResult, denied: boolean): void {
    if (denied || result.isError || result.content.startsWith("Error:")) { this.unsafe = true; return; }
    let value: unknown;
    try { value = JSON.parse(result.content); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const receipt = record.receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || (receipt as Record<string, unknown>).toolCallId !== result.id
      || (receipt as Record<string, unknown>).toolName !== result.name) { this.unsafe = true; return; }
    this.observations.push({ id: result.id, name: result.name,
      digest: createHash("sha256").update(result.content).digest("hex"), value: record });
  }

  evidence(native?: NativeWorkspaceEvidence | null): string[] | null {
    if (this.unsafe) return null;
    const writes = this.observations.filter(item => item.name === "workspace_write" && item.value.written === true
      && typeof item.value.path === "string" && typeof item.value.sha256 === "string");
    const verified = writes.filter(write => this.observations.some((item, index) => index > this.observations.indexOf(write)
      && item.name === "workspace_verify"
      && item.value.verified === true && item.value.path === write.value.path && item.value.sha256 === write.value.sha256));
    const intrinsic = this.observations.filter(item =>
      (item.name === "agent_create" && item.value.created === true && item.value.humanConfirmed === true)
      || (item.name === "agent_rename" && item.value.renamed === true)
      || (item.name === "agent_contact" && item.value.completed === true
        && typeof item.value.completion === "object" && item.value.completion !== null
        && (item.value.completion as Record<string, unknown>).state === "verified"));
    if (native?.verified && native.nativeEventCount > 0 && native.changes.length && !writes.length && !intrinsic.length && !this.observations.some(item => item.name === "workspace_native_evidence" && item.value.verified !== true)) {
      return [`native-workspace-diff evidenceId=${native.id} sha256=${native.digest} files=${native.changes.length} nativeEvents=${native.nativeEventCount}`];
    }
    const actions = [...verified, ...intrinsic];
    // A simple one-outcome objective cannot silently close after a second unverified mutation.
    if (actions.length !== 1 || writes.length !== verified.length || intrinsic.length + writes.length !== 1) return null;
    return actions.map(item => `${item.name} toolCallId=${item.id} resultSummarySha256=${item.digest} verify=passed`);
  }
}
