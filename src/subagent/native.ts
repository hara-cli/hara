import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import { disposeReminderScope } from "../agent/reminders.js";
import { resetRepeatGuard } from "../agent/repeat-guard.js";
import { clearTouched } from "../agent/touched.js";
import { memoryDigest } from "../memory/store.js";
import { resolveAgent } from "../org/projects.js";
import { loadGlobalRoles, loadRoles, subagentToolFilter, type Role } from "../org/roles.js";
import type { Provider, NeutralMsg } from "../providers/types.js";
import type { SandboxMode } from "../sandbox.js";
import { effectiveRoleModel } from "../session/session-model.js";
import { disposeTodoScope } from "../tools/todo.js";
import type { SubagentProvider, SubagentRequest, SubagentSettlement, SubagentUsage } from "./runtime.js";

export const NATIVE_SUBAGENT_PROVIDER_ID = "native-readonly";

export const EXPLORE_SYSTEM =
  "You are a fast, READ-ONLY codebase explorer. Navigate with grep/glob/ls/read_file and be quick: " +
  "issue your searches and file reads as MULTIPLE PARALLEL tool calls in one round whenever they are " +
  "independent — never one-per-turn. Read targeted excerpts, not whole files. You cannot modify anything. " +
  "Answer with CONCLUSIONS: the finding, the relevant paths with line references, and what they mean for " +
  "the question — never dump raw file contents. Match your depth to the task: a quick lookup stays quick; " +
  "an architecture question deserves a thorough sweep across naming conventions and directories.";

export interface NativeSubagentRequest extends SubagentRequest {
  baseProvider: Provider;
  cwd: string;
  sandbox: SandboxMode;
  projectContext?: string;
  profileId?: string;
  parentStats: { input: number; output: number; lastInput?: number };
  timeoutMs: number;
  maxRounds: number;
  observers?: Pick<RunOpts, "onProviderTurn" | "onToolRun">;
  isReadonlyTool: (name: string) => boolean;
  resolveProvider: (model: string, profileId?: string) => Promise<Provider | null>;
}

function roleError(message: string): SubagentSettlement {
  return { status: "error", text: "", error: message };
}

function usageFrom(stats: SubagentUsage): SubagentUsage {
  return {
    input: stats.input,
    output: stats.output,
    ...(stats.lastInput !== undefined ? { lastInput: stats.lastInput } : {}),
  };
}

function aggregateUsage(
  parent: { input: number; output: number; lastInput?: number },
  child: SubagentUsage,
): void {
  parent.input += child.input;
  parent.output += child.output;
  // Cumulative usage includes delegated work for truthful cost/accounting totals. `lastInput` is different:
  // it drives the root conversation's context gauge and auto-compaction threshold, so a child's isolated
  // prompt must never make the parent look fuller (or trigger compaction) than it actually is.
}

async function executeNative(request: NativeSubagentRequest): Promise<SubagentSettlement> {
  const roles = loadRoles(request.cwd, request.profileId);
  const roleRef = request.role?.trim();
  if (request.role !== undefined && !roleRef) return roleError("role cannot be blank");
  let role: Role | undefined;
  if (roleRef?.includes(":")) {
    const hit = resolveAgent(roleRef, request.cwd, request.profileId);
    if (hit && "ambiguous" in hit) {
      return roleError(`role '${roleRef}' is ambiguous; use one of: ${hit.ambiguous.map((entry) => `${entry.project}:${entry.name}`).join(", ")}.`);
    }
    if (hit?.project && resolve(hit.home) !== resolve(request.cwd)) {
      return roleError(`role '${roleRef}' belongs to ${hit.home}; nested read-only agents stay in their parent home (${request.cwd}).`);
    }
    if (hit && !("ambiguous" in hit)) {
      role = hit.project
        ? roles.find((candidate) => candidate.id === hit.name)
        : loadGlobalRoles(request.profileId).find((candidate) => candidate.id === hit.name);
    }
  } else if (roleRef) {
    role = roles.find((candidate) => candidate.id === roleRef);
  }
  const builtinSystem = !role && roleRef === "explore" ? EXPLORE_SYSTEM : undefined;
  if (roleRef && !role && !builtinSystem) {
    return roleError(`no role '${roleRef}' is available in ${request.cwd}. Use a local role id, global:<name>, or role "explore".`);
  }

  const requestedModel = effectiveRoleModel(role?.model, request.baseProvider.model);
  const provider = requestedModel
    ? ((await request.resolveProvider(requestedModel, request.profileId)) ?? request.baseProvider)
    : request.baseProvider;
  const toolFilter = subagentToolFilter(role, request.isReadonlyTool);
  const history: NeutralMsg[] = [{ role: "user", content: request.task }];
  const todoScope = `subagent:${randomUUID()}`;
  const localStats: SubagentUsage = { input: 0, output: 0, lastInput: 0 };
  let outcome: RunOutcome;
  try {
    outcome = await runAgent(history, {
      provider,
      ctx: {
        cwd: request.cwd,
        sandbox: request.sandbox,
        todoScope,
        profileId: request.profileId,
      },
      approval: "full-auto",
      confirm: async () => true,
      projectContext: request.projectContext,
      memory: memoryDigest(request.cwd, request.profileId),
      stats: localStats,
      systemOverride: role?.system ?? builtinSystem,
      toolFilter,
      hooks: false,
      quiet: true,
      signal: request.signal,
      timeoutMs: Math.min(request.timeoutMs, 8 * 60_000),
      maxRounds: Math.min(request.maxRounds, 24),
      ...(request.observers ?? {}),
    });
  } finally {
    disposeTodoScope(todoScope);
    disposeReminderScope(todoScope);
    resetRepeatGuard(todoScope);
    clearTouched(todoScope);
    aggregateUsage(request.parentStats, localStats);
  }

  const usage = usageFrom(localStats);
  if (outcome.status !== "completed") {
    const reason = outcome.error?.trim()
      || (outcome.status === "empty"
        ? "the model returned an empty response"
        : outcome.stopReason
          ? `the run stopped (${outcome.stopReason})`
          : `the run ended with status ${outcome.status}`);
    return {
      status: request.signal?.aborted ? "cancelled" : outcome.status,
      text: "",
      model: provider.model,
      error: reason,
      ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
      usage,
    };
  }
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === "assistant" && message.text.trim()) {
      return { status: "completed", text: message.text.trim(), model: provider.model, usage };
    }
  }
  return { status: "completed", text: "", model: provider.model, usage };
}

export function createNativeSubagentProvider(): SubagentProvider<NativeSubagentRequest> {
  return { id: NATIVE_SUBAGENT_PROVIDER_ID, run: executeNative };
}
