import { bindAgentBoundaryExecution, type AgentBoundaryExecutionGate } from "./agent-boundary-execution.js";
import { WorkspaceNativeSessions, resettableNativeRuntime } from "./native-session-boundary.js";
import { runtimeToolTargetLabel } from "./runtime-tool-label.js";
import type { MessageTimingPoint, MessageTimingRecorder } from "./message-timing.js";
import { runtimeStageErrorKind } from "../agent-runtime/stage-observer.js";
import { decorateWorkspaceExtensionTool, isWorkspaceExtensionTool } from "./extension-binding.js";
import type { CompletionEvidenceLedger } from "../agent/completion-evidence.js";
import { createWorkspaceCompletionEvidence } from "./completion-evidence-store.js";
import type { RuntimeExecutionPolicy, NativeWorkspaceEvidence, RuntimeRiskEvent } from "../agent-runtime/execution-policy.js";
// A serialized RunBinding is provenance, never an execution capability. Only trusted Host composition
// calls this factory; renderer/Agent arguments cannot populate the private WeakMap below.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NeutralMsg, Provider, ProviderRetryEvent, TurnResult, TurnArgs } from "../providers/types.js";
import type { RunOpts } from "../agent/loop.js";
import type { TaskExecution } from "../session/task.js";
import type { Tool } from "../tools/registry.js";
import type { LocalWorkspaceCatalog } from "./local-catalog.js";
import type { WorkspaceResources } from "./resources.js";
import type { WorkspaceConnectionStoreV2 } from "./scoped-connections.js";
import type { WorkspaceSessionLease } from "./session-lease.js";
import { canonical, deepFreeze } from "./local-state.js";
import { AgentBoundaryContractError } from "./agent-boundaries-contract.js";
import { workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";
import { freezeWorkspaceRunBinding, workspaceFileIdMatches, workspaceRunBindingsEqual, workspaceRunMatchesTask, type WorkspaceRunBinding } from "./run-binding.js";
import type { WorkspaceUsage, WorkspaceConversation } from "./conversations.js";
import { workspaceTaskHistory, workspaceTaskProjection, workspaceWakeData, type WorkspaceContextStats } from "./model-context.js";
import { historyChars } from "../agent/context-budget.js";
import type { ToolResult } from "../providers/types.js";
import type { WorkspaceContextObservation } from "./context-audit.js";
import { WorkspaceExecutionAudit, type WorkspaceExecutionError } from "./execution-audit.js";
import type { RuntimeStageRecorder } from "./runtime-stage-events.js";
import type { WorkspaceUserInteraction, WorkspaceUserQuestion } from "./user-interaction.js";

export interface WorkspaceRunPermit { readonly binding: Readonly<WorkspaceRunBinding> }
declare const drainBrand: unique symbol;
export interface WorkspaceRunDrainProof { readonly [drainBrand]: true }
interface PermitState {
  boundaryExecution?: ReturnType<typeof bindAgentBoundaryExecution>;
  resetRoundClock?: () => void;
  completionEvidence: CompletionEvidenceLedger;
  storage: WorkspaceResourceStorage;
  assertLive(): void;
  provider: Provider;
  options?: RunOpts;
  cwd: string;
  managedProject: boolean;
  managedLegacyRoot?: string;
  hasLegacyToolPolicy: boolean;
  nativeConversationSafe: boolean;
  stateHome: string;
  signal: AbortSignal;
  tools: Set<string>;
  usage: WorkspaceUsage;
  updateUsage(value: Readonly<WorkspaceUsage>): void;
  pending: Set<Promise<unknown>>;
  lease: WorkspaceSessionLease;
  retired: boolean;
  drainProof?: WorkspaceRunDrainProof;
  started: boolean;
  nativePolicy?: RuntimeExecutionPolicy;
  nativeEvidence?: NativeWorkspaceEvidence;
  nativeRisks?: RuntimeRiskEvent[];
  onNativeRisks?(risks: readonly RuntimeRiskEvent[]): void;
  compactionSource?(): WorkspaceConversation;
  runtimeModel?: (args: TurnArgs) => Promise<TurnResult>;
  modelHistory?: { history: NeutralMsg[]; start: number; prefixDigest: string; retain?: (result: ToolResult) => string; usedTokens?: () => number };
  contextStats?: WorkspaceContextStats;
  wakeChars: number;
  audit: WorkspaceExecutionAudit;
  runtimeStages?: RuntimeStageRecorder;
  messageTiming?: MessageTimingRecorder;
  firstStageToken: boolean;
  onRuntimeStageChanged?: () => void;
  interaction?: WorkspaceUserInteraction;
  onQuestion?: (question: WorkspaceUserQuestion) => void;
  onInteractionChanged?: () => void;
  interactionUsage?: () => Readonly<WorkspaceUsage>;
  startedAt: number;
  toolTail: Promise<unknown>;
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
/** Only native Codex has the approved non-cache run-budget policy. Preserve raw/cache counts in its
 * private thread telemetry and context audit; other Runtime/provider budget semantics are unchanged. */
function runtimeUsageDelta(usage: NonNullable<TurnResult["usage"]>, nativeCodex: boolean): Partial<WorkspaceUsage> {
  const cached = nativeCodex ? usage.cachedInput ?? 0 : 0;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.input) throw new Error("invalid Workspace native cache telemetry");
  return { inputTokens: usage.input - cached, outputTokens: usage.output };
}

/** A path-shaped string alone cannot opt a user project out of the CLI trust check. */
export function workspaceRunHasManagedProject(permit: WorkspaceRunPermit): boolean {
  const state = stateOf(permit); state.assertLive(); return state.managedProject;
}

/** Closed Host projection: the legacy compatibility root and this exact Agent's home, never caller paths. */
export function workspaceRunManagedProjectRoots(permit: WorkspaceRunPermit): Readonly<{ workRoot: string; legacyRoot: string; homeRoot: string }> | null {
  const state = stateOf(permit); state.assertLive();
  if (!state.managedProject || !state.managedLegacyRoot) return null;
  return Object.freeze({ workRoot: state.cwd, legacyRoot: state.managedLegacyRoot,
    homeRoot: join(state.managedLegacyRoot, "colleagues", permit.binding.agent.agentId) });
}

export function createWorkspaceRunPermit(input: {
  binding: WorkspaceRunBinding;
  /** C2 trusted Host composition only. Missing retains the released legacy lane; null/JSON denies. */
  agentBoundary?: AgentBoundaryExecutionGate;
  catalog: LocalWorkspaceCatalog;
  resources: WorkspaceResources;
  storage: WorkspaceResourceStorage;
  connections: WorkspaceConnectionStoreV2;
  lease: WorkspaceSessionLease;
  provider: Provider;
  cwd: string;
  /** Only the Host that created this private project namespace may supply this proof. Never RPC input. */
  managedProjectRoot?: string;
  signal: AbortSignal;
  toolNames: readonly string[];
  usage: WorkspaceUsage;
  /** Same-task continuation predecessor and actual question answer from protected Host state; never renderer task data. */
  completionRecovery?: { previousTask: TaskExecution; currentTask: TaskExecution; answeredQuestionId?: string };
  /** Trusted Host-only attempt boundary. Persisted history stays complete and append-only. */
  modelHistory?: { history: NeutralMsg[]; start: number; retain?: (result: ToolResult) => string; usedTokens?: () => number };
  observeContext?(value: WorkspaceContextObservation): void;
  /** Host-created diagnostic recorder, never accepted from model/RPC data. */
  runtimeStages?: RuntimeStageRecorder;
  messageTiming?: MessageTimingRecorder;
  onRuntimeStageChanged?(): void;
  onNativeRisks?(risks: readonly RuntimeRiskEvent[]): void;
  compactionSource?(): WorkspaceConversation;
  interaction?: WorkspaceUserInteraction;
  onQuestion?(question: WorkspaceUserQuestion): void;
  /** Host view refresh after an ask card is posted (async cards do not pass through a checkpoint). */
  onInteractionChanged?(): void;
  interactionUsage?(): Readonly<WorkspaceUsage>;
  updateUsage(value: Readonly<WorkspaceUsage>): void;
}): WorkspaceRunPermit {
  const binding = freezeWorkspaceRunBinding(input.binding), cwd = realpathSync.native(input.cwd);
  const legacyRoot = join(dirname(input.catalog.home), "project", binding.scope.workspaceId);
  const homeRoot = join(legacyRoot, "colleagues", binding.agent.agentId);
  const managedProject = input.managedProjectRoot === legacyRoot && basename(input.catalog.home) === "home"
    && (cwd === legacyRoot || cwd === homeRoot);
  const legacyIdentity = managedProject ? lstatSync(legacyRoot, { bigint: true }) : undefined;
  if (legacyIdentity && (!legacyIdentity.isDirectory() || legacyIdentity.isSymbolicLink() || realpathSync.native(legacyRoot) !== legacyRoot))
    throw new Error("Invalid managed Workspace project identity");
  if (input.managedProjectRoot !== undefined && !managedProject) throw new Error("Invalid managed Workspace project proof");
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
    if (state?.retired || input.signal.aborted || (binding.budget.mode !== "interactive" && Date.now() - started >= binding.budget.timeoutMs)) throw new Error("Workspace attempt cancelled or expired");
    input.lease.assertCurrent();
    state?.boundaryExecution?.assertCurrent();
    if (legacyIdentity) {
      const currentLegacy = lstatSync(legacyRoot, { bigint: true });
      if (!currentLegacy.isDirectory() || currentLegacy.isSymbolicLink() || realpathSync.native(legacyRoot) !== legacyRoot
        || currentLegacy.dev !== legacyIdentity.dev || currentLegacy.ino !== legacyIdentity.ino) throw new Error("Workspace legacy project identity changed");
    }
    const project = lstatSync(cwd, { bigint: true });
    if (!project.isDirectory() || project.isSymbolicLink() || realpathSync.native(cwd) !== cwd
      || !workspaceFileIdMatches(binding.project.dev, project.dev) || !workspaceFileIdMatches(binding.project.ino, project.ino)) throw new Error("Workspace project grant identity changed");
    input.storage.run(() => {});
    // Use one freshly verified catalog snapshot so host epoch and grant come from the same revision.
    const catalog = input.catalog.read(), row = catalog.workspaces.find(row => row.scope.workspaceId === binding.scope.workspaceId && row.active);
    if (!row) throw new Error("Workspace is unavailable or revoked");
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
      state.boundaryExecution?.beforeModel(state.usage.modelCalls);
      if (state.runtimeModel) return undefined; // Native CLI owns its model transport; never prepare another provider route.
      const result = await track(state, Promise.resolve().then(() => { assertLive(); return input.provider.prepareTurn?.(history, signal); }));
      assertLive(); return result;
    },
    async turn(args) {
      assertLive();
      if (!state.started) throw new Error("Workspace model requires the governed entry");
      if (args.signal?.aborted || (binding.budget.mode !== "interactive" && (state.usage.modelCalls >= binding.budget.maxRounds
        || state.usage.inputTokens + state.usage.outputTokens >= binding.budget.maxTokens))) throw new Error("Workspace model budget exhausted or cancelled");
      if (state.interaction?.check(state.interactionUsage?.() ?? state.usage, Date.now() - started)) throw new Error("Workspace is waiting for user input; model not dispatched");
      state.resetRoundClock?.();
      state.boundaryExecution?.beforeModel(state.usage.modelCalls);
      publishUsage(state, { modelCalls: 1 });
      const auditIndex = state.audit.start("model", state.usage.modelCalls, "provider"), callStarted = performance.now();
      const endStage = runtimeStageObserve(state, () => state.runtimeStages?.beginEvent("model_roundtrip", { call: state.usage.modelCalls }));
      let outcome: "completed" | "error" | "cancelled" = "error", errorKind: WorkspaceExecutionError = "thrown", status: number | null = null;
      let stageError = runtimeStageErrorKind(undefined);
      const observation = { modelCall: state.usage.modelCalls, systemChars: args.system.length, toolSchemaChars: JSON.stringify(args.tools).length,
        systemAndToolsUtf8Bytes: Buffer.byteLength(args.system + JSON.stringify(args.tools)), modelHistoryChars: historyChars(args.history), wakeChars: state.wakeChars,
        ...(state.contextStats ?? { compacted: false, originalChars: historyChars(args.history), recentChars: historyChars(args.history), summaryChars: 0, toolMaxChars: 0, agedToolMaxChars: 0 }) };
      const revoked = new AbortController();
      const signals = [input.signal, revoked.signal, ...(args.signal ? [args.signal] : [])];
      const forward = <A extends unknown[]>(fn: ((...values: A) => void) | undefined) => (...values: A): void => {
        if (!fn || revoked.signal.aborted || args.signal?.aborted) return;
        try { assertLive(); fn(...values); } catch { revoked.abort(); }
      };
      let lastActivityAt = -Infinity;
      const forwardActivity = forward(args.onActivity);
      const guardedArgs = { ...args, signal: AbortSignal.any(signals), onText: forward((chunk: string) => {
        // A native MCP handoff is a governor wait, not proof of a model token. Native
        // output is observed by its driver from documented structured events only.
        if (chunk.length && !state.runtimeModel && state.runtimeStages && !state.firstStageToken) {
          state.firstStageToken = true; runtimeStageObserve(state, () => state.runtimeStages?.mark("first_token", "provider_stream"));
        }
        args.onText?.(chunk);
      }),
        onAssistantPreview: forward(args.onAssistantPreview),
        onReasoning: forward(args.onReasoning), onActivity: () => {
          const now = performance.now();
          // Drop redundant payload-free watchdog ticks. Every delivered tick still runs the
          // original fresh check; no cached allow is reused for text, tools or side effects.
          if (now - lastActivityAt < 50) return;
          lastActivityAt = now; forwardActivity();
        }, onRetry: forward((event: ProviderRetryEvent) => {
          state.audit.retry(auditIndex, event);
          runtimeStageObserve(state, () => state.runtimeStages?.markRetry(event.kind === "rate_limit" ? "runtime_rate_limit" : event.kind === "timeout" ? "timeout" : "runtime_network"));
          args.onRetry?.(event);
        }) };
      const operation = Promise.resolve().then(() => { assertLive(); if (guardedArgs.signal.aborted) throw new Error("Workspace model cancelled"); return state.runtimeModel ? state.runtimeModel(guardedArgs) : input.provider.turn(guardedArgs); });
      try {
        const result: TurnResult = await track(state, operation);
        // Even a cancelled/late request consumes its recorded telemetry, but never releases more tools.
        try { if (result.usage) publishUsage(state, runtimeUsageDelta(result.usage, Boolean(state.runtimeModel) && binding.agent.runtimeId === "codex")); }
        finally { input.observeContext?.({ ...observation, input: result.usage?.input ?? null, output: result.usage?.output ?? null,
          inputWarning: (result.usage?.input ?? 0) > 12000 }); }
        assertLive();
        if (result.usage && Number.isSafeInteger(result.usage.input) && result.usage.input >= 0) runtimeStageObserve(state, () => state.runtimeStages?.setContextTokens(result.usage!.input));
        if (binding.budget.mode !== "interactive" && state.usage.inputTokens + state.usage.outputTokens > binding.budget.maxTokens) {
          errorKind = "budget_exhausted"; throw new Error("Workspace token telemetry safety ceiling reached");
        }
        outcome = result.stop === "error" ? "error" : "completed"; errorKind = result.stop === "error" ? "provider_error" : null;
        stageError = runtimeStageErrorKind(result.errorMetadata?.code ?? result.errorMsg);
        status = result.errorMetadata?.status ?? null;
        return result;
      } finally {
        if (input.signal.aborted || args.signal?.aborted || revoked.signal.aborted) { outcome = "cancelled"; errorKind = "cancelled"; }
        runtimeStageObserve(state, () => endStage?.(outcome, outcome === "error" ? stageError : undefined));
        state.audit.finish(auditIndex, performance.now() - callStarted, outcome, errorKind, status);
      }
    },
  };
  state = { completionEvidence: createWorkspaceCompletionEvidence(input.storage, binding, input.completionRecovery), nativeConversationSafe: true, compactionSource: input.compactionSource, onNativeRisks: input.onNativeRisks, storage: input.storage, assertLive, provider, cwd, managedProject, ...(managedProject ? { managedLegacyRoot: legacyRoot } : {}), hasLegacyToolPolicy: Boolean(input.resources.agents.resolveTask(binding.agent).toolPolicy), stateHome, signal: input.signal, tools: new Set(input.toolNames), usage: { ...input.usage },
    updateUsage: input.updateUsage, pending: new Set(), lease: input.lease, retired: false, started: false, wakeChars: 0,
    interaction: input.interaction, onQuestion: input.onQuestion, onInteractionChanged: input.onInteractionChanged, interactionUsage: input.interactionUsage, startedAt: started, toolTail: Promise.resolve(),
    audit: new WorkspaceExecutionAudit(input.storage, binding.runId, binding.agent.agentId),
    runtimeStages: input.runtimeStages, messageTiming: input.messageTiming, firstStageToken: false, onRuntimeStageChanged: input.onRuntimeStageChanged,
    ...(input.modelHistory ? { modelHistory: { ...input.modelHistory,
      prefixDigest: createHash("sha256").update(canonical(input.modelHistory.history.slice(0, input.modelHistory.start))).digest("hex") } } : {}) };
  for (const value of Object.values(state.usage)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid Workspace persisted usage");
  if (Object.hasOwn(input, "agentBoundary")) state.boundaryExecution = bindAgentBoundaryExecution(input.agentBoundary, binding, state.completionEvidence);
  else if (state.completionEvidence.requiresAgentBoundary) throw new Error("Workspace run requires its original C2 authority; no legacy fallback was started");
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
  state.boundaryExecution?.assertTools(input.extraTools ?? []);
  const extraTools = input.extraTools?.map(tool => {
    if (!state.tools.has(tool.name) || ["task_intake", "task_checkpoint", "todo_write"].includes(tool.name)
      || (tool.kind === "exec" || tool.kind === "computer") && !isWorkspaceExtensionTool(tool)) throw new Error("unscoped Workspace extra tool");
    return Object.freeze(decorateWorkspaceExtensionTool(tool, { ...tool }));
  }) ?? [];
  const options: RunOpts = { ...input, ctx: Object.freeze({ ...input.ctx, stateHome: state.stateHome, writeBoundary: state.cwd,
    ...(input.ctx.ui ? { ui: Object.freeze({ ...input.ctx.ui }) } : {}) }),
    taskIntake: Object.freeze({ ...input.taskIntake }), extraTools: Object.freeze(extraTools) as unknown as Tool[],
    systemOverrideParts: input.systemOverrideParts
      ? Object.freeze(input.systemOverrideParts.map(part => Object.freeze({ ...part }))) : undefined,
    provider: state.provider, workspaceRun: permit, toolFilter: name => state.tools.has(name), autoContinue: false,
    maxRounds: permit.binding.budget.maxRounds, timeoutMs: permit.binding.budget.timeoutMs };
  state.options = options;
  assertWorkspaceRunAdmission(permit, options, permit.binding.agent.runtimeId);
  return Object.freeze(options);
}

