import { CodexContextCompaction, NativeCompactionError } from "./context-compaction.js";
import { WorkspaceContextCompactions, compactionSourceKey, contextSummary, contextSummaryPrompt } from "../workspace/context-compaction.js";
import { workspaceCompactionSource, reserveWorkspaceCompaction, recordWorkspaceRuntimeUsage } from "../workspace/execution.js";
import { ResidentWorkspaceMcp, residentMcpToolsSupported, WORKSPACE_ATTEMPT_MARKER } from "./registered-cli-resident-mcp.js";
import { createAssistantPreview } from "./assistant-preview.js";
import { observeWorkspaceMessageTiming } from "../workspace/execution.js";
import { runtimeErrorFirstLine } from "../security/runtime-error.js";
import { classifyRuntimeFailure, type RuntimeFailureKind, type RuntimeRpcDiagnostic } from "./failure-diagnostics.js";
import { createRuntimeExecutionPolicy, type RuntimeExecutionPolicy } from "./execution-policy.js";
import { beginWorkspaceNativePolicy, endWorkspaceNativePolicy, observeWorkspaceNativeItem, workspaceRuntimePolicyInput, workspaceRuntimeProcessKey } from "./workspace-native-policy.js";
import { codexHostToolOverrides } from "./codex-host-config.js";
import { workspaceRunRuntimeStages } from "../workspace/execution.js";
// Native protocol facts may persist. Tool capabilities always belong to one immutable attempt.
// A loaded handle is not an authority grant; current policy preparation and Host fences remain mandatory.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { JsonlRpcClient, ExternalJsonlRpcRequestError, ExternalJsonlRpcTransportError, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { canonical, plain } from "../workspace/local-state.js";
import type { WorkspaceResourceStorage } from "../workspace/resource-context.js";
import { codexThreadState, recordCodexEmptyThreadReset, codexConversationKey, nativeContextFull, nativeCodexId as nativeId, nativeTokenCount as count, type CodexThreadState } from "../workspace/codex-thread.js";
import { assertWorkspaceRuntimeUsage, workspaceRuntimeStorage, type WorkspaceRunPermit } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import { inspectLocalRuntime } from "../workspace/runtime-detect.js";
import type { ToolResult, TurnArgs, TurnResult } from "../providers/types.js";
import { createWorkspaceMcpEndpoint, WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint, type WorkspaceMcpAttemptInput } from "./registered-cli-mcp.js";

const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => plain(value) ? value : {};
/** Documented agentMessage is visible prose even when legacy providers omit its phase.
 * Require its real typed item first; unknown future phases never become preview text. */
export function codexVisibleAgentMessage(value: unknown): value is { type: "agentMessage"; id: string; text: string; phase?: null | "partial_answer" | "final_answer" } {
  const item = object(value);
  return item.type === "agentMessage" && nativeId(item.id) && typeof item.text === "string"
    && (item.phase === undefined || item.phase === null || item.phase === "partial_answer" || item.phase === "final_answer");
}
/** Stable policy changes refresh the native context; turn-clock/checkpoint text travels every turn. */
export function codexStandingContext(args: Pick<TurnArgs, "system" | "systemParts">, _model: string | null, _effort: string | null,
  tier: string, configRevision: number) {
  const standingParts = args.systemParts?.filter(part => part.stability !== "turn") ?? [];
  const turnParts = args.systemParts?.filter(part => part.stability === "turn") ?? [];
  const standing = standingParts.length ? standingParts.map(part => part.content).join("\n\n") : args.system;
  return { standing, turnParts, digest: hash([standing, tier, configRevision]) };
}
const origin = (resolved: ReturnType<WorkspaceRuntimeInstaller["resolveBound"]>, project: unknown): string =>
  hash([resolved.command, inspectLocalRuntime(resolved.command)?.fingerprint ?? null, resolved.loginSource,
    resolved.env.HOME ?? null, resolved.env.CODEX_HOME ?? null, project]);
const MAX_RESIDENT = 4, IDLE_MS = 5 * 60_000;
interface ActiveTurn {
  id?: string; ready: Promise<string>; bind(id: string): void;
  finish(ok: boolean, code?: string, kind?: RuntimeFailureKind, firstLine?: string, rpc?: RuntimeRpcDiagnostic): void; done: Promise<void>;
  activity(): void; assertCurrent(): void;
  text: string; settled: boolean;
  rawTokenObserved?: boolean; visibleItems: Map<string, boolean>; previewItem?: string; preview?: ReturnType<typeof createAssistantPreview>;
  previewOutput?: TurnArgs["onAssistantPreview"]; previewEnv: NodeJS.ProcessEnv;
  seedRecord?: string;
  standingHash: string | null; compacted: boolean; partDigests: Map<string, string>;
}
const pools = new WeakMap<WorkspaceRuntimeInstaller, CodexSessionPool>();

/** The installer is scope-owned and outlives a single AgentRuntimeRegistry or task. */
export function codexSessionPool(installer: WorkspaceRuntimeInstaller): CodexSessionPool {
  let pool = pools.get(installer);
  if (!pool) {
    pool = new CodexSessionPool(installer); pools.set(installer, pool);
    const owned = pool;
    installer.ownNativeResource(async () => { await owned.close(); pools.delete(installer); });
  }
  return pool;
}

