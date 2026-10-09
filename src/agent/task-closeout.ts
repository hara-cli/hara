import { freshTaskCompletion, isRecoverableRunPause, type TaskExecution, type TaskUserDependency } from "../session/task.js";
import { redactSensitiveText, requestsCredentialDisclosure } from "../security/secrets.js";
import type { Todo } from "../tools/todo.js";
import type { RunOutcome } from "./loop.js";
import { sanitizeAssistantText } from "./assistant-text.js";
import { redactOwnedToolImageText } from "../tools/tool-images.js";

type CloseoutLanguage = "en" | "zh-Hans";

// Only durable task state is summarized here, never raw tool output or a model's unaccepted success
// claim. A receipt still attests to the accepted checks, not to every unrelated transcript action.
function safeLine(value: string): string {
  const normalized = redactOwnedToolImageText(sanitizeAssistantText(value))
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").trim();
  if (requestsCredentialDisclosure(normalized)) return "";
  return redactSensitiveText(normalized).text.slice(0, 500);
}

function lines(values: readonly string[], limit = 4): string[] {
  return [...new Set(values.map(safeLine).filter(Boolean))].slice(0, limit);
}

function section(label: string, values: readonly string[]): string {
  return values.length ? `\n\n${label}\n${values.map((value) => `- ${value}`).join("\n")}` : "";
}

function manualActionText(action: TaskUserDependency["manualAction"], zh: boolean): string {
  if (!action) return "";
  const commands: string[] = [];
  for (const [label, value] of [
    [zh ? "操作命令" : "Action command", action.command],
    [zh ? "核验命令" : "Verification command", action.verifyCommand],
  ]) {
    if (!value) continue;
    const text = safeLine(value);
    if (!text) continue;
    // Never present a truncated or whitespace-rewritten shell command as ready to copy. The summary
    // remains bounded, while a longer/multiline command must be reviewed in its complete form first.
    const complete = redactSensitiveText(redactOwnedToolImageText(sanitizeAssistantText(value))).text.trim();
    commands.push(`${label}: ${complete === text ? text : (zh
      ? "本摘要未展示完整命令，请先获取并核对完整命令后再操作。"
      : "The complete command is not shown here; obtain and review it before acting.")}`);
  }
  const resumePhrase = safeLine(action.resumePhrase ?? "");
  const hints = lines((action.hints ?? []).map((hint) => {
    const term = safeLine(hint.term);
    const detail = safeLine(hint.detail);
    return term && detail ? `${term}: ${detail}` : "";
  }));
  return section(zh ? "人工操作命令（仅供复制，不会自动执行）：" : "Manual commands (copy only; never executed automatically):", commands)
    + section(zh ? "操作完成后可回复：" : "After completing the action, reply with:", resumePhrase ? [resumePhrase] : [])
    + section(zh ? "操作提示：" : "Action hints:", hints);
}

/** An accepted receipt without authored prose must still close the turn, without another model call.
 * Pending todos win over the word `verified`, matching finishTaskExecution's lifecycle rules. */
export function completionCloseoutText(task: TaskExecution | undefined, todos: readonly Todo[], language: CloseoutLanguage): string | undefined {
  const completion = freshTaskCompletion(task);
  if (!completion) return undefined;
  const zh = language === "zh-Hans";
  const unfinished = todos.filter((todo) => todo.status !== "done");
  const pending = lines(unfinished.map((todo) => todo.text));
  if (unfinished.length && !pending.length) pending.push(zh ? "仍有待处理的步骤。" : "There are unfinished steps.");
  const evidence = lines(completion.evidence);
  const artifacts = lines(task?.checkpoint?.artifacts ?? []);
  if (completion.state === "awaiting_user") {
    const dependency = safeLine(completion.dependency?.detail ?? completion.waitingFor ?? "");
    return (zh ? "任务已安全暂停，还没有全部完成。" : "The task is safely paused, not fully complete.")
      + `\n\n${zh ? "需要你处理：" : "Your input is needed: "}${dependency || (zh ? "请查看当前的确认卡片或受保护登录入口。" : "Check the current decision card or trusted sign-in surface.")}`
      + section(zh ? "可选项：" : "Options:", lines(completion.dependency?.options ?? [], 8))
      + manualActionText(completion.dependency?.manualAction, zh)
      + section(zh ? "已记录的情况：" : "Recorded observations:", evidence)
      + section(zh ? "已保存的产物：" : "Saved artifacts:", artifacts);
  }
  return (pending.length
    ? zh ? "本次执行已结束，但任务仍有未完成步骤，尚未全部完成。" : "This run has ended, but the task still has unfinished steps and is not fully complete."
    : zh ? "任务已完成。" : "The task is complete.")
    + section(zh ? "验收记录：" : "Acceptance evidence:", evidence)
    + section(zh ? "已保存的产物：" : "Saved artifacts:", artifacts)
    + section(zh ? "尚未完成：" : "Still unfinished:", pending);
}

