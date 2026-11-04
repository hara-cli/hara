import { runtimeErrorFirstLine } from "../security/runtime-error.js";
import { classifyRuntimeFailure, type RuntimeFailureKind } from "./failure-diagnostics.js";
import { createRuntimeExecutionPolicy, type RuntimeExecutionPolicy } from "./execution-policy.js";
import { beginWorkspaceNativePolicy, endWorkspaceNativePolicy, observeWorkspaceNativeItem, workspaceRuntimePolicyInput, workspaceRuntimeProcessKey } from "./workspace-native-policy.js";
import { codexHostToolOverrides } from "./codex-host-config.js";
import { workspaceRunRuntimeStages } from "../workspace/execution.js";
// Native context is reusable; Workspace execution capabilities are not. Each attempt has a fresh
// immutable MCP endpoint, and an unloaded thread is resumed only after fresh Host admission.
import { createHash, randomBytes } from "node:crypto";
import { JsonlRpcClient, ExternalJsonlRpcRequestError, ExternalJsonlRpcTransportError, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { canonical, plain } from "../workspace/local-state.js";
import type { WorkspaceResourceStorage } from "../workspace/resource-context.js";
import { codexThreadState, codexConversationKey, nativeContextFull, nativeCodexId as nativeId, nativeTokenCount as count, type CodexThreadState } from "../workspace/codex-thread.js";
import { assertWorkspaceRuntimeUsage, workspaceRuntimeStorage, type WorkspaceRunPermit } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import { inspectLocalRuntime } from "../workspace/runtime-detect.js";
import type { ToolResult, TurnArgs, TurnResult } from "../providers/types.js";
import { WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint } from "./registered-cli-mcp.js";

const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => plain(value) ? value : {};
const origin = (resolved: ReturnType<WorkspaceRuntimeInstaller["resolveBound"]>, project: unknown): string =>
  hash([resolved.command, inspectLocalRuntime(resolved.command)?.fingerprint ?? null, resolved.loginSource,
    resolved.env.HOME ?? null, resolved.env.CODEX_HOME ?? null, project]);
const MAX_RESIDENT = 4, IDLE_MS = 5 * 60_000;
interface ActiveTurn {
  id?: string; ready: Promise<string>; bind(id: string): void;
  finish(ok: boolean, code?: string, kind?: RuntimeFailureKind, firstLine?: string): void; done: Promise<void>;
  activity(): void; assertCurrent(): void;
  text: string; settled: boolean;
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
  private idleTimer?: ReturnType<typeof setTimeout>;
  private unload?: () => void;
  private loaded = false;
  private closing = false;
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
    if (this.value.threadId !== null && this.value.origin !== this.origin) throw new Error("Saved Codex thread belongs to a different login or project origin; no fallback was selected");
    if (this.value.threadId === null) this.value.origin = this.origin;
  }
  claim(permit: WorkspaceRunPermit, assertCurrent: () => void): void {
    assertCurrent();
    if (this.busy || this.closing) throw new Error("Codex conversation is busy or draining; no second writer was started");
    this.permit = permit; this.busy = true; clearTimeout(this.idleTimer); this.idleTimer = undefined;
    if (!this.client) this.token = randomBytes(32).toString("hex");
    this.pendingUsage = { input: 0, output: 0, cachedInput: 0 }; this.observedUsage = false; this.firstUsage = true;
    this.value.lastAttempt = { input: 0, output: 0, cachedInput: 0 };
  }
  get needsNewSession(): boolean { return nativeContextFull(this.value); }
  takeUsage(): TurnResult["usage"] {
    if (!this.observedUsage || !this.pendingUsage.input && !this.pendingUsage.output) return undefined;
    const usage = { ...this.pendingUsage }; this.pendingUsage = { input: 0, output: 0, cachedInput: 0 }; return usage;
  }
  decorateResult(result: ToolResult, args: TurnArgs): ToolResult {
    const parts = args.systemParts?.length ? args.systemParts : [{ id: "system", digest: hash(args.system), content: args.system }];
    const changed = parts.filter(part => this.systemDigests.get(part.id) !== part.digest);
    for (const part of parts) this.systemDigests.set(part.id, part.digest);
    const update = changed.map(part => part.content).join("\n\n");
    return update ? { ...result, content: result.content + "\n\n<system-reminder>\nCurrent Hara governance context (the receipt above is unchanged):\n"
      + update + "\nAvailable tools at this boundary: " + args.tools.map(tool => tool.name).join(", ") + "\n</system-reminder>" } : result;
  }
  private save(): void { this.value = this.state.update(this.value.revision, () => this.value); }
  private notification(client: JsonlRpcClient, method: string, params: Record<string, unknown>): void {
    if (this.client !== client || params.threadId !== this.value.threadId) return;
    if (method === "thread/closed") { this.loaded = false; this.unload?.(); return; }
    const active = this.active;
    if (!active || active.settled) return;
    const turn = object(params.turn), turnId = method === "turn/completed" ? turn.id : params.turnId;
    void active.ready.then(expected => {
      if (!expected || expected !== turnId || this.client !== client || this.active !== active || active.settled) return;
      try {
        active.assertCurrent(); active.activity();
        if (this.policy && (method === "item/started" || method === "item/completed")) observeWorkspaceNativeItem(this.permit, this.policy, object(params.item), method === "item/started" ? "started" : "completed");
        if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta.length) {
          try { workspaceRunRuntimeStages(this.permit)?.mark("first_token", "native_event"); } catch { /* Diagnostic only. */ }
        }
        if (method === "item/completed" && object(params.item).type === "agentMessage") {
          const item = object(params.item);
          if (typeof item.text === "string") {
            active.text = item.text.slice(0, 200_000);
            if (item.text.length) try { workspaceRunRuntimeStages(this.permit)?.mark("first_output", "native_event"); } catch { /* Diagnostic only. */ }
          }
        } else if (method === "thread/tokenUsage/updated") {
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
          this.value.contextTokens = last.inputTokens + last.outputTokens;
          if (!count(this.value.contextTokens)) throw new Error("Invalid native context usage");
          if (usage.modelContextWindow !== undefined && usage.modelContextWindow !== null) {
            if (!count(usage.modelContextWindow) || !usage.modelContextWindow) throw new Error("Invalid native context window");
            this.value.modelContextWindow = usage.modelContextWindow;
          }
          this.firstUsage = false; this.observedUsage = true;
          assertWorkspaceRuntimeUsage(this.permit, this.pendingUsage);
          if (this.needsNewSession) {
            this.value.phase = "new_session_required"; this.save();
            active.finish(false, "codex_context_limit_open_new_session"); client.close();
          }
        } else if (method === "turn/completed") {
          this.value.phase = turn.status === "completed" ? "idle" : "unknown"; this.save();
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
    const resolved = await this.installer.prepareBound("codex", input.signal);
    if (input.cwd !== this.project.root || origin(resolved, this.project) !== this.origin) throw new Error("Codex login origin changed; no fallback was selected");
    const policyInput = workspaceRuntimePolicyInput(this.permit, "codex", resolved, "resident", this.installer);
    const processKey = workspaceRuntimeProcessKey(policyInput, resolved);
    // Retire an idle process before binding the new ActiveTurn, so its close event cannot settle it.
    if (this.processKey !== processKey || !this.client && this.policy) {
      const previous = this.client; previous?.close(); if (previous) await previous.waitForClose(); else await this.exit;
      if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy); await this.policy.close(); }
      this.policy = undefined; this.client = undefined; this.loaded = false;
    }
    input.assertCurrent();
    if (!this.policy) this.policy = createRuntimeExecutionPolicy(policyInput);
    beginWorkspaceNativePolicy(this.permit, this.policy); await this.policy.prepareAttempt(); this.processKey = processKey;
    try { workspaceRunRuntimeStages(this.permit)?.setRuntime({ id: "codex", version: this.installer.list().options.find(row => row.runtimeId === "codex")?.version ?? null,
      loginSource: resolved.loginSource, model: input.model, effort: input.effort }); } catch { /* Observational metadata only. */ }
    const env = { ...resolved.env, [WORKSPACE_MCP_TOKEN_ENV]: this.token,
      HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
    let finish!: ActiveTurn["finish"], bind!: ActiveTurn["bind"], done!: () => void;
    const terminal = new Promise<ExternalCommandCaptureResult>(resolve => {
      finish = (ok, code, kind, firstLine) => {
        if (active.settled) return;
        active.settled = true;
        resolve({ ok, code: ok ? 0 : 1, timedOut: false, ...(!ok ? { errorCode: code ?? "runtime_failed", ...(firstLine ? { errorFirstLine: runtimeErrorFirstLine(firstLine, env) } : {}), ...(kind ? { nativeFailureKind: kind } : {}) } : {}),
          stdout: ok ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: redactToolSubprocessOutput(active.text, env) } }) : "" });
        done();
      };
    });
    const active: ActiveTurn = { ready: new Promise(resolve => { bind = resolve; }), bind: id => bind(id), finish,
      done: new Promise(resolve => { done = resolve; }), activity: input.activity, assertCurrent: input.assertCurrent, text: "", settled: false };
    this.active = active;
    const interrupt = () => {
      const client = this.client;
      if (!client || active.settled) return;
      if (active.id) void client.call("turn/interrupt", { threadId: this.value.threadId, turnId: active.id })
        .catch(() => { active.finish(false, "interrupted"); client.close(); });
      else { active.bind(""); active.finish(false, "interrupted"); client.close(); }
    };
    input.signal.addEventListener("abort", interrupt, { once: true });
    try {
      if (!this.client) {
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
          onNotification: (method, params) => this.notification(client, method, params),
          onServerRequest: (_request, _reply, reject) => reject(-32601, "Use Hara Workspace tools and its governed approval channel"),
          onClose: error => { if (this.client === client) { this.client = undefined; this.loaded = false; this.unload?.(); this.active?.finish(false, "runtime_failed", error instanceof ExternalJsonlRpcTransportError ? error.runtimeFailureKind : undefined, error instanceof ExternalJsonlRpcTransportError ? error.errorFirstLine : undefined); } },
        });
        this.client = client; this.exit = client.waitForClose(); void this.exit.catch(() => {});
        await client.call("initialize", { clientInfo: { name: "hara", version: "1.0.2" }, capabilities: { experimentalApi: true } });
        client.notify("initialized");
        try { endCold?.("completed"); } catch { /* Diagnostic only. */ }
      }
      input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
      const client = this.client!;
      const config = { mcp_servers: { [this.mcpName]: { enabled: true, url: endpoint.url, bearer_token_env_var: WORKSPACE_MCP_TOKEN_ENV,
        // Only this immutable governed endpoint is trusted. Codex 0.166's `auto` can ask a second
        // native MCP approval before reaching Hara; `approve` changes no Hara tool/card authority.
        default_tools_approval_mode: "approve", required: true, tool_timeout_sec: 120 } },
        model_auto_compact_token_limit: Number.MAX_SAFE_INTEGER, model_post_turn_compact_threshold_percent: 0,
        ...(input.effort ? { model_reasoning_effort: input.effort } : {}) };
      const resumed = Boolean(this.value.threadId);
      let response: Record<string, unknown>;
      try {
        response = await client.call(resumed ? "thread/resume" : "thread/start", {
          ...(resumed ? { threadId: this.value.threadId, excludeTurns: true } : { ephemeral: false }),
          cwd: input.cwd, sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
          developerInstructions: args.system, config, ...(input.model ? { model: input.model } : {}),
        });
      } catch (error) {
        if (resumed) { this.value.phase = "unknown"; this.save(); }
        active.finish(false, resumed ? "codex_resume_failed_history_preserved" : "codex_thread_start_failed", error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.runtimeFailureKind : "runtime_failed", error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.errorFirstLine : undefined); client.close(); return await terminal;
      }
      const thread = object(response.thread);
      if (!nativeId(thread.id) || resumed && thread.id !== this.value.threadId || thread.cwd !== input.cwd
        || response.approvalPolicy !== "never" || response.approvalsReviewer !== "user"
        || object(response.sandbox).type !== "dangerFullAccess"
        || input.model !== null && response.model !== input.model || input.effort !== null && response.reasoningEffort !== input.effort
        || object(thread.status).type !== "idle") {
        throw new Error("Codex thread confinement or idle origin was not confirmed");
      }
      this.value.threadId = thread.id; this.loaded = true;
      this.value.phase = "unknown"; this.save(); // Write ahead of an accepted or outcome-unknown turn.
      this.systemDigests = new Map((args.systemParts?.length ? args.systemParts : [{ id: "system", digest: hash(args.system) }]).map(part => [part.id, part.digest]));
      input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
      const started = await client.call<Record<string, unknown>>("turn/start", { threadId: thread.id,
        input: [{ type: "text", text: prompt, text_elements: [] }], cwd: input.cwd, approvalPolicy: "never", approvalsReviewer: "user",
        ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) });
      const turn = object(started.turn);
      if (!nativeId(turn.id)) throw new Error("Codex did not bind the accepted turn");
      active.id = turn.id; active.bind(turn.id);
      const result = await terminal;
      if (!result.ok) this.client?.close();
      // A native terminal frame is logical completion, not proof its tools have stopped.
      // Drain before the governor sees the final response or imports the final workspace diff.
      await this.settleNativeAttempt();
      return result;
    } catch (error) {
      active.bind(""); active.finish(false, "codex_delivery_unknown_no_replay", error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.runtimeFailureKind : undefined, error instanceof ExternalJsonlRpcRequestError || error instanceof ExternalJsonlRpcTransportError ? error.errorFirstLine : undefined); this.client?.close();
      await this.settleNativeAttempt();
      const result = await terminal;
      return result.ok ? { ok: false, code: 1, timedOut: false, stdout: "", errorCode: "runtime_process_cleanup_unverified" } : result;
    }
    finally { input.signal.removeEventListener("abort", interrupt); }
  }
  private async settleNativeAttempt(): Promise<void> {
      const client = this.client;
      if (client && this.loaded && this.value.threadId) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const unloaded = new Promise<void>(resolve => { this.unload = resolve; });
        try {
          const result = await client.call<{ status?: string }>("thread/unsubscribe", { threadId: this.value.threadId });
          if (result.status === "notLoaded") this.loaded = false;
          if (this.loaded) await Promise.race([unloaded, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Codex thread unload unconfirmed")), 3000);
          })]);
        } catch { client.close(); await client.waitForClose(); }
        finally { clearTimeout(timer); this.unload = undefined; }
      }
      if (!this.client) { await this.exit; if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy); await this.policy.close(); this.policy = undefined; } }
      else if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy, { keepResidentRoot: true }); }
  }
  async release(): Promise<void> {
    try { await this.settleNativeAttempt(); } finally {
      this.active = undefined; this.busy = false; this.lastUsed = Date.now();
      if (!this.closing) { this.idleTimer = setTimeout(() => { void this.dispose(); }, IDLE_MS); this.idleTimer.unref(); }
    }
  }
  async dispose(): Promise<void> {
    this.closing = true; clearTimeout(this.idleTimer);
    const client = this.client; client?.close(); if (client) await client.waitForClose(); else await this.exit;
    if (this.policy) { await endWorkspaceNativePolicy(this.permit, this.policy); await this.policy.close(); this.policy = undefined; }
    this.evict();
  }
}