export class CodexSessionPool {
  private readonly sessions = new Map<string, GovernedCodexSession>();
  private closed = false;
  private admission: Promise<void> = Promise.resolve();
  constructor(private readonly installer: WorkspaceRuntimeInstaller) {}
  async acquire(permit: WorkspaceRunPermit, assertCurrent: () => void): Promise<GovernedCodexSession> {
    const prior = this.admission;
    let unlock!: () => void; this.admission = new Promise(resolve => { unlock = resolve; });
    await prior;
    try { return await this.acquireCurrent(permit, assertCurrent); } finally { unlock(); }
  }
  private async acquireCurrent(permit: WorkspaceRunPermit, assertCurrent: () => void): Promise<GovernedCodexSession> {
    assertCurrent();
    if (this.closed) throw new Error("Codex session pool is closed");
    const b = permit.binding, identity = b.agent.resourceBinding;
    const key = codexConversationKey(identity, b.agent.agentId, b.sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= MAX_RESIDENT) {
        const idle = [...this.sessions.entries()].filter(([, row]) => !row.busy).sort((a, z) => a[1].lastUsed - z[1].lastUsed)[0];
        if (!idle) throw new Error("Codex resident session limit reached; active work was preserved");
        await idle[1].dispose(); this.sessions.delete(idle[0]);
      }
      assertCurrent(); if (this.closed) throw new Error("Codex session pool is closed");
      session = new GovernedCodexSession(this.installer, permit, () => { if (this.sessions.get(key) === session) this.sessions.delete(key); });
      this.sessions.set(key, session);
    }
    session.claim(permit, assertCurrent); return session;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => session.dispose())); this.sessions.clear();
  }
  /** Host holds this conversation's physical lease while retiring its idle native process. */
  async forget(storage: WorkspaceResourceStorage, agentId: string, sessionId: string): Promise<void> {
    const key = codexConversationKey(codexThreadState(storage, agentId, sessionId).binding(), agentId, sessionId);
    const session = this.sessions.get(key);
    if (session?.busy) throw new Error("Codex conversation is busy or draining; reset refused");
    if (session) await session.dispose();
  }
}

export class GovernedCodexSession {
  token = randomBytes(32).toString("hex");
  busy = false;
  lastUsed = Date.now();
  private client?: JsonlRpcClient;
  private policy?: RuntimeExecutionPolicy;
  private processKey?: string;
  private exit?: Promise<void>;
  private active?: ActiveTurn;
  private maintenance?: CodexContextCompaction;
  private readonly endpointMaintenance = new WeakMap<WorkspaceMcpEndpoint, { suspend(): Promise<boolean>; resume(): void }>();
  private readonly compactions: WorkspaceContextCompactions;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private unload?: () => void;
  private loaded = false;
  private closing = false;
  private residentMcp?: ResidentWorkspaceMcp;
  private residentToken?: string;
  private attemptEndpoint?: WorkspaceMcpEndpoint;
  private settling?: Promise<void>;
  private nativeSucceeded = false;
  private loadedContract?: string;
  /** Created only after a real native start/resume response passes every existing check. */
  private loadedHandle?: Readonly<{ id: string; cwd: string; client: JsonlRpcClient }>;
  private readonly state: ReturnType<typeof codexThreadState>;
  private value: CodexThreadState;
  private pendingUsage = { input: 0, output: 0, cachedInput: 0 };
  private observedUsage = false;
  private firstUsage = true;
  private systemDigests = new Map<string, string>();
  private readonly origin: string;
  private readonly mcpName: string;
  private readonly project: { root: string; dev: string | number; ino: string | number };
  constructor(private readonly installer: WorkspaceRuntimeInstaller, private permit: WorkspaceRunPermit, private readonly evict: () => void) {
    const b = permit.binding, resolved = installer.resolveBound("codex");
    this.mcpName = "hara_workspace_" + createHash("sha256").update(b.sessionId).digest("hex").slice(0, 24);
    this.project = { ...b.project };
    this.origin = origin(resolved, b.project);
    this.state = codexThreadState(workspaceRuntimeStorage(permit), b.agent.agentId, b.sessionId, this.origin);
    this.value = this.state.read();
    this.compactions = new WorkspaceContextCompactions(workspaceRuntimeStorage(permit), b.agent.agentId, b.sessionId);
    if (this.value.threadId !== null && this.value.origin !== this.origin) throw new Error("Saved Codex thread belongs to a different login or project origin; no fallback was selected");
    if (this.value.threadId === null) this.value.origin = this.origin;
  }
  claim(permit: WorkspaceRunPermit, assertCurrent: () => void): void {
    assertCurrent();
    if (this.busy || this.closing) throw new Error("Codex conversation is busy or draining; no second writer was started");
    this.settling = undefined; this.attemptEndpoint = undefined; this.nativeSucceeded = false;
    this.permit = permit; this.busy = true; clearTimeout(this.idleTimer); this.idleTimer = undefined;
    if (!this.client) this.token = randomBytes(32).toString("hex");
    this.pendingUsage = { input: 0, output: 0, cachedInput: 0 }; this.observedUsage = false; this.firstUsage = true;
    this.value.lastAttempt = { input: 0, output: 0, cachedInput: 0 };
  }
  async createEndpoint(input: WorkspaceMcpAttemptInput): Promise<WorkspaceMcpEndpoint> {
    input.assertCurrent();
    if (!this.busy || this.closing) throw new Error("Codex attempt unavailable");
    if (!residentMcpToolsSupported(input)) return createWorkspaceMcpEndpoint({ ...input, bearerToken: this.token });
    const attempt = Object.freeze({ ...input }), token = this.token;
    const env: NodeJS.ProcessEnv = { [WORKSPACE_MCP_TOKEN_ENV]: token };
    let inner: WorkspaceMcpEndpoint | undefined, preparedFor: string | undefined, preparing: Promise<void> | undefined, closed = false;
    // One assignment for this immutable attempt, never a pointer to a later attempt's capability.
    const endpoint: WorkspaceMcpEndpoint = Object.freeze({
      get url() { if (!inner || closed) throw new Error("Codex MCP attempt is not prepared"); return inner.url; },
      get attemptMarker() { return closed ? undefined : inner?.attemptMarker; }, env,
      prepare: (contract: string): void | Promise<void> => {
        attempt.assertCurrent();
        if (closed || !this.busy || this.closing || token !== this.token || !/^[a-f0-9]{64}$/.test(contract)) throw new Error("Codex MCP attempt unavailable");
        if (preparedFor !== undefined) { if (preparedFor !== contract) throw new Error("Codex MCP contract changed"); return preparing; }
        preparedFor = contract;
        const reusable = this.residentMcp?.reusable && this.residentToken === token && this.loadedContract === contract
          && this.client && this.loadedHandle?.client === this.client && this.loadedHandle.id === this.value.threadId
          && this.loadedHandle.cwd === this.project.root && this.loaded && this.value.phase === "idle"
          && this.value.contextGeneration && this.value.standingPromptHash;
        if (reusable) { inner = this.residentMcp!.bind(attempt); return; }
        this.loadedContract = undefined;
        preparing = (async () => {
          // Native start/resume may construct a new MCP client. Never reinitialize an old SDK session.
          const previous = this.residentMcp; if (previous) await previous.close();
          if (this.residentMcp === previous) this.residentMcp = undefined;
          attempt.assertCurrent(); if (closed || attempt.signal.aborted) throw new Error("Codex MCP attempt ended");
          const created = await ResidentWorkspaceMcp.create(token);
          try {
            attempt.assertCurrent();
            if (closed || attempt.signal.aborted || !this.busy || this.closing || token !== this.token) throw new Error("Codex MCP attempt ended");
            inner = created.bind(attempt); this.residentMcp = created; this.residentToken = token;
          } catch (error) { await created.close(); throw error; }
        })();
        return preparing;
      },
      close: async () => { closed = true; delete env[WORKSPACE_MCP_TOKEN_ENV]; await preparing?.catch(() => {}); await inner?.close(); },
    });
    this.endpointMaintenance.set(endpoint, {
      suspend: async () => {
        attempt.assertCurrent();
        if (closed || !inner || !this.residentMcp) return false;
        if (!this.residentMcp.retireCurrent()) return false;
        const prior = inner; inner = undefined; await prior.close();
        attempt.assertCurrent(); return !closed && this.residentMcp.reusable;
      },
      resume: () => {
        attempt.assertCurrent();
        if (closed || !this.residentMcp?.reusable || attempt.signal.aborted) throw new Error("Codex compaction binding changed");
        inner = this.residentMcp.bind(attempt);
      },
    });
    return endpoint;
  }

