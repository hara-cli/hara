import { coreText } from "../i18n/messages.js";
import type { Locale as CloseoutLanguage } from "../i18n/locale.js";
import { freshTaskCompletion, isRecoverableRunPause, type TaskExecution, type TaskUserDependency } from "../session/task.js";
import { redactSensitiveText, requestsCredentialDisclosure } from "../security/secrets.js";
import type { Todo } from "../tools/todo.js";
import type { RunOutcome } from "./loop.js";
import { sanitizeAssistantText } from "./assistant-text.js";
import { redactOwnedToolImageText } from "../tools/tool-images.js";


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

function manualActionText(action: TaskUserDependency["manualAction"], language: CloseoutLanguage): string {
  if (!action) return "";
  const commands: string[] = [];
  for (const [label, value] of [
    [coreText("core.closeout.action_command", language), action.command],
    [coreText("core.closeout.verification_command", language), action.verifyCommand],
  ]) {
    if (!value) continue;
    const text = safeLine(value);
    if (!text) continue;
    // Never present a truncated or whitespace-rewritten shell command as ready to copy. The summary
    // remains bounded, while a longer/multiline command must be reviewed in its complete form first.
    const complete = redactSensitiveText(redactOwnedToolImageText(sanitizeAssistantText(value))).text.trim();
    commands.push(`${label}: ${complete === text ? text : (coreText("core.closeout.the_complete_command_is_not_shown_here_obtain_and", language))}`);
  }
  const resumePhrase = safeLine(action.resumePhrase ?? "");
  const hints = lines((action.hints ?? []).map((hint) => {
    const term = safeLine(hint.term);
    const detail = safeLine(hint.detail);
    return term && detail ? `${term}: ${detail}` : "";
  }));
  return section(coreText("core.closeout.manual_commands_copy_only_never_executed_automatically", language), commands)
    + section(coreText("core.closeout.after_completing_the_action_reply_with", language), resumePhrase ? [resumePhrase] : [])
    + section(coreText("core.closeout.action_hints", language), hints);
}

/** An accepted receipt without authored prose must still close the turn, without another model call.
 * Pending todos win over the word `verified`, matching finishTaskExecution's lifecycle rules. */
export function completionCloseoutText(task: TaskExecution | undefined, todos: readonly Todo[], language: CloseoutLanguage): string | undefined {
  const completion = freshTaskCompletion(task);
  if (!completion) return undefined;
  const unfinished = todos.filter((todo) => todo.status !== "done");
  const pending = lines(unfinished.map((todo) => todo.text));
  if (unfinished.length && !pending.length) pending.push(coreText("core.closeout.there_are_unfinished_steps", language));
  const evidence = lines(completion.evidence);
  const artifacts = lines(task?.checkpoint?.artifacts ?? []);
  if (completion.state === "awaiting_user") {
    const dependency = safeLine(completion.dependency?.detail ?? completion.waitingFor ?? "");
    return (coreText("core.closeout.the_task_is_safely_paused_not_fully_complete", language))
      + `\n\n${coreText("core.closeout.your_input_is_needed", language)}${dependency || (coreText("core.closeout.check_the_current_decision_card_or_trusted_sign_in", language))}`
      + section(coreText("core.closeout.options", language), lines(completion.dependency?.options ?? [], 8))
      + manualActionText(completion.dependency?.manualAction, language)
      + section(coreText("core.closeout.recorded_observations", language), evidence)
      + section(coreText("core.closeout.saved_artifacts", language), artifacts);
  }
  return (pending.length
    ? coreText("core.closeout.this_run_has_ended_but_the_task_still_has", language)
    : coreText("core.closeout.the_task_is_complete", language))
    + section(coreText("core.closeout.acceptance_evidence", language), evidence)
    + section(coreText("core.closeout.saved_artifacts", language), artifacts)
    + section(coreText("core.closeout.still_unfinished", language), pending);
}

