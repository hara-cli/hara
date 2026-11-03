import { runtimeProxyFailure, runtimeProxyFailureFromText, type RuntimeProxyFailure } from "../security/runtime-proxy.js";
import { classifyRuntimeFailure, runtimeFailureMessage, type RuntimeFailureKind } from "./failure-diagnostics.js";
import { runtimeFailureTracker } from "./failure-tracker.js";
import { randomUUID } from "node:crypto";
import { runExternalCommandCapture, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { createCodingHostBridge, type CodingHostBridge } from "../coding/host.js";
import { runGovernedAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg, ToolResult, ToolSpec, TurnArgs, TurnResult } from "../providers/types.js";
import { assertWorkspaceRunAdmission } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import { CLI_TOOL_GUIDANCE } from "./tool-guidance.js";

interface PendingCall { id: string; name: string; input: Record<string, unknown>; resolve(result: ToolResult): void }
type Failure = RuntimeProxyFailure | RuntimeFailureKind;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Only fixed categories cross the CLI boundary; raw provider errors can contain URLs or credentials. */
export function openCodeFailure(value: unknown, explicitProxy = false): Failure {
  let text: string;
  try { text = JSON.stringify(value ?? "").slice(0, 16_384); } catch { return "runtime_failed"; }
  const proxy = runtimeProxyFailureFromText(text, explicitProxy); if (proxy) return proxy;
  const object = record(value);
  return classifyRuntimeFailure({ stderr: text,
    ...(typeof object?.code === "string" ? { code: object.code } : {}),
    ...(typeof object?.status === "number" ? { status: object.status } : {}) });
}

/** Parse only the documented JSON event stream; an error frame or missing completion fails even on exit 0. */
export function parseOpenCodeRun(result: ExternalCommandCaptureResult, explicitProxy = false): TurnResult {
  if (result.errorCode === "runtime_proxy_failed") return { text: "", toolUses: [], stop: "error", errorMsg: result.errorCode };
  let text = "", finished = false, failure: Failure | null = null, frames = 0;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" };
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(line)); } catch { return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" }; }
    if (!event || typeof event.type !== "string" || ++frames > 4096) return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" };
    if (event.type === "error") failure = openCodeFailure(event.error ?? event, explicitProxy);
    if (event.type === "step_finish") finished = true;
    if (event.type === "text") {
      const part = record(event.part);
      if (typeof part?.text === "string") text += part.text;
      if (text.length > 200_000) return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" };
    }
  }
  if (failure || !result.ok || !finished) return { text: "", toolUses: [], stop: "error",
    errorMsg: failure && failure !== "runtime_failed" ? failure : classifyRuntimeFailure({ code: result.errorCode, timedOut: result.timedOut }) };
  return { text: text.trim(), toolUses: [], stop: "end" };
}

/** The CLI may read the host login, but never inherits profile overrides, telemetry or caller tools. */
export function openCodeRunEnv(host: NodeJS.ProcessEnv, bridge: CodingHostBridge): NodeJS.ProcessEnv {
  const env = { ...host };
  for (const name of Object.keys(env)) if (/^(?:OPENCODE_|OTEL_|XDG_)/iu.test(name)) delete env[name];
  const allowed = Object.fromEntries(bridge.toolNames.map(name => [`hara_${name}`, "allow"]));
  const permission = { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", ...allowed };
  const config = {
    autoupdate: false, share: "disabled", snapshot: false, plugin: [], skills: { paths: [], urls: [] }, instructions: [],
    permission, tools: { read: true, glob: true, grep: true, list: true, edit: false, write: false, bash: false, task: false, webfetch: false },
    agent: { "hara-general": { mode: "primary", permission, steps: 64 },
      build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true } },
    default_agent: "hara-general",
    mcp: { hara: { ...bridge.mcp, enabled: true, timeout: 30_000 } },
    formatter: false, lsp: false, compaction: { auto: false, prune: false },
  };
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", NO_COLOR: "1" };
}

export function openCodeRunArgs(cwd: string, model: string, prompt: string): string[] {
  return ["run", "--pure", "--format", "json", "-m", model, "--dir", cwd, "--agent", "hara-general", "--", prompt];
}