  get needsNewSession(): boolean { return nativeContextFull(this.value); }
  takeUsage(): TurnResult["usage"] {
    if (!this.observedUsage || !this.pendingUsage.input && !this.pendingUsage.output) return undefined;
    const usage = { ...this.pendingUsage }; this.pendingUsage = { input: 0, output: 0, cachedInput: 0 }; return usage;
  }
  decorateResult(result: ToolResult, args: TurnArgs): ToolResult {
    const parts = args.systemParts?.length ? args.systemParts : [{ id: "system", digest: hash(args.system), content: args.system }];
    const changed = parts.filter(part => this.systemDigests.get(part.id) !== part.digest);
    const update = changed.map(part => part.content).join("\n\n");
    return update ? { ...result, content: result.content + "\n\n<system-reminder>\nCurrent Hara governance context (the receipt above is unchanged):\n"
      + update + "\nAvailable tools at this boundary: " + args.tools.map(tool => tool.name).join(", ") + "\n</system-reminder>" } : result;
  }
  private save(): void { this.value = this.state.update(this.value.revision, () => this.value); }
  private observeUsage(params: Record<string, unknown>, maintenance = false): void {
    const usage = object(params.tokenUsage), total = object(usage.total), last = object(usage.last);
    if (!count(total.inputTokens) || !count(total.outputTokens) || !count(last.inputTokens) || !count(last.outputTokens)) throw new Error("Invalid native usage");
    const totalCache = total.cachedInputTokens, lastCache = last.cachedInputTokens;
    if (totalCache !== undefined && (!count(totalCache) || totalCache > total.inputTokens)
      || lastCache !== undefined && (!count(lastCache) || lastCache > last.inputTokens)) throw new Error("Invalid native cache usage");
    if (total.inputTokens === this.value.input && total.outputTokens === this.value.output) return;
    // A cold native counter epoch may restart just *above* the saved watermark. Its output
    // delta cannot then contain even the explicitly reported current request. Do not debit a
    // tiny cross-epoch difference: use that request's last counters, including its cache split.
    const reset = total.inputTokens < this.value.input || total.outputTokens < this.value.output
      || this.firstUsage && total.outputTokens - this.value.output < last.outputTokens;
    if (reset && !this.firstUsage) throw new Error("Native usage regressed");
    const input = reset ? last.inputTokens : total.inputTokens - this.value.input;
    const output = reset ? last.outputTokens : total.outputTokens - this.value.output;
    // Per-attempt cumulative deltas, including its first observation. An explicit cold-counter
    // reset uses the current native request; missing legacy cache baselines never earn credit.
    const cachedInput = reset ? lastCache ?? 0 : count(totalCache) && this.value.cachedInput !== null
      ? totalCache - this.value.cachedInput : input === last.inputTokens ? lastCache ?? 0 : 0;
    if (!count(cachedInput) || cachedInput > input) throw new Error("Native cache usage regressed or exceeded input");
    for (const [key, amount] of Object.entries({ input, output, cachedInput }) as ["input" | "output" | "cachedInput", number][]) {
      if (!Number.isSafeInteger(this.pendingUsage[key] + amount) || !Number.isSafeInteger(this.value.lastAttempt[key] + amount)) throw new Error("Native usage overflow");
      this.pendingUsage[key] += amount; this.value.lastAttempt[key] += amount;
    }
    this.value.input = total.inputTokens; this.value.output = total.outputTokens;
    this.value.cachedInput = count(totalCache) ? totalCache : null;
    const contextTokens = last.inputTokens + last.outputTokens;
    if (!count(contextTokens)) throw new Error("Invalid native context usage");
    if (!maintenance) this.value.contextTokens = contextTokens;
    if (usage.modelContextWindow !== undefined && usage.modelContextWindow !== null) {
      if (!count(usage.modelContextWindow) || !usage.modelContextWindow) throw new Error("Invalid native context window");
      this.value.modelContextWindow = usage.modelContextWindow;
    }
    this.firstUsage = false; this.observedUsage = true;
    assertWorkspaceRuntimeUsage(this.permit, this.pendingUsage);
    if (!maintenance && this.needsNewSession) {
      this.value.phase = "new_session_required"; this.save();
      this.active?.finish(false, "codex_context_limit_open_new_session"); this.client?.close();
    }
  }
  private notification(client: JsonlRpcClient, method: string, params: Record<string, unknown>): void {
    if (this.client !== client || params.threadId !== this.value.threadId) return;
    const observedAt = performance.now();
    if (this.maintenance) {
      try { this.maintenance.observe(method, params); } catch (error) { this.maintenance.fail(new NativeCompactionError("unknown", error)); }
      return;
    }
    if (method === "thread/closed") { this.loaded = false; this.unload?.(); return; }
    if (method === "thread/compacted") {
      // The native model may have forgotten earlier instructions; no previous seen hash survives.
      this.value.contextGeneration = randomUUID(); this.value.standingPromptHash = null;
      this.systemDigests.clear();
      if (this.active) this.active.compacted = true;
      try { this.save(); } catch { client.close(); }
      return;
    }
    const active = this.active;
    if (!active || active.settled) return;
    const businessEvent = ["turn/completed", "thread/tokenUsage/updated", "item/started", "item/completed", "item/agentMessage/delta"].includes(method);
    if (!businessEvent && !method.startsWith("item/reasoning/") && method !== "item/commandExecution/outputDelta") return;
    const turn = object(params.turn), turnId = method === "turn/completed" ? turn.id : params.turnId;
    void active.ready.then(expected => {
      if (!expected || expected !== turnId || this.client !== client || this.active !== active || active.settled) return;
      try {
        active.activity();
        if (!businessEvent) return; // Payload-free watchdog only; no raw reasoning/tool output leaves this adapter.
        if (method === "item/agentMessage/delta") {
          if (!active.rawTokenObserved && typeof params.delta === "string" && params.delta.length) {
            active.rawTokenObserved = true;
            try { workspaceRunRuntimeStages(this.permit)?.mark("first_token", "native_event"); } catch { /* Optional diagnostic only. */ }
          }
          if (typeof params.delta !== "string" || !params.delta.length || params.itemId !== active.previewItem || active.visibleItems.get(String(params.itemId)) !== true) return;
          observeWorkspaceMessageTiming(this.permit, "T5", observedAt);
          active.preview?.push(params.delta); return;
        }
        active.assertCurrent();
        if (method === "turn/completed") observeWorkspaceMessageTiming(this.permit, "T8", observedAt);
        const previewItem = object(params.item);
        if (method === "item/started" && previewItem.type === "agentMessage" && nativeId(previewItem.id)) {
          if (active.visibleItems.size < 32) active.visibleItems.set(previewItem.id, codexVisibleAgentMessage(previewItem));
          if (!active.previewItem && active.visibleItems.get(previewItem.id)) {
            active.previewItem = previewItem.id;
            active.preview = createAssistantPreview({ source: active.previewEnv, emit: text => {
              if (this.active === active && !active.settled && active.id && this.client === client)
                active.previewOutput?.({ nativeTurnId: active.id, itemId: active.previewItem!, text });
            } });
            if (previewItem.text) active.preview.push(previewItem.text as string);
          }
        }
        if (this.policy && (method === "item/started" || method === "item/completed")) observeWorkspaceNativeItem(this.permit, this.policy, object(params.item), method === "item/started" ? "started" : "completed");
        if (method === "item/completed" && object(params.item).type === "agentMessage") {
          const item = object(params.item);
          if (typeof item.text === "string") {
            if (item.id === active.previewItem) active.preview?.finish();
            else if (!active.previewItem && codexVisibleAgentMessage(item)) {
              // Missing/malformed start item: wait for this complete, documented agent message.
              active.previewItem = item.id;
              active.preview = createAssistantPreview({ source: active.previewEnv, emit: text => {
                if (this.active === active && !active.settled && active.id && this.client === client)
                  active.previewOutput?.({ nativeTurnId: active.id, itemId: item.id as string, text });
              } }); active.preview.push(item.text); active.preview.finish();
            }
            active.text = item.text.slice(0, 200_000);
            if (item.text.length) try { workspaceRunRuntimeStages(this.permit)?.mark("first_output", "native_event"); } catch { /* Diagnostic only. */ }
          }
        } else if (method === "thread/tokenUsage/updated") {
          this.observeUsage(params);
        } else if (method === "turn/completed") {
          this.value.phase = turn.status === "completed" ? "idle" : "unknown";
          if (turn.status === "completed" && !active.compacted) {
            this.value.standingPromptHash = active.standingHash;
          } else this.value.standingPromptHash = null;
          this.save();
          if (active.seedRecord) this.compactions.recordOutcome(active.seedRecord, turn.status === "completed" ? "completed" : "failed",
            { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
          if (turn.status === "completed" && this.value.contextTokens !== null && this.value.threadId)
            this.compactions.observeAfter(compactionSourceKey("codex", this.value.threadId), this.value.contextTokens);
          if (turn.status === "completed" && !active.compacted) this.systemDigests = new Map(active.partDigests);
          active.finish(turn.status === "completed", turn.status === "interrupted" ? "interrupted" : "runtime_failed",
            turn.status === "completed" ? undefined : classifyRuntimeFailure({ stderr: JSON.stringify(turn.error ?? {}).slice(0, 65_536) }),
            runtimeErrorFirstLine(object(turn.error).message, this.installer.resolveBound("codex").env));
        }
      } catch (error) {
        active.finish(false, error instanceof Error && error.message === "Workspace native token telemetry safety ceiling reached"
          ? "workspace_budget_exhausted" : "workspace_authority_changed"); client.close();
      }
    }).catch(() => { active.finish(false, "runtime_failed"); client.close(); });
  }
  async launch(endpoint: WorkspaceMcpEndpoint, prompt: string, args: TurnArgs, input: {
    model: string | null; effort: string | null; cwd: string; signal: AbortSignal; assertCurrent(): void; activity(): void;
  }): Promise<ExternalCommandCaptureResult> {
    input.assertCurrent();
    if (!this.busy || this.active || input.signal.aborted) throw new Error("Codex attempt unavailable");
    if (this.needsNewSession) return { ok: false, code: 1, timedOut: false, stdout: "", errorCode: "codex_context_limit_open_new_session" };
    this.attemptEndpoint = endpoint;
    const resolved = await this.installer.prepareBound("codex", input.signal);
    if (input.cwd !== this.project.root || origin(resolved, this.project) !== this.origin) throw new Error("Codex login origin changed; no fallback was selected");
    const policyInput = workspaceRuntimePolicyInput(this.permit, "codex", resolved, "resident", this.installer);
    const { standing, turnParts, digest: standingHash } = codexStandingContext(args, input.model, input.effort,
      policyInput.tier, this.permit.binding.agent.configRevision);
    const processKey = workspaceRuntimeProcessKey(policyInput, resolved);
    const contract = hash([standingHash, args.tools, processKey]);
    // Retire an idle process before binding the new ActiveTurn, so its close event cannot settle it.
    if (this.processKey !== processKey || !this.client && this.policy) {
      const previous = this.client; previous?.close(); if (previous) await previous.waitForClose(); else await this.exit;
      if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy); await this.policy.close(); }
      this.policy = undefined; this.client = undefined; this.loaded = false; this.loadedContract = undefined; this.loadedHandle = undefined;
    }
    input.assertCurrent();
    if (!this.policy) this.policy = createRuntimeExecutionPolicy(policyInput);
    beginWorkspaceNativePolicy(this.permit, this.policy); await this.policy.prepareAttempt(); this.processKey = processKey;
    try { workspaceRunRuntimeStages(this.permit)?.setRuntime({ id: "codex", version: this.installer.list().options.find(row => row.runtimeId === "codex")?.version ?? null,
      loginSource: resolved.loginSource, model: input.model, effort: input.effort }); } catch { /* Observational metadata only. */ }
    const env = { ...resolved.env, [WORKSPACE_MCP_TOKEN_ENV]: this.token,
      HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
    const visibleEnv: NodeJS.ProcessEnv = { ...env, ...(endpoint.attemptMarker ? { HARA_PREVIEW_ATTEMPT_TOKEN: endpoint.attemptMarker } : {}) };
    let finish!: ActiveTurn["finish"], bind!: ActiveTurn["bind"], done!: () => void;
    const terminal = new Promise<ExternalCommandCaptureResult>(resolve => {
      finish = (ok, code, kind, firstLine, rpc) => {
        if (active.settled) return;
        active.settled = true; active.preview?.stop();
        resolve({ ok, code: ok ? 0 : 1, timedOut: false, ...(!ok ? { errorCode: code ?? "runtime_failed", ...(firstLine ? { errorFirstLine: runtimeErrorFirstLine(firstLine, env) } : {}), ...(kind ? { nativeFailureKind: kind } : {}), ...(rpc ? { nativeRpc: rpc } : {}) } : {}),
          stdout: ok ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: redactToolSubprocessOutput(active.text, visibleEnv) } }) : "" });
        done();
      };
    });
    const active: ActiveTurn = { ready: new Promise(resolve => { bind = resolve; }), bind: id => bind(id), finish,
      done: new Promise(resolve => { done = resolve; }), activity: input.activity, assertCurrent: input.assertCurrent, text: "", settled: false,
      visibleItems: new Map(), previewOutput: args.onAssistantPreview, previewEnv: visibleEnv,
      standingHash, compacted: false, partDigests: new Map((args.systemParts?.length ? args.systemParts : [{ id: "system", digest: hash(args.system) }]).map(part => [part.id, part.digest])) };
    this.active = active;
    const interrupt = () => {
      const client = this.client;
      if (!client || active.settled) return;
      if (active.id) void client.call("turn/interrupt", { threadId: this.value.threadId, turnId: active.id })
        .catch(() => { active.finish(false, "interrupted"); client.close(); });
      else { active.bind(""); active.finish(false, "interrupted"); client.close(); }
    };
    input.signal.addEventListener("abort", interrupt, { once: true });
    let freshProcess = false;
    try {
      if (!this.client) {
        freshProcess = true;
        const stages = workspaceRunRuntimeStages(this.permit);
        const endSpawn = stages?.beginEvent("spawn"), endCold = stages?.beginEvent("cold_start");
        const nativeArgs = ["app-server", "--stdio", "-c", "thread_unload_delay_secs=0", "-c", "mcp_servers={}",
            "-c", "model_auto_compact_token_limit=9007199254740991", "-c", "model_post_turn_compact_threshold_percent=0",
            "-c", 'shell_environment_policy.set.HARA_WORKSPACE_MCP_TOKEN=""',
            "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"',
            ...codexHostToolOverrides(resolved.env.HOME!, resolved.env.CODEX_HOME, input.cwd, this.mcpName)];
        const launch = this.policy.wrap({ command: resolved.command, env, args: nativeArgs });
        const client = JsonlRpcClient.start({ ...launch, captureErrorFirstLine: true, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 * 1024,
          appServerArgs: launch.args,
          onSpawn: () => { try { endSpawn?.("completed"); } catch { /* Diagnostic only. */ } },
          onRequestSent: method => { if (method === "turn/start") observeWorkspaceMessageTiming(this.permit, "T4"); },
          onNotification: (method, params) => this.notification(client, method, params),
          onServerRequest: (_request, _reply, reject) => reject(-32601, "Use Hara Workspace tools and its governed approval channel"),
          onClose: error => {
            if (this.client !== client) return;
            this.client = undefined; this.loaded = false; this.unload?.();
            this.maintenance?.fail(new NativeCompactionError("unknown", error));
            // During a control RPC, its rejected promise owns the precise terminal reason. onClose
            // runs synchronously before that catch; settling here would hide restore timeouts.
            if (this.active?.id) this.active.finish(false, "codex_delivery_unknown_no_replay",
              error instanceof ExternalJsonlRpcTransportError ? error.runtimeFailureKind : undefined,
              error instanceof ExternalJsonlRpcTransportError ? error.errorFirstLine : undefined,
              error instanceof ExternalJsonlRpcTransportError ? error.rpc : undefined);
          },
        });
        this.client = client; this.exit = client.waitForClose(); void this.exit.catch(() => {});
        await client.call("initialize", { clientInfo: { name: "hara", version: "1.0.2" }, capabilities: { experimentalApi: true } });
        client.notify("initialized");
        try { endCold?.("completed"); } catch { /* Diagnostic only. */ }
      }
      const endpointReady = endpoint.prepare?.(contract);
      if (endpointReady) {
        await endpointReady;
        input.assertCurrent();
        // Async cold setup is never an authorization cache or a stale launch-profile grant.
        const current = this.installer.resolveBound("codex");
        const currentPolicy = workspaceRuntimePolicyInput(this.permit, "codex", current, "resident", this.installer);
        if (origin(current, this.project) !== this.origin || workspaceRuntimeProcessKey(currentPolicy, current) !== processKey)
          throw new Error("Codex launch profile changed during preparation; no turn was sent");
      }
      if (endpoint.attemptMarker) visibleEnv.HARA_PREVIEW_ATTEMPT_TOKEN = endpoint.attemptMarker;
      input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
      const client = this.client;
      if (!client) throw new Error("Codex native process changed during preparation; no turn was sent");
      const config = { mcp_servers: { [this.mcpName]: { enabled: true, url: endpoint.url, bearer_token_env_var: WORKSPACE_MCP_TOKEN_ENV,
        // Only this immutable governed endpoint is trusted. Codex 0.166's `auto` can ask a second
        // native MCP approval before reaching Hara; `approve` changes no Hara tool/card authority.
        default_tools_approval_mode: "approve", required: true, tool_timeout_sec: 120 } },
        model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER, model_post_turn_compact_threshold_percent: 0,
        ...(input.effort ? { model_reasoning_effort: input.effort } : {}) };
      let resumed = Boolean(this.value.threadId);
      let recoverySeed: string | undefined;
      const direct = Boolean(endpoint.attemptMarker && this.loaded && this.value.phase === "idle" && this.value.contextGeneration
        && this.value.standingPromptHash === standingHash && this.loadedContract === contract
        && this.loadedHandle?.client === client && this.loadedHandle.id === this.value.threadId && this.loadedHandle.cwd === input.cwd);
      let threadId = this.loadedHandle?.id;
      if (!direct) {
      let response: Record<string, unknown>;
      try {
        // Codex ignores resume overrides while the thread is already loaded. The close
        // notification, not just the unsubscribe ACK, proves that fresh governance can load.
        if (resumed && this.loaded) await this.unloadThread(client);
        input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
        const load = (resume: boolean) => client.call<Record<string, unknown>>(resume ? "thread/resume" : "thread/start", {
          ...(resume ? { threadId: this.value.threadId, excludeTurns: true } : { ephemeral: false }),
          cwd: input.cwd, sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
          developerInstructions: standing, config, ...(input.model ? { model: input.model } : {}),
        });
        let resetFrom: string | undefined;
        try { response = await load(resumed); }
        catch (error) {
          // Local-install exception pending Elon/Linus review: only an explicitly missing,
          // provably empty rollout can be replaced. Never replay a submitted/unknown action.
          if (!resumed || !(error instanceof ExternalJsonlRpcRequestError) || error.rpc?.rpcMethod !== "thread/resume"
            || !/^no rollout found for thread id(?:\s|:|$)/iu.test(error.errorFirstLine ?? "")
            || this.value.input !== 0 || this.value.output !== 0 || this.value.contextTokens !== null) throw error;
          resetFrom = this.value.threadId!;
          const source = workspaceCompactionSource(this.permit);
          if (source) recoverySeed = contextSummaryPrompt(contextSummary(source));
          input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
          response = await load(false);
        }
        const thread = object(response.thread);
        if (!nativeId(thread.id) || resumed && !resetFrom && thread.id !== this.value.threadId || thread.cwd !== input.cwd
          || response.approvalPolicy !== "never" || response.approvalsReviewer !== "user"
          || object(response.sandbox).type !== "dangerFullAccess"
          || input.model !== null && response.model !== input.model || input.effort !== null && response.reasoningEffort !== input.effort
          || object(thread.status).type !== "idle") {
          throw new Error("Codex thread confinement or idle origin was not confirmed");
        }
        if (resetFrom) {
          const reset = recordCodexEmptyThreadReset(workspaceRuntimeStorage(this.permit), this.value, resetFrom, thread.id as string);
          this.value.resets = [...this.value.resets.slice(-1023), reset];
          this.value.contextGeneration = null; this.value.standingPromptHash = null;
          resumed = false;
        }
      } catch (error) {
        if (resumed) { this.value.phase = "unknown"; this.save(); }
        active.bind("");
        const typed = error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error : undefined;
        active.finish(false, resumed ? "codex_resume_failed_history_preserved" : "codex_thread_start_failed",
          typed?.runtimeFailureKind ?? "runtime_failed", typed?.errorFirstLine, typed?.rpc);
        client.close();
        await this.settleNativeAttempt();
        return await terminal;
      }
      const thread = object(response.thread);
      threadId = thread.id as string;
      this.loadedHandle = Object.freeze({ id: thread.id as string, cwd: input.cwd, client });
      }
      if (!threadId) throw new Error("Codex loaded thread handle is unavailable");
      // npm's launcher remains the owned root; its initialized native app-server child is
      // resident too. Seal that baseline before turn/start, never after model tools can run.
      if (freshProcess) await this.policy.prepareResidentRoot();
      this.value.threadId = threadId; this.loaded = true;
      if (!resumed || this.value.contextGeneration === null) this.value.contextGeneration = randomUUID();
      const compacted = await this.compactIdle({ client, endpoint, resumed, standing, config, model: input.model, effort: input.effort,
        cwd: input.cwd, signal: input.signal, assertCurrent: input.assertCurrent, activity: input.activity });
      threadId = this.value.threadId!;
      if (compacted.seedRecord) active.seedRecord = compacted.seedRecord;
      if (endpoint.attemptMarker) {
        visibleEnv.HARA_PREVIEW_PRE_COMPACT_TOKEN = visibleEnv.HARA_PREVIEW_ATTEMPT_TOKEN;
        visibleEnv.HARA_PREVIEW_ATTEMPT_TOKEN = endpoint.attemptMarker;
      }
      this.value.phase = "unknown"; this.save(); // Write ahead of an accepted or outcome-unknown turn.
      const refresh = resumed && this.value.standingPromptHash !== standingHash;
      const currentPrompt = [
        ...(recoverySeed ? [recoverySeed] : []),
        ...(compacted.seed ? [compacted.seed] : []),
        ...(endpoint.attemptMarker ? [`<system-reminder>Current Hara attempt: every Hara Workspace MCP tool call MUST include the extra argument "${WORKSPACE_ATTEMPT_MARKER}": "${endpoint.attemptMarker}". Never use an earlier turn's marker. Hara removes this routing field before the governed tool; it grants no permission or approval.</system-reminder>`] : []),
        ...(refresh ? [`<system-reminder>Current Hara standing governance context for this resumed thread:\n${standing}\n</system-reminder>`] : []),
        ...(turnParts.length ? [`<system-reminder>Current Hara turn context:\n${turnParts.map(part => part.content).join("\n\n")}\n</system-reminder>`] : []),
        prompt,
      ].join("\n\n");
      if (Buffer.byteLength(currentPrompt) > 400_000) throw new Error("Codex native prompt context is too large");
      input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
      observeWorkspaceMessageTiming(this.permit, "T3");
      const started = await client.call<Record<string, unknown>>("turn/start", { threadId,
        input: [{ type: "text", text: currentPrompt, text_elements: [] }], cwd: input.cwd, approvalPolicy: "never", approvalsReviewer: "user",
        ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) });
      const turn = object(started.turn);
      if (!nativeId(turn.id)) throw new Error("Codex did not bind the accepted turn");
      active.id = turn.id; active.bind(turn.id);
      const result = await terminal; this.nativeSucceeded = result.ok;
      if (!result.ok) this.client?.close();
      // A native terminal frame is logical completion, not proof its tools have stopped.
      // Drain before the governor sees the final response or imports the final workspace diff.
      await this.settleNativeAttempt();
      if (result.ok && this.loaded && this.residentMcp?.reusable) this.loadedContract = contract;
      return result;
    } catch (error) {
      active.bind(""); active.finish(false, "codex_delivery_unknown_no_replay", error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.runtimeFailureKind : undefined, error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.errorFirstLine : undefined, error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.rpc : undefined); this.client?.close();
      await this.settleNativeAttempt();
      const result = await terminal;
      return result.ok ? { ok: false, code: 1, timedOut: false, stdout: "", errorCode: "runtime_process_cleanup_unverified" } : result;
    }
    finally { input.signal.removeEventListener("abort", interrupt); }
  }
  private async compactIdle(input: { client: JsonlRpcClient; endpoint: WorkspaceMcpEndpoint; resumed: boolean; standing: string;
    config: Record<string, unknown>; model: string | null; effort: string | null; cwd: string; signal: AbortSignal;
    assertCurrent(): void; activity(): void }): Promise<{ seed?: string; seedRecord?: string }> {
    input.assertCurrent();
    const source = workspaceCompactionSource(this.permit), threadId = this.value.threadId;
    if (!source || !threadId || !this.loaded || this.maintenance) return {};
    const key = compactionSourceKey("codex", threadId);
    const summary = this.compactions.plan(source, { runtimeId: "codex", sourceKey: key, tokens: this.value.contextTokens, idle: true });
    if (!summary) return {};
    const control = this.endpointMaintenance.get(input.endpoint);
    const makeSeed = async (record?: string): Promise<{ seed: string; seedRecord: string }> => {
      input.assertCurrent();
      const original = this.value.threadId, beforeTokens = this.value.contextTokens;
      if (input.resumed) {
        const response = await input.client.call<Record<string, unknown>>("thread/start", { ephemeral: false, cwd: input.cwd,
          sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user", developerInstructions: input.standing,
          config: input.config, ...(input.model ? { model: input.model } : {}) });
        const thread = object(response.thread);
        if (!nativeId(thread.id) || thread.cwd !== input.cwd || object(thread.status).type !== "idle" || response.approvalPolicy !== "never"
          || response.approvalsReviewer !== "user" || object(response.sandbox).type !== "dangerFullAccess"
          || input.model !== null && response.model !== input.model || input.effort !== null && response.reasoningEffort !== input.effort)
          throw new Error("Compacted seed thread confinement was not confirmed");
        input.assertCurrent(); this.value.threadId = thread.id; this.loaded = true;
        this.loadedHandle = Object.freeze({ id: thread.id, cwd: input.cwd, client: input.client });
        this.value.contextGeneration = randomUUID(); this.value.standingPromptHash = null; this.value.contextTokens = null;
        this.systemDigests.clear(); this.loadedContract = undefined;
      }
      if (record) this.compactions.recordOutcome(record, "failed");
      const seedRecord = this.compactions.begin(source, { runtimeId: "codex", method: "host-seed",
        sourceKey: compactionSourceKey("codex", this.value.threadId!), tokens: beforeTokens, requests: 0, summary, priorThreadId: original });
      this.firstUsage = true;
      return { seed: contextSummaryPrompt(summary), seedRecord };
    };
    if (!input.resumed || !control) return makeSeed();
    const endCost = reserveWorkspaceCompaction(this.permit);
    if (!endCost) return {}; // Preserve the frozen budget; compaction is optional, the admitted user turn is not.
    const record = this.compactions.begin(source, { runtimeId: "codex", method: "codex-native", sourceKey: key,
      tokens: this.value.contextTokens, requests: 1, summary });
    let suspended = false, success = false, failure: NativeCompactionError | undefined;
    try {
      suspended = await control.suspend();
      if (!suspended) throw new NativeCompactionError("unknown");
      input.assertCurrent();
      const operation = new CodexContextCompaction({ threadId, signal: input.signal, assertCurrent: input.assertCurrent, activity: input.activity,
        usage: params => this.observeUsage(params, true) });
      this.maintenance = operation;
      await operation.run(input.client); success = true;
    } catch (error) { failure = error instanceof NativeCompactionError ? error : new NativeCompactionError("unknown", error); }
    finally {
      this.maintenance = undefined;
      const usage = this.takeUsage(); recordWorkspaceRuntimeUsage(this.permit, usage);
      this.compactions.recordOutcome(record, success ? "completed" : failure?.outcome === "unknown" ? "running" : "failed", { inputTokens: usage?.input ?? null,
        outputTokens: usage?.output ?? null, cachedInputTokens: usage ? usage.cachedInput ?? 0 : null });
      endCost(success, failure?.cause instanceof ExternalJsonlRpcTransportError ? failure.cause.runtimeFailureKind : "runtime_failed");
      this.firstUsage = true;
    }
    if (failure?.outcome === "unknown" || input.signal.aborted || this.client !== input.client) {
      this.value.phase = "unknown"; this.save(); input.client.close();
      throw failure?.cause instanceof ExternalJsonlRpcTransportError || failure?.cause instanceof ExternalJsonlRpcRequestError
        ? failure.cause : failure ?? new NativeCompactionError("unknown");
    }
    // Shared ownership proves physical cleanup; no private drain implementation or reused capability.
    await endWorkspaceNativePolicy(this.permit, this.policy!, { keepResidentRoot: true });
    input.assertCurrent(); beginWorkspaceNativePolicy(this.permit, this.policy!); await this.policy!.prepareAttempt(); input.assertCurrent();
    if (suspended) control.resume();
    if (failure?.outcome === "unsupported") return makeSeed();
    this.value.contextGeneration = randomUUID(); this.value.standingPromptHash = null;
    this.systemDigests.clear(); this.loadedContract = undefined;
    if (success) this.value.contextTokens = null;
    this.value.phase = "idle"; this.save();
    return success ? { seed: contextSummaryPrompt(summary, false) } : {};
  }
  private async unloadThread(client: JsonlRpcClient): Promise<void> {
    if (!this.loaded || !this.value.threadId) return;
    this.loadedContract = undefined; this.loadedHandle = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unloaded = new Promise<void>(resolve => { this.unload = resolve; });
    try {
      const result = await client.call<{ status?: string }>("thread/unsubscribe", { threadId: this.value.threadId });
      if (result.status === "notLoaded") this.loaded = false;
      if (this.loaded) await Promise.race([unloaded, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex thread unload unconfirmed")), 3000);
      })]);
    } catch (error) { client.close(); await client.waitForClose(); throw error; }
    finally { clearTimeout(timer); this.unload = undefined; }
  }
  private settleNativeAttempt(): Promise<void> { return this.settling ??= this.settleCurrentAttempt(); }
  private async settleCurrentAttempt(): Promise<void> {
      const cleanMcp = this.residentMcp?.retireCurrent() ?? false;
      const keepLoaded = Boolean(this.attemptEndpoint?.attemptMarker && cleanMcp && this.nativeSucceeded && this.active?.settled
        && this.value.phase === "idle" && !this.active.compacted);
      if (!keepLoaded) this.loadedContract = undefined;
      const client = this.client;
      if (client && this.loaded && this.value.threadId && !keepLoaded) {
        try { await this.unloadThread(client); } catch { /* Closed by unloadThread; the saved thread survives. */ }
      }
      if (!this.client) { await this.exit; if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy); await this.policy.close(); this.policy = undefined; } }
      else if (this.policy) {
        try { await endWorkspaceNativePolicy(this.permit, this.policy, { keepResidentRoot: true }); }
        catch (error) { this.loadedContract = undefined; this.client?.close(); throw error; }
      }
  }
  async release(): Promise<void> {
    try { if (this.active || this.attemptEndpoint) await this.settleNativeAttempt(); else this.residentMcp?.retireCurrent(); } finally {
      this.active = undefined; this.busy = false; this.lastUsed = Date.now();
      if (!this.closing) { this.idleTimer = setTimeout(() => { void this.dispose(); }, IDLE_MS); this.idleTimer.unref(); }
    }
  }
  async dispose(): Promise<void> {
    this.closing = true; clearTimeout(this.idleTimer);
    const client = this.client; client?.close(); if (client) await client.waitForClose(); else await this.exit;
    if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy); await this.policy.close(); this.policy = undefined; }
    await this.residentMcp?.close(); this.residentMcp = undefined;
    this.evict();
  }
}