export function assertWorkspaceRunAdmission(permit: unknown, options: RunOpts, runtimeId: string): void {
  const state = stateOf(permit), binding = (permit as WorkspaceRunPermit).binding, pinned = state.options;
  state.assertLive();
  if (!pinned || options.workspaceRun !== permit || runtimeId !== binding.agent.runtimeId
    || options.provider !== state.provider || options.taskIntake !== pinned.taskIntake || options.extraTools !== pinned.extraTools
    || options.toolFilter !== pinned.toolFilter || options.hooks !== false || options.guardian || options.fallback
    || options.ctx.cwd !== state.cwd || options.ctx.sessionId !== binding.sessionId || options.ctx.stateHome !== state.stateHome
    || options.ctx.spaceId !== undefined || options.ctx.profileId !== undefined || options.signal !== state.signal
    || options.systemOverride !== pinned.systemOverride || options.systemOverrideParts !== pinned.systemOverrideParts
    || options.memory !== pinned.memory || options.projectContext !== pinned.projectContext
    || options.approval !== pinned.approval || options.approvalChannel !== pinned.approvalChannel || options.confirm !== pinned.confirm
    || options.ctx.ui !== pinned.ctx.ui || options.ctx.ask !== pinned.ctx.ask || options.ctx.todoScope !== pinned.ctx.todoScope
    || options.ctx.writeBoundary !== pinned.ctx.writeBoundary || options.ctx.spawn || options.ctx.agentTeam
    || options.ctx.inspectImage || options.ctx.describeImage || options.ctx.locate || options.ctx.toolImageMode) {
    throw new Error("Workspace execution options do not match the trusted Host permit");
  }
}
/** Trusted native Runtime composition only: one immutable model transport before admission is consumed.
 * The existing provider wrapper retains liveness, accounting, audit, cancellation and physical tracking. */
