// A serialized RunBinding is provenance, never an execution capability. Only trusted Host composition
// calls this factory; renderer/Agent arguments cannot populate the private WeakMap below.
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type { NeutralMsg, Provider, TurnResult } from "../providers/types.js";
import type { RunOpts } from "../agent/loop.js";
import type { TaskExecution } from "../session/task.js";
import type { Tool } from "../tools/registry.js";
import type { LocalWorkspaceCatalog } from "./local-catalog.js";
import type { WorkspaceResources } from "./resources.js";
import type { WorkspaceConnectionStoreV2 } from "./scoped-connections.js";
import type { WorkspaceSessionLease } from "./session-lease.js";
import { canonical } from "./local-state.js";
import { workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";
import { freezeWorkspaceRunBinding, workspaceRunBindingsEqual, workspaceRunMatchesTask, type WorkspaceRunBinding } from "./run-binding.js";
import type { WorkspaceUsage } from "./conversations.js";
import { workspaceTaskHistory, workspaceTaskProjection, workspaceWakeBrief, type WorkspaceContextStats } from "./model-context.js";
import { historyChars } from "../agent/context-budget.js";
import type { ToolResult } from "../providers/types.js";
import type { WorkspaceContextObservation } from "./context-audit.js";

export interface WorkspaceRunPermit { readonly binding: Readonly<WorkspaceRunBinding> }
interface PermitState {
  assertLive(): void;
  provider: Provider;
  options?: RunOpts;
  cwd: string;
  stateHome: string;
  signal: AbortSignal;
  tools: Set<string>;
  usage: WorkspaceUsage;
  updateUsage(value: Readonly<WorkspaceUsage>): void;
  pending: Set<Promise<unknown>>;
  lease: WorkspaceSessionLease;
  retired: boolean;
  started: boolean;
  modelHistory?: { history: NeutralMsg[]; start: number; prefixDigest: string; retain?: (result: ToolResult) => string; usedTokens?: () => number };
  contextStats?: WorkspaceContextStats;
  wakeChars: number;
}
const permits = new WeakMap<object, PermitState>();
function stateOf(permit: unknown): PermitState {
  const state = permit && typeof permit === "object" ? permits.get(permit) : undefined;
  if (!state) throw new Error("Workspace execution requires a trusted Host permit; no legacy fallback was started");
  return state;
}
function track<T>(state: PermitState, operation: Promise<T>): Promise<T> {
  state.pending.add(operation); state.lease.setDraining(true);
  const done = () => { state.pending.delete(operation); if (!state.pending.size) state.lease.setDraining(false); };
  // Observe both outcomes without discarding a rejecting .finally() Promise.
  void operation.then(done, done).catch(() => {});
  return operation;
}
function publishUsage(state: PermitState, delta: Partial<WorkspaceUsage>): void {
  const next = { ...state.usage };
  for (const [key, amount] of Object.entries(delta) as [keyof WorkspaceUsage, number][]) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(next[key] + amount)) throw new Error("invalid Workspace usage telemetry");
    next[key] += amount;
  }
  if (state.updateUsage(Object.freeze({ ...next })) !== undefined) throw new Error("Workspace usage persistence must complete synchronously");
  state.usage = next;
}

