import crossSpawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { runGovernedAgent, type RunOpts, type RunOutcome } from "../agent/loop.js";
import type { NeutralMsg } from "../providers/types.js";
import type { TaskRuntimeBinding } from "./bindings.js";
import type { GovernedAgentRuntimeDriver } from "./registry.js";
import { assertWorkspaceRunAdmission, workspaceRunRuntimeStages } from "../workspace/execution.js";
import type { WorkspaceRuntimeInstaller } from "../workspace/runtime-install.js";
import type { WorkspaceRuntimeModels } from "../workspace/runtime-models.js";
import { runExternalCommandCapture, JsonlRpcClient, ExternalJsonlRpcRequestError, type ExternalCommandCaptureResult } from "../external-sessions/process.js";
import { createRegisteredCliMcpTurn, WORKSPACE_MCP_TOKEN_ENV, type WorkspaceMcpEndpoint } from "./registered-cli-mcp.js";
import { classifyRuntimeFailure, runtimeFailureMessage } from "./failure-diagnostics.js";
import { runtimeFailureTracker } from "./failure-tracker.js";
import { createRuntimeStageProcessObserver } from "./stage-observer.js";
import { runtimeProxyFailure } from "../security/runtime-proxy.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import type { ExpandedRuntimeId } from "./expanded-models.js";
import { expandedCliArgs, grokPermissionResult, grokUpdate, parseExpandedRun } from "./expanded-protocol.js";
import { overlayCursorMcpConfig, writeCopilotMcpConfig } from "./expanded-mcp-config.js";
import { unavailableExpandedProtection, type ExpandedRuntimeProtection, type ProtectedExpandedRuntime } from "./expanded-protection.js";

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
async function childStopped(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const ended = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.removeListener("close", ended); reject(new Error("runtime_failed")); }, 4000);
    child.once("close", ended);
  });
}
async function grokTurn(input: {
  command: string; env: NodeJS.ProcessEnv; cwd: string; args: string[]; prompt: string;
  signal: AbortSignal; timeoutMs: number; endpoint: WorkspaceMcpEndpoint; protection: ProtectedExpandedRuntime;
  observer: ReturnType<typeof createRuntimeStageProcessObserver>; activity(): void; assertCurrent(): void;
}): Promise<ExternalCommandCaptureResult> {
  let client: JsonlRpcClient | undefined, sessionId: string | null = null, active = false, text = "", protocolFailure = false, tools = 0;
  const permissionReplies = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
  const wrapped = input.protection.wrap(input.command, input.args, input.env);
  const refusal = (): void => { protocolFailure = true; client?.close(); };
  try {
    input.assertCurrent();
    client = JsonlRpcClient.start({ command: wrapped.command, env: wrapped.env, cwd: input.cwd, appServerArgs: wrapped.args,
      timeoutMs: input.timeoutMs, maxOutputBytes: 4 * 1024 * 1024, signal: input.signal, jsonRpcVersion: "2.0", onSpawn: input.observer.onSpawn,
      onNotification(method, params) {
        if (method !== "session/update") return;
        if (!active || !sessionId || input.signal.aborted) { refusal(); return; }
        try {
          input.assertCurrent(); input.protection.assertCurrent();
          const event = grokUpdate(params, sessionId);
          if (event.text) { text += event.text; if (text.length > 200_000) { refusal(); return; } input.activity(); }
          if (event.tool) { if (++tools > 1024) { refusal(); return; } input.protection.observeNativeTool(event.tool); input.activity(); }
          input.observer.onStdout(JSON.stringify({ method, params }) + "\n");
        } catch { refusal(); }
      },
      onServerRequest(request, reply, reject) {
        if (request.method !== "session/request_permission") { reject(-32601, "Unsupported client method"); return; }
        try {
          input.assertCurrent(); input.protection.assertCurrent();
          const key = JSON.stringify(request.id), fingerprint = JSON.stringify(request.params);
          const previous = permissionReplies.get(key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) { reject(-32602, "Permission request identity changed"); refusal(); }
            else reply(previous.result);
            return;
          }
          if (permissionReplies.size >= 64) { reject(-32602, "Permission request limit"); refusal(); return; }
          const result = grokPermissionResult(request.params, { sessionId, active, fullProtected: input.protection.fullProtected, aborted: input.signal.aborted });
          permissionReplies.set(key, { fingerprint, result }); reply(result);
        } catch { reject(-32602, "Permission request unavailable"); refusal(); }
      },
    });
    const initialized = object(await client.call("initialize", { protocolVersion: 1, clientInfo: { name: "hara", version: "1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }));
    const capabilities = object(initialized?.agentCapabilities), mcp = object(capabilities?.mcpCapabilities);
    if (initialized?.protocolVersion !== 1 || mcp?.http !== true) throw new Error("version_incompatible");
    input.assertCurrent(); input.protection.assertCurrent();
    const session = object(await client.call("session/new", { cwd: input.cwd,
      mcpServers: [{ type: "http", name: "hara", url: input.endpoint.url,
        headers: [{ name: "Authorization", value: "Bearer " + input.endpoint.env[WORKSPACE_MCP_TOKEN_ENV] }] }],
      _meta: { yoloMode: input.protection.fullProtected } }));
    if (typeof session?.sessionId !== "string" || !session.sessionId || session.sessionId.length > 512) throw new Error("runtime_failed");
    sessionId = session.sessionId; active = true;
    const result = object(await client.call("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] }));
    active = false;
    if (protocolFailure || input.signal.aborted || result?.stopReason !== "end_turn") throw new Error(input.signal.aborted ? "interrupted" : "runtime_failed");
    return { ok: true, stdout: text.trim(), code: 0, timedOut: false };
  } catch (error) {
    const kind = input.signal.aborted ? "interrupted" : protocolFailure ? "runtime_failed" : error instanceof ExternalJsonlRpcRequestError
      ? classifyRuntimeFailure({ status: error.code }) : classifyRuntimeFailure({ code: error instanceof Error ? error.message : undefined });
    return { ok: false, stdout: "", code: null, timedOut: kind === "timeout", errorCode: kind };
  } finally { active = false; await client?.closeAndWait(); }
}
/** Full permissions are unreachable without a trusted common-layer protector. A missing module,
 * unsupported platform or failed proof returns a fixed failure; it never starts an unwrapped process. */
export function expandedCliDriver(id: ExpandedRuntimeId, installer: WorkspaceRuntimeInstaller, models?: WorkspaceRuntimeModels,
  protect: ExpandedRuntimeProtection = unavailableExpandedProtection): GovernedAgentRuntimeDriver {
  return { id, async run(history: NeutralMsg[], options: RunOpts, binding: Readonly<TaskRuntimeBinding>): Promise<RunOutcome> {
    const permit = options.workspaceRun;
    if (!permit || permit.binding.agent.runtimeId !== id || permit.binding.agent.taskId !== binding.taskId)
      return { status: "error", error: "Expanded Runtime requires its exact Workspace run permit" };
    const assertCurrent = () => assertWorkspaceRunAdmission(permit, options, id);
    assertCurrent();
    if (options.signal?.aborted) return { status: "error", error: "Expanded Runtime execution cancelled" };
    if (!models) return { status: "error", error: "Expanded Runtime model inventory unavailable" };
    const resolved = installer.resolveBound(id);
    const diagnostic = (kind: Parameters<typeof runtimeFailureMessage>[0]["kind"]) => ({
      status: "error" as const, error: runtimeFailureMessage({ ...installer.failureContext(id, resolved), kind, elapsedMs: 0 }),
    });
    if (resolved.loginSource !== "host") return diagnostic("runtime_auth_required");
    let selection;
    try { selection = await models.launchSelection(id); } catch { return diagnostic("invalid_model"); }
    if (!selection.modelId || selection.effort && !await models.effortLaunchable(id)) return diagnostic("invalid_model");
    const inventory = await models.list(id);
    if (!inventory.models.some(model => model.id === selection.modelId)) return diagnostic("invalid_model");
    const tracker = runtimeFailureTracker(installer, id, permit.binding.agent.agentId,
      JSON.stringify([resolved.command, resolved.env.HOME, installer.proxy.read().revision, permit.binding.agent.configRevision, selection]), resolved);
    const held = tracker.blocked(); if (held) return { status: "error", error: held };
    try { workspaceRunRuntimeStages(permit)?.setRuntime({ id,
      version: installer.list().options.find(row => row.runtimeId === id)?.version ?? null,
      loginSource: "host", model: selection.modelId, effort: selection.effort }); } catch { /* diagnostic metadata only */ }
    let successfulUse: (() => void) | undefined;
    const native = createRegisteredCliMcpTurn({ signal: options.signal!, assertCurrent, jsonEvents: false,
      async launch(endpoint, prompt, activity) {
        const started = Date.now();
        let protection: ProtectedExpandedRuntime | undefined, config: { path: string; close(): void } | undefined, child: ChildProcess | undefined;
        let physicallyStopped = true;
        const observer = createRuntimeStageProcessObserver(workspaceRunRuntimeStages(permit), id, native.signal);
        try {
          assertCurrent();
          const current = await installer.prepareBound(id, native.signal); assertCurrent();
          const env = { ...current.env, ...endpoint.env,
            HARA_SUBPROCESS_ENV_ALLOW: [current.env.HARA_SUBPROCESS_ENV_ALLOW, WORKSPACE_MCP_TOKEN_ENV].filter(Boolean).join(",") };
          protection = await protect({ runtimeId: id, options, command: current.command, env });
          protection.assertCurrent();
          if (id === "copilot") config = writeCopilotMcpConfig(protection.temporaryDirectory, endpoint);
          if (id === "cursor") config = overlayCursorMcpConfig(options.ctx.cwd, endpoint);
          const args = expandedCliArgs({ id, prompt, model: selection.modelId, effort: selection.effort,
            fullProtected: protection.fullProtected, ...(id === "copilot" && config ? { mcpConfigPath: config.path } : {}) });
          const recordSuccessfulUse = installer.captureSuccessfulUse(id, current.command);
          let result: ExternalCommandCaptureResult;
          if (id === "grok") { physicallyStopped = false; result = await grokTurn({ command: current.command, env, cwd: options.ctx.cwd, args, prompt,
            signal: native.signal, timeoutMs: permit.binding.budget.timeoutMs, endpoint, protection, observer, activity, assertCurrent }); physicallyStopped = true; }
          else {
            const wrapped = protection.wrap(current.command, args, env); protection.assertCurrent(); assertCurrent();
            physicallyStopped = false;
            try {
              result = await runExternalCommandCapture({ command: wrapped.command, env: wrapped.env,
                spawnProcess(command, argv, spawnOptions) { child = crossSpawn(command, [...argv], spawnOptions); return child; } }, wrapped.args, {
                cwd: options.ctx.cwd, signal: native.signal, timeoutMs: permit.binding.budget.timeoutMs, maxOutputBytes: 4 * 1024 * 1024,
                failureKind: "runtime", proxyUrl: current.proxyUrl, retainStdoutOnFailure: true,
                onSpawn: observer.onSpawn, onStdout(chunk) { observer.onStdout(chunk); activity(); },
              });
            } finally { await childStopped(child); physicallyStopped = true; }
            const parsed = parseExpandedRun(id, result);
            for (const event of parsed.tools) protection.observeNativeTool(event);
            result = { ...result, ok: parsed.completed, stdout: parsed.text, ...(parsed.failure ? { errorCode: parsed.failure } : {}) };
          }
          observer.finish(result.ok, result.errorCode);
          if (!result.ok) {
            if (native.signal.aborted || result.errorCode === "interrupted") return { ...result, stdout: "", errorCode: "interrupted" };
            return { ...result, stdout: "", runtimeFailure: tracker.failed(classifyRuntimeFailure({ code: result.errorCode, timedOut: result.timedOut }), Date.now() - started) };
          }
          assertCurrent(); protection.assertCurrent();
          config?.close(); config = undefined;
          await protection.collectEvidence?.();
          tracker.succeeded(); successfulUse = recordSuccessfulUse;
          return { ...result, stdout: redactToolSubprocessOutput(result.stdout, env) };
        } catch (error) {
          if (native.signal.aborted) return { ok: false, stdout: "", code: null, timedOut: false, errorCode: "interrupted" };
          const kind = runtimeProxyFailure(error) ? "runtime_proxy" : classifyRuntimeFailure({ code: error instanceof Error ? error.message : undefined });
          return { ok: false, stdout: "", code: null, timedOut: false, runtimeFailure: tracker.failed(kind, Date.now() - started) };
        } finally {
          observer.finish(false);
          // If physical cleanup is unknown, preserve config/policy state for recovery instead of
          // removing a live child's profile. No other process is searched for or terminated here.
          if (physicallyStopped) { try { config?.close(); } finally { await protection?.close(); } }
        }
      },
    });
    try {
      const outcome = await runGovernedAgent(history, options, id, (_provider, args) => native.turn(args));
      if (outcome.status === "completed" && !options.signal?.aborted && successfulUse) { assertCurrent(); successfulUse(); }
      return outcome;
    } finally { await native.close(history); }
  } };
}