function createOpenCodeTurn(input: { installer: WorkspaceRuntimeInstaller; model: string; options: RunOpts;
  tracker: ReturnType<typeof runtimeFailureTracker> }) {
  const stop = new AbortController();
  const signal = input.options.signal ? AbortSignal.any([input.options.signal, stop.signal]) : stop.signal;
  const pending = new Map<string, PendingCall>(), queue: PendingCall[] = [];
  let bridge: CodingHostBridge | undefined, physical: Promise<void> | undefined, finished: TurnResult | undefined;
  let wake: (() => void) | undefined, closed = false, ended = false;
  const notify = () => { wake?.(); wake = undefined; };
  const flush = (history: readonly NeutralMsg[]) => {
    for (const message of history) if (message.role === "tool") for (const result of message.results) {
      const call = pending.get(result.id);
      if (call) { pending.delete(result.id); call.resolve(result); }
    }
  };
  return {
    async turn(_provider: unknown, args: TurnArgs): Promise<TurnResult> {
      if (closed || signal.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
      flush(args.history);
      if (!physical) {
        const permit = input.options.workspaceRun!;
        const assertCurrent = () => assertWorkspaceRunAdmission(permit, input.options, "opencode");
        const tools: ToolSpec[] = args.tools;
        bridge = await createCodingHostBridge({
          provider: { id: "hara-mcp-only", model: "hara/mcp-only", async turn() { throw new Error("MCP-only bridge has no model route"); } },
          tools, executeTool(name, parameters) {
            assertCurrent();
            if (pending.size >= 16) throw new Error("Workspace tool queue full");
            return new Promise<ToolResult>(resolve => {
              const call = { id: randomUUID(), name, input: parameters, resolve };
              pending.set(call.id, call); queue.push(call); notify();
            }).then(result => ({ content: result.content, isError: result.isError }));
          },
          assertCurrent, signal,
          budget: { maxProviderRounds: 1, maxToolCalls: permit.binding.budget.maxToolCalls,
            maxTokens: permit.binding.budget.maxTokens, timeoutMs: permit.binding.budget.timeoutMs },
        });
        const prompt = [args.system, CLI_TOOL_GUIDANCE, ...args.history.map(message => message.role === "user" ? "User: " + message.content
          : message.role === "assistant" ? "Assistant: " + message.text : "")].filter(Boolean).join("\n\n");
        if (!prompt.trim() || prompt.length > 200_000 || args.history.some(message => message.role === "user" && message.images?.length)) {
          finished = { text: "", toolUses: [], stop: "error", errorMsg: "Native Agent Runtime context is unsupported or too large" };
        } else {
          physical = (async () => {
            const started = Date.now();
            try {
              const held = input.tracker.blocked();
              if (held) { finished = { text: "", toolUses: [], stop: "error", errorMsg: held }; return; }
              const resolved = await input.installer.prepareBound("opencode", signal);
              assertCurrent();
              const env = openCodeRunEnv(resolved.env, bridge!);
              const result = await runExternalCommandCapture({ command: resolved.command, env },
                openCodeRunArgs(input.options.ctx.cwd, input.model, prompt), {
                  cwd: input.options.ctx.cwd, signal, timeoutMs: permit.binding.budget.timeoutMs,
                  maxOutputBytes: 4 * 1024 * 1024, retainStdoutOnFailure: true,
                  failureKind: "runtime", proxyUrl: resolved.proxyUrl,
                  onStdout: () => args.onActivity?.(),
                });
              const parsed = parseOpenCodeRun(result, Boolean(resolved.proxyUrl));
              if (signal.aborted || result.errorCode === "interrupted") finished = { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
              else if (parsed.stop === "error") finished = { ...parsed, errorMsg: input.tracker.failed(
                classifyRuntimeFailure({ code: parsed.errorMsg }), Date.now() - started) };
              else { input.tracker.succeeded(); finished = parsed; }
            } catch (error) { finished = { text: "", toolUses: [], stop: "error", errorMsg: signal.aborted ? "interrupted"
              : input.tracker.failed(runtimeProxyFailure(error) ? "runtime_proxy" : "runtime_failed", Date.now() - started) }; }
            finally { notify(); }
          })();
        }
      }
      while (!closed) {
        if (signal.aborted) return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
        const call = queue.shift();
        if (call) return { text: "", toolUses: [{ id: call.id, name: call.name, input: call.input }], stop: "tool_use" };
        if (finished) { const result = finished; finished = undefined; ended = true; return result; }
        if (ended) return { text: "", toolUses: [], stop: "error", errorMsg: "OpenCode ended before the governed task completed" };
        await new Promise<void>(resolve => { wake = resolve; });
      }
      return { text: "", toolUses: [], stop: "error", errorMsg: "interrupted" };
    },
    async close(history: readonly NeutralMsg[]) {
      if (closed) return;
      closed = true; flush(history); stop.abort();
      for (const call of pending.values()) call.resolve({ id: call.id, name: call.name, content: "Error: Workspace attempt ended", isError: true });
      pending.clear(); queue.length = 0; notify();
      await bridge?.close().catch(() => {});
      await physical?.catch(() => {});
    },
  };
}

export function openCodeCliDriver(installer: WorkspaceRuntimeInstaller, models?: WorkspaceRuntimeModels): GovernedAgentRuntimeDriver {
  return { id: "opencode", async run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome> {
    const permit = options.workspaceRun;
    if (!permit || permit.binding.agent.runtimeId !== "opencode" || permit.binding.agent.taskId !== binding.taskId)
      return { status: "error", error: "OpenCode requires its exact Workspace run permit" };
    if (!models) return { status: "error", error: "OpenCode model inventory is unavailable" };
    assertWorkspaceRunAdmission(permit, options, "opencode");
    if (options.signal?.aborted) return { status: "error", error: "OpenCode execution cancelled" };
    const resolved = installer.resolveBound("opencode");
    const diagnostic = (kind: RuntimeFailureKind) => ({ status: "error" as const,
      error: runtimeFailureMessage({ ...installer.failureContext("opencode", resolved), kind, elapsedMs: 0 }) });
    if (resolved.loginSource !== "host") return diagnostic("runtime_auth_required");
    const model = models.selection("opencode");
    if (!model.modelId || model.effort) return diagnostic("invalid_model");
    const tracker = runtimeFailureTracker(installer, "opencode", permit.binding.agent.agentId,
      JSON.stringify([resolved.command, resolved.loginSource, resolved.env.HOME, resolved.proxyUrl, permit.binding.agent.configRevision, model.modelId]), resolved);
    const held = tracker.blocked();
    if (held) return { status: "error", error: held };
    let catalog;
    try { catalog = await models.list("opencode"); }
    catch { return diagnostic("runtime_failed"); }
    if (!catalog.models.some(row => row.id === model.modelId)) return diagnostic("invalid_model");
    const kernel = createOpenCodeTurn({ installer, model: model.modelId, options, tracker });
    try { return await runGovernedAgent(history, options, "opencode", kernel.turn); }
    finally { await kernel.close(history); }
  } };
}
