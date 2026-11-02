// Native context is reusable; Workspace execution capabilities are not. Each attempt has a fresh
// immutable MCP endpoint, and an unloaded thread is resumed only after fresh Host admission.
import { createHash, randomBytes } from "node:crypto";
import { JsonlRpcClient, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { canonical, exact, plain, WorkspaceJsonState } from "../workspace/local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding } from "../workspace/resource-context.js";
import { assertWorkspaceRuntimeUsage, workspaceRuntimeStorage, type WorkspaceRunPermit } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import { inspectLocalRuntime } from "../workspace/runtime-detect.js";
import type { ToolResult, TurnArgs, TurnResult } from "../providers/types.js";
import { WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint } from "./registered-cli-mcp.js";

const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => plain(value) ? value : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nativeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const origin = (resolved: ReturnType<WorkspaceRuntimeInstaller["resolveBound"]>, project: unknown): string =>
  hash([resolved.command, inspectLocalRuntime(resolved.command)?.fingerprint ?? null, resolved.loginSource,
    resolved.env.HOME ?? null, resolved.env.CODEX_HOME ?? null, project]);
const MAX_RESIDENT = 4, IDLE_MS = 5 * 60_000;
interface ThreadState {
  schemaVersion: 1; resourceBinding: WorkspaceResourceBinding; revision: number;
  agentId: string; sessionId: string; origin: string; threadId: string | null;
  input: number; output: number; phase: "idle" | "unknown";
}
interface ActiveTurn {
  id?: string; ready: Promise<string>; bind(id: string): void;
  finish(ok: boolean, code?: string): void; done: Promise<void>;
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
    const key = hash([identity, b.agent.agentId, b.sessionId]);
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
}

export class GovernedCodexSession {
  token = randomBytes(32).toString("hex");
  busy = false;
  lastUsed = Date.now();
  private client?: JsonlRpcClient;
  private exit?: Promise<void>;
  private active?: ActiveTurn;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private unload?: () => void;
  private loaded = false;
  private closing = false;
  private readonly state: WorkspaceJsonState<ThreadState>;
  private value: ThreadState;
  private pendingUsage = { input: 0, output: 0 };
  private observedUsage = false;
  private firstUsage = true;
  private systemDigests = new Map<string, string>();
  private readonly origin: string;
  private readonly project: { root: string; dev: string | number; ino: string | number };
  constructor(private readonly installer: WorkspaceRuntimeInstaller, private permit: WorkspaceRunPermit, private readonly evict: () => void) {
    const b = permit.binding, resolved = installer.resolveBound("codex");
    this.project = { ...b.project };
    this.origin = origin(resolved, b.project);
    const storage = workspaceRuntimeStorage(permit), binding = () => this.state.binding();
    this.state = new WorkspaceJsonState(storage, "codex-thread-" + hash([b.agent.agentId, b.sessionId]).slice(0, 24) + ".json", raw => {
      if (!plain(raw) || !exact(raw, ["schemaVersion", "resourceBinding", "revision", "agentId", "sessionId", "origin", "threadId", "input", "output", "phase"])
        || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
        || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, binding())
        || raw.agentId !== b.agent.agentId || raw.sessionId !== b.sessionId || typeof raw.origin !== "string" || !/^[a-f0-9]{64}$/.test(raw.origin)
        || !(raw.threadId === null || nativeId(raw.threadId)) || !count(raw.input) || !count(raw.output)
        || !["idle", "unknown"].includes(String(raw.phase))) throw new Error("Saved Codex thread binding is invalid; history was preserved");
      return structuredClone(raw) as unknown as ThreadState;
    }, () => ({ schemaVersion: 1, resourceBinding: binding(), revision: 0, agentId: b.agent.agentId, sessionId: b.sessionId,
      origin: this.origin, threadId: null, input: 0, output: 0, phase: "idle" }));
    this.value = this.state.read();
    if (this.value.origin !== this.origin) throw new Error("Saved Codex thread belongs to a different login or project origin; no fallback was selected");
  }
  claim(permit: WorkspaceRunPermit, assertCurrent: () => void): void {
    assertCurrent();
    if (this.busy || this.closing) throw new Error("Codex conversation is busy or draining; no second writer was started");
    this.permit = permit; this.busy = true; clearTimeout(this.idleTimer); this.idleTimer = undefined;
    if (!this.client) this.token = randomBytes(32).toString("hex");
    this.pendingUsage = { input: 0, output: 0 }; this.observedUsage = false; this.firstUsage = true;
  }
  takeUsage(): TurnResult["usage"] {
    if (!this.observedUsage || !this.pendingUsage.input && !this.pendingUsage.output) return undefined;
    const usage = { ...this.pendingUsage }; this.pendingUsage = { input: 0, output: 0 }; return usage;
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
        if (method === "item/completed" && object(params.item).type === "agentMessage") {
          const item = object(params.item);
          if (typeof item.text === "string") active.text = item.text.slice(0, 200_000);
        } else if (method === "thread/tokenUsage/updated") {
          const usage = object(params.tokenUsage), total = object(usage.total), last = object(usage.last);
          if (!count(total.inputTokens) || !count(total.outputTokens) || !count(last.inputTokens) || !count(last.outputTokens)) throw new Error("Invalid native usage");
          // A restored/rate-limit snapshot can repeat the previous watermark. New-turn telemetry is
          // attributed by native turn ID; debit its explicit first request, not a cross-attempt delta.
          // This also handles native counters that restart above the saved watermark on cold resume.
          if (this.firstUsage && total.inputTokens === this.value.input && total.outputTokens === this.value.output) return;
          const reset = total.inputTokens < this.value.input || total.outputTokens < this.value.output;
          if (reset && !this.firstUsage) throw new Error("Native usage regressed");
          this.pendingUsage.input += this.firstUsage ? last.inputTokens : total.inputTokens - this.value.input;
          this.pendingUsage.output += this.firstUsage ? last.outputTokens : total.outputTokens - this.value.output;
          this.value.input = total.inputTokens; this.value.output = total.outputTokens;
          this.firstUsage = false; this.observedUsage = true;
          assertWorkspaceRuntimeUsage(this.permit, this.pendingUsage);
        } else if (method === "turn/completed") {
          this.value.phase = turn.status === "completed" ? "idle" : "unknown"; this.save();
          active.finish(turn.status === "completed", turn.status === "interrupted" ? "interrupted" : "runtime_failed");
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
    const resolved = this.installer.resolveBound("codex");
    if (input.cwd !== this.project.root || origin(resolved, this.project) !== this.origin) throw new Error("Codex login origin changed; no fallback was selected");
    const env = { ...resolved.env, [WORKSPACE_MCP_TOKEN_ENV]: this.token,
      HARA_SUBPROCESS_ENV_ALLOW: [resolved.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
    let finish!: ActiveTurn["finish"], bind!: ActiveTurn["bind"], done!: () => void;
    const terminal = new Promise<ExternalCommandCaptureResult>(resolve => {
      finish = (ok, code) => {
        if (active.settled) return;
        active.settled = true;
        resolve({ ok, code: ok ? 0 : 1, timedOut: false, ...(!ok ? { errorCode: code ?? "runtime_failed" } : {}),
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
        const client = JsonlRpcClient.start({ command: resolved.command, env, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 * 1024,
          appServerArgs: ["app-server", "--stdio", "-c", "thread_unload_delay_secs=0", "-c", "mcp_servers={}",
            "-c", 'shell_environment_policy.set.HARA_WORKSPACE_MCP_TOKEN=""'],
          onNotification: (method, params) => this.notification(client, method, params),
          onServerRequest: (_request, _reply, reject) => reject(-32601, "Use Hara Workspace tools and its governed approval channel"),
          onClose: () => { if (this.client === client) { this.client = undefined; this.loaded = false; this.unload?.(); this.active?.finish(false, "runtime_failed"); } },
        });
        this.client = client; this.exit = client.waitForClose();
        await client.call("initialize", { clientInfo: { name: "hara", version: "1.0.2" }, capabilities: { experimentalApi: true } });
        client.notify("initialized");
      }
      input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
      const client = this.client!;
      const config = { mcp_servers: { hara: { url: endpoint.url, bearer_token_env_var: WORKSPACE_MCP_TOKEN_ENV,
        // Only this immutable governed endpoint is trusted. Codex 0.166's `auto` can ask a second
        // native MCP approval before reaching Hara; `approve` changes no Hara tool/card authority.
        default_tools_approval_mode: "approve", required: true, tool_timeout_sec: 120 } },
        ...(input.effort ? { model_reasoning_effort: input.effort } : {}) };
      const resumed = Boolean(this.value.threadId);
      let response: Record<string, unknown>;
      try {
        response = await client.call(resumed ? "thread/resume" : "thread/start", {
          ...(resumed ? { threadId: this.value.threadId, excludeTurns: true } : { ephemeral: false }),
          cwd: input.cwd, sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user",
          developerInstructions: args.system, config, ...(input.model ? { model: input.model } : {}),
        });
      } catch { active.finish(false, resumed ? "codex_resume_failed_history_preserved" : "codex_thread_start_failed"); client.close(); return await terminal; }
      const thread = object(response.thread);
      if (!nativeId(thread.id) || resumed && thread.id !== this.value.threadId || thread.cwd !== input.cwd
        || response.approvalPolicy !== "on-request" || response.approvalsReviewer !== "user"
        || object(response.sandbox).type !== "readOnly" || object(response.sandbox).networkAccess === true
        || input.model !== null && response.model !== input.model || input.effort !== null && response.reasoningEffort !== input.effort
        || ["active", "systemError"].includes(String(object(thread.status).type))) {
        throw new Error("Codex thread confinement or idle origin was not confirmed");
      }
      this.value.threadId = thread.id; this.loaded = true;
      this.value.phase = "unknown"; this.save(); // Write ahead of an accepted or outcome-unknown turn.
      this.systemDigests = new Map((args.systemParts?.length ? args.systemParts : [{ id: "system", digest: hash(args.system) }]).map(part => [part.id, part.digest]));
      input.assertCurrent(); if (input.signal.aborted) throw new Error("interrupted");
      const started = await client.call<Record<string, unknown>>("turn/start", { threadId: thread.id,
        input: [{ type: "text", text: prompt, text_elements: [] }], cwd: input.cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false }, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) });
      const turn = object(started.turn);
      if (!nativeId(turn.id)) throw new Error("Codex did not bind the accepted turn");
      active.id = turn.id; active.bind(turn.id);
      return await terminal;
    } catch { active.bind(""); active.finish(false, "codex_delivery_unknown_no_replay"); this.client?.close(); return await terminal; }
    finally { input.signal.removeEventListener("abort", interrupt); }
  }
  async release(): Promise<void> {
    try {
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
      if (!this.client) await this.exit;
    } finally {
      this.active = undefined; this.busy = false; this.lastUsed = Date.now();
      if (!this.closing) { this.idleTimer = setTimeout(() => { void this.dispose(); }, IDLE_MS); this.idleTimer.unref(); }
    }
  }
  async dispose(): Promise<void> {
    this.closing = true; clearTimeout(this.idleTimer);
    const client = this.client; client?.close(); if (client) await client.waitForClose(); else await this.exit;
    this.evict();
  }
}