export function attachWorkspaceRuntimeModel(permit: WorkspaceRunPermit, options: RunOpts, runtimeId: "codex" | "claude" | "gemini" | "kimi",
  execute: (args: TurnArgs) => Promise<TurnResult>): void {
  assertWorkspaceRunAdmission(permit, options, runtimeId);
  const state = stateOf(permit);
  if ((!["codex", "claude", "gemini", "kimi"].includes(runtimeId)) || state.started || state.runtimeModel || typeof execute !== "function") {
    throw new Error("Workspace Runtime model transport is unavailable or already attached");
  }
  state.boundaryExecution?.assertNativeUnavailable();
  state.runtimeModel = execute;
}
export function beginWorkspaceGovernedRun(permit: WorkspaceRunPermit, options: RunOpts, runtimeId: string): void {
  assertWorkspaceRunAdmission(permit, options, runtimeId);
  const state = stateOf(permit);
  if (state.started) throw new Error("Workspace attempt permit was already consumed; obtain a fresh admitted attempt");
  state.started = true;
}
export function workspaceRunToolAllowed(permit: WorkspaceRunPermit, name: string): boolean { return stateOf(permit).tools.has(name); }
/** Imported role policies grant only their scoped Hara tools, never an extra native shell. */
export function workspaceRunHasLegacyToolPolicy(permit: WorkspaceRunPermit): boolean {
  const state = stateOf(permit); state.assertLive(); return state.hasLegacyToolPolicy;
}
/** Trusted native transport composition; never derived from a renderer path or the foreground scope. */
export function workspaceRuntimeStorage(permit: WorkspaceRunPermit): WorkspaceResourceStorage {
  const state = stateOf(permit); state.assertLive(); return state.storage;
}
/** Trusted Host facts, rechecked at use. Never exposed as a model/renderer capability. */
export function workspaceCompactionSource(permit: WorkspaceRunPermit): WorkspaceConversation | null {
  const state = stateOf(permit); state.assertLive(); return state.compactionSource?.() ?? null;
}
/** Native context reset is independent from UI history and task budgets. Boundaries retain absolute indices. */
export function workspaceNativeSessionBoundary(permit: WorkspaceRunPermit, historyLength: number) {
  const state = stateOf(permit); state.assertLive(); const binding = permit.binding;
  return resettableNativeRuntime(binding.agent.runtimeId)
    ? new WorkspaceNativeSessions(state.storage, binding.agent.agentId, binding.sessionId).latest(binding.agent.runtimeId, historyLength) : null;
}
/** Reserve the separate native maintenance dispatch before effects; the ordinary turn is already reserved. */
export function reserveWorkspaceCompaction(permit: WorkspaceRunPermit): ((ok: boolean, kind?: import("../agent-runtime/failure-diagnostics.js").RuntimeFailureKind) => void) | null {
  const state = stateOf(permit); state.assertLive();
  const limits = permit.binding.budget;
  if (!state.started || state.signal.aborted) throw new Error("Workspace compaction is not admitted");
  if (limits.mode !== "interactive" && (state.usage.modelCalls >= limits.maxRounds
    || state.usage.inputTokens + state.usage.outputTokens >= limits.maxTokens)) return null;
  if (state.interaction?.check(state.interactionUsage?.() ?? state.usage, Date.now() - state.startedAt)) return null;
  state.resetRoundClock?.();
  publishUsage(state, { modelCalls: 1 });
  const index = state.audit.start("model", state.usage.modelCalls, "context_compaction"), began = performance.now();
  const end = runtimeStageObserve(state, () => state.runtimeStages?.beginEvent("model_roundtrip", { call: state.usage.modelCalls }));
  let ended = false;
  return (ok, kind) => {
    if (ended) return; ended = true;
    runtimeStageObserve(state, () => end?.(ok ? "completed" : "error", ok ? undefined : kind ?? "runtime_failed"));
    state.audit.finish(index, performance.now() - began, ok ? "completed" : "error", ok ? null : "provider_error", null);
  };
}
/** Charge observed native telemetry even when cancellation prevented another provider boundary. */
export function recordWorkspaceRuntimeUsage(permit: WorkspaceRunPermit, usage: TurnResult["usage"]): void {
  const state = stateOf(permit);
  if (usage) publishUsage(state, runtimeUsageDelta(usage, Boolean(state.runtimeModel) && permit.binding.agent.runtimeId === "codex"));
}
/** Native inference can make progress between virtual governor boundaries. Stop on observed overage
 * immediately; accounting still travels through the ordinary provider result or final drain. */