/** A stopped action needs a visible handoff, but never an invented completion receipt or an automatic
 * replay of uploads/messages. Completed checklist entries and artifacts are partial records only. */
export function pausedCloseoutText(task: TaskExecution, todos: readonly Todo[], language: CloseoutLanguage, outcome?: RunOutcome): string {
  const zh = language === "zh-Hans";
  const done = lines(todos.filter((todo) => todo.status === "done").map((todo) => todo.text));
  const pending = lines(todos.filter((todo) => todo.status !== "done").map((todo) => todo.text));
  const checkpoint = task.checkpoint;
  const remaining = pending.length ? pending : lines([checkpoint?.nextStep ?? checkpoint?.currentStep ?? ""]);
  const blocked = outcome !== undefined && (outcome.status === "error" || outcome.status === "empty"
    || (outcome.status === "halted" && !isRecoverableRunPause(outcome)));
  const boundaryReasons: Partial<Record<NonNullable<RunOutcome["stopReason"]>, string>> = {
    deadline: zh ? "本次执行已达到有效执行时限。" : "The active-execution deadline was reached.",
    task_round_budget: zh ? "任务已达到累计执行回合预算。" : "The task's cumulative execution-round budget was reached.",
    max_rounds: zh ? "本次执行已达到回合上限。" : "This run reached its execution-round limit.",
    strategy_stall: zh ? "当前策略没有继续取得可核验进展。" : "The current strategy stopped making verifiable progress.",
    no_progress: zh ? "近期没有取得新的可核验进展。" : "Recent work produced no new verifiable progress.",
    repeat_loop: zh ? "检测到重复执行，已停止以避免再次操作。" : "Repeated execution was detected and stopped to avoid repeating actions.",
  };
  const reason = outcome?.status === "error"
    ? zh ? "本次执行发生错误，已停止。" : "This run stopped after an error."
    : outcome?.status === "empty"
      ? zh ? "模型未返回可用响应，本次执行已停止。" : "The model returned no usable response, so this run stopped."
      : blocked
        ? zh ? "安全检查或执行条件阻止了本次执行。" : "A safety or execution gate stopped this run."
        : outcome?.stopReason === "completion_verification"
          ? zh ? "操作已有结果，但最终验收记录不完整。" : "Work produced a result, but its final acceptance record is incomplete."
          : (outcome?.stopReason && boundaryReasons[outcome.stopReason])
            || (zh ? "已到达安全停止边界。" : "A safe stopping boundary was reached.");
  return (blocked
    ? zh ? "任务受阻，执行已停止，尚未确认全部完成。" : "The task is blocked and execution has stopped; full completion has not been verified."
    : zh ? "任务已暂停，尚未确认全部完成。" : "The task is paused; full completion has not been verified.")
    + `\n${reason}`
    + section(zh ? "已登记完成的步骤：" : "Steps recorded as done:", done)
    + section(zh ? "已保存的产物（不代表全部验收通过）：" : "Saved artifacts (not proof of full completion):", lines(checkpoint?.artifacts ?? []))
    + section(zh ? "尚待处理或核验：" : "Still to do or verify:", remaining)
    + (blocked
      ? zh
        ? "\n\n请先核对已有回执并排查、解决上方错误或拦截原因，再请求重试。不要重复上传或发送；不能仅靠继续执行来消除该阻碍。"
        : "\n\nCheck existing receipts and diagnose and resolve the error or blocking condition above before requesting a retry. Do not repeat uploads or messages; resuming alone does not resolve this blocker."
      : zh
        ? "\n\n已记录的结果会保留。请先核对回执和上方暂停原因，不要重复上传或发送；解决阻碍后可在当前对话输入 /continue 继续。"
        : "\n\nRecorded results are retained. Check existing receipts and the pause reason above before resuming; do not repeat uploads or messages. Use /continue in this conversation after resolving the boundary.");
}