/** A stopped action needs a visible handoff, but never an invented completion receipt or an automatic
 * replay of uploads/messages. Completed checklist entries and artifacts are partial records only. */
export function pausedCloseoutText(task: TaskExecution, todos: readonly Todo[], language: CloseoutLanguage, outcome?: RunOutcome): string {
  const done = lines(todos.filter((todo) => todo.status === "done").map((todo) => todo.text));
  const pending = lines(todos.filter((todo) => todo.status !== "done").map((todo) => todo.text));
  const checkpoint = task.checkpoint;
  const progress = outcome?.progress ?? task.progress;
  const progressReason = outcome?.stopReason === "no_progress" && progress?.trigger === "unattended_token_budget"
    && [progress.tokens.total, progress.rounds, progress.checkpointStaleRounds].every((value) => Number.isSafeInteger(value) && value >= 0)
    ? (coreText("core.closeout.usage_guard_round_cumulative_model_i_o_tokens_working", language, { p1: progress.rounds, p2: progress.tokens.total.toLocaleString("en-US"), p3: progress.checkpointStaleRounds }))
    : undefined;
  const remaining = pending.length ? pending : lines([checkpoint?.nextStep ?? checkpoint?.currentStep ?? ""]);
  const blocked = outcome !== undefined && (outcome.status === "error" || outcome.status === "empty"
    || (outcome.status === "halted" && !isRecoverableRunPause(outcome)));
  const boundaryReasons: Partial<Record<NonNullable<RunOutcome["stopReason"]>, string>> = {
    deadline: coreText("core.closeout.the_active_execution_deadline_was_reached", language),
    task_round_budget: coreText("core.closeout.the_task_s_cumulative_execution_round_budget_was_reached", language),
    max_rounds: coreText("core.closeout.this_run_reached_its_execution_round_limit", language),
    strategy_stall: coreText("core.closeout.the_current_strategy_stopped_making_verifiable_progress", language),
    no_progress: coreText("core.closeout.recent_work_produced_no_new_verifiable_progress", language),
    repeat_loop: coreText("core.closeout.repeated_execution_was_detected_and_stopped_to_avoid_repeating", language),
    native_context_limit: coreText("core.closeout.the_context_limit_was_reached_open_a_new_session", language),
    native_prose_only: coreText("core.closeout.the_engine_finished_this_turn_without_a_verified_action", language),
    native_resume_timeout: coreText("core.closeout.loading_the_existing_conversation_timed_out_before_this_message", language),
  };
  const reason = outcome?.status === "error"
    ? coreText("core.closeout.this_run_stopped_after_an_error", language)
    : outcome?.status === "empty"
      ? coreText("core.closeout.the_model_returned_no_usable_response_so_this_run", language)
      : blocked
        ? coreText("core.closeout.a_safety_or_execution_gate_stopped_this_run", language)
        : outcome?.stopReason === "completion_verification"
          ? coreText("core.closeout.work_produced_a_result_but_its_final_acceptance_record", language)
          : progressReason || (outcome?.stopReason && boundaryReasons[outcome.stopReason])
            || (coreText("core.closeout.a_safe_stopping_boundary_was_reached", language));
  return (blocked
    ? coreText("core.closeout.the_task_is_blocked_and_execution_has_stopped_full", language)
    : coreText("core.closeout.the_task_is_paused_full_completion_has_not_been", language))
    + `\n${reason}`
    + section(coreText("core.closeout.steps_recorded_as_done", language), done)
    + section(coreText("core.closeout.saved_artifacts_not_proof_of_full_completion", language), lines(checkpoint?.artifacts ?? []))
    + section(coreText("core.closeout.still_to_do_or_verify", language), remaining)
    + (outcome?.stopReason === "native_context_limit"
      ? coreText("core.closeout.choose_open_new_session_then_send_a_new_message", language)
      : blocked
      ? coreText("core.closeout.check_existing_receipts_and_diagnose_and_resolve_the_error", language)
      : coreText("core.closeout.recorded_results_are_retained_check_existing_receipts_and_the", language));
}