export function assertWorkspaceRuntimeUsage(permit: WorkspaceRunPermit, pending: { input: number; output: number; cachedInput?: number }): void {
  const state = stateOf(permit); state.assertLive();
  const delta = runtimeUsageDelta(pending, permit.binding.agent.runtimeId === "codex");
  if (!Number.isSafeInteger(pending.input) || !Number.isSafeInteger(pending.output) || pending.input < 0 || pending.output < 0
    || (permit.binding.budget.mode !== "interactive" && state.usage.inputTokens + state.usage.outputTokens + delta.inputTokens! + pending.output > permit.binding.budget.maxTokens)) {
    throw new Error("Workspace native token telemetry safety ceiling reached");
  }
}
/** Trusted Host composition may retain a long instruction reference before options are pinned. */
/** WeakMap-backed permit is required; an arbitrary option or renderer flag cannot enable this. */
export function bindWorkspaceRoundClock(permit: WorkspaceRunPermit, reset: () => void): () => void {
  const state = stateOf(permit); state.assertLive();
  if (state.resetRoundClock) throw new Error("Workspace round clock already bound");
  if (permit.binding.budget.mode === "interactive") state.resetRoundClock = reset;
  return () => { if (state.resetRoundClock === reset) state.resetRoundClock = undefined; };
}
export function workspaceRunIsInteractive(permit: WorkspaceRunPermit): boolean {
  const state = stateOf(permit); state.assertLive(); return permit.binding.budget.mode === "interactive";
}
export function assertWorkspaceRunContextCurrent(permit: WorkspaceRunPermit): void { stateOf(permit).assertLive(); }
export function prepareWorkspaceRunHistory(permit: WorkspaceRunPermit, history: NeutralMsg[], modelTranscript?: NeutralMsg[]): NeutralMsg[] {
  const state = stateOf(permit); state.assertLive();
  if (!state.started) throw new Error("Workspace model context requires the governed entry");
  const pinned = state.modelHistory;
  if (!pinned) return modelTranscript ?? history; // Existing trusted non-Host fixtures already contain one attempt only.
  if (history !== pinned.history || createHash("sha256").update(canonical(history.slice(0, pinned.start))).digest("hex") !== pinned.prefixDigest) {
    throw new Error("Workspace durable history prefix changed; model request refused");
  }
  // Validate the original durable prefix first. The run-only overlay retains the current user
  // object, so removing legacy internal rows or adding feedback cannot shift the task boundary.
  const source = modelTranscript ?? history;
  const start = modelTranscript ? source.indexOf(history[pinned.start]!) : pinned.start;
  const projected = workspaceTaskProjection(source, start, { usedTokens: pinned.usedTokens?.() ?? state.usage.inputTokens + state.usage.outputTokens,
    maxTokens: permit.binding.budget.maxTokens, task: state.options?.taskIntake?.current?.(), retain: pinned.retain });
  state.contextStats = projected.stats; return projected.history;
}
export function prepareWorkspaceRunWakeBrief(permit: WorkspaceRunPermit): string {
  const state = stateOf(permit); state.assertLive();
  const task = state.options?.taskIntake?.current?.() ?? state.options?.taskIntake?.task;
  if (!state.started || !task) throw new Error("Workspace wake context requires the governed task");
  const brief = workspaceWakeData(task, state.modelHistory?.retain); state.wakeChars = brief.length; return brief;
}
/** Called at a closed-history boundary, before another model request or tool batch. */
export function workspaceRunQuestion(permit: WorkspaceRunPermit): WorkspaceUserQuestion | null {
  const state = stateOf(permit);
  if (state.retired || state.signal.aborted) return null;
  const question = state.interaction?.check(state.interactionUsage?.() ?? state.usage, Date.now() - state.startedAt) ?? null;
  if (question) state.onQuestion?.(question);
  return question;
}
/** Read-only completion must not close a turn while a user question/card is still open. */
export function workspaceRunHasPendingInteraction(permit: WorkspaceRunPermit): boolean {
  const state = stateOf(permit);
  if (state.retired || state.signal.aborted) return true;
  return Boolean(state.interaction?.question() || state.interaction?.pendingInteractions().length);
}
/** ask_user enters the same run-bound ask channel as the observation gates. sync retains the one
 * blocking question; async posts a card and lets non-interactive work continue. */
