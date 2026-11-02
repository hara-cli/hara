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
type Failure = "runtime_auth_required" | "runtime_network" | "invalid_model" | "runtime_permission_denied" | "runtime_failed";
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Only fixed categories cross the CLI boundary; raw provider errors can contain URLs or credentials. */
export function openCodeFailure(value: unknown): Failure {
  const text = JSON.stringify(value ?? "").slice(0, 16_384);
  if (/\b401\b|unauthori[sz]ed|authentication|not logged in|invalid.api.key/i.test(text)) return "runtime_auth_required";
  if (/unknown.model|model.not.found|model.*not.*recognized|unknown.provider/i.test(text)) return "invalid_model";
  if (/permission.denied|access.denied|forbidden|\b403\b/i.test(text)) return "runtime_permission_denied";
  if (/cannot.connect|network|ECONN|ETIMEDOUT|fetch.failed/i.test(text)) return "runtime_network";
  return "runtime_failed";
}

/** Parse only the documented JSON event stream; an error frame or missing completion fails even on exit 0. */
export function parseOpenCodeRun(result: ExternalCommandCaptureResult): TurnResult {
  let text = "", finished = false, failure: Failure | null = null, frames = 0;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" };
    let event: Record<string, unknown> | null;
    try { event = record(JSON.parse(line)); } catch { return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" }; }
    if (!event || typeof event.type !== "string" || ++frames > 4096) return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" };
    if (event.type === "error") failure = openCodeFailure(event.error ?? event);
    if (event.type === "step_finish") finished = true;
    if (event.type === "text") {
      const part = record(event.part);
      if (typeof part?.text === "string") text += part.text;
      if (text.length > 200_000) return { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" };
    }
  }
  if (failure || !result.ok || !finished) return { text: "", toolUses: [], stop: "error",
    errorMsg: failure ?? (result.timedOut ? "runtime_network" : result.errorCode === "runtime_auth_required" ? "runtime_auth_required" : "runtime_failed") };
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

function createOpenCodeTurn(input: { command: string; env: NodeJS.ProcessEnv; model: string; options: RunOpts }) {
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
          const env = openCodeRunEnv(input.env, bridge);
          physical = (async () => {
            try {
              const result = await runExternalCommandCapture({ command: input.command, env },
                openCodeRunArgs(input.options.ctx.cwd, input.model, prompt), {
                  cwd: input.options.ctx.cwd, signal, timeoutMs: permit.binding.budget.timeoutMs,
                  maxOutputBytes: 4 * 1024 * 1024, retainStdoutOnFailure: true,
                  onStdout: () => args.onActivity?.(),
                });
              finished = parseOpenCodeRun(result);
            } catch { finished = { text: "", toolUses: [], stop: "error", errorMsg: "runtime_failed" }; }
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
    if (resolved.loginSource !== "host") return { status: "error", error: "OpenCode requires host login" };
    const model = models.selection("opencode");
    if (!model.modelId || model.effort) return { status: "error", error: "OpenCode requires a selected model without reasoning variant" };
    const catalog = await models.list("opencode");
    if (!catalog.models.some(row => row.id === model.modelId)) return { status: "error", error: "OpenCode selected model is unavailable in the live catalog" };
    const kernel = createOpenCodeTurn({ command: resolved.command, env: resolved.env, model: model.modelId, options });
    try { return await runGovernedAgent(history, options, "opencode", kernel.turn); }
    finally { await kernel.close(history); }
  } };
}