export function createWorkspaceRunPermit(input: {
  binding: WorkspaceRunBinding;
  catalog: LocalWorkspaceCatalog;
  resources: WorkspaceResources;
  storage: WorkspaceResourceStorage;
  connections: WorkspaceConnectionStoreV2;
  lease: WorkspaceSessionLease;
  provider: Provider;
  cwd: string;
  signal: AbortSignal;
  toolNames: readonly string[];
  usage: WorkspaceUsage;
  /** Trusted Host-only attempt boundary. Persisted history stays complete and append-only. */
  modelHistory?: { history: NeutralMsg[]; start: number; retain?: (result: ToolResult) => string; usedTokens?: () => number };
  observeContext?(value: WorkspaceContextObservation): void;
  updateUsage(value: Readonly<WorkspaceUsage>): void;
}): WorkspaceRunPermit {
  const binding = freezeWorkspaceRunBinding(input.binding), cwd = realpathSync.native(input.cwd);
  if (cwd !== binding.project.root || canonical(input.resources.scope) !== canonical(binding.scope) || canonical(input.storage.scope) !== canonical(binding.scope)
    || input.lease.sessionId !== binding.sessionId || input.provider.model !== binding.connection.model
    || new Set(input.toolNames).size !== input.toolNames.length || input.toolNames.some(name => !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
    throw new Error("Workspace Host dependencies do not match RunBinding");
  }
  const started = Date.now();
  if (input.modelHistory) workspaceTaskHistory(input.modelHistory.history, input.modelHistory.start);
  const permit = Object.freeze({ binding });
  const stateHome = input.storage.run(() => workspaceStateHome());
  let state: PermitState;
  const assertLive = (): void => {
    if (state?.retired || input.signal.aborted || Date.now() - started >= binding.budget.timeoutMs) throw new Error("Workspace attempt cancelled or expired");
    input.lease.assertCurrent();
    const project = lstatSync(cwd);
    if (!project.isDirectory() || project.isSymbolicLink() || realpathSync.native(cwd) !== cwd
      || project.dev !== binding.project.dev || project.ino !== binding.project.ino) throw new Error("Workspace project grant identity changed");
    input.storage.run(() => {});
    const catalog = input.catalog.read(), row = input.catalog.resolve(binding.scope.workspaceId);
    if (canonical(row.scope) !== canonical(binding.scope) || catalog.hostId !== binding.host.hostId || catalog.hostEpoch !== binding.host.hostEpoch
      || row.actorId !== binding.host.actorId || row.policyRevision !== binding.host.policyRevision
      || row.grantId !== binding.host.grantId || row.grantRevision !== binding.host.grantRevision) throw new Error("Workspace Host authority was revoked");
    input.resources.agents.resolveTask(binding.agent);
    const connection = input.connections.resolve(binding.connection);
    if (input.provider.id !== connection.provider || input.provider.model !== binding.connection.model) throw new Error("Workspace Provider route mismatch");
    if (state?.options) {
      const opts = state.options, initial = opts.taskIntake?.task, current = opts.taskIntake?.current?.() ?? initial;
      if (!initial || !current || !workspaceRunMatchesTask(initial.workspaceRunBinding, initial)
        || !workspaceRunMatchesTask(current.workspaceRunBinding, current) || !workspaceRunBindingsEqual(binding, current.workspaceRunBinding)
        || !workspaceRunBindingsEqual(binding, initial.workspaceRunBinding) || initial.turnId !== current.turnId || current.status !== "running") {
        throw new Error("Workspace execution task changed; no retargeting allowed");
      }
    }
  };
  const provider: Provider = {
    id: input.provider.id, model: binding.connection.model,
    supportsToolImages: false, trailingTurnContext: input.provider.trailingTurnContext,
    async prepareTurn(history, signal) {
      assertLive();
      if (!state.started) throw new Error("Workspace model requires the governed entry");
      if (signal?.aborted) throw new Error("Workspace model preparation cancelled");
      const result = await track(state, Promise.resolve().then(() => { assertLive(); return input.provider.prepareTurn?.(history, signal); }));
      assertLive(); return result;
    },
    async turn(args) {
      assertLive();
      if (!state.started) throw new Error("Workspace model requires the governed entry");
      if (args.signal?.aborted || state.usage.modelCalls >= binding.budget.maxRounds
        || state.usage.inputTokens + state.usage.outputTokens >= binding.budget.maxTokens) throw new Error("Workspace model budget exhausted or cancelled");
      publishUsage(state, { modelCalls: 1 });
      const observation = { modelCall: state.usage.modelCalls, systemChars: args.system.length, toolSchemaChars: JSON.stringify(args.tools).length,
        systemAndToolsUtf8Bytes: Buffer.byteLength(args.system + JSON.stringify(args.tools)), modelHistoryChars: historyChars(args.history), wakeChars: state.wakeChars,
        ...(state.contextStats ?? { compacted: false, originalChars: historyChars(args.history), recentChars: historyChars(args.history), summaryChars: 0, toolMaxChars: 0, agedToolMaxChars: 0 }) };
      const revoked = new AbortController();
      const signals = [input.signal, revoked.signal, ...(args.signal ? [args.signal] : [])];
      const forward = <A extends unknown[]>(fn: ((...values: A) => void) | undefined) => (...values: A): void => {
        if (!fn || revoked.signal.aborted || args.signal?.aborted) return;
        try { assertLive(); fn(...values); } catch { revoked.abort(); }
      };
      const guardedArgs = { ...args, signal: AbortSignal.any(signals), onText: forward(args.onText),
        onReasoning: forward(args.onReasoning), onActivity: forward(args.onActivity), onRetry: forward(args.onRetry) };
      const operation = Promise.resolve().then(() => { assertLive(); if (guardedArgs.signal.aborted) throw new Error("Workspace model cancelled"); return input.provider.turn(guardedArgs); });
      const result: TurnResult = await track(state, operation);
      // Even a cancelled/late request consumes its recorded telemetry, but never releases more tools.
      try { if (result.usage) publishUsage(state, { inputTokens: result.usage.input, outputTokens: result.usage.output }); }
      finally { input.observeContext?.({ ...observation, input: result.usage?.input ?? null, output: result.usage?.output ?? null,
        inputWarning: (result.usage?.input ?? 0) > 12000 }); }
      assertLive();
      if (state.usage.inputTokens + state.usage.outputTokens > binding.budget.maxTokens) throw new Error("Workspace token telemetry safety ceiling reached");
      return result;
    },
  };
  state = { assertLive, provider, cwd, stateHome, signal: input.signal, tools: new Set(input.toolNames), usage: { ...input.usage },
    updateUsage: input.updateUsage, pending: new Set(), lease: input.lease, retired: false, started: false, wakeChars: 0,
    ...(input.modelHistory ? { modelHistory: { ...input.modelHistory,
      prefixDigest: createHash("sha256").update(canonical(input.modelHistory.history.slice(0, input.modelHistory.start))).digest("hex") } } : {}) };
  for (const value of Object.values(state.usage)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid Workspace persisted usage");
  permits.set(permit, state);
  assertLive();
  return permit;
}

/** Compose the only accepted RunOpts. Callbacks are host-owned; no arbitrary imported extra tools. */
export function bindWorkspaceRunOptions(permit: WorkspaceRunPermit, input: Omit<RunOpts, "provider" | "workspaceRun">): RunOpts {
  const state = stateOf(permit);
  if (state.options) throw new Error("Workspace permit was already attached to a run");
  if (input.ctx.cwd !== state.cwd || input.ctx.sessionId !== permit.binding.sessionId || input.ctx.spaceId !== undefined
    || input.ctx.profileId !== undefined || input.ctx.spawn || input.ctx.agentTeam || input.ctx.inspectImage || input.ctx.describeImage || input.ctx.locate
    || input.guardian || input.fallback || input.hooks !== false || input.pendingInput || input.skillPolicies?.length
    || input.autoApprove || input.projectApprovals || input.taskApprovals || input.organizationPolicyVersion !== undefined
    || input.signal !== state.signal || !input.taskIntake) throw new Error("Workspace run contains unscoped dependencies");
  const extraTools = input.extraTools?.map(tool => {
    if (!state.tools.has(tool.name) || ["task_intake", "task_checkpoint", "todo_write"].includes(tool.name)
      || tool.kind === "exec" || tool.kind === "computer") throw new Error("unscoped Workspace extra tool");
    return Object.freeze({ ...tool });
  }) ?? [];
  const options: RunOpts = { ...input, ctx: Object.freeze({ ...input.ctx, stateHome: state.stateHome, writeBoundary: state.cwd,
    ...(input.ctx.ui ? { ui: Object.freeze({ ...input.ctx.ui }) } : {}) }),
    taskIntake: Object.freeze({ ...input.taskIntake }), extraTools: Object.freeze(extraTools) as unknown as Tool[],
    provider: state.provider, workspaceRun: permit, toolFilter: name => state.tools.has(name), autoContinue: false,
    maxRounds: permit.binding.budget.maxRounds, timeoutMs: permit.binding.budget.timeoutMs };
  state.options = options;
  assertWorkspaceRunAdmission(permit, options, "pi");
  return Object.freeze(options);
}

export function assertWorkspaceRunAdmission(permit: unknown, options: RunOpts, runtimeId: string): void {
  const state = stateOf(permit), binding = (permit as WorkspaceRunPermit).binding, pinned = state.options;
  state.assertLive();
  if (!pinned || options.workspaceRun !== permit || runtimeId !== binding.agent.runtimeId || runtimeId !== "pi"
    || options.provider !== state.provider || options.taskIntake !== pinned.taskIntake || options.extraTools !== pinned.extraTools
    || options.toolFilter !== pinned.toolFilter || options.hooks !== false || options.guardian || options.fallback
    || options.ctx.cwd !== state.cwd || options.ctx.sessionId !== binding.sessionId || options.ctx.stateHome !== state.stateHome
    || options.ctx.spaceId !== undefined || options.ctx.profileId !== undefined || options.signal !== state.signal
    || options.systemOverride !== pinned.systemOverride || options.memory !== pinned.memory || options.projectContext !== pinned.projectContext
    || options.approval !== pinned.approval || options.approvalChannel !== pinned.approvalChannel || options.confirm !== pinned.confirm
    || options.ctx.ui !== pinned.ctx.ui || options.ctx.ask !== pinned.ctx.ask || options.ctx.todoScope !== pinned.ctx.todoScope
    || options.ctx.writeBoundary !== pinned.ctx.writeBoundary || options.ctx.spawn || options.ctx.agentTeam
    || options.ctx.inspectImage || options.ctx.describeImage || options.ctx.locate || options.ctx.toolImageMode) {
    throw new Error("Workspace execution options do not match the trusted Host permit");
  }
}
export function beginWorkspaceGovernedRun(permit: WorkspaceRunPermit, options: RunOpts, runtimeId: string): void {
  assertWorkspaceRunAdmission(permit, options, runtimeId);
  const state = stateOf(permit);
  if (state.started) throw new Error("Workspace attempt permit was already consumed; obtain a fresh admitted attempt");
  state.started = true;
}
export function workspaceRunToolAllowed(permit: WorkspaceRunPermit, name: string): boolean { return stateOf(permit).tools.has(name); }
/** Trusted Host composition may retain a long instruction reference before options are pinned. */
export function assertWorkspaceRunContextCurrent(permit: WorkspaceRunPermit): void { stateOf(permit).assertLive(); }
export function prepareWorkspaceRunHistory(permit: WorkspaceRunPermit, history: NeutralMsg[]): NeutralMsg[] {
  const state = stateOf(permit); state.assertLive();
  if (!state.started) throw new Error("Workspace model context requires the governed entry");
  const pinned = state.modelHistory;
  if (!pinned) return history; // Existing trusted non-Host fixtures already contain one attempt only.
  if (history !== pinned.history || createHash("sha256").update(canonical(history.slice(0, pinned.start))).digest("hex") !== pinned.prefixDigest) {
    throw new Error("Workspace durable history prefix changed; model request refused");
  }
  const projected = workspaceTaskProjection(history, pinned.start, { usedTokens: pinned.usedTokens?.() ?? state.usage.inputTokens + state.usage.outputTokens,
    maxTokens: permit.binding.budget.maxTokens, task: state.options?.taskIntake?.current?.(), retain: pinned.retain });
  state.contextStats = projected.stats; return projected.history;
}
export function prepareWorkspaceRunWakeBrief(permit: WorkspaceRunPermit): string {
  const state = stateOf(permit); state.assertLive();
  const task = state.options?.taskIntake?.current?.() ?? state.options?.taskIntake?.task;
  if (!state.started || !task) throw new Error("Workspace wake context requires the governed task");
  const brief = workspaceWakeBrief(task, state.modelHistory?.retain); state.wakeChars = brief.length; return brief;
}
export function executeWorkspaceTool<T>(permit: WorkspaceRunPermit, name: string, execute: () => Promise<T>): Promise<T> {
  const state = stateOf(permit); state.assertLive();
  if (!state.started || !state.tools.has(name) || state.usage.toolCalls >= permit.binding.budget.maxToolCalls) throw new Error("Workspace tool unavailable or budget exhausted");
  publishUsage(state, { toolCalls: 1 });
  return track(state, Promise.resolve().then(() => { state.assertLive(); return execute(); }));
}
export async function closeWorkspaceRunPermit(permit: WorkspaceRunPermit): Promise<void> {
  const state = stateOf(permit); state.retired = true;
  while (state.pending.size) await Promise.allSettled([...state.pending]);
  state.lease.release();
}