export function workspaceRunAsk(permit: WorkspaceRunPermit, input: { question: string; header?: string; options: string[] },
  delivery: "sync" | "async"): WorkspaceUserQuestion | null {
  const state = stateOf(permit); state.assertLive();
  if (!state.interaction) return null;
  const question = delivery === "async"
    ? state.interaction.requestAsync(input.question, input.options, input.header)
    : state.interaction.request("explicit", input.question, input.options, input.header ? { header: input.header } : {});
  state.onInteractionChanged?.(); return question;
}
/** Answers to async questions that arrived since the last boundary, as user turns for the model. */
export function workspaceRunAsyncAnswers(permit: WorkspaceRunPermit): NeutralMsg[] {
  const state = stateOf(permit);
  if (state.retired || state.signal.aborted || !state.interaction) return [];
  return state.interaction.drainAsyncAnswers().map(row => ({ role: "user" as const,
    content: `Answer to your earlier async question "${row.question}" (question id ${row.id}):\n${row.answer}` }));
}
export function workspaceRunBeginToolBatch(permit: WorkspaceRunPermit, names: readonly string[]): void {
  stateOf(permit).interaction?.beginBatch(names);
}
export function executeWorkspaceTool<T>(permit: WorkspaceRunPermit, name: string, execute: (input?: unknown) => Promise<T>, toolFailed?: (result: T) => boolean, toolInput?: unknown, toolCallId?: string): Promise<T> {
  const state = stateOf(permit); state.assertLive();
  // Serialize the governed dispatch boundary, including read lookups. A third queued search or a
  // sibling write cannot run past the second result that required a real user's answer.
  const operation = state.toolTail.then(async () => {
    state.assertLive();
    if (!state.started || !state.tools.has(name) || (permit.binding.budget.mode !== "interactive" && state.usage.toolCalls >= permit.binding.budget.maxToolCalls)) throw new Error("Workspace tool unavailable or budget exhausted");
    if (name !== "ask_user" && state.interaction?.check(state.interactionUsage?.() ?? state.usage, Date.now() - state.startedAt)) throw new Error("Workspace is waiting for user input; tool not dispatched");
    state.interaction?.admit(name);
    publishUsage(state, { toolCalls: 1 });
    const auditIndex = state.audit.start("tool", state.usage.toolCalls, name), callStarted = performance.now();
    const targetLabel = runtimeToolTargetLabel(name, toolInput);
    const endStage = runtimeStageObserve(state, () => state.runtimeStages?.beginEvent("tool_call", { call: state.usage.toolCalls, toolName: name, ...(targetLabel ? { targetLabel } : {}) }));
    let outcome: "completed" | "error" | "cancelled" = "error", errorKind: WorkspaceExecutionError = "thrown";
    try {
      state.assertLive();
      const result = state.boundaryExecution
        ? await state.boundaryExecution.runTool(name, toolInput, toolCallId, input => execute(input), toolFailed)
        : await execute(toolInput);
      const failed = Boolean(toolFailed?.(result) || (typeof result === "string" && /^Error:/i.test(result)));
      state.interaction?.observe(name, result, failed);
      outcome = failed ? "error" : "completed"; errorKind = failed ? "tool_error" : null; return result;
    } catch (error) {
      state.interaction?.observe(name, undefined, true); throw error;
    } finally {
      if (state.signal.aborted) { outcome = "cancelled"; errorKind = "cancelled"; }
      runtimeStageObserve(state, () => endStage?.(outcome, outcome === "error" ? "runtime_failed" : undefined));
      state.audit.finish(auditIndex, performance.now() - callStarted, outcome, errorKind);
    }
  });
  state.toolTail = operation.then(() => undefined, () => undefined);
  return track(state, operation);
}
/** Observation only, from the real private runtime state. Not accepted from task/RPC JSON. */
export function workspaceRunEffectFacts(permit: WorkspaceRunPermit) {
  const state = stateOf(permit);
  let operations: ReturnType<WorkspaceExecutionAudit["read"]>["operations"] | null;
  try { operations = state.audit.read().operations; } catch { operations = null; }
  return deepFreeze({ binding: permit.binding, attemptId: state.lease.attemptId, started: state.started,
    modelCalls: state.usage.modelCalls, toolCalls: state.usage.toolCalls,
    effects: state.completionEvidence.effectReceipts(), operations });
}
const drainProofs = new WeakMap<object, Readonly<ReturnType<typeof workspaceRunEffectFacts> & { proofRef: string }>>();
export function workspaceRunDrainProof(permit: WorkspaceRunPermit): WorkspaceRunDrainProof {
  const proof = stateOf(permit).drainProof;
  if (!proof) throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.drainProof"); return proof;
}
export function workspaceRunDrainFacts(proof: unknown) {
  const facts = proof && typeof proof === "object" ? drainProofs.get(proof) : undefined;
  if (!facts) throw new AgentBoundaryContractError("AUTHORITY_UNVERIFIED", "control.drainProof"); return facts;
}
export async function closeWorkspaceRunPermit(permit: WorkspaceRunPermit): Promise<void> {
  const state = stateOf(permit); if (state.drainProof) return; state.retired = true;
  while (state.pending.size) await Promise.allSettled([...state.pending]);
  if (state.nativePolicy) {
    state.lease.setDraining(true);
    const policy = state.nativePolicy;
    // A failed native teardown never releases the physical lease or silently reuses a resident.
    const { endWorkspaceNativePolicy } = await import("../agent-runtime/workspace-native-policy.js");
    await endWorkspaceNativePolicy(permit, policy, { keepResidentRoot: false }); await policy.close();
    state.lease.setDraining(false);
  }
  state.boundaryExecution?.close();
  state.lease.release();
  const proof = Object.freeze({}) as WorkspaceRunDrainProof;
  drainProofs.set(proof, deepFreeze({ ...workspaceRunEffectFacts(permit), proofRef: `drain_${randomUUID()}` }));
  state.drainProof = proof;
}

/** Observation only. Callers retain the original live checks at protected boundaries. */
export function observeWorkspaceMessageTiming(permit: WorkspaceRunPermit, point: Exclude<MessageTimingPoint, "T0" | "T1" | "T7">, at?: number): void {
  const state = stateOf(permit);
  if (!state.retired && !state.signal.aborted) try {
    const observed = state.messageTiming?.mark(point, at);
    // T8 is a live observation, not durable completion. Publish it before the T9 drain/commit.
    if (point === "T8" && observed) state.onRuntimeStageChanged?.();
  } catch { /* Optional diagnostics. */ }
}

/** Diagnostics never confer execution authority or make an observer failure a task failure. */
function runtimeStageObserve<T>(state: PermitState, observe: () => T): T | undefined {
  if (state.retired || !state.runtimeStages) return undefined;
  try { const value = observe(); state.onRuntimeStageChanged?.(); return value; } catch { return undefined; }
}
/** Only a real Host permit may attach native lifecycle metadata. No renderer identity is accepted. */
export function workspaceRunRuntimeStages(permit: WorkspaceRunPermit): RuntimeStageRecorder | undefined {
  const state = stateOf(permit); state.assertLive(); return state.runtimeStages;
}

/** Host composition only. Serialized events and model tool inputs cannot install a policy. */
export function attachWorkspaceNativePolicy(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy): void {
  const state = stateOf(permit); state.assertLive();
  if (state.nativePolicy && state.nativePolicy !== policy) throw new Error("A native process already owns this attempt");
  if (policy.runtimeId !== permit.binding.agent.runtimeId || policy.tier !== (permit.binding.agent.permissionTier ?? "controlled")) throw new Error("Native policy does not match the frozen runtime and permission tier");
  if (policy.workRoot !== state.cwd) throw new Error("Native working directory does not match the admitted project");
  state.nativePolicy = policy; state.nativeEvidence = undefined; state.nativeConversationSafe = false;
}
/** Host-only proof for a tool-free greeting/self-introduction after native settle and drain. */
export function workspaceRunCanCompleteConversation(permit: WorkspaceRunPermit): boolean {
  const state = stateOf(permit); state.assertLive();
  return state.usage.toolCalls === 0 && !state.nativePolicy && state.nativeConversationSafe;
}
export function workspaceRunNativeEvidence(permit: WorkspaceRunPermit): NativeWorkspaceEvidence | null {
  const state = stateOf(permit); state.assertLive();
  if (state.nativePolicy) state.nativeEvidence = state.nativePolicy.collectWorkspaceEvidence() ?? undefined;
  return state.nativeEvidence ? structuredClone(state.nativeEvidence) : null;
}
export function publishWorkspaceNativeRisks(permit: WorkspaceRunPermit): void {
  const state = stateOf(permit), policy = state.nativePolicy;
  if (!policy) return;
  const risks = policy.risks.map(row => ({ ...row }));
  if (JSON.stringify(risks) !== JSON.stringify(state.nativeRisks)) {
    state.nativeRisks = risks; state.onNativeRisks?.(risks);
  }
}
/** Called before policy cleanup, including cancellation; collection never makes a retired permit live. */
export function finishWorkspaceNativePolicy(permit: WorkspaceRunPermit, policy: RuntimeExecutionPolicy): void {
  const state = stateOf(permit);
  if (state.nativePolicy !== policy) return;
  try { state.nativeEvidence = policy.collectWorkspaceEvidence() ?? undefined; state.nativeConversationSafe = typeof policy.canCompleteConversation === "function" && policy.canCompleteConversation(); publishWorkspaceNativeRisks(permit); }
  finally { state.nativePolicy = undefined; }
}

/** Native Pi tool batches are issued by the Host model bridge, never inferred from CLI success text. */
export function recordWorkspacePiNativeCalls(permit: WorkspaceRunPermit, names: readonly string[]): void {
  const state = stateOf(permit); state.assertLive();
  const native = new Set(["read", "bash", "edit", "write"]);
  if (!state.started || !state.nativePolicy || permit.binding.agent.runtimeId !== "pi" || names.some(name => !native.has(name)) || names.length > 256
    || (permit.binding.budget.mode !== "interactive" && state.usage.toolCalls + names.length > permit.binding.budget.maxToolCalls)) throw new Error("Workspace native Pi tool budget exhausted");
  if (names.length) publishUsage(state, { toolCalls: names.length });
}

/** Trusted Host permit only. The model cannot supply or restore a provenance journal. */
export function workspaceRunCompletionEvidence(permit: WorkspaceRunPermit): CompletionEvidenceLedger {
  const state = stateOf(permit); state.assertLive(); return state.completionEvidence;
}
